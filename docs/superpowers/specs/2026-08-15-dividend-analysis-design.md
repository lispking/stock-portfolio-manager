# 分红分析 功能设计

日期：2026-08-15
状态：已确认

## 背景

分红对价值投资来说是重要的现金流。用户希望在应用中以表格形式查看年度分红：行 = 公司，列 = 该市场下的各证券账户 + 合计，三个市场（CN/US/HK）各一张表。默认当前年份，可下拉选择往年。

## 决策

- **位置**：侧边栏独立菜单「分红分析」（与绩效分析、季度分析并列）
- **年度选择**：年份下拉，默认当前年份，列出有分红记录的年份
- **币种**：每张市场表格用该市场本位币（CN=¥ / US=$ / HK=HK$）
- **净额**：分红金额 = `total_amount - commission`（交易记录 PAY 类型）
- **总计区**：独立总计区，显示三个市场分红总计，**货币单位可选择**（复用前端现有汇率 store 换算）

## 架构

- **数据源**：交易记录中 `transaction_type = 'PAY'`（分红）的记录，无需新录入
- **后端**：新增 `get_dividend_analysis(year)` 命令，按市场分组、按 (symbol, account) 透视成矩阵，**返回各市场本位币原始金额**（不做汇率换算）
- **前端**：新页面 `Dividends`，用 `useExchangeRateStore` 的 `convertWithCachedRates` 把各市场小计换算到所选币种，求和得总计（与统计分析口径一致，避免后端重复实现汇率逻辑）

## 组件/数据流

### 后端

新增 `src-tauri/src/commands/dividends.rs`：

```
get_dividend_analysis(year: i32) -> DividendAnalysis
```

```rust
struct DividendAnalysis {
    year: i32,
    markets: Vec<MarketDividend>,   // CN / US / HK（只含有分红的市场）
    grand_total: f64,               // 各市场本位币合计（跨币种，仅参考，前端会换算）
}

struct MarketDividend {
    market: String,                 // "CN" / "US" / "HK"
    currency: String,               // "CNY" / "USD" / "HKD"
    accounts: Vec<AccountDividend>, // 该市场的账户（名称 + 总额）
    rows: Vec<DividendRow>,         // 行 = 公司
    total: f64,                     // 该市场本位币合计
}

struct AccountDividend {
    account_id: String,
    account_name: String,
    total: f64,
}

struct DividendRow {
    symbol: String,
    name: String,
    per_account: Vec<(account_id, f64)>,  // 各账户分红
    total: f64,                            // 该公司该市场合计
}
```

聚合 SQL：

```sql
SELECT t.market, t.symbol, t.name, t.account_id, a.name,
       SUM(t.total_amount - t.commission)
FROM transactions t
JOIN accounts a ON t.account_id = a.id
WHERE t.transaction_type = 'PAY'
  AND strftime('%Y', t.traded_at) = ?
GROUP BY t.market, t.symbol, t.name, t.account_id, a.name
ORDER BY t.market, SUM(t.total_amount - t.commission) DESC
```

在 Rust 中透视成 `MarketDividend`（账户列表 = 该市场出现过的账户，rows 每行含 per_account 映射）。

注册命令到 `lib.rs`；模型加到 `src-tauri/src/models/mod.rs`（或 dividends.rs 内定义 + serde 序列化）。

### 前端

新页面 `src/pages/Dividends/index.tsx`：

1. **工具条**：年份 Select（默认当前年）+ 总计币种 Select（USD/CNY/HKD，默认 CNY，复用 `useExchangeRateStore`）
2. **年度合计概览（4 卡片）**：
   - 本年度分红总计（所选币种，三市场换算后求和）
   - 三市场小计（各本位币 + 折合所选币种）
3. **三张分红表格**（按市场分，各自本位币）：
   - 行 = 公司（代码 + 名称），列 = 该市场各账户 + 合计
   - 底部合计行 = 各账户列汇总 + 公司合计
   - 无分红显示 0.00
4. **独立总计区**：三市场分红总计，按所选币种换算后求和

路由：`/dividends`（App.tsx）；侧边栏菜单：「分红分析」（MainLayout.tsx）。

## 边缘情况

- 无分红记录的年份不显示在年份下拉中
- 某市场无分红 → 隐藏该表
- 账户在当年无分红 → 该列显示 0.00
- 跨市场总计用前端 `convertWithCachedRates` 换算（与统计分析口径一致）

## 测试

- **后端**：`dividends.rs` 单测——构造多账户多市场的 PAY 记录，验证按市场/账户/公司透视正确、净额计算正确、年份过滤正确
- **前端**：构建通过 + 手动验证
