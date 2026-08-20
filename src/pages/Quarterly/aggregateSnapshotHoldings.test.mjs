import test from "node:test";
import assert from "node:assert/strict";
import { aggregateSnapshotHoldings } from "./aggregateSnapshotHoldings.ts";

const baseHolding = {
  id: "holding-1", quarterly_snapshot_id: "snapshot-1", account_id: "account-1",
  account_name: "Main", symbol: "AAPL", name: "Apple", market: "US",
  category_name: "科技", category_color: "#1677ff", shares: 10, avg_cost: 100,
  close_price: 130, market_value: 1300, cost_value: 1000, pnl: 300,
  pnl_percent: 30, weight: 13, notes: "长期持有",
};

test("同一股票代码跨账户合并，同时保留账户级快照子行", () => {
  const result = aggregateSnapshotHoldings([
    baseHolding,
    { ...baseHolding, id: "holding-2", account_id: "account-2", account_name: "Retirement", shares: 20, avg_cost: 110, market_value: 2600, cost_value: 2200, pnl: 400, pnl_percent: 18.1818, weight: 26 },
    { ...baseHolding, id: "holding-3", symbol: "MSFT", name: "Microsoft", shares: 5, avg_cost: 200, close_price: 210, market_value: 1050, cost_value: 1000, pnl: 50, pnl_percent: 5, weight: 10.5, notes: null },
  ]);

  assert.equal(result.length, 2);
  assert.equal(result[0].symbol, "AAPL");
  assert.equal(result[0].shares, 30);
  assert.equal(result[0].avg_cost, 3200 / 30);
  assert.equal(result[0].market_value, 3900);
  assert.equal(result[0].pnl, 700);
  assert.equal(result[0].pnl_percent, 21.875);
  assert.equal(result[0].weight, 39);
  assert.deepEqual(result[0].accountRows.map((row) => [row.id, row.account_name]), [["holding-2", "Retirement"], ["holding-1", "Main"]]);
});

test("跨市场持仓按统一为美元后的市值降序排列", () => {
  const result = aggregateSnapshotHoldings([
    { ...baseHolding, symbol: "CN.BABA", market: "CN", market_value: 720, cost_value: 600, pnl: 120 },
    { ...baseHolding, id: "holding-2", symbol: "AAPL", market: "US", market_value: 200, cost_value: 150, pnl: 50 },
  ], { usd_cny: 7.2, usd_hkd: 7.8, cny_hkd: 1.0833, updated_at: "2026-08-20" });

  assert.deepEqual(result.map((row) => row.symbol), ["AAPL", "CN.BABA"]);
  assert.deepEqual(result.map((row) => row.market_value_base), [200, 100]);
});
