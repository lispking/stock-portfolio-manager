/// Parse a 同花顺 (THS) trade-history Excel export and return structured rows
/// so the frontend can review them before confirming the import.
///
/// The command receives the raw file bytes encoded as a Base64 string.  The
/// Rust layer decodes them, opens the workbook with calamine (supports both
/// .xls and .xlsx), and maps the well-known THS column names to our internal
/// `ThsExcelRow` struct.
///
/// Commission aggregation rule (per the feature spec):
///     total_commission = 手续费 + 印花税 + 附加费 + 过户费
///
/// Transaction-type rule:
///     发生金额 < 0  →  BUY   (money left the account)
///     发生金额 > 0  →  SELL  (money entered the account)
///
/// Symbol formatting:
///     交易所名称 contains "上海" → "SH" prefix, e.g. SH600036
///     交易所名称 contains "深圳" → "SZ" prefix, e.g. SZ000001
///
/// Date/time:
///     成交日期 is an 8-digit string like "20260430".
///     成交时间 is a time string like "14:13:09".
///     Combined → "2026-04-30T14:13:09".
use serde::{Deserialize, Serialize};

/// A single parsed row returned to the frontend.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ThsExcelRow {
    /// "BUY" or "SELL"
    pub transaction_type: String,
    /// Stock code with exchange prefix, e.g. "SH600036"
    pub symbol: String,
    /// Stock name, e.g. "招商银行"
    pub stock_name: String,
    /// ISO-8601 datetime string, e.g. "2026-04-30T14:13:09"
    pub traded_at: String,
    /// Trade price
    pub price: f64,
    /// Number of shares traded (positive)
    pub shares: f64,
    /// Trade amount = price × shares (positive)
    pub total_amount: f64,
    /// Aggregated commission = 手续费 + 印花税 + 附加费 + 过户费
    pub commission: f64,
    /// Exchange name as-is from the file, e.g. "上海A股"
    pub exchange: String,
}

#[tauri::command(rename_all = "camelCase")]
pub fn parse_ths_excel(file_base64: String) -> Result<Vec<ThsExcelRow>, String> {
    use base64::Engine;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&file_base64)
        .map_err(|e| format!("Base64 decode error: {e}"))?;

    // Try xlsx first, fall back to xls
    let rows = parse_xlsx(&bytes).or_else(|_| parse_xls(&bytes))?;
    Ok(rows)
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn parse_xlsx(bytes: &[u8]) -> Result<Vec<ThsExcelRow>, String> {
    use calamine::{open_workbook_from_rs, Reader, Xlsx};
    use std::io::Cursor;

    let cursor = Cursor::new(bytes);
    let mut wb: Xlsx<_> =
        open_workbook_from_rs(cursor).map_err(|e| format!("xlsx open error: {e}"))?;

    let sheet_name = wb
        .sheet_names()
        .first()
        .cloned()
        .ok_or("No sheets in workbook")?;

    let range = wb
        .worksheet_range(&sheet_name)
        .map_err(|e| format!("worksheet_range error: {e}"))?;

    extract_rows_from_range(range)
}

fn parse_xls(bytes: &[u8]) -> Result<Vec<ThsExcelRow>, String> {
    use calamine::{open_workbook_from_rs, Reader, Xls};
    use std::io::Cursor;

    let cursor = Cursor::new(bytes);
    let mut wb: Xls<_> =
        open_workbook_from_rs(cursor).map_err(|e| format!("xls open error: {e}"))?;

    let sheet_name = wb
        .sheet_names()
        .first()
        .cloned()
        .ok_or("No sheets in workbook")?;

    let range = wb
        .worksheet_range(&sheet_name)
        .map_err(|e| format!("worksheet_range error: {e}"))?;

    extract_rows_from_range(range)
}

fn cell_str(cell: &calamine::Data) -> String {
    use calamine::Data;
    match cell {
        Data::String(s) => s.clone(),
        Data::Float(f) => {
            // Numbers stored as floats (e.g. date 20260430.0)
            if f.fract() == 0.0 && f.abs() < 1e15 {
                format!("{}", *f as i64)
            } else {
                format!("{f}")
            }
        }
        Data::Int(i) => format!("{i}"),
        Data::Bool(b) => format!("{b}"),
        Data::Error(_) => String::new(),
        Data::Empty => String::new(),
        _ => String::new(),
    }
}

fn cell_f64(cell: &calamine::Data) -> f64 {
    use calamine::Data;
    match cell {
        Data::Float(f) => *f,
        Data::Int(i) => *i as f64,
        Data::String(s) => s.trim().replace(',', "").parse::<f64>().unwrap_or(0.0),
        _ => 0.0,
    }
}

fn extract_rows_from_range(
    range: calamine::Range<calamine::Data>,
) -> Result<Vec<ThsExcelRow>, String> {
    let mut rows_iter = range.rows();

    // Locate the header row: first row whose cells contain "证券代码"
    let header_row: Vec<String> = loop {
        let row = rows_iter
            .next()
            .ok_or("Header row with '证券代码' not found")?;
        let cells: Vec<String> = row.iter().map(cell_str).collect();
        if cells.iter().any(|c| c.contains("证券代码")) {
            break cells;
        }
    };

    // Build column-index lookup by name
    let col = |name: &str| -> Option<usize> {
        header_row.iter().position(|h| h.trim() == name)
    };

    let i_trade_time = col("成交时间");
    let i_trade_date = col("成交日期").or_else(|| col("交易日期"));
    let i_code = col("证券代码");
    let i_name = col("证券名称");
    let i_happen_amt = col("发生金额");
    let i_shares = col("成交数量");
    let i_price = col("成交价格");
    let i_amount = col("成交金额");
    let i_commission = col("手续费");
    let i_stamp = col("印花税");
    let i_extra = col("附加费");
    let i_transfer = col("过户费");
    let i_exchange = col("交易所名称");

    // At minimum we need code and shares
    let i_code = i_code.ok_or("Column '证券代码' not found")?;
    let i_shares = i_shares.ok_or("Column '成交数量' not found")?;

    let mut result: Vec<ThsExcelRow> = Vec::new();

    for raw_row in rows_iter {
        let get = |idx: Option<usize>| -> &calamine::Data {
            idx.and_then(|i| raw_row.get(i))
                .unwrap_or(&calamine::Data::Empty)
        };

        let code_str = cell_str(get(Some(i_code)));
        let code_str = code_str.trim().to_string();
        if code_str.is_empty() {
            continue;
        }
        // Skip rows that look like sub-totals or non-stock rows (code must be
        // 6 digits for A-shares)
        if !code_str.chars().all(|c| c.is_ascii_digit()) || code_str.len() != 6 {
            continue;
        }

        let shares_raw = cell_f64(get(Some(i_shares)));
        let shares = shares_raw.abs();
        if shares == 0.0 {
            continue;
        }

        let price = i_price.map(|i| cell_f64(raw_row.get(i).unwrap_or(&calamine::Data::Empty))).unwrap_or(0.0);
        let trade_amount = i_amount.map(|i| cell_f64(raw_row.get(i).unwrap_or(&calamine::Data::Empty))).unwrap_or(0.0);
        let total_amount = if trade_amount != 0.0 {
            trade_amount.abs()
        } else {
            (price * shares * 100.0).round() / 100.0
        };

        // Commission = sum of four fee columns
        let commission = {
            let c = cell_f64(get(i_commission));
            let s = cell_f64(get(i_stamp));
            let e = cell_f64(get(i_extra));
            let t = cell_f64(get(i_transfer));
            ((c.abs() + s.abs() + e.abs() + t.abs()) * 100.0).round() / 100.0
        };

        // Transaction type from 发生金额
        let happen_amt = cell_f64(get(i_happen_amt));
        let transaction_type = if happen_amt < 0.0 {
            "BUY".to_string()
        } else {
            "SELL".to_string()
        };

        // Exchange name → symbol prefix
        let exchange = cell_str(get(i_exchange));
        let prefix = if exchange.contains("上海") || exchange.contains("SH") {
            "SH"
        } else if exchange.contains("深圳") || exchange.contains("SZ") {
            "SZ"
        } else {
            // Heuristic: Shanghai A-shares start with 6; Shenzhen start with 0 or 3
            if code_str.starts_with('6') { "SH" } else { "SZ" }
        };
        let symbol = format!("{}{}", prefix, code_str);

        // Stock name
        let stock_name = cell_str(get(i_name));
        let stock_name = stock_name.trim().to_string();

        // Date + time
        let date_str = cell_str(get(i_trade_date));
        let date_str = date_str.trim().to_string();
        let time_str = cell_str(get(i_trade_time));
        let time_str = time_str.trim().to_string();
        let traded_at = build_datetime(&date_str, &time_str);

        result.push(ThsExcelRow {
            transaction_type,
            symbol,
            stock_name,
            traded_at,
            price,
            shares,
            total_amount,
            commission,
            exchange,
        });
    }

    if result.is_empty() {
        return Err("未从 Excel 中识别到有效的成交记录，请确认文件为同花顺导出的历史成交 Excel".to_string());
    }

    Ok(result)
}

/// Build an ISO-8601 datetime string from a THS date string (e.g. "20260430")
/// and time string (e.g. "14:13:09" or "141309").
fn build_datetime(date_str: &str, time_str: &str) -> String {
    // Normalize date: "20260430" → "2026-04-30"
    let date_part = if date_str.len() == 8 && date_str.chars().all(|c| c.is_ascii_digit()) {
        format!("{}-{}-{}", &date_str[0..4], &date_str[4..6], &date_str[6..8])
    } else {
        date_str.to_string()
    };

    // Normalize time: "141309" → "14:13:09", or pass through "14:13:09" as-is
    let time_part = if time_str.len() == 6 && time_str.chars().all(|c| c.is_ascii_digit()) {
        format!("{}:{}:{}", &time_str[0..2], &time_str[2..4], &time_str[4..6])
    } else if time_str.is_empty() {
        "09:30:00".to_string()
    } else {
        time_str.to_string()
    };

    format!("{}T{}", date_part, time_part)
}
