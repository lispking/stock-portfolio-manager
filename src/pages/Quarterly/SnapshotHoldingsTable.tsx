import { useState, useMemo } from "react";
import { Button, Select, Space, Table, Tag, Typography } from "antd";
import { EditOutlined, HistoryOutlined } from "@ant-design/icons";
import type { QuarterlyHoldingSnapshot, QuarterlySnapshot } from "../../types";
import HoldingNotesEditor from "./HoldingNotesEditor";
import { usePnlColor } from "../../hooks/usePnlColor";

const { Text } = Typography;

interface Props {
  holdings: QuarterlyHoldingSnapshot[];
  snapshotId: string;
  loading?: boolean;
  snap?: QuarterlySnapshot;
}

function fmtPct(v: number) {
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function fmt(v: number) {
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const MARKET_LABELS: Record<string, string> = {
  US: "🇺🇸 美股",
  CN: "🇨🇳 A股",
  HK: "🇭🇰 港股",
};

const MARKET_CURRENCY_PREFIX: Record<string, string> = {
  US: "$",
  CN: "¥",
  HK: "HK$",
};

export default function SnapshotHoldingsTable({ holdings, snapshotId, loading, snap }: Props) {
  const [notesTarget, setNotesTarget] = useState<QuarterlyHoldingSnapshot | null>(null);
  const [historySymbol, setHistorySymbol] = useState<string | null>(null);
  const [filterMarket, setFilterMarket] = useState<string | undefined>(undefined);
  const [filterAccountId, setFilterAccountId] = useState<string | undefined>(undefined);
  const { pnlColorDark } = usePnlColor();

  // Derive unique accounts from holdings
  const uniqueAccounts = useMemo(() => {
    const map = new Map<string, { id: string; name: string; market: string }>();
    holdings.forEach((h) => {
      if (!map.has(h.account_id)) {
        map.set(h.account_id, { id: h.account_id, name: h.account_name, market: h.market });
      }
    });
    return [...map.values()];
  }, [holdings]);

  // Apply filters
  const displayHoldings = useMemo(() => {
    return holdings.filter((h) => {
      if (filterMarket && h.market !== filterMarket) return false;
      if (filterAccountId && h.account_id !== filterAccountId) return false;
      return true;
    });
  }, [holdings, filterMarket, filterAccountId]);

  // The market of the selected account (if any)
  const activeAccountMarket = useMemo(() => {
    if (!filterAccountId) return undefined;
    return uniqueAccounts.find((a) => a.id === filterAccountId)?.market;
  }, [filterAccountId, uniqueAccounts]);

  // Weight denominator: account total > market total > 0 (use stored weight)
  const weightDenominator = useMemo(() => {
    if (filterAccountId) {
      // Sum market_value for all visible holdings of this account (same currency)
      return displayHoldings.reduce((sum, h) => sum + h.market_value, 0);
    }
    if (filterMarket && snap) {
      const totals: Record<string, number> = {
        US: snap.us_value,
        CN: snap.cn_value,
        HK: snap.hk_value,
      };
      return totals[filterMarket] ?? 0;
    }
    return 0;
  }, [filterAccountId, filterMarket, displayHoldings, snap]);

  // Currency prefix for the market_value column header note
  // null = mixed (each row shows its own currency)
  const uniformPrefix: string | null = useMemo(() => {
    if (activeAccountMarket) return MARKET_CURRENCY_PREFIX[activeAccountMarket] ?? "";
    if (filterMarket) return MARKET_CURRENCY_PREFIX[filterMarket] ?? "";
    return null;
  }, [filterMarket, activeAccountMarket]);

  function computeWeight(h: QuarterlyHoldingSnapshot): number {
    if ((filterAccountId || filterMarket) && weightDenominator > 0) {
      return (h.market_value / weightDenominator) * 100;
    }
    return h.weight;
  }

  function fmtMv(h: QuarterlyHoldingSnapshot): string {
    const prefix = uniformPrefix ?? (MARKET_CURRENCY_PREFIX[h.market] ?? "");
    return `${prefix}${fmt(h.market_value)}`;
  }

  const weightTitle = filterAccountId
    ? "仓位% (账户)"
    : filterMarket
    ? "仓位% (市场)"
    : "仓位% (组合)";

  const marketValueTitle = uniformPrefix !== null
    ? `市值 (${uniformPrefix})`
    : "市值";

  const columns = [
    {
      title: "市场",
      dataIndex: "market",
      key: "market",
      render: (m: string) => <Tag>{MARKET_LABELS[m] ?? m}</Tag>,
    },
    {
      title: "代码",
      dataIndex: "symbol",
      key: "symbol",
      render: (s: string) => <Text strong>{s}</Text>,
    },
    {
      title: "名称",
      dataIndex: "name",
      key: "name",
    },
    {
      title: "类别",
      dataIndex: "category_name",
      key: "category_name",
      render: (name: string, record: QuarterlyHoldingSnapshot) => (
        <Tag color={record.category_color}>{name}</Tag>
      ),
    },
    {
      title: "账户",
      dataIndex: "account_name",
      key: "account_name",
    },
    {
      title: "持股数",
      dataIndex: "shares",
      key: "shares",
      render: (v: number) => v.toLocaleString(),
    },
    {
      title: "均成本",
      dataIndex: "avg_cost",
      key: "avg_cost",
      render: (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 3, maximumFractionDigits: 3 }),
    },
    {
      title: "收盘价",
      dataIndex: "close_price",
      key: "close_price",
      render: (v: number) => fmt(v),
    },
    {
      title: marketValueTitle,
      dataIndex: "market_value",
      key: "market_value",
      render: (_: unknown, record: QuarterlyHoldingSnapshot) => (
        <Text strong>{fmtMv(record)}</Text>
      ),
      sorter: (a: QuarterlyHoldingSnapshot, b: QuarterlyHoldingSnapshot) =>
        a.market_value - b.market_value,
    },
    {
      title: "盈亏",
      dataIndex: "pnl",
      key: "pnl",
      render: (v: number) => (
        <Text style={{ color: pnlColorDark(v) }}>
          {v >= 0 ? "+" : ""}{fmt(v)}
        </Text>
      ),
      sorter: (a: QuarterlyHoldingSnapshot, b: QuarterlyHoldingSnapshot) => a.pnl - b.pnl,
    },
    {
      title: "盈亏%",
      dataIndex: "pnl_percent",
      key: "pnl_percent",
      render: (v: number) => (
        <Text style={{ color: pnlColorDark(v) }}>{fmtPct(v)}</Text>
      ),
      sorter: (a: QuarterlyHoldingSnapshot, b: QuarterlyHoldingSnapshot) =>
        a.pnl_percent - b.pnl_percent,
    },
    {
      title: weightTitle,
      key: "weight",
      defaultSortOrder: "descend" as const,
      sorter: (a: QuarterlyHoldingSnapshot, b: QuarterlyHoldingSnapshot) =>
        computeWeight(a) - computeWeight(b),
      render: (_: unknown, record: QuarterlyHoldingSnapshot) =>
        `${computeWeight(record).toFixed(2)}%`,
    },
    {
      title: "操作思考",
      key: "notes",
      render: (_: unknown, record: QuarterlyHoldingSnapshot) => (
        <Space>
          <Button
            size="small"
            icon={<EditOutlined />}
            onClick={() => setNotesTarget(record)}
          >
            {record.notes ? "编辑" : "记录"}
          </Button>
          <Button
            size="small"
            icon={<HistoryOutlined />}
            onClick={() => setHistorySymbol(record.symbol)}
          >
            历史
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <>
      {/* Filter controls */}
      <Space className="mb-3" wrap>
        <Space>
          <Text type="secondary">按市场:</Text>
          <Select
            value={filterMarket}
            onChange={(v) => { setFilterMarket(v); setFilterAccountId(undefined); }}
            placeholder="全部市场"
            allowClear
            style={{ width: 140 }}
          >
            <Select.Option value="US">🇺🇸 美股</Select.Option>
            <Select.Option value="CN">🇨🇳 A股</Select.Option>
            <Select.Option value="HK">🇭🇰 港股</Select.Option>
          </Select>
        </Space>
        <Space>
          <Text type="secondary">按账户:</Text>
          <Select
            value={filterAccountId}
            onChange={(v) => { setFilterAccountId(v); setFilterMarket(undefined); }}
            placeholder="全部账户"
            allowClear
            style={{ width: 180 }}
          >
            {uniqueAccounts.map((a) => (
              <Select.Option key={a.id} value={a.id}>
                [{MARKET_LABELS[a.market] ?? a.market}] {a.name}
              </Select.Option>
            ))}
          </Select>
        </Space>
      </Space>

      <Table
        dataSource={displayHoldings}
        columns={columns}
        rowKey="id"
        loading={loading}
        size="small"
        pagination={{ pageSize: 20 }}
        scroll={{ x: "max-content" }}
      />

      {/* Notes editor modal */}
      {notesTarget && (
        <HoldingNotesEditor
          holding={notesTarget}
          snapshotId={snapshotId}
          open={!!notesTarget}
          onClose={() => setNotesTarget(null)}
          showHistory={false}
        />
      )}

      {/* Notes history modal */}
      {historySymbol && (
        <HoldingNotesEditor
          holding={holdings.find((h) => h.symbol === historySymbol) ?? null}
          snapshotId={snapshotId}
          open={!!historySymbol}
          onClose={() => setHistorySymbol(null)}
          showHistory={true}
        />
      )}
    </>
  );
}
