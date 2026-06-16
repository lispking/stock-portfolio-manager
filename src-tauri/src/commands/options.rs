use crate::db::Database;
use crate::models::option::{
    CallContractSimulation, ExpiredOptionStats, OptionContract, OptionRecord,
    PutContractSimulation, SellCallSimulation, SellPutSimulation,
};
use tauri::State;

/// Parse the option symbol like "PDD 20FEB26 100 P" into components.
/// Returns (underlying, expiry_date, strike_price, option_type)
fn parse_option_symbol(symbol: &str) -> Result<(String, String, f64, String), String> {
    let parts: Vec<&str> = symbol.trim().split_whitespace().collect();
    if parts.len() < 4 {
        return Err(format!("Invalid option symbol: {}", symbol));
    }
    let underlying = parts[0].to_string();
    let expiry_date = parts[1].to_string();
    let strike_price: f64 = parts[2]
        .parse()
        .map_err(|_| format!("Invalid strike price in: {}", symbol))?;
    let option_type = parts[3].to_string();
    if option_type != "P" && option_type != "C" {
        return Err(format!("Invalid option type '{}' in: {}", option_type, symbol));
    }
    Ok((underlying, expiry_date, strike_price, option_type))
}

/// Import option records from CSV content.
/// CSV columns: 账户, 股票, 交易时间, 交割时间, 交易所, 操作, 股票数量, 价格, 金额, 佣金, 费用, 类型, 代码
#[tauri::command(rename_all = "camelCase")]
pub fn import_options_csv(
    db: State<Database>,
    account_id: String,
    csv_content: String,
) -> Result<ImportOptionsResult, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    // Strip UTF-8 BOM if present
    let content = csv_content.strip_prefix('\u{feff}').unwrap_or(&csv_content);

    let mut reader = csv::ReaderBuilder::new()
        .has_headers(true)
        .flexible(true)
        .from_reader(content.as_bytes());

    let headers = reader
        .headers()
        .map_err(|e| format!("Failed to read CSV headers: {}", e))?
        .clone();

    let mut imported = 0;
    let mut skipped = 0;
    let mut errors: Vec<String> = Vec::new();

    for (i, result) in reader.records().enumerate() {
        let record = match result {
            Ok(r) => r,
            Err(e) => {
                errors.push(format!("Row {}: {}", i + 2, e));
                continue;
            }
        };

        // Skip "Total" summary rows
        let first_field = record.get(0).unwrap_or("").trim();
        if first_field.starts_with("Total") || first_field.is_empty() {
            skipped += 1;
            continue;
        }

        // Get the option symbol (column index 1: 股票)
        let option_symbol = match get_field(
            &record,
            &headers,
            &["股票", "股票代码", "合约", "期权", "期权代码", "symbol", "Symbol"],
        ) {
            Some(s) if !s.is_empty() => s,
            _ => {
                skipped += 1;
                continue;
            }
        };

        // Parse option symbol
        let (underlying, expiry_date, strike_price, option_type) =
            match parse_option_symbol(&option_symbol) {
                Ok(v) => v,
                Err(e) => {
                    errors.push(format!("Row {}: {}", i + 2, e));
                    continue;
                }
            };

        // Parse other fields
        let action_raw = get_field(&record, &headers, &["操作", "买/卖", "买卖", "action", "Action"])
            .unwrap_or_default();
        let action = normalize_action(&action_raw);
        if action.is_empty() {
            errors.push(format!("Row {}: invalid action '{}'", i + 2, action_raw));
            continue;
        }

        let code = get_field(&record, &headers, &["代码", "code", "Code"]).unwrap_or_default();
        let quantity_str = get_field(
            &record,
            &headers,
            &["股票数量", "数量", "合约数量", "合约数", "quantity", "Quantity"],
        )
        .unwrap_or_default();
        let quantity: i64 = parse_quantity(&quantity_str);

        if quantity == 0 {
            skipped += 1;
            continue;
        }

        let price: f64 = get_field(&record, &headers, &["价格", "price", "Price"])
            .unwrap_or_default()
            .replace(',', "")
            .parse()
            .unwrap_or(0.0);

        let amount: f64 = get_field(&record, &headers, &["金额", "amount", "Amount"])
            .unwrap_or_default()
            .replace(',', "")
            .parse()
            .unwrap_or(0.0);

        let commission: f64 = get_field(&record, &headers, &["佣金", "commission", "Commission"])
            .unwrap_or_default()
            .replace(',', "")
            .parse()
            .unwrap_or(0.0);

        let fee: f64 = get_field(&record, &headers, &["费用", "fee", "Fee"])
            .unwrap_or_default()
            .replace(',', "")
            .parse()
            .unwrap_or(0.0);

        let traded_at =
            get_field(&record, &headers, &["交易时间", "traded_at", "Trade Date"]);
        let settled_at =
            get_field(&record, &headers, &["交割时间", "settled_at", "Settle Date"]);

        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();

        conn.execute(
            "INSERT INTO option_records (id, account_id, option_symbol, underlying, expiry_date, strike_price, option_type, action, code, quantity, price, amount, commission, fee, traded_at, settled_at, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
            rusqlite::params![
                id,
                account_id,
                option_symbol,
                underlying,
                expiry_date,
                strike_price,
                option_type,
                action,
                code,
                quantity,
                price,
                amount,
                commission,
                fee,
                traded_at,
                settled_at,
                now,
            ],
        )
        .map_err(|e| format!("Row {}: {}", i + 2, e))?;

        imported += 1;
    }

    Ok(ImportOptionsResult {
        imported,
        skipped,
        errors,
    })
}

/// Get all option contracts for an account, paired by option_symbol
#[tauri::command(rename_all = "camelCase")]
pub fn get_option_contracts(
    db: State<Database>,
    account_id: String,
) -> Result<Vec<OptionContract>, String> {
    get_option_contracts_inner(&db, &account_id)
}

/// Get statistics for expired options
#[tauri::command(rename_all = "camelCase")]
pub fn get_expired_option_stats(
    db: State<Database>,
    account_id: String,
) -> Result<ExpiredOptionStats, String> {
    let contracts = get_option_contracts_inner(&db, &account_id)?;

    let expired: Vec<&OptionContract> = contracts.iter().filter(|c| c.status == "expired").collect();
    let total = expired.len() as i64;
    let assigned = expired
        .iter()
        .filter(|c| c.close_code.as_deref() == Some("A;C"))
        .count() as i64;
    let expired_count = expired
        .iter()
        .filter(|c| c.close_code.as_deref() == Some("C;Ep"))
        .count() as i64;

    let ratio = if total > 0 {
        assigned as f64 / total as f64
    } else {
        0.0
    };

    Ok(ExpiredOptionStats {
        total_contracts: total,
        assigned_contracts: assigned,
        expired_contracts: expired_count,
        assignment_ratio: ratio,
    })
}

/// Simulate sell put assignments given stock prices
#[tauri::command(rename_all = "camelCase")]
pub fn simulate_sell_put(
    db: State<Database>,
    account_id: String,
    stock_prices: Vec<StockPriceInput>,
) -> Result<Vec<SellPutSimulation>, String> {
    let contracts = get_option_contracts_inner(&db, &account_id)?;

    let active_puts: Vec<&OptionContract> = contracts
        .iter()
        .filter(|c| c.status == "active" && c.option_type == "P")
        .collect();

    // Group by underlying
    let mut grouped: std::collections::HashMap<String, Vec<&OptionContract>> =
        std::collections::HashMap::new();
    for contract in &active_puts {
        grouped
            .entry(contract.underlying.clone())
            .or_default()
            .push(contract);
    }

    let price_map: std::collections::HashMap<String, f64> = stock_prices
        .into_iter()
        .map(|sp| (sp.symbol.to_uppercase(), sp.price))
        .collect();

    let mut results: Vec<SellPutSimulation> = Vec::new();

    for (underlying, puts) in &grouped {
        let stock_price = price_map.get(&underlying.to_uppercase()).copied();

        let mut sim_contracts: Vec<PutContractSimulation> = Vec::new();
        let mut total_cash = 0.0;

        for put in puts {
            let would_be_assigned = match stock_price {
                Some(price) => price < put.strike_price,
                None => false,
            };
            let cash_needed = if would_be_assigned {
                put.strike_price * put.contracts as f64 * 100.0
            } else {
                0.0
            };
            total_cash += cash_needed;

            sim_contracts.push(PutContractSimulation {
                option_symbol: put.option_symbol.clone(),
                strike_price: put.strike_price,
                contracts: put.contracts,
                would_be_assigned,
                cash_needed,
            });
        }

        results.push(SellPutSimulation {
            underlying: underlying.clone(),
            contracts: sim_contracts,
            total_cash_needed: total_cash,
        });
    }

    results.sort_by(|a, b| a.underlying.cmp(&b.underlying));
    Ok(results)
}

/// Simulate sell call assignments given stock prices
#[tauri::command(rename_all = "camelCase")]
pub fn simulate_sell_call(
    db: State<Database>,
    account_id: String,
    stock_prices: Vec<StockPriceInput>,
) -> Result<Vec<SellCallSimulation>, String> {
    let contracts = get_option_contracts_inner(&db, &account_id)?;

    let active_calls: Vec<&OptionContract> = contracts
        .iter()
        .filter(|c| c.status == "active" && c.option_type == "C")
        .collect();

    let mut grouped: std::collections::HashMap<String, Vec<&OptionContract>> =
        std::collections::HashMap::new();
    for contract in &active_calls {
        grouped
            .entry(contract.underlying.clone())
            .or_default()
            .push(contract);
    }

    let price_map: std::collections::HashMap<String, f64> = stock_prices
        .into_iter()
        .map(|sp| (sp.symbol.to_uppercase(), sp.price))
        .collect();

    let mut results: Vec<SellCallSimulation> = Vec::new();

    for (underlying, calls) in &grouped {
        let stock_price = price_map.get(&underlying.to_uppercase()).copied();

        let mut sim_contracts: Vec<CallContractSimulation> = Vec::new();
        let mut total_shares: i64 = 0;

        for call in calls {
            let would_be_assigned = match stock_price {
                Some(price) => price > call.strike_price,
                None => false,
            };
            let shares_needed = if would_be_assigned {
                call.contracts * 100
            } else {
                0
            };
            total_shares += shares_needed;

            sim_contracts.push(CallContractSimulation {
                option_symbol: call.option_symbol.clone(),
                strike_price: call.strike_price,
                contracts: call.contracts,
                would_be_assigned,
                shares_needed,
            });
        }

        results.push(SellCallSimulation {
            underlying: underlying.clone(),
            contracts: sim_contracts,
            total_shares_needed: total_shares,
        });
    }

    results.sort_by(|a, b| a.underlying.cmp(&b.underlying));
    Ok(results)
}

/// Delete all option records for an account
#[tauri::command(rename_all = "camelCase")]
pub fn delete_option_records(
    db: State<Database>,
    account_id: String,
) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM option_records WHERE account_id = ?1",
        rusqlite::params![account_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// --- Helper types and functions ---

#[derive(Debug, serde::Deserialize)]
pub struct StockPriceInput {
    pub symbol: String,
    pub price: f64,
}

#[derive(Debug, serde::Serialize)]
pub struct ImportOptionsResult {
    pub imported: usize,
    pub skipped: usize,
    pub errors: Vec<String>,
}

/// Normalize action value to "SELL" or "BUY", supporting Chinese and English variants
fn normalize_action(raw: &str) -> String {
    let s = raw.trim().to_uppercase();
    match s.as_str() {
        "SELL" | "卖" | "卖出" | "卖开" | "卖平" => "SELL".to_string(),
        "BUY" | "买" | "买入" | "买开" | "买平" => "BUY".to_string(),
        _ => {
            // Check if the raw value contains Chinese sell/buy characters
            let raw_trimmed = raw.trim();
            if raw_trimmed.contains('卖') {
                "SELL".to_string()
            } else if raw_trimmed.contains('买') {
                "BUY".to_string()
            } else {
                String::new()
            }
        }
    }
}

/// Parse quantity string to number of contracts.
/// If the absolute value is >= 100 and divisible by 100, treat as shares and divide by 100.
/// Otherwise treat as contracts directly.
fn parse_quantity(s: &str) -> i64 {
    let val = s
        .replace(',', "")
        .parse::<f64>()
        .map(|v| v.abs() as i64)
        .unwrap_or(0);
    if val >= 100 && val % 100 == 0 {
        val / 100
    } else {
        val
    }
}

/// Helper to get field by trying multiple header names
fn get_field(
    record: &csv::StringRecord,
    headers: &csv::StringRecord,
    names: &[&str],
) -> Option<String> {
    for name in names {
        if let Some(idx) = headers.iter().position(|h| h.trim() == *name) {
            if let Some(val) = record.get(idx) {
                let trimmed = val.trim().to_string();
                if !trimmed.is_empty() {
                    return Some(trimmed);
                }
            }
        }
    }
    None
}

/// Internal helper that doesn't require State wrapper
fn get_option_contracts_inner(
    db: &Database,
    account_id: &str,
) -> Result<Vec<OptionContract>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT id, account_id, option_symbol, underlying, expiry_date, strike_price, option_type, action, code, quantity, price, amount, commission, fee, traded_at, settled_at, created_at
             FROM option_records WHERE account_id = ?1
             ORDER BY option_symbol, traded_at",
        )
        .map_err(|e| e.to_string())?;

    let records: Vec<OptionRecord> = stmt
        .query_map(rusqlite::params![account_id], |row| {
            Ok(OptionRecord {
                id: row.get(0)?,
                account_id: row.get(1)?,
                option_symbol: row.get(2)?,
                underlying: row.get(3)?,
                expiry_date: row.get(4)?,
                strike_price: row.get(5)?,
                option_type: row.get(6)?,
                action: row.get(7)?,
                code: row.get(8)?,
                quantity: row.get(9)?,
                price: row.get(10)?,
                amount: row.get(11)?,
                commission: row.get(12)?,
                fee: row.get(13)?,
                traded_at: row.get(14)?,
                settled_at: row.get(15)?,
                created_at: row.get(16)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let mut contracts: Vec<OptionContract> = Vec::new();
    let mut grouped: std::collections::HashMap<String, Vec<OptionRecord>> =
        std::collections::HashMap::new();

    for record in records {
        grouped
            .entry(record.option_symbol.clone())
            .or_default()
            .push(record);
    }

    for (symbol, recs) in &grouped {
        let open_rec = recs.iter().find(|r| r.action == "SELL" && r.code == "O");
        let close_rec = recs
            .iter()
            .find(|r| r.action == "BUY" && (r.code == "C;Ep" || r.code == "A;C"));

        if let Some(open) = open_rec {
            let status = if close_rec.is_some() {
                "expired".to_string()
            } else {
                "active".to_string()
            };

            contracts.push(OptionContract {
                option_symbol: symbol.clone(),
                underlying: open.underlying.clone(),
                expiry_date: open.expiry_date.clone(),
                strike_price: open.strike_price,
                option_type: open.option_type.clone(),
                contracts: open.quantity,
                open_price: open.price,
                open_amount: open.amount,
                close_price: close_rec.map(|r| r.price),
                close_code: close_rec.map(|r| r.code.clone()),
                status,
                account_id: open.account_id.clone(),
            });
        }
    }

    contracts.sort_by(|a, b| {
        a.status
            .cmp(&b.status)
            .then(a.underlying.cmp(&b.underlying))
            .then(a.expiry_date.cmp(&b.expiry_date))
    });

    Ok(contracts)
}
