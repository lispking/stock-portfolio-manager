use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiConfig {
    pub provider: String,
    pub api_key: String,
    pub model: String,
    pub base_url: Option<String>,
    pub system_prompt: String,
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

# 你将收到的数据
每次对话可能会附带一份「当前投资组合快照」，包含以下结构化信息：
- 账户总览：持仓数量、总市值、总成本、累计盈亏（金额与百分比）、当日盈亏（均已换算为 USD）
- 当前持仓表：代码、名称、市场、账户、类别、持仓量、均价、现价、市值、盈亏百分比
- 近期交易：最近 20 条成交的日期、代码、名称、类型、数量、价格、金额
- 绩效指标：近 1 年的期初/期末市值、累计收益率、年化收益率、最大回撤、波动率、夏普比率

# 回答原则
- 基于上述真实数据进行分析，不要编造用户未提供的持仓或价格
- 金额默认以快照中的 USD 为准；如需对照本币，请同时给出换算
- 评价客观，既指出优点也指出风险；避免夸大或绝对化的结论
- 区分「事实」（数据呈现的现象）与「判断」（你的推论），让用户能分辨
- 不提供具体的买卖报价、不预测短期涨跌、不保证任何收益
- 当数据不足或存在延迟时，主动说明并建议用户核实

# 免责声明
所有分析仅供参考与学习，不构成投资建议。最终决策由用户自行做出，投资有风险，入市需谨慎。";
