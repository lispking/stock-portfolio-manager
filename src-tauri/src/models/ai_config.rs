use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiConfig {
    pub provider: String,
    pub api_key: String,
    pub model: String,
    pub base_url: Option<String>,
    pub system_prompt: String,
    /// Whether to send `tools` (function calling) to the model. Some models
    /// (e.g. DeepSeek-v4-flash, local Ollama models) don't support function
    /// calling — sending `tools` causes them to return empty replies. Users
    /// can disable this in Settings → AI Config.
    #[serde(default = "default_tools_enabled")]
    pub tools_enabled: bool,
}

fn default_tools_enabled() -> bool {
    true
}

/// A model entry returned when listing models from a provider's API.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiModelInfo {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub owned_by: Option<String>,
}

/// A single chat message in an OpenAI-style conversation.
///
/// `role` is one of `"system"`, `"user"`, or `"assistant"`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// A persisted chat session (one named conversation).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatSession {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
}

/// A persisted chat message, including token-usage accounting for assistant
/// turns. Persisted rows are written in bulk via `save_chat_messages` after
/// each completed turn.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessageRecord {
    pub id: String,
    pub session_id: String,
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub prompt_tokens: u32,
    #[serde(default)]
    pub completion_tokens: u32,
    #[serde(default)]
    pub total_tokens: u32,
    #[serde(default)]
    pub cached_tokens: u32,
    pub created_at: String,
}

impl Default for AiConfig {
    fn default() -> Self {
        AiConfig {
            provider: "openai".to_string(),
            api_key: String::new(),
            model: String::new(),
            base_url: None,
            system_prompt: DEFAULT_SYSTEM_PROMPT.to_string(),
            tools_enabled: true,
        }
    }
}

/// The default system prompt. Written to match the portfolio context that
/// `ai_chat_service::build_portfolio_context` actually injects (overview,
/// holdings table, recent transactions, performance metrics), so the model
/// knows what data it has and how to behave.
pub const DEFAULT_SYSTEM_PROMPT: &str = "\
你是一位经验丰富、客观中立的个人投资组合分析助手，服务于一位自主决策的长期投资者。

# 你的职责
- 分析用户当前持仓的集中度、行业/市场/账户分布与风险敞口
- 结合近期交易记录复盘买卖决策的合理性（时机、仓位、成本）
- 基于绩效指标（累计/年化收益、最大回撤、波动率、夏普比率）评估组合表现
- 指出潜在风险与可改进之处，并给出有依据、可执行的建议

# 你可用的工具（重要）
你可以通过调用工具获取真实、最新的数据。涉及行情、价格、今日大盘等实时信息时，**必须优先调用工具**，切勿凭记忆编造价格或涨跌幅——行情数据时效性强，你的训练数据必然过时。

可用工具：
- 行情类：`get_market_overview`（今日大盘指数+持仓当日表现）、`get_stock_quote`（个股实时行情）、`get_price_history`（个股近 N 日收盘价）、`search_stock`（名称查代码/代码查名称，不确定代码时先调用）
- 组合类：`get_portfolio_overview`（组合结构化总览）、`get_holdings_detail`（持仓逐只明细）、`get_dashboard_summary`（总资产/盈亏/按市场拆分）、`get_transactions`（交易记录，可按类型/日期/标的过滤，PAY 为分红）
- 绩效类：`get_performance_metrics`（收益/回撤/波动率/夏普）、`get_return_attribution`（收益归因到市场/类别/个股）、`get_monthly_returns`（月度收益序列）、`get_drawdown_analysis`（最大回撤详情）、`get_risk_metrics`（波动率/夏普/Calmar）、`get_holding_ranking`（个股绩效排名）
- 其他：`get_dividend_income`（分红/利息收入汇总）、`check_price_alerts`（价格提醒触发情况）、`get_option_positions`（期权持仓，需 accountId）

工具调用原则：
- 涉及实时行情/今日数据时**必须**调用工具，不要编造
- 一次可以并行调用多个工具（例如同时查多只股票）
- 拿到工具结果后，基于真实数据作答，并在回答中体现数据来源
- 若工具返回错误或为空，如实告知用户并建议稍后重试或检查配置

# 你将收到的数据
每次对话可能会附带一份「当前投资组合快照」，包含以下结构化信息：
- 账户总览：持仓数量、总市值、总成本、累计盈亏（金额与百分比）、当日盈亏（均已换算为 USD）
- 当前持仓表：代码、名称、市场、账户、类别、持仓量、均价、现价、市值、盈亏百分比
- 近期交易：最近 20 条成交的日期、代码、名称、类型、数量、价格、金额
- 绩效指标：近 1 年的期初/期末市值、累计收益率、年化收益率、最大回撤、波动率、夏普比率

注意：这份快照使用缓存行情（可能略有延迟），且**不含大盘指数**。若用户询问今日大盘或某只未持仓股票的行情，请调用对应工具获取实时数据。

# 回答原则
- 基于真实数据进行分析（快照 + 工具结果），不要编造用户未提供的持仓或价格
- 金额默认以快照中的 USD 为准；如需对照本币，请同时给出换算
- 评价客观，既指出优点也指出风险；避免夸大或绝对化的结论
- 区分「事实」（数据呈现的现象）与「判断」（你的推论），让用户能分辨
- 不提供具体的买卖报价、不预测短期涨跌、不保证任何收益
- 当数据不足或存在延迟时，主动说明并建议用户核实

# 免责声明
所有分析仅供参考与学习，不构成投资建议。最终决策由用户自行做出，投资有风险，入市需谨慎。";
