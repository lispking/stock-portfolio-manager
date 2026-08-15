use serde::{Deserialize, Serialize};

/// Per-account dividend total within one market.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountDividend {
    pub account_id: String,
    pub account_name: String,
    pub total: f64,
}

/// One company's dividend across accounts within a single market.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DividendRow {
    pub symbol: String,
    pub name: String,
    /// Per-account amounts keyed by account_id (0.0 if that account has none).
    pub per_account: Vec<(String, f64)>,
    pub total: f64,
}

/// Dividend summary for one market (CN / US / HK), in that market's native
/// currency (CNY / USD / HKD).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketDividend {
    pub market: String,
    pub currency: String,
    pub accounts: Vec<AccountDividend>,
    pub rows: Vec<DividendRow>,
    pub total: f64,
}

/// Annual dividend analysis: per-market tables (row = company, column =
/// account) plus a grand total across markets (native currencies, not
/// converted — the frontend converts using its exchange-rate store).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DividendAnalysis {
    pub year: i32,
    pub markets: Vec<MarketDividend>,
    /// Sum of each market's native-currency total. Not a single-currency
    /// figure; the frontend sums converted values for the displayed total.
    pub grand_total: f64,
}
