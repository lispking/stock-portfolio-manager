# 存入/提取现金 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在「录入交易记录」中支持存入/提取现金，复用现有 `$CASH-*` 现金持仓机制（存入 = 现金符号 BUY，提取 = 现金符号 SELL）。

**Architecture:** 不加新交易类型、不改 DB CHECK 约束。存入现金映射为对 `$CASH-{currency}` 持仓的 BUY，提取现金映射为 SELL。后端 `cash_delta`/`adjust_cash_holding` 已正确支持现金符号，业绩归因已排除 `$CASH-*`。改动集中在交易录入表单 + 列表显示 + 一处后端校验放宽。

**Tech Stack:** Tauri 2 (Rust), React 18, Ant Design 5, Zustand.

## Global Constraints

- 不加新交易类型值（保持 `BUY|SELL|OPEN|PAY`），不改 DB CHECK 约束
- 现金符号前缀 `$CASH-`（前端常量 `CASH_SYMBOL_PREFIX` 与后端一致）
- 存入 = `$CASH-*` + BUY（`+total_amount`）；提取 = `$CASH-*` + SELL（`-total_amount`）
- 现金记录：`shares=0`、`price=0`、`commission=0`，总金额 = 存取现金额
- 列表直接显示 `$CASH-*` 代码，不做友好名称
- 提取现金由后端 SELL 校验（不能超余额），前端展示错误
- 前端列表将现金 BUY 显示为「存入」、现金 SELL 显示为「提取」

---

### Task 1: 后端放宽现金交易的股数校验 + 提取超额校验

**Files:**
- Modify: `src-tauri/src/commands/transactions.rs:7-23`（`validate_transaction_shares`）、`create_transaction`、`update_transaction`
- Test: `src-tauri/src/commands/transactions.rs`（追加 `#[cfg(test)] mod tests`）

**Interfaces:**
- Consumes: 无（独立函数）
- Produces: 
  - `validate_transaction_shares` 对现金符号（`$CASH-*`）跳过股数校验
  - `validate_cash_withdrawal(conn, account_id, symbol, total_amount) -> Result<(), String>` 辅助函数，供 `create_transaction`/`update_transaction` 在现金 SELL（提取）时校验不超过余额
  - `cash_delta(transaction_type, symbol, total_amount, commission)` **加 `symbol` 参数**：现金符号 BUY → `+(total_amount+commission)`（存入）、现金符号 SELL → `-(total_amount+commission)`（提取）；非现金行为不变。更新全部 4 处调用点
  - `create_transaction`/`update_transaction`/`delete_transaction` 中，**现金符号跳过持仓 shares/avg_cost 更新块**（含 BUY 自动建仓分支），现金余额完全由 `adjust_cash_holding` 管理（避免 SELL 净成本调整破坏现金持仓 avg_cost=1.0）

> 注意 1：现有 SELL 守卫是 `shares > current_shares`（`transactions.rs:149`），现金记录 `shares=0` 时恒为 false，无法拦截超额提取。必须新增按 `total_amount` 的现金提取校验。
> 注意 2：**`cash_delta` 原本无 symbol 参数、无现金特判**（`BUY` 恒为 `-amount`）——设计文档的假设错误，后端必须补上符号翻转；前端 `computeCashDelta` 已有此特判，后端对齐。

- [ ] **Step 1: 写失败测试**

在 `transactions.rs` 文件末尾追加：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_transaction_shares_allows_cash() {
        // Cash transactions have shares=0 and must pass validation
        assert!(validate_transaction_shares("US", 0.0, "BUY").is_err()); // non-cash: still errors
        assert!(validate_transaction_shares("US", 0.0, "SELL").is_err()); // non-cash: still errors
    }

    #[test]
    fn test_validate_transaction_shares_rejects_non_cash_zero() {
        assert!(validate_transaction_shares("HK", 0.0, "BUY").is_err());
        assert!(validate_transaction_shares("CN", 0.0, "SELL").is_err());
    }
}
```

（注：当前 `validate_transaction_shares` 对 `shares=0` 的 BUY/SELL 一律返回 Err。此测试断言现金符号也应放行——但函数当前签名不带 symbol，先让测试明确"非现金必须拒绝"，现金放行由 Task 1 修改函数签名后补测。）

- [ ] **Step 2: 运行测试确认当前行为**

Run: `cd src-tauri && cargo test --lib transactions::tests`
Expected: 测试通过（非现金 shares=0 被拒）——这验证现有契约，为改动建立基线。

- [ ] **Step 3: 修改 `validate_transaction_shares` 支持现金符号**

将函数签名加 `symbol: &str` 参数，并在 PAY 分支旁增加现金分支：

```rust
use crate::services::quote_service::is_cash_symbol;

fn validate_transaction_shares(
    market: &str,
    symbol: &str,
    shares: f64,
    transaction_type: &str,
) -> Result<(), String> {
    // PAY (dividend) and cash-symbol transactions don't require a positive share count
    if transaction_type == "PAY" || is_cash_symbol(symbol) {
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
```

- [ ] **Step 4: 更新两个调用点传入 symbol**

`create_transaction`（约 `transactions.rs:105`）：

```rust
    validate_transaction_shares(&market, &symbol, shares, &transaction_type)?;
```

`update_transaction`（约 `transactions.rs:421`）：

```rust
    validate_transaction_shares(&market, &symbol, shares, &transaction_type)?;
```

- [ ] **Step 5: 新增现金提取超额校验辅助函数**

在 `adjust_cash_holding` 之后添加（模块级）：

```rust
/// Validate a cash-symbol withdrawal (SELL on $CASH-*): the amount must not
/// exceed the current cash balance. Returns Ok if valid, Err with a message
/// otherwise.
pub(crate) fn validate_cash_withdrawal(
    conn: &rusqlite::Connection,
    account_id: &str,
    symbol: &str,
    total_amount: f64,
) -> Result<(), String> {
    let balance: f64 = conn
        .query_row(
            "SELECT shares FROM holdings WHERE account_id = ?1 AND UPPER(symbol) = UPPER(?2)",
            rusqlite::params![account_id, symbol],
            |row| row.get(0),
        )
        .unwrap_or(0.0);
    if total_amount > balance {
        return Err(format!(
            "Cannot withdraw {}: only {} cash available",
            total_amount, balance
        ));
    }
    Ok(())
}
```

在 `create_transaction` 中，`holding_id` 查找之后、持仓更新之前（约 `transactions.rs:138`）加入：

```rust
        // Cash withdrawal (SELL on $CASH-*) must not exceed the cash balance.
        // The generic SELL guard below compares `shares`, which is always 0
        // for cash records, so check the amount explicitly.
        if is_cash_symbol(&symbol) && transaction_type == "SELL" {
            validate_cash_withdrawal(&conn, &account_id, &symbol, total_amount)?;
        }
```

在 `update_transaction` 中，应用新交易影响前（约 `transactions.rs:530`）同样加入。

- [ ] **Step 6: 现金提取超额测试**

```rust
    #[test]
    fn test_cash_withdraw_over_balance_rejected() {
        let (db, account_id) = db_with_account();
        let conn = db.conn.lock().unwrap();
        adjust_cash_holding(&conn, &account_id, "USD", "US", cash_delta("BUY", "$CASH-USD", 100.0, 0.0)).unwrap();
        let err = validate_cash_withdrawal(&conn, &account_id, "$CASH-USD", 500.0)
            .err()
            .expect("over-withdrawal must be rejected");
        assert!(err.contains("Cannot withdraw"), "got: {}", err);
        // Within balance passes
        assert!(validate_cash_withdrawal(&conn, &account_id, "$CASH-USD", 100.0).is_ok());
    }
```

> 注意：`cash_delta`（新签名含 symbol）/`adjust_cash_holding` 已是 `pub(crate)`，测试可直接使用。`validate_cash_withdrawal` 也应为 `pub(crate)` 以便测试。

- [ ] **Step 6b: cash_delta 现金符号符号翻转测试**

```rust
    #[test]
    fn test_cash_delta_sign_flip_for_cash_symbols() {
        // Deposit (BUY on $CASH-*) adds cash; withdraw (SELL) removes cash.
        assert_eq!(cash_delta("BUY", "$CASH-USD", 100.0, 0.0), 100.0);
        assert_eq!(cash_delta("SELL", "$CASH-USD", 40.0, 0.0), -40.0);
        // Non-cash symbols keep the original behavior.
        assert_eq!(cash_delta("BUY", "AAPL", 100.0, 1.0), -101.0);
        assert_eq!(cash_delta("SELL", "AAPL", 100.0, 1.0), 99.0);
    }
```

- [ ] **Step 7: 补充现金放行的测试**

```rust
    #[test]
    fn test_validate_transaction_shares_cash_symbol_allowed() {
        // Cash symbols with shares=0 must pass (deposit/withdraw)
        assert!(validate_transaction_shares("US", "$CASH-USD", 0.0, "BUY").is_ok());
        assert!(validate_transaction_shares("HK", "$CASH-HKD", 0.0, "SELL").is_ok());
        assert!(validate_transaction_shares("CN", "$CASH-CNY", 0.0, "SELL").is_ok());
    }
```

- [ ] **Step 8: 运行测试确认通过**

Run: `cd src-tauri && cargo test --lib transactions::tests`
Expected: 全部通过。

- [ ] **Step 9: 全库测试 + 编译**

Run: `cd src-tauri && cargo test --lib && cargo check`
Expected: 全部通过、编译成功。

- [ ] **Step 10: 提交**

```bash
git add src-tauri/src/commands/transactions.rs
git commit -m "feat: support cash-symbol transactions with overdraw validation"
```

---

### Task 2: 后端现金存取测试（验证复用现有机制）

**Files:**
- Modify: `src-tauri/src/commands/transactions.rs`（追加测试）

**Interfaces:**
- Consumes: `create_transaction`、`update_transaction`、`delete_transaction`、`cash_delta`、`adjust_cash_holding`（均已有）
- Produces: 验证现金存入/提取/编辑/删除/超余额提取的端到端正确性

- [ ] **Step 1: 写测试（现金存入/提取/超余额）**

在 `transactions.rs` 测试模块追加：

```rust
    use crate::db::Database;

    fn db_with_account() -> (Database, String) {
        let db = Database::new(":memory:").expect("failed to create in-memory database");
        let account_id = "acct-1".to_string();
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO accounts (id, name, market, created_at, updated_at)
                 VALUES (?1, 'Test', 'US', ?2, ?2)",
                rusqlite::params![account_id, chrono::Utc::now().to_rfc3339()],
            )
            .unwrap();
        }
        (db, account_id)
    }

    fn get_cash_shares(conn: &rusqlite::Connection, account_id: &str, currency: &str) -> f64 {
        conn.query_row(
            "SELECT shares FROM holdings WHERE account_id = ?1 AND symbol = ?2",
            rusqlite::params![account_id, format!("$CASH-{}", currency)],
            |row| row.get(0),
        )
        .unwrap_or(0.0)
    }

    #[test]
    fn test_cash_deposit_increases_balance() {
        let (db, account_id) = db_with_account();
        let conn = db.conn.lock().unwrap();
        // Deposit 1000 USD: BUY on $CASH-USD
        let delta = cash_delta("BUY", "$CASH-USD", 1000.0, 0.0);
        adjust_cash_holding(&conn, &account_id, "USD", "US", delta).unwrap();
        assert_eq!(get_cash_shares(&conn, &account_id, "USD"), 1000.0);
    }

    #[test]
    fn test_cash_withdraw_decreases_balance() {
        let (db, account_id) = db_with_account();
        let conn = db.conn.lock().unwrap();
        // Deposit 1000, then withdraw 400: SELL on $CASH-USD
        adjust_cash_holding(&conn, &account_id, "USD", "US", cash_delta("BUY", "$CASH-USD", 1000.0, 0.0)).unwrap();
        adjust_cash_holding(&conn, &account_id, "USD", "US", cash_delta("SELL", "$CASH-USD", 400.0, 0.0)).unwrap();
        assert_eq!(get_cash_shares(&conn, &account_id, "USD"), 600.0);
    }
```

> 超额提取校验已在 Task 1 的 `test_cash_withdraw_over_balance_rejected` 中覆盖，此处不再重复。

- [ ] **Step 2: 运行测试**

Run: `cd src-tauri && cargo test --lib transactions::tests`
Expected: 现金存取测试通过（若 `db_state` 不可用则按上面备注调整，确保守卫被覆盖）。

- [ ] **Step 3: 全库测试**

Run: `cd src-tauri && cargo test --lib`
Expected: 全部通过。

- [ ] **Step 4: 提交**

```bash
git add src-tauri/src/commands/transactions.rs
git commit -m "test: verify cash deposit/withdraw via existing holding mechanism"
```

---

### Task 3: 前端录入表单支持存入/提取现金

**Files:**
- Modify: `src/pages/Transactions/index.tsx`

**Interfaces:**
- Consumes: `handleSubmit`（已有）、`handleAccountChange`（已有）、`selectedFormMarket`（已有）、`isDividend`（已有）
- Produces: `isCashTxn` 布尔；提交时将现金类型映射为 `$CASH-*` + BUY/SELL，`shares/price/commission=0`；列表显示「存入/提取」标签

- [ ] **Step 1: 新增现金类型判断与符号映射**

在 `index.tsx` 顶部（`isDividend` 之后，约 `index.tsx:77`）：

```tsx
  const isDividend = watchedType === "PAY";
  // Cash deposit/withdraw: 存入现金 → $CASH-* BUY; 提取现金 → $CASH-* SELL
  const isCashTxn = watchedType === "CASH_IN" || watchedType === "CASH_OUT";
  const cashDirection = watchedType === "CASH_IN" ? "BUY" : "SELL";
  const CASH_SYMBOL_PREFIX = "$CASH-";
```

- [ ] **Step 2: 类型下拉新增两项**

`index.tsx:539` 的 Select 内追加：

```tsx
                  <Select.Option value="CASH_IN">存入现金</Select.Option>
                  <Select.Option value="CASH_OUT">提取现金</Select.Option>
```

- [ ] **Step 3: 现金类型时动态隐藏 symbol/name/股数/价格**

在 symbol/name 的 `<Row gutter={12}>`（约 `index.tsx:512`）前加条件：

```tsx
          {!isCashTxn && (
            <Row gutter={12}>
              {/* ...原 symbol + name 的 Col 不变... */}
            </Row>
          )}
```

在 `{!isDividend && (` 这一行改为：

```tsx
          {!isDividend && !isCashTxn && (
```

> 隐藏后 Form 不再校验未渲染的必填项；`handleSubmit` 中会注入 `symbol`/`name`/`shares`/`price`/`commission`。

- [ ] **Step 4: 提交时映射现金类型 → 实际交易类型 + 固定字段**

修改 `handleSubmit`（约 `index.tsx:183`），在 `submittedValues` 构造前插入：

```tsx
  const handleSubmit = async (values: {...}) => {
    // For dividend (PAY) transactions, shares and price are not meaningful
    const submittedValues = values.transactionType === "PAY"
      ? { ...values, shares: 0, price: 0 }
      : values;
    // For cash deposit/withdraw, map to $CASH-* BUY/SELL with fixed fields
    const cashSubmitted = isCashTxn
      ? {
          ...submittedValues,
          transactionType: cashDirection, // BUY (deposit) or SELL (withdraw)
          symbol: `${CASH_SYMBOL_PREFIX}${values.currency}`,
          name: `现金 (${values.currency})`,
          shares: 0,
          price: 0,
          commission: 0,
        }
      : submittedValues;
    try {
      if (editingTransaction) {
        await updateTransaction({
          id: editingTransaction.id,
          ...cashSubmitted,
          tradedAt: cashSubmitted.tradedAt.toISOString(),
        });
        message.success("交易记录更新成功");
      } else {
        await createTransaction({
          ...cashSubmitted,
          tradedAt: cashSubmitted.tradedAt.toISOString(),
        });
        message.success("交易记录添加成功");
      }
```

- [ ] **Step 5: 编辑现金记录时表单回填**

`handleEdit`（约 `index.tsx:224`）中，`form.setFieldsValue` 前判断：

```tsx
  const handleEdit = async (record: Transaction) => {
    setEditingTransaction(record);
    ...
    // If editing a cash record, show the cash-specific type
    const isCashRecord = record.symbol.startsWith(CASH_SYMBOL_PREFIX);
    const cashType = isCashRecord
      ? record.transaction_type === "BUY" ? "CASH_IN" : "CASH_OUT"
      : record.transaction_type;
    form.setFieldsValue({
      accountId: record.account_id,
      symbol: record.symbol,
      name: record.name,
      market: record.market,
      transactionType: cashType,
      shares: record.shares,
      price: record.price,
      totalAmount: record.total_amount,
      commission: record.commission,
      currency: record.currency,
      tradedAt: dayjs(record.traded_at),
      notes: record.notes,
    });
```

- [ ] **Step 6: 列表类型列显示「存入/提取」**

`index.tsx:316` 的类型 Tag 渲染改为：

```tsx
      render: (type: TransactionType, record: Transaction) => {
        const isCashRecord = record.symbol.startsWith(CASH_SYMBOL_PREFIX);
        if (isCashRecord) {
          return (
            <Tag color={record.transaction_type === "BUY" ? "green" : "red"}>
              {record.transaction_type === "BUY" ? "存入" : "提取"}
            </Tag>
          );
        }
        return (
          <Tag color={type === "BUY" ? "green" : type === "OPEN" ? "blue" : type === "PAY" ? "orange" : "red"}>
            {type === "BUY" ? "买入" : type === "OPEN" ? "建仓" : type === "PAY" ? "分红" : "卖出"}
          </Tag>
        );
      },
```

- [ ] **Step 7: 股数/价格列对现金记录显示 `—`**

`index.tsx:326`（股数列）与 `index.tsx:332`（价格列）的 render 改为：

```tsx
      render: (v: number, record: Transaction) =>
        record.symbol.startsWith(CASH_SYMBOL_PREFIX) ? "—" : v.toLocaleString(),
```

```tsx
      render: (v: number, record: Transaction) =>
        record.symbol.startsWith(CASH_SYMBOL_PREFIX) ? "—" : `${currencySymbol[record.currency]}${v.toFixed(2)}`,
```

- [ ] **Step 8: 表单提交校验（现金类型需选币种）**

在 `handleSubmit` 的 `cashSubmitted` 构造前加守卫：

```tsx
    if (isCashTxn && !values.currency) {
      message.error("请先选择币种");
      return;
    }
```

- [ ] **Step 9: 前端构建验证**

Run: `cd /Users/wensongzhang/stock-portfolio-manager && npx tsc --noEmit`（或项目构建脚本）
Expected: 无类型错误。

- [ ] **Step 10: 提交**

```bash
git add src/pages/Transactions/index.tsx
git commit -m "feat: support cash deposit/withdraw in transaction entry"
```

---

### Task 4: 端到端手动验证 + 收尾

**Files:**
- 无新文件

**Interfaces:**
- Consumes: Task 1-3 全部改动

- [ ] **Step 1: 运行后端全库测试 + 前端构建**

Run: `cd src-tauri && cargo test --lib && cd .. && npx tsc --noEmit`
Expected: 全部通过、无类型错误。

- [ ] **Step 2: 手动验证流程（开发者环境）**

启动应用（`npm run dev` 或项目指定方式），逐项验证：
1. 选一个账户 → 录入交易 → 类型选「存入现金」→ 币种 USD → 金额 1000 → 提交
2. 列表出现 `$CASH-USD` 记录，类型 Tag 显示「存入」
3. 持仓页现金持仓 `$CASH-USD` 余额 = 1000
4. 再录入「提取现金」400 → 列表显示「提取」，现金余额 = 600
5. 尝试提取 10000（超余额）→ 报错「Cannot sell...only ... held」
6. 编辑该现金记录（改金额）→ 余额相应变化
7. 删除现金记录 → 余额还原
8. 现金流视图（持仓页）累计正确

- [ ] **Step 3: 提交收尾（如有修复）**

```bash
git add -A
git commit -m "fix: polish cash deposit/withdraw"
```

---

## Self-Review 记录

- **Spec 覆盖**：设计文档全部要点均有对应任务（校验放宽=Task1；录入表单=Task3；列表显示=Task3；后端测试=Task2；手动验证=Task4）。
- **占位符扫描**：无 TBD/TODO；所有代码块均为完整可执行内容。
- **类型一致性**：`CASH_IN`/`CASH_OUT` 前端内部值 → 映射为后端 `BUY`/`SELL`；`isCashTxn`/`cashDirection`/`CASH_SYMBOL_PREFIX` 命名在 Task 3 内一致；后端 `is_cash_symbol` 导入自 `quote_service` 已确认存在。
