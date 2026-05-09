//! Standalone utility: normalize_hk_symbols
//!
//! 用途：将数据库所有表中港股（市场 = HK）的股票代码统一去掉前导零。
//!       例如 0998.HK → 998.HK，0941.HK → 941.HK。
//!
//! 涉及的表：
//!   - holdings                  (symbol, market)
//!   - transactions              (symbol, market)
//!   - daily_holding_snapshots   (symbol, market)
//!   - quarterly_holding_snapshots (symbol, market)
//!   - price_alerts              (symbol, market)
//!   - benchmark_daily_prices    (symbol，无 market 列，按 %.HK 匹配)
//!   - cached_quotes             (symbol 为主键，需要删除旧行，插入新行)
//!
//! 用法：
//!   cargo run -- <数据库路径> [--dry-run]
//!
//! 选项：
//!   --dry-run   仅打印将要执行的操作，不写入数据库。

use rusqlite::{params, Connection};

/// Strip leading zeros from an HK symbol, e.g. "0998.HK" → "998.HK".
/// Returns None if the symbol does not need normalization.
fn normalize_hk_symbol(symbol: &str) -> Option<String> {
    let suffix = ".HK";
    if !symbol.ends_with(suffix) {
        return None;
    }
    let code = &symbol[..symbol.len() - suffix.len()];
    // Remove leading zeros; keep at least one digit.
    let normalized_code = code.trim_start_matches('0').max("0");
    let normalized = format!("{}{}", normalized_code, suffix);
    if normalized == symbol {
        None // already normalized
    } else {
        Some(normalized)
    }
}

struct TableSpec {
    /// Table name
    table: &'static str,
    /// Column name that holds the symbol
    symbol_col: &'static str,
    /// Optional market column name; if Some, the WHERE clause also filters by market='HK'
    market_col: Option<&'static str>,
    /// Whether symbol is the PRIMARY KEY (requires DELETE+INSERT instead of UPDATE)
    symbol_is_pk: bool,
}

/// Row data for the `cached_quotes` table (needed for DELETE + re-INSERT on PRIMARY KEY rename).
struct CachedQuoteRow {
    name: String,
    market: String,
    current_price: f64,
    previous_close: f64,
    change: f64,
    change_percent: f64,
    high: f64,
    low: f64,
    volume: i64,
    updated_at: String,
}

const TABLES: &[TableSpec] = &[
    TableSpec {
        table: "holdings",
        symbol_col: "symbol",
        market_col: Some("market"),
        symbol_is_pk: false,
    },
    TableSpec {
        table: "transactions",
        symbol_col: "symbol",
        market_col: Some("market"),
        symbol_is_pk: false,
    },
    TableSpec {
        table: "daily_holding_snapshots",
        symbol_col: "symbol",
        market_col: Some("market"),
        symbol_is_pk: false,
    },
    TableSpec {
        table: "quarterly_holding_snapshots",
        symbol_col: "symbol",
        market_col: Some("market"),
        symbol_is_pk: false,
    },
    TableSpec {
        table: "price_alerts",
        symbol_col: "symbol",
        market_col: Some("market"),
        symbol_is_pk: false,
    },
    TableSpec {
        table: "benchmark_daily_prices",
        symbol_col: "symbol",
        market_col: None, // no market column; match by %.HK suffix
        symbol_is_pk: false,
    },
    TableSpec {
        table: "cached_quotes",
        symbol_col: "symbol",
        market_col: Some("market"),
        symbol_is_pk: true, // PRIMARY KEY — must DELETE + re-INSERT
    },
];

fn main() {
    let args: Vec<String> = std::env::args().collect();

    let mut db_path: Option<String> = None;
    let mut dry_run = false;
    let mut extra_paths = false;

    for arg in args.iter().skip(1) {
        match arg.as_str() {
            "--dry-run" => dry_run = true,
            path => {
                if db_path.is_some() {
                    extra_paths = true;
                }
                db_path = Some(path.to_string());
            }
        }
    }

    if extra_paths {
        eprintln!("错误：提供了多个数据库路径，请只指定一个。");
        std::process::exit(1);
    }

    let db_path = db_path.unwrap_or_else(|| {
        eprintln!("用法: normalize_hk_symbols <数据库路径> [--dry-run]");
        eprintln!();
        eprintln!("  --dry-run   仅预览将要执行的操作，不写入数据库");
        eprintln!();
        eprintln!("示例:");
        eprintln!("  cargo run -- ~/Library/Application\\ Support/com.stock-portfolio-manager.app/portfolio.db");
        eprintln!("  cargo run -- ~/portfolio.db --dry-run");
        std::process::exit(1);
    });

    if dry_run {
        println!("=== DRY-RUN 模式（不写入数据库）===\n");
    }

    let conn = Connection::open(&db_path).unwrap_or_else(|e| {
        eprintln!("无法打开数据库 {}: {}", db_path, e);
        std::process::exit(1);
    });

    let mut total_updated = 0u64;
    let mut total_skipped = 0u64;

    for spec in TABLES {
        // Check whether the table exists (some databases may be older versions).
        let exists: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                params![spec.table],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0)
            > 0;

        if !exists {
            println!("[跳过] 表 {} 不存在，忽略。", spec.table);
            continue;
        }

        // Build query to find HK symbols with leading zeros.
        let where_clause = match spec.market_col {
            Some(mc) => format!(
                "{mc} = 'HK' AND {sc} LIKE '0%.HK'",
                mc = mc,
                sc = spec.symbol_col
            ),
            None => format!("{sc} LIKE '0%.HK'", sc = spec.symbol_col),
        };

        let query = format!(
            "SELECT DISTINCT {sc} FROM {t} WHERE {w}",
            sc = spec.symbol_col,
            t = spec.table,
            w = where_clause
        );

        let affected_symbols: Vec<String> = {
            let mut stmt = conn.prepare(&query).unwrap_or_else(|e| {
                eprintln!("准备查询失败 [{}]: {}", spec.table, e);
                std::process::exit(1);
            });
            stmt.query_map([], |row| row.get::<_, String>(0))
                .unwrap_or_else(|e| {
                    eprintln!("查询失败 [{}]: {}", spec.table, e);
                    std::process::exit(1);
                })
                .filter_map(|r| r.ok())
                .collect()
        };

        if affected_symbols.is_empty() {
            println!("[{}] 无需处理（没有带前导零的港股代码）", spec.table);
            total_skipped += 1;
            continue;
        }

        for old_sym in &affected_symbols {
            let new_sym = match normalize_hk_symbol(old_sym) {
                Some(s) => s,
                None => {
                    println!("[{}] {} 已规范化，跳过", spec.table, old_sym);
                    total_skipped += 1;
                    continue;
                }
            };

            if dry_run {
                if spec.symbol_is_pk {
                    println!(
                        "[预览] 表 {}: {} → {} （主键：将删除旧行并插入新行）",
                        spec.table, old_sym, new_sym
                    );
                } else {
                    println!(
                        "[预览] 表 {}: {} → {}",
                        spec.table, old_sym, new_sym
                    );
                }
                total_updated += 1;
                continue;
            }

            if spec.symbol_is_pk {
                // For PRIMARY KEY columns we cannot UPDATE directly.
                // Strategy: copy the row(s) with the new symbol (INSERT OR REPLACE),
                // then delete the old row(s).
                //
                // cached_quotes schema:
                //   symbol TEXT PRIMARY KEY, name, market, current_price,
                //   previous_close, change, change_percent, high, low, volume, updated_at
                let rows: Vec<CachedQuoteRow> = {
                    let mut stmt = conn
                        .prepare(
                            "SELECT name, market, current_price, previous_close, \
                             change, change_percent, high, low, volume, updated_at \
                             FROM cached_quotes WHERE symbol = ?1",
                        )
                        .unwrap_or_else(|e| {
                            eprintln!("准备查询失败 [cached_quotes]: {}", e);
                            std::process::exit(1);
                        });
                    stmt.query_map(params![old_sym], |row| {
                        Ok(CachedQuoteRow {
                            name: row.get(0)?,
                            market: row.get(1)?,
                            current_price: row.get(2)?,
                            previous_close: row.get(3)?,
                            change: row.get(4)?,
                            change_percent: row.get(5)?,
                            high: row.get(6)?,
                            low: row.get(7)?,
                            volume: row.get(8)?,
                            updated_at: row.get(9)?,
                        })
                    })
                    .unwrap_or_else(|e| {
                        eprintln!("查询失败 [cached_quotes] {}: {}", old_sym, e);
                        std::process::exit(1);
                    })
                    .filter_map(|r| r.ok())
                    .collect()
                };

                for r in &rows {
                    conn.execute(
                        "INSERT OR REPLACE INTO cached_quotes \
                         (symbol, name, market, current_price, previous_close, \
                          change, change_percent, high, low, volume, updated_at) \
                         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
                        params![
                            new_sym, r.name, r.market, r.current_price, r.previous_close,
                            r.change, r.change_percent, r.high, r.low, r.volume, r.updated_at
                        ],
                    )
                    .unwrap_or_else(|e| {
                        eprintln!("插入失败 [{}] {} → {}: {}", spec.table, old_sym, new_sym, e);
                        0
                    });
                }

                conn.execute(
                    &format!("DELETE FROM {} WHERE {} = ?1", spec.table, spec.symbol_col),
                    params![old_sym],
                )
                .unwrap_or_else(|e| {
                    eprintln!("删除失败 [{}] {}: {}", spec.table, old_sym, e);
                    0
                });

                println!("[更新] 表 {}: {} → {} （主键替换）", spec.table, old_sym, new_sym);
            } else {
                let update_sql = format!(
                    "UPDATE {t} SET {sc} = ?1 WHERE {sc} = ?2{market_filter}",
                    t = spec.table,
                    sc = spec.symbol_col,
                    market_filter = match spec.market_col {
                        Some(mc) => format!(" AND {} = 'HK'", mc),
                        None => String::new(),
                    }
                );

                let rows_changed = conn
                    .execute(&update_sql, params![new_sym, old_sym])
                    .unwrap_or_else(|e| {
                        eprintln!("更新失败 [{}] {} → {}: {}", spec.table, old_sym, new_sym, e);
                        0
                    });

                println!(
                    "[更新] 表 {}: {} → {} （影响 {} 行）",
                    spec.table, old_sym, new_sym, rows_changed
                );
            }

            total_updated += 1;
        }
    }

    println!();
    println!("=== 汇总 ===");
    if dry_run {
        println!("将更新（预览）: {}", total_updated);
        println!("无需处理:       {}", total_skipped);
        println!();
        println!("以上为预览结果。去掉 --dry-run 参数后再次运行即可写入数据库。");
    } else {
        println!("已更新: {}", total_updated);
        println!("跳过:   {}", total_skipped);
    }
}

#[cfg(test)]
mod tests {
    use super::normalize_hk_symbol;

    #[test]
    fn test_normalize_hk_symbol() {
        assert_eq!(normalize_hk_symbol("0998.HK"), Some("998.HK".to_string()));
        assert_eq!(normalize_hk_symbol("00941.HK"), Some("941.HK".to_string()));
        assert_eq!(normalize_hk_symbol("0700.HK"), Some("700.HK".to_string()));
        assert_eq!(normalize_hk_symbol("00001.HK"), Some("1.HK".to_string()));
        // Already normalized — should return None
        assert_eq!(normalize_hk_symbol("998.HK"), None);
        assert_eq!(normalize_hk_symbol("941.HK"), None);
        // Non-HK symbols — should return None
        assert_eq!(normalize_hk_symbol("SH600036"), None);
        assert_eq!(normalize_hk_symbol("AAPL"), None);
    }
}
