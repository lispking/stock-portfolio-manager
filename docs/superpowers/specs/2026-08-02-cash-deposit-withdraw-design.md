# 存入/提取现金 功能设计

日期：2026-08-02
状态：已确认

## 背景

用户需要在「录入交易记录」中增加存入或提取现金的操作。当前系统只有 买入(BUY) / 卖出(SELL) / 分红(PAY) 三种可录入类型，无法记录账户现金的存入和提取。

## 决策

- **方案**：复用现有机制（方案 A），不加新交易类型、不改 DB CHECK 约束。
- **展示**：统一在交易记录列表中显示，直接显示 `$CASH-*` 代码。
- **手续费**：现金存取记录不需要手续费字段。
- **余额校验**：提取现金时由后端 SELL 校验（不能超过当前现金余额）。

## 架构

复用已有的现金持仓机制：
- **存入现金** = 对 `$CASH-{currency}` 现金持仓做一笔 **BUY**
  - `cash_delta("BUY", ...)` 对现金符号已正确返回 `+total_amount`（存入）
- **提取现金** = 对 `$CASH-{currency}` 现金持仓做一笔 **SELL**
  - `cash_delta("SELL", ...)` 对现金符号已正确返回 `-total_amount`（提取）

所有后端路径已天然支持，无需新增交易类型：

| 后端路径 | 现状 | 需要改动 |
|---|---|---|
| `create_transaction` | 现金 BUY 创建现金持仓；SELL 校验余额并扣减 | 无（除校验放宽） |
| `update_transaction` / `delete_transaction` | 反转现金影响 | 无 |
| `performance_service` | 已把 `$CASH-*` 排除在 P&L 归因之外 | 无 |
| 前端 `computeCashDelta` | 已把现金符号 BUY 当存入、SELL 当提取 | 无 |

## 组件/数据流

### 前端 `src/pages/Transactions/index.tsx`

1. **交易类型下拉**（约 `index.tsx:539`）新增两项：
   - `存入现金` → 内部映射为 `BUY` + `symbol = "$CASH-{currency}"`
   - `提取现金` → 内部映射为 `SELL` + `symbol = "$CASH-{currency}"`

2. **表单动态逻辑**（选现金类型时）：
   - `symbol` 自动填 `$CASH-{currency}` 并禁用输入
   - `name` 自动填 `现金`（与后端 `cash_display_name` 一致）
   - 隐藏 股数 / 价格 / 手续费 字段，只留 **总金额**（即存取现金额）
   - `shares` / `price` 提交时置 0（复用现有 PAY 处理方式，`index.tsx:198`）
   - 提取时后端校验余额，前端 `message.error` 展示错误

3. **列表显示**（约 `index.tsx:316`）：
   - 类型 Tag：`$CASH-*` 且 BUY → "存入"（绿色）；`$CASH-*` 且 SELL → "提取"（红色）
   - 股数 / 价格列显示 `—`（现金记录无意义）

4. **编辑 / 删除**：走现有逻辑，无需特殊处理（现金记录非 OPEN，可正常编辑删除）

### 后端 `src-tauri/src/commands/transactions.rs`

- `validate_transaction_shares` 对现金符号（`$CASH-*`）放宽校验：现金记录 `shares=0` 时跳过股数校验（避免前端必须传假股数）。

## 错误处理

- 提取超过现金余额 → 后端 SELL 校验报错，前端 `message.error` 展示。
- 未选币种就选现金类型 → 表单校验拦截（币种必填，现金类型才需要）。

## 测试

- **后端**：`transactions.rs` 新增测试：
  - 现金 BUY 增加现金持仓
  - 现金 SELL 减少现金持仓
  - 超额提取被拒绝
  - 编辑 / 删除现金记录反转正确
- **前端**：构建通过 + 手动验证（录入 → 列表显示 → 编辑 → 删除 → 现金流视图正确）。
