use crate::db::Database;
use crate::models::Transaction;
use crate::services::quote_provider_service::market_adjusts_sell_pay_cost;
use crate::services::quote_service::{cash_display_name, CASH_SYMBOL_PREFIX};
use tauri::State;

fn validate_transaction_shares(
    market: &str,
    shares: f64,
    transaction_type: &str,
) -> Result<(), String> {
    // PAY (dividend) transactions don't require a positive share count
    if transaction_type == "PAY" {
        return Ok(());
    }
    if !shares.is_finite() || shares <= 0.0 {
        return Err("Transaction shares must be a positive number".to_string());
    }
    if market != "US" && shares.fract().abs() > 1e-9 {
        return Err("Only US transactions support fractional shares; CN and HK transactions must use whole shares".to_string());
    }
    Ok(())
}

/// Compute the cash delta for a transaction.
/// BUY  → cash decreases by total_amount + commission (money leaves the account).
/// SELL → cash increases by total_amount - commission (money enters the account).
/// PAY  → cash increases by total_amount - commission (dividend net of fees).
/// OPEN → no cash impact (initial position entry, not a real trade).
/// Panics if `transaction_type` is not `"BUY"`, `"SELL"`, `"PAY"`, or `"OPEN"`.
pub(crate) fn cash_delta(transaction_type: &str, total_amount: f64, commission: f64) -> f64 {
    match transaction_type {
        "BUY" => -(total_amount + commission),
        "SELL" => total_amount - commission,
        "PAY" => total_amount - commission,
        "OPEN" => 0.0,
        other => panic!("Unexpected transaction_type for cash_delta: {}", other),
    }
}

/// Find or create the cash holding for the given account and currency,
/// then adjust its `shares` (i.e. cash balance) by `delta`.
/// `conn` must already be inside a SQLite transaction.
pub(crate) fn adjust_cash_holding(
    conn: &rusqlite::Connection,
    account_id: &str,
    currency: &str,
    market: &str,
    delta: f64,
) -> Result<(), String> {
    let cash_symbol = format!("{}{}", CASH_SYMBOL_PREFIX, currency);

    let existing: Option<(String, f64)> = conn
        .query_row(
            "SELECT id, shares FROM holdings WHERE account_id = ?1 AND symbol = ?2",
            rusqlite::params![account_id, cash_symbol],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok();

    let updated_at = chrono::Utc::now().to_rfc3339();

    if let Some((cash_id, current_shares)) = existing {
        let new_shares = current_shares + delta;
        conn.execute(
            "UPDATE holdings SET shares = ?2, updated_at = ?3 WHERE id = ?1",
            rusqlite::params![cash_id, new_shares, updated_at],
        )
        .map_err(|e| e.to_string())?;
    } else {
        // Cash holding does not exist yet – create it
        let cash_id = uuid::Uuid::new_v4().to_string();
        let cash_name = cash_display_name(&cash_symbol);
        conn.execute(
            "INSERT INTO holdings (id, account_id, symbol, name, market, category_id, shares, avg_cost, currency, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, 1.0, ?7, ?8, ?9)",
            rusqlite::params![
                cash_id, account_id, cash_symbol, cash_name, market,
                delta, currency, updated_at, updated_at
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
#[allow(clippy::too_many_arguments)]
pub fn create_transaction(
    db: State<Database>,
    account_id: String,
    symbol: String,
    name: String,
    market: String,
    transaction_type: String,
    shares: f64,
    price: f64,
    total_amount: f64,
    commission: f64,
    currency: String,
    traded_at: String,
    notes: Option<String>,
) -> Result<Transaction, String> {
    validate_transaction_shares(&market, shares, &transaction_type)?;

    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    // Wrap the entire operation in a SQLite transaction for atomicity
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| e.to_string())?;

    let result = (|| -> Result<(Option<String>,), String> {
        // Find existing holding for this symbol/account (case-insensitive)
        let mut holding_id: Option<String> = conn
            .query_row(
                "SELECT id FROM holdings WHERE account_id = ?1 AND UPPER(symbol) = UPPER(?2)",
                rusqlite::params![account_id, symbol],
                |row| row.get(0),
            )
            .ok();

        // For a BUY with no existing holding, create a new one.
        if holding_id.is_none() && transaction_type == "BUY" {
            let new_hid = uuid::Uuid::new_v4().to_string();
            let created_at = chrono::Utc::now().to_rfc3339();
            conn.execute(
                "INSERT INTO holdings (id, account_id, symbol, name, market, category_id, shares, avg_cost, currency, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, NULL, 0.0, 0.0, ?6, ?7, ?8)",
                rusqlite::params![new_hid, account_id, symbol, name, market, currency, created_at, created_at],
            )
            .map_err(|e| e.to_string())?;
            holding_id = Some(new_hid);
        }

        // Update holding shares and avg_cost based on transaction type.
        if let Some(ref hid) = holding_id {
            let (current_shares, current_avg_cost): (f64, f64) = conn
                .query_row(
                    "SELECT shares, avg_cost FROM holdings WHERE id = ?1",
                    rusqlite::params![hid],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(|e| e.to_string())?;

            // Guard against selling more shares than currently held
            if transaction_type == "SELL" && shares > current_shares {
                return Err(format!(
                    "Cannot sell {} shares of {}: only {} shares held",
                    shares, symbol, current_shares
                ));
            }

            let adjust = market_adjusts_sell_pay_cost(&conn, &market);

            let (new_shares, new_avg_cost) = if transaction_type == "BUY" {
                let total_shares = current_shares + shares;
                let new_avg = if total_shares > 0.0 {
                    (current_shares * current_avg_cost + shares * price + commission) / total_shares
                } else {
                    price
                };
                (total_shares, new_avg)
            } else if transaction_type == "PAY" {
                // Dividend: shares unchanged.  Net dividend = total_amount - commission
                // (the commission/fee is deducted from the gross dividend).
                // Adjust avg_cost only when the market setting is enabled.
                let net_amount = total_amount - commission;
                let new_avg = if adjust && current_shares > 0.0 {
                    (current_shares * current_avg_cost - net_amount) / current_shares
                } else {
                    current_avg_cost
                };
                (current_shares, new_avg)
            } else {
                // SELL: shares always decrease.
                // Adjust avg_cost (net cost method) only when the market setting is enabled.
                // The commission paid on a sale is a trading cost, so net proceeds are
                // total_amount - commission. The remaining cost basis is reduced by net proceeds.
                let remaining = current_shares - shares;
                let new_avg = if adjust {
                    if remaining > 0.0 {
                        (current_shares * current_avg_cost - total_amount + commission) / remaining
                    } else {
                        0.0
                    }
                } else {
                    current_avg_cost
                };
                (remaining, new_avg)
            };

            let updated_at = chrono::Utc::now().to_rfc3339();
            conn.execute(
                "UPDATE holdings SET shares = ?2, avg_cost = ?3, updated_at = ?4 WHERE id = ?1",
                rusqlite::params![hid, new_shares, new_avg_cost, updated_at],
            )
            .map_err(|e| e.to_string())?;
        }

        conn.execute(
            "INSERT INTO transactions (id, holding_id, account_id, symbol, name, market, transaction_type, shares, price, total_amount, commission, currency, traded_at, notes, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            rusqlite::params![
                id, holding_id, account_id, symbol, name, market,
                transaction_type, shares, price, total_amount, commission,
                currency, traded_at, notes, now
            ],
        )
        .map_err(|e| e.to_string())?;

        // Auto-update cash holding for the account
        let delta = cash_delta(&transaction_type, total_amount, commission);
        adjust_cash_holding(&conn, &account_id, &currency, &market, delta)?;

        Ok((holding_id,))
    })();

    // Commit or rollback based on result
    match result {
        Ok((holding_id,)) => {
            conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
            let _ = holding_id; // used below
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(e);
        }
    }

    // Re-fetch holding_id for the response (after commit)
    let holding_id: Option<String> = conn
        .query_row(
            "SELECT id FROM holdings WHERE account_id = ?1 AND UPPER(symbol) = UPPER(?2)",
            rusqlite::params![account_id, symbol],
            |row| row.get(0),
        )
        .ok();

    Ok(Transaction {
        id,
        holding_id,
        account_id,
        symbol,
        name,
        market,
        transaction_type,
        shares,
        price,
        total_amount,
        commission,
        currency,
        traded_at,
        notes,
        created_at: now,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn get_transactions(
    db: State<Database>,
    account_id: Option<String>,
    symbol: Option<String>,
) -> Result<Vec<Transaction>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    let base_query = "SELECT id, holding_id, account_id, symbol, name, market, transaction_type,
                      shares, price, total_amount, commission, currency, traded_at, notes, created_at
                      FROM transactions";

    let transactions = match (account_id, symbol) {
        (Some(aid), Some(sym)) => {
            let query = format!(
                "{} WHERE account_id = ?1 AND UPPER(symbol) = UPPER(?2) ORDER BY traded_at DESC",
                base_query
            );
            let mut stmt = conn.prepare(&query).map_err(|e| e.to_string())?;
            let result = stmt
                .query_map(rusqlite::params![aid, sym], map_transaction)
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            result
        }
        (Some(aid), None) => {
            let query = format!(
                "{} WHERE account_id = ?1 ORDER BY traded_at DESC",
                base_query
            );
            let mut stmt = conn.prepare(&query).map_err(|e| e.to_string())?;
            let result = stmt
                .query_map(rusqlite::params![aid], map_transaction)
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            result
        }
        (None, Some(sym)) => {
            let query = format!(
                "{} WHERE UPPER(symbol) = UPPER(?1) ORDER BY traded_at DESC",
                base_query
            );
            let mut stmt = conn.prepare(&query).map_err(|e| e.to_string())?;
            let result = stmt
                .query_map(rusqlite::params![sym], map_transaction)
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            result
        }
        (None, None) => {
            let query = format!("{} ORDER BY traded_at DESC", base_query);
            let mut stmt = conn.prepare(&query).map_err(|e| e.to_string())?;
            let result = stmt
                .query_map([], map_transaction)
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            result
        }
    };

    Ok(transactions)
}

fn map_transaction(row: &rusqlite::Row<'_>) -> rusqlite::Result<Transaction> {
    Ok(Transaction {
        id: row.get(0)?,
        holding_id: row.get(1)?,
        account_id: row.get(2)?,
        symbol: row.get(3)?,
        name: row.get(4)?,
        market: row.get(5)?,
        transaction_type: row.get(6)?,
        shares: row.get(7)?,
        price: row.get(8)?,
        total_amount: row.get(9)?,
        commission: row.get(10)?,
        currency: row.get(11)?,
        traded_at: row.get(12)?,
        notes: row.get(13)?,
        created_at: row.get(14)?,
    })
}

/// Flexible transaction query for the AI tools layer. Filters are all
/// optional and combined with AND; results are newest-first, capped at `limit`
/// (default 50, max 200) so a tool call can't dump the entire history into the
/// model's context.
///
/// `tx_type` is matched case-insensitively against `transaction_type`
/// (BUY/SELL/OPEN/PAY). `days` restricts to the last N days (traded_at >= now
/// minus days). This is a plain `&Database` function (no Tauri State) so it can
/// be called from `ai_tools::execute_tool` directly.
pub fn query_transactions_inner(
    db: &Database,
    account_id: Option<&str>,
    symbol: Option<&str>,
    tx_type: Option<&str>,
    days: Option<i64>,
    limit: Option<usize>,
) -> Result<Vec<Transaction>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut sql = String::from(
        "SELECT id, holding_id, account_id, symbol, name, market, transaction_type,
                shares, price, total_amount, commission, currency, traded_at, notes, created_at
         FROM transactions WHERE 1=1",
    );
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    if let Some(aid) = account_id {
        sql.push_str(" AND account_id = ?");
        params.push(Box::new(aid.to_string()));
    }
    if let Some(sym) = symbol {
        sql.push_str(" AND UPPER(symbol) = UPPER(?)");
        params.push(Box::new(sym.to_string()));
    }
    if let Some(t) = tx_type {
        sql.push_str(" AND UPPER(transaction_type) = UPPER(?)");
        params.push(Box::new(t.to_string()));
    }
    if let Some(d) = days {
        sql.push_str(" AND traded_at >= ?");
        let cutoff = chrono::Utc::now() - chrono::Duration::days(d);
        params.push(Box::new(cutoff.to_rfc3339()));
    }
    sql.push_str(" ORDER BY traded_at DESC LIMIT ?");
    let cap = limit.unwrap_or(50).min(200);
    params.push(Box::new(cap as i64));

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let param_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    let rows = stmt
        .query_map(param_refs.as_slice(), map_transaction)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command(rename_all = "camelCase")]
#[allow(clippy::too_many_arguments)]
pub fn update_transaction(
    db: State<Database>,
    id: String,
    account_id: String,
    symbol: String,
    name: String,
    market: String,
    transaction_type: String,
    shares: f64,
    price: f64,
    total_amount: f64,
    commission: f64,
    currency: String,
    traded_at: String,
    notes: Option<String>,
) -> Result<Transaction, String> {
    validate_transaction_shares(&market, shares, &transaction_type)?;

    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    // Fetch the original transaction to reverse holding impact
    let old_txn: Transaction = conn
        .query_row(
            "SELECT id, holding_id, account_id, symbol, name, market, transaction_type, shares, price, total_amount, commission, currency, traded_at, notes, created_at FROM transactions WHERE id = ?1",
            rusqlite::params![id],
            map_transaction,
        )
        .map_err(|e| format!("Transaction not found: {}", e))?;

    if old_txn.transaction_type == "OPEN" {
        return Err("Cannot edit the initial position-opening record".to_string());
    }

    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| e.to_string())?;

    let result = (|| -> Result<Option<String>, String> {
        // 1) Reverse the old transaction's impact on its holding.
        if let Some(ref old_hid) = old_txn.holding_id {
            let (cur_shares, cur_avg_cost): (f64, f64) = conn
                .query_row(
                    "SELECT shares, avg_cost FROM holdings WHERE id = ?1",
                    rusqlite::params![old_hid],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(|e| e.to_string())?;

            let old_adjust = market_adjusts_sell_pay_cost(&conn, &old_txn.market);

            let (rev_shares, rev_avg_cost) = if old_txn.transaction_type == "BUY" {
                // Reverse a BUY: subtract shares and remove the commission that was
                // added to the cost basis when this buy was recorded.
                let new_shares = cur_shares - old_txn.shares;
                let new_avg = if new_shares > 0.0 {
                    let total_cost = cur_shares * cur_avg_cost
                        - old_txn.shares * old_txn.price
                        - old_txn.commission;
                    total_cost / new_shares
                } else {
                    0.0
                };
                (new_shares, new_avg)
            } else if old_txn.transaction_type == "PAY" {
                // Reverse a dividend: add back net dividend to cost basis
                // only if the market setting was enabled.
                let old_net = old_txn.total_amount - old_txn.commission;
                let rev_avg = if old_adjust && cur_shares > 0.0 {
                    (cur_shares * cur_avg_cost + old_net) / cur_shares
                } else {
                    cur_avg_cost
                };
                (cur_shares, rev_avg)
            } else {
                // Reverse a SELL: add shares back.
                // Undo the net-cost adjustment only if the market setting is enabled.
                // Forward SELL reduced cost by (total_amount - commission), so
                // reversal adds back (total_amount - commission).
                let new_shares = cur_shares + old_txn.shares;
                let rev_avg = if old_adjust && new_shares > 0.0 {
                    (cur_shares * cur_avg_cost + old_txn.total_amount - old_txn.commission)
                        / new_shares
                } else {
                    cur_avg_cost
                };
                (new_shares, rev_avg)
            };

            let updated_at = chrono::Utc::now().to_rfc3339();
            conn.execute(
                "UPDATE holdings SET shares = ?2, avg_cost = ?3, updated_at = ?4 WHERE id = ?1",
                rusqlite::params![old_hid, rev_shares, rev_avg_cost, updated_at],
            )
            .map_err(|e| e.to_string())?;
        }

        // Reverse the old transaction's cash impact
        let old_cash_delta = cash_delta(
            &old_txn.transaction_type,
            old_txn.total_amount,
            old_txn.commission,
        );
        adjust_cash_holding(
            &conn,
            &old_txn.account_id,
            &old_txn.currency,
            &old_txn.market,
            -old_cash_delta,
        )?;

        // 2) Apply the new transaction's impact on its holding.
        let holding_id: Option<String> = conn
            .query_row(
                "SELECT id FROM holdings WHERE account_id = ?1 AND UPPER(symbol) = UPPER(?2)",
                rusqlite::params![account_id, symbol],
                |row| row.get(0),
            )
            .ok();

        if let Some(ref hid) = holding_id {
            let (cur_shares, cur_avg_cost): (f64, f64) = conn
                .query_row(
                    "SELECT shares, avg_cost FROM holdings WHERE id = ?1",
                    rusqlite::params![hid],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(|e| e.to_string())?;

            if transaction_type == "SELL" && shares > cur_shares {
                return Err(format!(
                    "Cannot sell {} shares of {}: only {} shares held",
                    shares, symbol, cur_shares
                ));
            }

            let adjust = market_adjusts_sell_pay_cost(&conn, &market);

            let (new_shares, new_avg_cost) = if transaction_type == "BUY" {
                let total_shares = cur_shares + shares;
                let new_avg = if total_shares > 0.0 {
                    (cur_shares * cur_avg_cost + shares * price + commission) / total_shares
                } else {
                    price
                };
                (total_shares, new_avg)
            } else if transaction_type == "PAY" {
                // Dividend: shares unchanged.  Net = total_amount - commission.
                let net_amount = total_amount - commission;
                let new_avg = if adjust && cur_shares > 0.0 {
                    (cur_shares * cur_avg_cost - net_amount) / cur_shares
                } else {
                    cur_avg_cost
                };
                (cur_shares, new_avg)
            } else {
                // SELL: shares always decrease.
                // Adjust avg_cost (net cost method) only when the market setting is enabled.
                // Net proceeds = total_amount - commission; remaining cost is reduced by net proceeds.
                let remaining = cur_shares - shares;
                let new_avg = if adjust {
                    if remaining > 0.0 {
                        (cur_shares * cur_avg_cost - total_amount + commission) / remaining
                    } else {
                        0.0
                    }
                } else {
                    cur_avg_cost
                };
                (remaining, new_avg)
            };

            let updated_at = chrono::Utc::now().to_rfc3339();
            conn.execute(
                "UPDATE holdings SET shares = ?2, avg_cost = ?3, updated_at = ?4 WHERE id = ?1",
                rusqlite::params![hid, new_shares, new_avg_cost, updated_at],
            )
            .map_err(|e| e.to_string())?;
        }

        // Apply the new transaction's cash impact
        let new_cash_delta = cash_delta(&transaction_type, total_amount, commission);
        adjust_cash_holding(&conn, &account_id, &currency, &market, new_cash_delta)?;

        // 3) Update the transaction row
        conn.execute(
            "UPDATE transactions SET holding_id = ?2, account_id = ?3, symbol = ?4, name = ?5, market = ?6, transaction_type = ?7, shares = ?8, price = ?9, total_amount = ?10, commission = ?11, currency = ?12, traded_at = ?13, notes = ?14 WHERE id = ?1",
            rusqlite::params![
                id, holding_id, account_id, symbol, name, market,
                transaction_type, shares, price, total_amount, commission,
                currency, traded_at, notes
            ],
        )
        .map_err(|e| e.to_string())?;

        Ok(holding_id)
    })();

    match result {
        Ok(holding_id) => {
            conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
            Ok(Transaction {
                id,
                holding_id,
                account_id,
                symbol,
                name,
                market,
                transaction_type,
                shares,
                price,
                total_amount,
                commission,
                currency,
                traded_at,
                notes,
                created_at: old_txn.created_at,
            })
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn delete_transaction(db: State<Database>, id: String) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    // Fetch the transaction so we can reverse its cash impact
    let txn: Transaction = conn
        .query_row(
            "SELECT id, holding_id, account_id, symbol, name, market, transaction_type, shares, price, total_amount, commission, currency, traded_at, notes, created_at FROM transactions WHERE id = ?1",
            rusqlite::params![id],
            map_transaction,
        )
        .map_err(|e| format!("Transaction not found: {}", e))?;

    if txn.transaction_type == "OPEN" {
        return Err("Cannot delete the initial position-opening record".to_string());
    }

    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| e.to_string())?;

    let result = (|| -> Result<(), String> {
        conn.execute(
            "DELETE FROM transactions WHERE id = ?1",
            rusqlite::params![id],
        )
        .map_err(|e| e.to_string())?;

        // Reverse holding position impact of the deleted transaction
        if let Some(ref hid) = txn.holding_id {
            let holding_data: Result<(f64, f64), _> = conn.query_row(
                "SELECT shares, avg_cost FROM holdings WHERE id = ?1",
                rusqlite::params![hid],
                |row| Ok((row.get(0)?, row.get(1)?)),
            );
            if let Ok((cur_shares, cur_avg_cost)) = holding_data {
                let adjust = market_adjusts_sell_pay_cost(&conn, &txn.market);
                let (rev_shares, rev_avg_cost) = if txn.transaction_type == "BUY" {
                    // Reverse a BUY: subtract shares and remove the commission that was
                    // added to the cost basis when this buy was recorded.
                    let new_shares = cur_shares - txn.shares;
                    let new_avg = if new_shares > 0.0 {
                        let total_cost =
                            cur_shares * cur_avg_cost - txn.shares * txn.price - txn.commission;
                        total_cost / new_shares
                    } else {
                        0.0
                    };
                    (new_shares, new_avg)
                } else if txn.transaction_type == "PAY" {
                    // Reverse a dividend: add back net dividend to avg_cost only if enabled.
                    let net_amount = txn.total_amount - txn.commission;
                    let rev_avg = if adjust && cur_shares > 0.0 {
                        (cur_shares * cur_avg_cost + net_amount) / cur_shares
                    } else {
                        cur_avg_cost
                    };
                    (cur_shares, rev_avg)
                } else {
                    // Reverse a SELL: add shares back; undo net-cost adjustment only if enabled.
                    // Forward SELL reduced cost by (total_amount - commission), so
                    // reversal adds back (total_amount - commission).
                    let new_shares = cur_shares + txn.shares;
                    let rev_avg = if adjust && new_shares > 0.0 {
                        (cur_shares * cur_avg_cost + txn.total_amount - txn.commission) / new_shares
                    } else {
                        cur_avg_cost
                    };
                    (new_shares, rev_avg)
                };
                let updated_at = chrono::Utc::now().to_rfc3339();
                conn.execute(
                    "UPDATE holdings SET shares = ?2, avg_cost = ?3, updated_at = ?4 WHERE id = ?1",
                    rusqlite::params![hid, rev_shares, rev_avg_cost, updated_at],
                )
                .map_err(|e| e.to_string())?;
            }
        }

        // Reverse cash impact of the deleted transaction
        let delta = cash_delta(&txn.transaction_type, txn.total_amount, txn.commission);
        adjust_cash_holding(&conn, &txn.account_id, &txn.currency, &txn.market, -delta)?;

        Ok(())
    })();

    match result {
        Ok(()) => {
            conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
            Ok(())
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

/// Recalculate `shares` and `avg_cost` for every non-cash holding from scratch
/// by replaying all its transactions in chronological order, honouring the
/// current per-market cost-adjustment settings.
///
/// Call this after changing the per-market SELL/PAY cost-adjustment toggles so
/// that historical positions reflect the new policy.
#[tauri::command(rename_all = "camelCase")]
pub fn recalculate_holdings_cost(db: State<Database>) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;

    // Read per-market settings once.
    let cn_adjust = market_adjusts_sell_pay_cost(&conn, "CN");
    let us_adjust = market_adjusts_sell_pay_cost(&conn, "US");
    let hk_adjust = market_adjusts_sell_pay_cost(&conn, "HK");

    // Fetch all non-cash holdings and their (account_id, symbol) pairs.
    let mut stmt = conn
        .prepare(
            "SELECT id, account_id, symbol, market FROM holdings \
             WHERE symbol NOT LIKE '$CASH-%' \
             ORDER BY id",
        )
        .map_err(|e| e.to_string())?;

    struct HoldingInfo {
        id: String,
        account_id: String,
        symbol: String,
        market: String,
    }

    let all_holdings: Vec<HoldingInfo> = stmt
        .query_map([], |row| {
            Ok(HoldingInfo {
                id: row.get(0)?,
                account_id: row.get(1)?,
                symbol: row.get(2)?,
                market: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e: rusqlite::Error| e.to_string())?;

    let now = chrono::Utc::now().to_rfc3339();

    // Recalculate by (account_id, symbol) group rather than per holding_id.
    // This merges transactions spread across multiple holding rows and picks
    // up orphan transactions with NULL holding_id.
    let mut groups: std::collections::HashMap<(String, String), Vec<&HoldingInfo>> =
        std::collections::HashMap::new();
    for h in &all_holdings {
        groups
            .entry((h.account_id.clone(), h.symbol.clone()))
            .or_default()
            .push(h);
    }

    // Also collect (account_id, symbol) from transactions that have no holding
    // (holding_id IS NULL), so we reconstruct holdings for them too.
    {
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT account_id, symbol, market FROM transactions \
                 WHERE holding_id IS NULL AND symbol NOT LIKE '$CASH-%'",
            )
            .map_err(|e| e.to_string())?;
        let orphan_pairs: Vec<(String, String, String)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e: rusqlite::Error| e.to_string())?;

        for (acct_id, sym, _mkt) in orphan_pairs {
            let key = (acct_id.clone(), sym.clone());
            if !groups.contains_key(&key) {
                // Create a virtual entry so we synthesise a holding for these orphans
                groups.entry(key).or_default();
            }
        }
    }

    // Delete duplicate holdings AFTER recalculating — we keep the first one.
    let mut dupes_to_delete: Vec<String> = Vec::new();

    for ((account_id, symbol), holding_list) in &groups {
        let market = holding_list
            .first()
            .map(|h| h.market.clone())
            .unwrap_or_else(|| "US".to_string());

        let adjust = match market.as_str() {
            "CN" => cn_adjust,
            "US" => us_adjust,
            "HK" => hk_adjust,
            _ => true,
        };

        // Load ALL transactions for this (account_id, symbol), including those
        // with NULL holding_id, oldest first.
        let mut tx_stmt = conn
            .prepare(
                "SELECT transaction_type, shares, price, total_amount, commission \
                 FROM transactions \
                 WHERE account_id = ?1 AND UPPER(symbol) = UPPER(?2) \
                   AND symbol NOT LIKE '$CASH-%' \
                 ORDER BY traded_at ASC, created_at ASC",
            )
            .map_err(|e| e.to_string())?;

        struct TxRow {
            tx_type: String,
            shares: f64,
            price: f64,
            total_amount: f64,
            commission: f64,
        }

        let txs: Vec<TxRow> = tx_stmt
            .query_map(rusqlite::params![account_id, symbol], |row| {
                Ok(TxRow {
                    tx_type: row.get(0)?,
                    shares: row.get(1)?,
                    price: row.get(2)?,
                    total_amount: row.get(3)?,
                    commission: row.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e: rusqlite::Error| e.to_string())?;

        let mut shares: f64 = 0.0;
        let mut avg_cost: f64 = 0.0;

        for tx in &txs {
            match tx.tx_type.as_str() {
                "OPEN" => {
                    shares = tx.shares;
                    avg_cost = tx.price;
                }
                "BUY" => {
                    let new_total = shares + tx.shares;
                    if new_total > 0.0 {
                        avg_cost =
                            (shares * avg_cost + tx.shares * tx.price + tx.commission) / new_total;
                    }
                    shares = new_total;
                }
                "SELL" => {
                    let remaining = shares - tx.shares;
                    if adjust {
                        avg_cost = if remaining > 0.0 {
                            (shares * avg_cost - tx.total_amount + tx.commission) / remaining
                        } else {
                            0.0
                        };
                    }
                    shares = remaining;
                }
                "PAY" if adjust && shares > 0.0 => {
                    let net_amount = tx.total_amount - tx.commission;
                    avg_cost = (shares * avg_cost - net_amount) / shares;
                }
                _ => {}
            }
        }

        // Update/create the primary holding.  Use the first existing holding
        // row if available, otherwise create a new one.
        if let Some(primary) = holding_list.first() {
            conn.execute(
                "UPDATE holdings SET shares = ?2, avg_cost = ?3, updated_at = ?4 WHERE id = ?1",
                rusqlite::params![primary.id, shares, avg_cost, now],
            )
            .map_err(|e| e.to_string())?;

            // Re-link orphan transactions (NULL holding_id) and transactions
            // pointing to duplicate holdings back to the primary holding.
            if holding_list.len() > 1 {
                for dup in &holding_list[1..] {
                    conn.execute(
                        "UPDATE transactions SET holding_id = ?1 WHERE holding_id = ?2",
                        rusqlite::params![primary.id, dup.id],
                    )
                    .map_err(|e| e.to_string())?;
                    dupes_to_delete.push(dup.id.clone());
                }
            }

            // Also fix any NULL-holding_id transactions for this symbol.
            conn.execute(
                "UPDATE transactions SET holding_id = ?1 \
                 WHERE account_id = ?2 AND UPPER(symbol) = UPPER(?3) \
                   AND holding_id IS NULL",
                rusqlite::params![primary.id, account_id, symbol],
            )
            .map_err(|e| e.to_string())?;
        } else if !txs.is_empty() {
            // No holding exists yet but we have transactions — create one.
            let new_id = uuid::Uuid::new_v4().to_string();
            let currency = match market.as_str() {
                "CN" => "CNY",
                "HK" => "HKD",
                _ => "USD",
            };
            // Look up name from any transaction
            let name: String = conn
                .query_row(
                    "SELECT name FROM transactions \
                     WHERE account_id = ?1 AND UPPER(symbol) = UPPER(?2) \
                     ORDER BY traded_at DESC LIMIT 1",
                    rusqlite::params![account_id, symbol],
                    |row| row.get(0),
                )
                .unwrap_or_else(|_| symbol.clone());

            conn.execute(
                "INSERT INTO holdings (id, account_id, symbol, name, market, category_id, \
                 shares, avg_cost, currency, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, ?8, ?9, ?10)",
                rusqlite::params![
                    new_id, account_id, symbol, name, market, shares, avg_cost, currency, now, now
                ],
            )
            .map_err(|e| e.to_string())?;

            // Link orphan transactions to the new holding.
            conn.execute(
                "UPDATE transactions SET holding_id = ?1 \
                 WHERE account_id = ?2 AND UPPER(symbol) = UPPER(?3) \
                   AND holding_id IS NULL",
                rusqlite::params![new_id, account_id, symbol],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    // Clean up duplicate holdings
    for dup_id in &dupes_to_delete {
        let _ = conn.execute(
            "DELETE FROM holdings WHERE id = ?1",
            rusqlite::params![dup_id],
        );
    }

    Ok(())
}
