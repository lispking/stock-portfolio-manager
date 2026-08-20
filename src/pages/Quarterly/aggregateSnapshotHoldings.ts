import type { ExchangeRates, QuarterlyHoldingSnapshot } from "../../types";

export interface AggregatedSnapshotHolding extends QuarterlyHoldingSnapshot {
  market_value_base: number;
  accountRows: QuarterlyHoldingSnapshot[];
}

export const DEFAULT_SNAPSHOT_RATES: ExchangeRates = {
  usd_cny: 7.2,
  usd_hkd: 7.8,
  cny_hkd: 7.8 / 7.2,
  updated_at: "",
};

export function parseSnapshotExchangeRates(value?: string): ExchangeRates {
  if (!value) return DEFAULT_SNAPSHOT_RATES;
  try {
    const rates = JSON.parse(value) as ExchangeRates;
    if (rates.usd_cny > 0 && rates.usd_hkd > 0) return rates;
  } catch {
    // Fall through to the same defaults used by the quarterly service.
  }
  return DEFAULT_SNAPSHOT_RATES;
}

function marketValueInUsd(value: number, market: string, rates: ExchangeRates) {
  if (market === "CN") return value / rates.usd_cny;
  if (market === "HK") return value / rates.usd_hkd;
  return value;
}

export function aggregateSnapshotHoldings(
  holdings: QuarterlyHoldingSnapshot[],
  rates: ExchangeRates = DEFAULT_SNAPSHOT_RATES,
): AggregatedSnapshotHolding[] {
  const grouped = new Map<string, QuarterlyHoldingSnapshot[]>();

  for (const holding of holdings) {
    const rows = grouped.get(holding.symbol);
    if (rows) rows.push(holding);
    else grouped.set(holding.symbol, [holding]);
  }

  return Array.from(grouped.values())
    .map((accountRows) => {
      const first = accountRows[0];
      const shares = accountRows.reduce((sum, row) => sum + row.shares, 0);
      const costValue = accountRows.reduce((sum, row) => sum + row.cost_value, 0);
      const marketValue = accountRows.reduce((sum, row) => sum + row.market_value, 0);
      const pnl = accountRows.reduce((sum, row) => sum + row.pnl, 0);

      return {
        ...first,
        id: `symbol:${first.symbol}`,
        account_id: "",
        account_name: "",
        shares,
        avg_cost: shares > 0 ? costValue / shares : 0,
        market_value: marketValue,
        cost_value: costValue,
        pnl,
        pnl_percent: costValue > 0 ? (pnl / costValue) * 100 : null,
        weight: accountRows.reduce((sum, row) => sum + row.weight, 0),
        notes: accountRows.find((row) => row.notes)?.notes ?? null,
        market_value_base: marketValueInUsd(marketValue, first.market, rates),
        accountRows: [...accountRows].sort((a, b) => b.market_value - a.market_value),
      };
    })
    .sort((a, b) => b.market_value_base - a.market_value_base);
}
