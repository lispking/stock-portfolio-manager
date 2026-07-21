//! AI chat service: streams OpenAI-compatible `/chat/completions` responses.
//!
//! The service does two jobs:
//! 1. `build_portfolio_context` — assembles a structured Markdown snapshot of
//!    the user's current portfolio (overview, holdings, recent transactions,
//!    performance metrics) by reusing existing in-process services. It never
//!    triggers network quote fetches (`cache_only = true`).
//! 2. `chat_stream` — POSTs the conversation to the configured LLM provider
//!    with `stream: true`, parses the Server-Sent-Events stream chunk by
//!    chunk, and emits incremental token deltas to the frontend via the
//!    `ai-chat-delta` Tauri event (`ai-chat-done` / `ai-chat-error` on
//!    completion / failure).
//!
//! All supported providers (OpenAI / Ollama / OpenRouter / Kimi / GLM / MiMo)
//! expose the same `/chat/completions` shape, so the request logic is uniform.

use crate::commands::dashboard::build_holding_details_pub;
use crate::db::Database;
use crate::models::ai_config::ChatMessage;
use crate::models::skill::Skill;
use crate::services::ai_config_service;
use crate::services::ai_models_service::resolve_base_url;
use crate::services::exchange_rate_service::{get_cached_rates, ExchangeRateCache};
use crate::services::http_client;
use crate::services::performance_service::{self, PerformanceFilter};
use crate::services::quote_service::QuoteCache;
use crate::services::skill_service::{self, build_skill_system_message};
use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter};

/// Parameters for a chat turn.
#[derive(Debug, Clone)]
pub struct ChatParams {
    /// Conversation history sent by the frontend (system prompt is prepended
    /// here from the saved config; portfolio context is added as an extra
    /// `user` message when `include_context` is true).
    pub messages: Vec<ChatMessage>,
    /// Whether to inject the portfolio context snapshot before the user
    /// messages.
    pub include_context: bool,
    /// Skill ids the user explicitly activated for this turn (via `/` or `@`
    /// in the composer, or by clicking a quick chip). Takes priority over
    /// automatic trigger-based activation.
    #[allow(dead_code)] // read via resolve_active_skills
    pub active_skills: Vec<String>,
}

/// Token-usage accounting for a single chat completion. Emitted to the
/// frontend once per turn (in the final SSE chunk).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatUsage {
    /// Tokens consumed by the prompt (system prompt + context + history).
    pub prompt_tokens: u32,
    /// Tokens produced by the model in its reply.
    pub completion_tokens: u32,
    /// `prompt_tokens + completion_tokens`.
    pub total_tokens: u32,
    /// Portion of `prompt_tokens` that hit the provider's prompt cache and is
    /// billed at a discount (OpenAI/Anthropic) or free (DeepSeek). 0 when the
    /// provider does not report cache info.
    #[serde(default)]
    pub cached_tokens: u32,
}

// Global stop flag. Set by `stop_chat()` from a Tauri command; the streaming
// loop polls it between chunks and aborts the request as soon as it is set.
// A single global flag is sufficient because only one chat turn is in flight
// at a time (the UI disables the send button while `sending` is true).
static STOP_REQUESTED: AtomicBool = AtomicBool::new(false);

/// Request that any in-flight chat stream terminate as soon as possible.
///
/// The streaming loop checks this flag after each chunk and, when set, emits
/// `ai-chat-done` (with whatever tokens were already streamed) and returns.
/// The flag is cleared automatically by `chat_stream` at the start of each
/// new turn.
pub fn stop_chat() {
    STOP_REQUESTED.store(true, Ordering::SeqCst);
}

// ─────────────────────────────────────────────────────────────────────────────
// Skill activation
// ─────────────────────────────────────────────────────────────────────────────

/// Resolve which skills are active for this turn.
///
/// 1. If the user passed explicit skill ids (`active_skills`), look each one
///    up by id and use it as-is (regardless of `enabled` — explicit wins).
///    Unknown ids are silently dropped.
/// 2. Otherwise, fall back to **auto-activation**: load every skill, then
///    match each one's `trigger` keywords against the latest user message
///    (case-insensitive). Disabled skills are skipped.
///
/// Errors loading the skill list are swallowed (best-effort — skills should
/// never block the chat), returning an empty vec.
fn resolve_active_skills(app: &AppHandle, params: &ChatParams) -> Vec<Skill> {
    // Explicit selection path.
    if !params.active_skills.is_empty() {
        let ids: std::collections::HashSet<&str> =
            params.active_skills.iter().map(|s| s.as_str()).collect();
        let selected: Vec<Skill> = skill_service::list_skills(app)
            .unwrap_or_default()
            .into_iter()
            .filter(|s| ids.contains(s.id.as_str()))
            .collect();
        if !selected.is_empty() {
            return selected;
        }
        // Fall through to auto-activation if every id was unknown.
    }

    // Auto-activation path: scan the latest user message for trigger hits.
    let latest_user = params
        .messages
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .map(|m| m.content.as_str())
        .unwrap_or("");
    if latest_user.trim().is_empty() {
        return Vec::new();
    }
    let skills = skill_service::list_skills(app).unwrap_or_default();
    skill_service::match_triggers(&skills, latest_user)
}

// ─────────────────────────────────────────────────────────────────────────────
// Portfolio context
// ─────────────────────────────────────────────────────────────────────────────

/// Assemble a Markdown snapshot of the current portfolio for the LLM prompt.
///
/// Uses cache-only quotes (no network) and pulls the last year of performance
/// metrics. Every section is guarded so an empty portfolio still yields a
/// short, valid context string rather than an error.
pub async fn build_portfolio_context(
    db: &Database,
    cache: &ExchangeRateCache,
    quote_cache: &QuoteCache,
) -> Result<String, String> {
    let details = build_holding_details_pub(db, quote_cache, true).await?;
    let rates =
        get_cached_rates(cache, db)
            .await
            .unwrap_or_else(|_| crate::models::quote::ExchangeRates {
                usd_cny: 7.2,
                usd_hkd: 7.8,
                cny_hkd: 7.8 / 7.2,
                updated_at: Utc::now().to_rfc3339(),
            });

    // Normalise every holding's market value to USD for cross-currency totals.
    let to_usd = |amount: f64, currency: &str| {
        crate::services::exchange_rate_service::convert_currency(amount, currency, "USD", &rates)
    };
    let total_market_value_usd: f64 = details
        .iter()
        .map(|d| to_usd(d.market_value, &d.currency))
        .sum();
    let total_cost_value_usd: f64 = details
        .iter()
        .map(|d| to_usd(d.cost_value, &d.currency))
        .sum();
    let total_daily_pnl_usd: f64 = details
        .iter()
        .map(|d| to_usd(d.daily_pnl, &d.currency))
        .sum();

    let mut out = String::new();
    out.push_str("# 当前投资组合快照\n\n");

    // ── Overview ───────────────────────────────────────────────────────────
    out.push_str("## 账户总览（单位：USD）\n");
    if details.is_empty() {
        out.push_str("（暂无持仓）\n\n");
    } else {
        let total_pnl = total_market_value_usd - total_cost_value_usd;
        let total_pnl_pct = if total_cost_value_usd > 0.0 {
            total_pnl / total_cost_value_usd * 100.0
        } else {
            0.0
        };
        out.push_str(&format!(
            "- 持仓数量：{}\n- 总市值：{:.2}\n- 总成本：{:.2}\n- 累计盈亏：{:.2} ({:.2}%)\n- 当日盈亏：{:.2}\n\n",
            details.len(),
            total_market_value_usd,
            total_cost_value_usd,
            total_pnl,
            total_pnl_pct,
            total_daily_pnl_usd,
        ));
    }

    // ── Holdings table ─────────────────────────────────────────────────────
    out.push_str("## 当前持仓\n");
    out.push_str("| 代码 | 名称 | 市场 | 账户 | 类别 | 持仓 | 均价 | 现价 | 市值(USD) | 盈亏% |\n");
    out.push_str("|------|------|------|------|------|------|------|------|-----------|-------|\n");
    let mut sorted = details.clone();
    sorted.sort_by(|a, b| {
        to_usd(b.market_value, &b.currency)
            .partial_cmp(&to_usd(a.market_value, &a.currency))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    for d in &sorted {
        let pnl_pct = d.pnl_percent.unwrap_or(0.0);
        out.push_str(&format!(
            "| {} | {} | {} | {} | {} | {:.4} | {:.4} | {:.4} | {:.2} | {:.2} |\n",
            d.symbol,
            d.name,
            d.market,
            d.account_name,
            d.category_name,
            d.shares,
            d.avg_cost,
            d.current_price,
            to_usd(d.market_value, &d.currency),
            pnl_pct,
        ));
    }
    out.push('\n');

    // ── Recent transactions ────────────────────────────────────────────────
    out.push_str("## 近期交易（最近 20 条）\n");
    match fetch_recent_transactions(db, 20) {
        Ok(txns) if !txns.is_empty() => {
            out.push_str("| 日期 | 代码 | 名称 | 类型 | 持仓 | 价格 | 金额 |\n");
            out.push_str("|------|------|------|------|------|------|------|\n");
            for t in &txns {
                out.push_str(&format!(
                    "| {} | {} | {} | {} | {:.4} | {:.4} | {:.2} |\n",
                    t.traded_at,
                    t.symbol,
                    t.name,
                    t.transaction_type,
                    t.shares,
                    t.price,
                    t.total_amount
                ));
            }
            out.push('\n');
        }
        _ => out.push_str("（暂无交易记录）\n\n"),
    }

    // ── Performance metrics (last 1 year) ──────────────────────────────────
    out.push_str("## 绩效指标（近 1 年）\n");
    let end = Utc::now().date_naive();
    let start = end - Duration::days(365);
    let filter = PerformanceFilter {
        market: None,
        account_id: None,
    };
    match performance_service::get_performance_summary(db, start, end, &filter) {
        Ok(p) if p.end_value > 0.0 || !p.return_series.is_empty() => {
            out.push_str(&format!(
                "- 期初市值：{:.2}\n- 期末市值：{:.2}\n- 累计收益率：{:.2}%\n- 年化收益率：{:.2}%\n- 累计盈亏：{:.2}\n- 最大回撤：{:.2}%\n- 波动率：{:.2}%\n- 夏普比率：{:.2}\n\n",
                p.start_value,
                p.end_value,
                p.total_return,
                p.annualized_return,
                p.total_pnl,
                p.max_drawdown,
                p.volatility,
                p.sharpe_ratio,
            ));
        }
        _ => out.push_str("（暂无足够的历史数据）\n\n"),
    }

    Ok(out.trim_end().to_string())
}

struct TxnRow {
    traded_at: String,
    symbol: String,
    name: String,
    transaction_type: String,
    shares: f64,
    price: f64,
    total_amount: f64,
}

fn fetch_recent_transactions(db: &Database, limit: usize) -> Result<Vec<TxnRow>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT traded_at, symbol, name, transaction_type, shares, price, total_amount
             FROM transactions
             ORDER BY traded_at DESC
             LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![limit as i64], |row| {
            Ok(TxnRow {
                traded_at: row.get(0)?,
                symbol: row.get(1)?,
                name: row.get(2)?,
                transaction_type: row.get(3)?,
                shares: row.get(4)?,
                price: row.get(5)?,
                total_amount: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

// ─────────────────────────────────────────────────────────────────────────────
// Chat streaming
// ─────────────────────────────────────────────────────────────────────────────

/// OpenAI-style streaming chunk.
#[derive(Debug, Deserialize)]
struct ChatStreamChunk {
    #[serde(default)]
    choices: Vec<ChatChoice>,
    /// Only present on the final chunk when `stream_options.include_usage`
    /// is set on the request.
    #[serde(default)]
    usage: Option<UsagePayload>,
}

#[derive(Debug, Deserialize)]
struct ChatChoice {
    #[serde(default)]
    delta: Delta,
}

#[derive(Debug, Default, Deserialize)]
struct Delta {
    #[serde(default)]
    content: Option<String>,
}

#[derive(Debug, Deserialize)]
struct UsagePayload {
    #[serde(default)]
    prompt_tokens: u32,
    #[serde(default)]
    completion_tokens: u32,
    #[serde(default)]
    total_tokens: u32,
    /// OpenAI / OpenRouter / Kimi style: nested under `prompt_tokens_details`.
    #[serde(default)]
    prompt_tokens_details: Option<PromptTokensDetails>,
    /// DeepSeek style: top-level `prompt_cache_hit_tokens`.
    #[serde(default)]
    prompt_cache_hit_tokens: Option<u32>,
}

#[derive(Debug, Default, Deserialize)]
struct PromptTokensDetails {
    #[serde(default)]
    cached_tokens: u32,
}

impl UsagePayload {
    fn into_chat_usage(self) -> ChatUsage {
        // Take the larger of the two cache fields so we tolerate either schema
        // (and providers that only populate one). When neither is present the
        // value is 0, which the UI renders as "no cache".
        let cached = self
            .prompt_tokens_details
            .map(|d| d.cached_tokens)
            .unwrap_or(0)
            .max(self.prompt_cache_hit_tokens.unwrap_or(0));
        ChatUsage {
            prompt_tokens: self.prompt_tokens,
            completion_tokens: self.completion_tokens,
            total_tokens: self.total_tokens,
            cached_tokens: cached,
        }
    }
}

/// Validate that the saved config is usable, returning the config on success.
fn load_and_validate_config(db: &Database) -> Result<crate::models::ai_config::AiConfig, String> {
    let cfg = ai_config_service::get_ai_config(db)?;
    if cfg.model.trim().is_empty() {
        return Err("尚未配置 AI 模型，请先到「设置 → AI 配置」中选择模型".to_string());
    }
    // Local Ollama does not need an API key.
    if !cfg.provider.eq_ignore_ascii_case("ollama") && cfg.api_key.trim().is_empty() {
        return Err("尚未配置 API Key，请先到「设置 → AI 配置」中填写".to_string());
    }
    Ok(cfg)
}

/// Stream a chat completion to the frontend via Tauri events.
///
/// Events emitted:
/// - `ai-chat-delta` (payload: `String`) — one token delta at a time
/// - `ai-chat-done` (payload: `()`) — successful completion
/// - `ai-chat-error` (payload: `String`) — any failure (also returned as `Err`)
pub async fn chat_stream(
    app: AppHandle,
    db: &Database,
    cache: &ExchangeRateCache,
    quote_cache: &QuoteCache,
    params: ChatParams,
) -> Result<(), String> {
    let emit_error = |app: &AppHandle, msg: String| {
        let _ = app.emit("ai-chat-error", msg);
    };

    let cfg = match load_and_validate_config(db) {
        Ok(c) => c,
        Err(e) => {
            emit_error(&app, e.clone());
            return Err(e);
        }
    };
    let base = match resolve_base_url(&cfg.provider, cfg.base_url.as_deref()) {
        Ok(b) => b,
        Err(e) => {
            emit_error(&app, e.clone());
            return Err(e);
        }
    };
    let url = format!("{base}/chat/completions");

    // Resolve which skills apply to this turn: the user's explicit selection
    // takes priority; otherwise we auto-activate any skill whose trigger
    // keyword appears in the latest user message. We also tell the frontend
    // which skills ended up active so the UI can show a badge.
    let activated = resolve_active_skills(&app, &params);
    if !activated.is_empty() {
        let names: Vec<String> = activated.iter().map(|s| s.name.clone()).collect();
        let _ = app.emit("ai-chat-skill", names);
    }

    // Build the full message list: system prompt, optional context, then the
    // conversation history from the frontend.
    let mut messages: Vec<serde_json::Value> = Vec::new();
    if !cfg.system_prompt.trim().is_empty() {
        messages.push(json!({ "role": "system", "content": cfg.system_prompt }));
    }
    // Active skills are injected as an extra system message so the model
    // treats them as authoritative instructions on top of its base persona.
    let skill_block = build_skill_system_message(&activated);
    if !skill_block.is_empty() {
        messages.push(json!({ "role": "system", "content": skill_block }));
    }
    if params.include_context {
        match build_portfolio_context(db, cache, quote_cache).await {
            Ok(ctx) => {
                messages.push(json!({
                    "role": "system",
                    "content": format!(
                        "以下是用户的实时投资组合数据，请在回答时参考（金额单位均为 USD，数据可能略有延迟）：\n\n{ctx}"
                    ),
                }));
            }
            // Context is best-effort; a failure should not block the chat.
            Err(e) => {
                eprintln!("[ai_chat] failed to build portfolio context: {e}");
            }
        }
    }
    for m in &params.messages {
        messages.push(json!({ "role": m.role, "content": m.content }));
    }

    let body = json!({
        "model": cfg.model,
        "messages": messages,
        "stream": true,
        // Ask the provider to include a `usage` block on the final SSE chunk
        // so we can report token consumption back to the user.
        "stream_options": { "include_usage": true },
    });

    // Start each turn with a clean stop flag so a stale request from a
    // previous turn doesn't immediately abort this one.
    STOP_REQUESTED.store(false, Ordering::SeqCst);

    let client = http_client::ai_client();
    let mut req = client.post(&url).json(&body);
    if !cfg.api_key.is_empty() {
        req = req.bearer_auth(&cfg.api_key);
    }

    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            let msg = format!("请求 AI 服务失败：{e}");
            emit_error(&app, msg.clone());
            return Err(msg);
        }
    };

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        let msg = format!("AI 服务返回错误 (HTTP {status})：{body}");
        emit_error(&app, msg.clone());
        return Err(msg);
    }

    // Parse the SSE stream. Each chunk is a slice of bytes; we buffer into a
    // string and split on `\n`, processing one SSE `data:` line at a time.
    let mut stream = resp;
    let mut buf = String::new();
    let mut last_usage: Option<ChatUsage> = None;
    let emit_usage = |app: &AppHandle, usage: &Option<ChatUsage>| {
        if let Some(u) = usage {
            let _ = app.emit("ai-chat-usage", u.clone());
        }
    };
    loop {
        // Honour a stop request between chunk reads so the user can abort a
        // long response. We emit whatever usage we have so far (may be `None`
        // when stopping before the final usage chunk arrived) and signal done.
        if STOP_REQUESTED.load(Ordering::SeqCst) {
            emit_usage(&app, &last_usage);
            let _ = app.emit("ai-chat-done", ());
            return Ok(());
        }

        match stream.chunk().await {
            Ok(Some(chunk)) => {
                buf.push_str(&String::from_utf8_lossy(&chunk));
                let mut newline_idx;
                while {
                    // Process every complete line currently in the buffer.
                    newline_idx = buf.find('\n');
                    newline_idx.is_some()
                } {
                    let newline_idx = newline_idx.unwrap();
                    let line = buf[..newline_idx].trim_end_matches('\r').to_string();
                    buf.drain(..=newline_idx);

                    if let Some(payload) = line.strip_prefix("data:") {
                        let payload = payload.trim();
                        if payload == "[DONE]" {
                            emit_usage(&app, &last_usage);
                            let _ = app.emit("ai-chat-done", ());
                            return Ok(());
                        }
                        if payload.is_empty() {
                            continue;
                        }
                        match serde_json::from_str::<ChatStreamChunk>(payload) {
                            Ok(parsed) => {
                                if let Some(u) = parsed.usage {
                                    last_usage = Some(u.into_chat_usage());
                                }
                                for choice in parsed.choices {
                                    if let Some(content) = choice.delta.content {
                                        if !content.is_empty() {
                                            let _ = app.emit("ai-chat-delta", content);
                                        }
                                    }
                                }
                            }
                            Err(e) => {
                                // Keep going — providers occasionally emit
                                // non-JSON keepalive comments or partial frames
                                // that we don't care about.
                                eprintln!("[ai_chat] skip unparseable SSE line: {e} :: {payload}");
                            }
                        }
                    }
                    // Lines without the `data:` prefix (comments, `event:`,
                    // `id:` etc.) are ignored.
                }
            }
            Ok(None) => break,
            Err(e) => {
                let msg = format!("读取 AI 响应流失败：{e}");
                emit_error(&app, msg.clone());
                return Err(msg);
            }
        }
    }

    // Stream ended without an explicit `[DONE]` marker — still signal done.
    emit_usage(&app, &last_usage);
    let _ = app.emit("ai-chat-done", ());
    Ok(())
}

/// OpenAI-style non-streaming chat completion response (only what we need).
#[derive(Debug, Deserialize)]
struct ChatCompletionResponse {
    #[serde(default)]
    choices: Vec<ChatCompletionChoice>,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionChoice {
    #[serde(default)]
    message: Option<ChatCompletionMessage>,
}

#[derive(Debug, Default, Deserialize)]
struct ChatCompletionMessage {
    #[serde(default)]
    content: Option<String>,
}

/// Ask the configured LLM to produce a short Chinese title summarising the
/// user's first question in a new session. Used to auto-name sessions with
/// something meaningful (e.g. "持仓集中度分析") instead of "新会话 14:30".
///
/// Returns a plain title string on success. On any failure the caller falls
/// back to a truncated prefix of the user message, so this is best-effort.
pub async fn generate_title(db: &Database, user_message: &str) -> Result<String, String> {
    let cfg = load_and_validate_config(db)?;
    let base = resolve_base_url(&cfg.provider, cfg.base_url.as_deref())?;
    let url = format!("{base}/chat/completions");

    let body = json!({
        "model": cfg.model,
        "messages": [
            {
                "role": "system",
                "content": "你是一个标题生成器。根据用户的问题生成一个简短的中文标题。要求：1) 不超过12个字；2) 不要使用标点符号或引号；3) 直接输出标题文字，不要加\"标题:\"等前缀；4) 用主题词概括问题核心。"
            },
            { "role": "user", "content": user_message }
        ],
        // Title generation is cheap — keep the reply short and deterministic.
        "max_tokens": 30,
        "temperature": 0.3,
        "stream": false,
    });

    let client = http_client::ai_client();
    let mut req = client.post(&url).json(&body);
    if !cfg.api_key.is_empty() {
        req = req.bearer_auth(&cfg.api_key);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("标题生成请求失败：{e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("标题生成失败 (HTTP {status})：{body}"));
    }

    let parsed: ChatCompletionResponse = resp
        .json()
        .await
        .map_err(|e| format!("解析标题响应失败：{e}"))?;

    let title = parsed
        .choices
        .into_iter()
        .next()
        .and_then(|c| c.message)
        .and_then(|m| m.content)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "标题响应为空".to_string())?;

    // Sanitise: strip wrapping quotes/backticks the model sometimes adds,
    // collapse internal whitespace, and clamp to a reasonable length so a
    // runaway model can't produce a paragraph.
    let cleaned = title
        .trim_matches(|c: char| {
            c == '"' || c == '\'' || c == '`' || c == '「' || c == '」' || c.is_whitespace()
        })
        .replace(['\n', '\r'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let clamped = if cleaned.chars().count() > 24 {
        cleaned.chars().take(24).collect::<String>()
    } else {
        cleaned
    };
    Ok(clamped)
}
