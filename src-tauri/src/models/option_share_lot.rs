use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OptionShareLot {
    pub id: i64,
    pub stock_code: String,
    pub shares_per_contract: i64,
    pub created_at: String,
}
