import { useEffect, useMemo } from "react";
import { Row, Col, Card, Statistic, Spin, Empty, Select, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import PieChart from "../../components/charts/PieChart";
import HoldingsTable from "../Dashboard/HoldingsTable";
import { useStatisticsStore } from "../../stores/dashboardStore";
import { useAccountStore } from "../../stores/accountStore";
import type { AccountStatistics } from "../../types";
import { usePnlColor } from "../../hooks/usePnlColor";

const { Text } = Typography;

interface Props {
  selectedAccountId: string;
  onAccountChange: (id: string) => void;
}

interface AggregatedStock {
  symbol: string;
  name: string;
  category_name: string;
  category_color: string;
  shares: number;
  avg_cost: number;
  current_price: number;
  market_value: number;
  market_value_usd: number;
  pnl: number;
  pnl_percent: number;
  currency: string;
  _totalMv: number;
}

interface StockAccumulator {
  shares: number;
  cost_value: number;
  market_value: number;
  market_value_usd: number;
  pnl: number;
  current_price: number;
  name: string;
  category_name: string;
  category_color: string;
  currency: string;
}

const marketCurrency: Record<string, { code: string; symbol: string }> = {
  US: { code: "USD", symbol: "$" },
  CN: { code: "CNY", symbol: "¥" },
  HK: { code: "HKD", symbol: "HK$" },
};

export default function AccountTab({ selectedAccountId, onAccountChange }: Props) {
  const { pnlColor } = usePnlColor();
  const { accountStats, fetchAccountStats } = useStatisticsStore();
  const { accounts, fetchAccounts } = useAccountStore();

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  useEffect(() => {
    if (selectedAccountId) {
      fetchAccountStats(selectedAccountId);
    }
  }, [selectedAccountId, fetchAccountStats]);

  const stats: AccountStatistics | undefined = accountStats[selectedAccountId];
  const currencyCode = stats ? (marketCurrency[stats.market]?.code ?? "USD") : "USD";
  const currencySymbol = stats ? (marketCurrency[stats.market]?.symbol ?? "$") : "$";

  // Aggregate holdings by symbol for the 个股明细 section
  const aggregatedStocks = useMemo((): AggregatedStock[] => {
    if (!stats) return [];
    const map = new Map<string, StockAccumulator>();
    for (const h of stats.holdings) {
      const existing = map.get(h.symbol);
      if (existing) {
        existing.shares += h.shares;
        existing.cost_value += h.cost_value;
        existing.market_value += h.market_value;
        existing.market_value_usd += h.market_value_usd;
        existing.pnl += h.pnl;
        // All rows for the same symbol share the same live quote; take the last seen.
        existing.current_price = h.current_price;
      } else {
        map.set(h.symbol, {
          shares: h.shares,
          cost_value: h.cost_value,
          market_value: h.market_value,
          market_value_usd: h.market_value_usd,
          pnl: h.pnl,
          current_price: h.current_price,
          name: h.name,
          category_name: h.category_name,
          category_color: h.category_color,
          currency: h.currency,
        });
      }
    }
    const totalMv = Array.from(map.values()).reduce((s, v) => s + v.market_value_usd, 0);
    return Array.from(map.entries()).map(([symbol, v]) => ({
      symbol,
      name: v.name,
      category_name: v.category_name,
      category_color: v.category_color,
      shares: v.shares,
      avg_cost: v.shares > 0 ? v.cost_value / v.shares : 0,
      current_price: v.current_price,
      market_value: v.market_value,
      market_value_usd: v.market_value_usd,
      pnl: v.pnl,
      pnl_percent: v.cost_value > 0 ? (v.pnl / v.cost_value) * 100 : 0,
      currency: v.currency,
      _totalMv: totalMv,
    }));
  }, [stats]);

  const stockColumns: ColumnsType<AggregatedStock> = useMemo(() => [
    {
      title: "代码",
      dataIndex: "symbol",
      key: "symbol",
      sorter: (a, b) => a.symbol.localeCompare(b.symbol),
      render: (symbol: string) => <Text strong>{symbol}</Text>,
      fixed: "left" as const,
      width: 110,
    },
    {
      title: "名称",
      dataIndex: "name",
      key: "name",
      ellipsis: true,
      width: 140,
    },
    {
      title: "类别",
      dataIndex: "category_name",
      key: "category_name",
      render: (name: string, record: AggregatedStock) => (
        <Tag color={record.category_color}>{name}</Tag>
      ),
      width: 90,
    },
    {
      title: "持仓数量",
      dataIndex: "shares",
      key: "shares",
      sorter: (a, b) => a.shares - b.shares,
      render: (shares: number) => shares.toLocaleString(),
      align: "right" as const,
      width: 100,
    },
    {
      title: "均价",
      dataIndex: "avg_cost",
      key: "avg_cost",
      sorter: (a, b) => a.avg_cost - b.avg_cost,
      render: (price: number, _record: AggregatedStock) =>
        `${currencySymbol}${price.toLocaleString("en-US", { minimumFractionDigits: 3, maximumFractionDigits: 3 })}`,
      align: "right" as const,
      width: 110,
    },
    {
      title: "现价",
      dataIndex: "current_price",
      key: "current_price",
      sorter: (a, b) => a.current_price - b.current_price,
      render: (price: number) =>
        `${currencySymbol}${price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      align: "right" as const,
      width: 110,
    },
    {
      title: "市值",
      dataIndex: "market_value",
      key: "market_value",
      sorter: (a, b) => a.market_value_usd - b.market_value_usd,
      defaultSortOrder: "descend" as const,
      render: (value: number) =>
        `${currencySymbol}${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      align: "right" as const,
      width: 140,
    },
    {
      title: "仓位%",
      key: "position_pct",
      sorter: (a, b) => a.market_value_usd - b.market_value_usd,
      render: (_: unknown, record: AggregatedStock) => {
        const pct = record._totalMv > 0 ? (record.market_value_usd / record._totalMv) * 100 : 0;
        return `${pct.toFixed(2)}%`;
      },
      align: "right" as const,
      width: 90,
    },
    {
      title: "盈亏金额",
      dataIndex: "pnl",
      key: "pnl",
      sorter: (a, b) => a.pnl - b.pnl,
      render: (pnl: number) => (
        <span style={{ color: pnlColor(pnl) }}>
          {pnl >= 0 ? "+" : ""}
          {currencySymbol}{Math.abs(pnl).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </span>
      ),
      align: "right" as const,
      width: 140,
    },
    {
      title: "盈亏比例",
      dataIndex: "pnl_percent",
      key: "pnl_percent",
      sorter: (a, b) => a.pnl_percent - b.pnl_percent,
      render: (pnl: number) => (
        <span style={{ color: pnlColor(pnl) }}>
          {pnl >= 0 ? "+" : ""}
          {pnl.toFixed(2)}%
        </span>
      ),
      align: "right" as const,
      width: 100,
    },
  ], [currencySymbol, pnlColor]);

  return (
    <div>
      <div className="mb-4">
        <Select
          value={selectedAccountId || undefined}
          onChange={onAccountChange}
          placeholder="选择账户"
          style={{ width: 220 }}
        >
          {accounts.map((a) => (
            <Select.Option key={a.id} value={a.id}>
              {a.name} ({a.market})
            </Select.Option>
          ))}
        </Select>
      </div>

      {!selectedAccountId ? (
        <Empty description="请选择账户" />
      ) : !stats ? (
        <div className="flex justify-center py-16">
          <Spin size="large" />
        </div>
      ) : stats.holdings.length === 0 ? (
        <Empty description="该账户暂无持仓" />
      ) : (
        <>
          <Row gutter={[16, 16]} className="mb-4">
            <Col xs={24} sm={8}>
              <Card>
                <Statistic title={`账户总市值 (${currencyCode})`} value={stats.total_market_value.toFixed(2)} prefix={currencySymbol} />
              </Card>
            </Col>
            <Col xs={24} sm={8}>
              <Card>
                <Statistic title={`账户总成本 (${currencyCode})`} value={stats.total_cost.toFixed(2)} prefix={currencySymbol} />
              </Card>
            </Col>
            <Col xs={24} sm={8}>
              <Card>
                <Statistic
                  title={`账户总盈亏 (${currencyCode})`}
                  value={`${stats.total_pnl >= 0 ? "+" : ""}${stats.total_pnl.toFixed(2)}`}
                  valueStyle={{ color: pnlColor(stats.total_pnl) }}
                  prefix={currencySymbol}
                  suffix={`(${stats.total_pnl >= 0 ? "+" : ""}${stats.total_pnl_percent.toFixed(2)}%)`}
                />
              </Card>
            </Col>
          </Row>

          <Row gutter={[16, 16]} className="mb-4">
            {stats.category_distribution.length > 0 && (
              <Col xs={24} md={12}>
                <Card title="类别分布">
                  <PieChart data={stats.category_distribution} height={260} currencyCode={currencyCode} />
                </Card>
              </Col>
            )}
            {stats.stock_distribution.length > 0 && (
              <Col xs={24} md={12}>
                <Card title="个股分布">
                  <PieChart data={stats.stock_distribution} height={260} currencyCode={currencyCode} />
                </Card>
              </Col>
            )}
          </Row>

          <Card title="持仓明细">
            <HoldingsTable holdings={stats.holdings} loading={false} hideAccountMarket />
          </Card>

          <Card title="个股明细" className="mt-4">
            <Table
              columns={stockColumns}
              dataSource={aggregatedStocks}
              rowKey="symbol"
              loading={false}
              scroll={{ x: 1100 }}
              size="small"
              pagination={{ pageSize: 20, showSizeChanger: true }}
              bordered
            />
          </Card>
        </>
      )}
    </div>
  );
}
