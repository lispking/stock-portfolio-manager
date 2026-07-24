import { useMemo } from "react";
import { Row, Col, Card, Statistic, Spin, Empty, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import PieChart from "../../components/charts/PieChart";
import BarChart from "../../components/charts/BarChart";
import type { StatisticsOverview } from "../../types";
import type { Currency } from "../../types";
import { usePnlColor } from "../../hooks/usePnlColor";
import { useQuoteStore } from "../../stores/quoteStore";
import { useExchangeRateStore } from "../../stores/exchangeRateStore";
import { useCategoryStore } from "../../stores/categoryStore";

const { Text } = Typography;

const currencySymbol: Record<string, string> = {
  USD: "$",
  CNY: "¥",
  HKD: "HK$",
};

interface AggregatedStock {
  symbol: string;
  name: string;
  market: string;
  category_name: string;
  category_color: string;
  shares: number;
  avg_cost: number;
  current_price: number;
  currency: string;
  market_value: number;
  market_value_base: number;
  pnl: number;
  pnl_percent: number | null;
}

interface Props {
  overview: StatisticsOverview | null;
  loading: boolean;
  baseCurrency: Currency;
}

export default function OverviewTab({ overview, loading, baseCurrency }: Props) {
  const { pnlColor } = usePnlColor();
  const currency = currencySymbol[baseCurrency] ?? "$";
  const holdingQuotes = useQuoteStore((s) => s.holdingQuotes);
  const { convertWithCachedRates } = useExchangeRateStore();
  const categories = useCategoryStore((s) => s.categories);

  // Build a category lookup map: category_id → { name, color }
  const categoryMap = useMemo(() => {
    const map = new Map<string, { name: string; color: string }>();
    for (const c of categories) {
      map.set(c.id, { name: c.name, color: c.color });
    }
    return map;
  }, [categories]);

  // Aggregate holdings by symbol across all accounts/markets, matching the
  // MarketTab table structure.
  const aggregatedStocks = useMemo((): AggregatedStock[] => {
    const map = new Map<string, {
      symbol: string;
      name: string;
      market: string;
      category_name: string;
      category_color: string;
      shares: number;
      cost_value: number;
      market_value: number;
      market_value_base: number;
      pnl: number;
      current_price: number;
      currency: string;
    }>();
    for (const hq of holdingQuotes) {
      if (hq.symbol.startsWith("$CASH-")) continue;
      const key = hq.symbol;
      const existing = map.get(key);
      const mvNative = hq.market_value ?? 0;
      const mvBase = convertWithCachedRates(mvNative, hq.currency as Currency, baseCurrency);
      const costNative = hq.total_cost ?? hq.shares * hq.avg_cost;
      if (existing) {
        existing.shares += hq.shares;
        existing.cost_value += costNative;
        existing.market_value += mvNative;
        existing.market_value_base += mvBase;
        existing.pnl += hq.unrealized_pnl ?? (mvNative - costNative);
        existing.current_price = hq.quote?.current_price ?? existing.current_price;
      } else {
        map.set(key, {
          symbol: hq.symbol,
          name: hq.name,
          market: hq.market,
          category_name: categoryMap.get(hq.category_id ?? "")?.name ?? "未分类",
          category_color: categoryMap.get(hq.category_id ?? "")?.color ?? "#8B8B8B",
          shares: hq.shares,
          cost_value: costNative,
          market_value: mvNative,
          market_value_base: mvBase,
          pnl: hq.unrealized_pnl ?? (mvNative - costNative),
          current_price: hq.quote?.current_price ?? 0,
          currency: hq.currency,
        });
      }
    }
    return Array.from(map.values())
      .map((v) => ({
        symbol: v.symbol,
        name: v.name,
        market: v.market,
        category_name: v.category_name,
        category_color: v.category_color,
        shares: v.shares,
        avg_cost: v.shares > 0 ? v.cost_value / v.shares : 0,
        current_price: v.current_price,
        currency: v.currency,
        market_value: v.market_value,
        market_value_base: v.market_value_base,
        pnl: v.pnl,
        pnl_percent: v.cost_value > 0 ? (v.pnl / v.cost_value) * 100 : null,
      }))
      .sort((a, b) => b.market_value_base - a.market_value_base);
  }, [holdingQuotes, baseCurrency, convertWithCachedRates, categoryMap]);

  // Columns matching the MarketTab table.
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
      sorter: (a, b) => a.category_name.localeCompare(b.category_name),
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
      render: (price: number) =>
        price.toLocaleString("en-US", { minimumFractionDigits: 3, maximumFractionDigits: 3 }),
      align: "right" as const,
      width: 90,
    },
    {
      title: "现价",
      dataIndex: "current_price",
      key: "current_price",
      sorter: (a, b) => a.current_price - b.current_price,
      render: (price: number, record: AggregatedStock) => {
        const sym = currencySymbol[record.currency] ?? "";
        return `${sym}${price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      },
      align: "right" as const,
      width: 110,
    },
    {
      title: "市值",
      dataIndex: "market_value",
      key: "market_value",
      sorter: (a, b) => a.market_value_base - b.market_value_base,
      defaultSortOrder: "descend" as const,
      render: (value: number, record: AggregatedStock) => {
        const sym = currencySymbol[record.currency] ?? "";
        return `${sym}${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      },
      align: "right" as const,
      width: 140,
    },
    {
      title: "仓位%",
      key: "position_pct",
      sorter: (a, b) => a.market_value_base - b.market_value_base,
      render: (_: unknown, record: AggregatedStock) => {
        const total = aggregatedStocks.reduce((s, r) => s + r.market_value_base, 0);
        const pct = total > 0 ? (record.market_value_base / total) * 100 : 0;
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
      render: (pnl: number, record: AggregatedStock) => {
        const sym = currencySymbol[record.currency] ?? "";
        return (
          <span style={{ color: pnlColor(pnl) }}>
            {pnl >= 0 ? "+" : "-"}
            {sym}{Math.abs(pnl).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
        );
      },
      align: "right" as const,
      width: 140,
    },
    {
      title: "盈亏比例",
      dataIndex: "pnl_percent",
      key: "pnl_percent",
      render: (pnl: number | null) =>
        pnl != null ? (
          <span style={{ color: pnlColor(pnl) }}>
            {pnl >= 0 ? "+" : ""}
            {pnl.toFixed(2)}%
          </span>
        ) : (
          <span>-</span>
        ),
      align: "right" as const,
      width: 100,
    },
  ], [aggregatedStocks, pnlColor]);

  if (loading && !overview) {
    return (
      <div className="flex justify-center py-16">
        <Spin size="large" />
      </div>
    );
  }
  if (!overview) {
    return <Empty description="暂无数据" />;
  }

  const totalPnlPos = overview.total_pnl >= 0;

  const gainersData = overview.top_gainers.map((g) => ({
    name: g.symbol,
    value: parseFloat(g.pnl.toFixed(2)),
  }));
  const losersData = overview.top_losers.map((g) => ({
    name: g.symbol,
    value: parseFloat(g.pnl.toFixed(2)),
  }));

  return (
    <div>
      {/* Summary stats */}
      <Row gutter={[16, 16]} className="mb-4">
        <Col xs={24} sm={8}>
          <Card>
            <Statistic
              title={`总市值 (${baseCurrency})`}
              value={overview.total_market_value.toFixed(2)}
              prefix={currency}
            />
          </Card>
        </Col>
        <Col xs={24} sm={8}>
          <Card>
            <Statistic
              title={`总成本 (${baseCurrency})`}
              value={overview.total_cost.toFixed(2)}
              prefix={currency}
            />
          </Card>
        </Col>
        <Col xs={24} sm={8}>
          <Card>
            <Statistic
              title={`总盈亏 (${baseCurrency})`}
              value={`${totalPnlPos ? "+" : ""}${overview.total_pnl.toFixed(2)}`}
              styles={{ content: {  color: pnlColor(overview.total_pnl)  } }}
              prefix={currency}
              suffix={`(${totalPnlPos ? "+" : ""}${overview.total_pnl_percent.toFixed(2)}%)`}
            />
          </Card>
        </Col>
      </Row>

      {/* Distribution charts */}
      <Row gutter={[16, 16]}>
        <Col xs={24} md={8}>
          <Card title="市场分布">
            <PieChart data={overview.market_distribution} height={260} currencyCode={baseCurrency} />
          </Card>
        </Col>
        <Col xs={24} md={8}>
          <Card title="类别分布">
            <PieChart data={overview.category_distribution} height={260} currencyCode={baseCurrency} />
          </Card>
        </Col>
        <Col xs={24} md={8}>
          <Card title="账户分布">
            <PieChart data={overview.account_distribution} height={260} currencyCode={baseCurrency} />
          </Card>
        </Col>
      </Row>

      {/* Stock distribution chart */}
      {overview.stock_distribution.length > 0 && (
        <Row gutter={[16, 16]} className="mt-4">
          <Col xs={24}>
            <Card title="个股分布">
              <PieChart data={overview.stock_distribution} height={360} currencyCode={baseCurrency} />
            </Card>
          </Col>
        </Row>
      )}

      {/* PnL charts */}
      {(gainersData.length > 0 || losersData.length > 0) && (
        <Row gutter={[16, 16]} className="mt-4">
          <Col xs={24} md={12}>
            <Card title="盈利 Top 5">
              <BarChart data={gainersData} colorByValue height={220} />
            </Card>
          </Col>
          <Col xs={24} md={12}>
            <Card title="亏损 Top 5">
              <BarChart data={losersData} colorByValue height={220} />
            </Card>
          </Col>
        </Row>
      )}

      {/* 个股明细 */}
      {aggregatedStocks.length > 0 && (
        <Row gutter={[16, 16]} className="mt-4">
          <Col xs={24}>
            <Card title="个股明细">
              <Table
                columns={stockColumns}
                dataSource={aggregatedStocks}
                rowKey="symbol"
                size="small"
                scroll={{ x: 1200 }}
                pagination={{ pageSize: 20, showSizeChanger: true }}
                bordered
              />
            </Card>
          </Col>
        </Row>
      )}
    </div>
  );
}
