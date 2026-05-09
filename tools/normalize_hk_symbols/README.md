# normalize_hk_symbols

一个独立的小工具，用于将数据库中所有港股（市场 `HK`）的股票代码**去掉前导零**，保持格式一致。

## 背景

港股股票代码（如中信银行 `0998.HK`）在录入时可能带有前导零，也可能不带，导致同一只股票在数据库中以 `998.HK` 和 `0998.HK` 两种形式存在，影响行情查询和数据汇总。本工具将所有带前导零的港股代码统一修正为**不带前导零**的形式（雪球/主流行情平台的标准格式）。

## 处理规则

| 原始代码 | 规范化后 |
|----------|----------|
| `0998.HK` | `998.HK` |
| `00941.HK` | `941.HK` |
| `0700.HK` | `700.HK` |
| `998.HK` | 不处理（已规范） |

## 涉及的表

| 表名 | 处理方式 |
|------|----------|
| `holdings` | UPDATE |
| `transactions` | UPDATE |
| `daily_holding_snapshots` | UPDATE |
| `quarterly_holding_snapshots` | UPDATE |
| `price_alerts` | UPDATE |
| `benchmark_daily_prices` | UPDATE |
| `cached_quotes` | DELETE 旧行 + INSERT 新行（因 `symbol` 为主键） |

## 构建与运行

> **前提**：已安装 [Rust 工具链](https://rustup.rs/)（1.70+）。
> 本工具不依赖 GTK / Tauri，可在任意平台独立编译。

```bash
cd tools/normalize_hk_symbols

# 先预览（不写入数据库）
cargo run -- /path/to/portfolio.db --dry-run

# 确认无误后正式写入
cargo run -- /path/to/portfolio.db
```

### macOS 数据库默认路径

```
~/Library/Application Support/com.stock-portfolio-manager.app/portfolio.db
```

### Windows 数据库默认路径

```
%APPDATA%\com.stock-portfolio-manager.app\portfolio.db
```

## 输出示例

```
=== DRY-RUN 模式（不写入数据库）===

[holdings] 无需处理（没有带前导零的港股代码）
[预览] 表 transactions: 0998.HK → 998.HK
[预览] 表 transactions: 00941.HK → 941.HK
[daily_holding_snapshots] 无需处理（没有带前导零的港股代码）
...

=== 汇总 ===
将更新（预览）: 2
无需处理:       5

以上为预览结果。去掉 --dry-run 参数后再次运行即可写入数据库。
```

## 运行测试

```bash
cargo test
```
