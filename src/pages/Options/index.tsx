import { useState, useEffect, useMemo, useCallback } from "react";
import {
  Card,
  Select,
  Button,
  Tabs,
  Table,
  Tag,
  Statistic,
  Row,
  Col,
  InputNumber,
  Space,
  Upload,
  message,
  Modal,
  Input,
  Typography,
  Alert,
} from "antd";
import {
  UploadOutlined,
  DeleteOutlined,
  DollarOutlined,
  StockOutlined,
  PlusOutlined,
  MinusOutlined,
} from "@ant-design/icons";
import { useAccountStore } from "../../stores/accountStore";
import { useOptionStore } from "../../stores/optionStore";
import type {
  OptionContract,
  StockPriceInput,
} from "../../types";

const { Title, Text } = Typography;

export default function OptionsPage() {
  const { accounts, fetchAccounts } = useAccountStore();
  const {
    contracts,
    expiredStats,
    putSimulations,
    callSimulations,
    fetchContracts,
    fetchExpiredStats,
    importOptionsCsv,
    simulateSellPut,
    simulateSellCall,
    deleteOptionRecords,
    clearSimulations,
  } = useOptionStore();

  const [selectedAccountId, setSelectedAccountId] = useState<string>(() => {
    return localStorage.getItem("options_selected_account_id") || "";
  });
  const [stockPrices, setStockPrices] = useState<Record<string, number>>({});
  const [activeTab, setActiveTab] = useState<string>("active");
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [confirmName, setConfirmName] = useState("");

  const selectedAccountName = useMemo(() => {
    return accounts.find((a) => a.id === selectedAccountId)?.name || "";
  }, [accounts, selectedAccountId]);

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  // Validate stored account ID exists; clear if account was deleted
  useEffect(() => {
    if (selectedAccountId && accounts.length > 0) {
      const exists = accounts.some((a) => a.id === selectedAccountId);
      if (!exists) {
        setSelectedAccountId("");
        localStorage.removeItem("options_selected_account_id");
      }
    }
  }, [accounts, selectedAccountId]);

  // Persist selected account
  useEffect(() => {
    if (selectedAccountId) {
      localStorage.setItem("options_selected_account_id", selectedAccountId);
    }
  }, [selectedAccountId]);

  // Load data when account changes
  useEffect(() => {
    if (selectedAccountId) {
      fetchContracts(selectedAccountId);
      fetchExpiredStats(selectedAccountId);
    }
    clearSimulations();
    setStockPrices({});
  }, [selectedAccountId, fetchContracts, fetchExpiredStats, clearSimulations]);

  // Calculate latest trade time from all contracts
  const latestTradeTime = useMemo(() => {
    const times = contracts
      .map((c) => c.traded_at)
      .filter((t): t is string => !!t);
    if (times.length === 0) return null;
    return times.sort().reverse()[0];
  }, [contracts]);

  // Get active and expired contracts
  const activeContracts = useMemo(
    () => contracts.filter((c) => c.status === "active"),
    [contracts]
  );
  const expiredContracts = useMemo(
    () => contracts.filter((c) => c.status !== "active"),
    [contracts]
  );

  // Group contracts by option_symbol for expandable display
  interface GroupedContract {
    key: string;
    option_symbol: string;
    underlying: string;
    expiry_date: string;
    strike_price: number;
    option_type: string;
    contracts: number;
    open_price: number;
    open_amount: number;
    commission: number;
    traded_at: string | null;
    close_price: number | null;
    close_code: string | null;
    status: string;
    children?: OptionContract[];
  }

  const groupContracts = useCallback((contractsList: OptionContract[]): GroupedContract[] => {
    const grouped: Record<string, OptionContract[]> = {};
    for (const c of contractsList) {
      if (!grouped[c.option_symbol]) {
        grouped[c.option_symbol] = [];
      }
      grouped[c.option_symbol].push(c);
    }

    return Object.entries(grouped).map(([symbol, items]) => {
      if (items.length === 1) {
        const c = items[0];
        return {
          key: c.id,
          option_symbol: c.option_symbol,
          underlying: c.underlying,
          expiry_date: c.expiry_date,
          strike_price: c.strike_price,
          option_type: c.option_type,
          contracts: c.contracts,
          open_price: c.open_price,
          open_amount: c.open_amount,
          commission: c.commission,
          traded_at: c.traded_at,
          close_price: c.close_price,
          close_code: c.close_code,
          status: c.status,
        };
      }
      // Multiple contracts with same symbol: sum contracts, aggregate amounts
      const totalContracts = items.reduce((sum, c) => sum + c.contracts, 0);
      const totalAmount = items.reduce((sum, c) => sum + c.open_amount, 0);
      const totalCommission = items.reduce((sum, c) => sum + c.commission, 0);
      const first = items[0];
      return {
        key: symbol,
        option_symbol: symbol,
        underlying: first.underlying,
        expiry_date: first.expiry_date,
        strike_price: first.strike_price,
        option_type: first.option_type,
        contracts: totalContracts,
        open_price: first.open_price,
        open_amount: totalAmount,
        commission: totalCommission,
        traded_at: first.traded_at,
        close_price: first.close_price,
        close_code: first.close_code,
        status: first.status,
        children: items,
      };
    });
  }, []);

  const groupedActiveContracts = useMemo(
    () => groupContracts(activeContracts),
    [activeContracts, groupContracts]
  );
  const groupedExpiredContracts = useMemo(
    () => groupContracts(expiredContracts),
    [expiredContracts, groupContracts]
  );

  // Get unique underlyings from active contracts for price inputs
  const activeUnderlyings = useMemo(() => {
    const set = new Set<string>();
    activeContracts.forEach((c) => set.add(c.underlying));
    return Array.from(set).sort();
  }, [activeContracts]);

  // Compute premium statistics for active contracts
  const activePremiumStats = useMemo(() => {
    const now = new Date();
    const d30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const d60 = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
    const d90 = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

    // Robust date parser that handles IBKR CSV formats:
    // "2022-06-28, 10:57:34", "2022/9/16", "2022-06-28", etc.
    const parseDate = (s: string): Date | null => {
      // Replace comma between date and time with space
      let normalized = s.replace(",", " ");
      // Try parsing directly
      let d = new Date(normalized);
      if (!isNaN(d.getTime())) return d;
      // Try replacing dashes with slashes (Safari-friendly)
      normalized = s.replace(",", " ").replace(/-/g, "/");
      d = new Date(normalized);
      if (!isNaN(d.getTime())) return d;
      return null;
    };

    let total = 0;
    let last30 = 0;
    let last60 = 0;
    let last90 = 0;

    // Total premium: active contracts only
    // 30/60/90 day premium: include active contracts only too
    for (const c of activeContracts) {
      const amount = Math.abs(c.open_amount);
      total += amount;
      if (c.traded_at) {
        const tradedDate = parseDate(c.traded_at);
        if (tradedDate) {
          if (tradedDate >= d90) last90 += amount;
          if (tradedDate >= d60) last60 += amount;
          if (tradedDate >= d30) last30 += amount;
        }
      }
    }

    return { total, last30, last60, last90 };
  }, [activeContracts, contracts]);

  // Compute total premium for expired contracts
  const expiredTotalPremium = useMemo(() => {
    return expiredContracts.reduce((sum, c) => sum + Math.abs(c.open_amount), 0);
  }, [expiredContracts]);

  // Compute premium grouped by underlying stock for active contracts
  const activePremiumByStock = useMemo(() => {
    const map: Record<string, number> = {};
    for (const c of activeContracts) {
      map[c.underlying] = (map[c.underlying] || 0) + Math.abs(c.open_amount);
    }
    return Object.entries(map)
      .map(([underlying, premium]) => ({ underlying, premium }))
      .sort((a, b) => b.premium - a.premium);
  }, [activeContracts]);

  // Compute premium grouped by underlying stock for expired contracts
  const expiredPremiumByStock = useMemo(() => {
    const map: Record<string, number> = {};
    for (const c of expiredContracts) {
      map[c.underlying] = (map[c.underlying] || 0) + Math.abs(c.open_amount);
    }
    return Object.entries(map)
      .map(([underlying, premium]) => ({ underlying, premium }))
      .sort((a, b) => b.premium - a.premium);
  }, [expiredContracts]);

  // Handle CSV import
  const handleImport = useCallback(
    async (file: File) => {
      if (!selectedAccountId) {
        message.error("请先选择证券账户");
        return false;
      }
      const text = await file.text();
      try {
        const result = await importOptionsCsv(selectedAccountId, text);
        if (result.errors.length > 0) {
          message.warning(
            `导入完成：成功 ${result.imported} 条，跳过 ${result.skipped} 条，错误 ${result.errors.length} 条`
          );
          console.error("[期权导入错误]", result.errors);
        } else {
          message.success(
            `导入成功：${result.imported} 条记录，跳过 ${result.skipped} 条`
          );
        }
        // Refresh data
        fetchContracts(selectedAccountId);
        fetchExpiredStats(selectedAccountId);
      } catch (err) {
        message.error(`导入失败: ${err}`);
      }
      return false; // Prevent default upload
    },
    [selectedAccountId, importOptionsCsv, fetchContracts, fetchExpiredStats]
  );

  // Handle stock price change and trigger simulation
  const handlePriceChange = useCallback(
    (symbol: string, price: number | null) => {
      setStockPrices((prev) => {
        const next = { ...prev };
        if (price !== null && price > 0) {
          next[symbol] = price;
        } else {
          delete next[symbol];
        }
        return next;
      });
    },
    []
  );

  // Run simulation
  const handleSimulate = useCallback(() => {
    if (!selectedAccountId) return;
    const prices: StockPriceInput[] = Object.entries(stockPrices).map(
      ([symbol, price]) => ({ symbol, price })
    );
    simulateSellPut(selectedAccountId, prices);
    simulateSellCall(selectedAccountId, prices);
  }, [selectedAccountId, stockPrices, simulateSellPut, simulateSellCall]);

  // Auto-simulate when prices change
  useEffect(() => {
    if (Object.keys(stockPrices).length > 0 && selectedAccountId) {
      const timer = setTimeout(handleSimulate, 300);
      return () => clearTimeout(timer);
    }
  }, [stockPrices, selectedAccountId, handleSimulate]);

  // Handle delete all records
  const handleDelete = useCallback(async () => {
    if (!selectedAccountId) return;
    if (confirmName !== selectedAccountName) {
      message.warning("账户名称不匹配");
      return;
    }
    try {
      await deleteOptionRecords(selectedAccountId);
      message.success("已清除所有期权记录");
      setDeleteModalOpen(false);
      setConfirmName("");
    } catch (err) {
      message.error(`删除失败: ${err}`);
    }
  }, [selectedAccountId, deleteOptionRecords, confirmName, selectedAccountName]);

  const openDeleteModal = useCallback(() => {
    setConfirmName("");
    setDeleteModalOpen(true);
  }, []);

  // Table columns for active contracts
  const activeColumns = [
    {
      title: "期权标识",
      dataIndex: "option_symbol",
      key: "option_symbol",
      width: 245,
    },
    {
      title: "股票",
      dataIndex: "underlying",
      key: "underlying",
      width: 80,
      render: (v: string) => <Tag color="blue">{v}</Tag>,
    },
    {
      title: "到期日",
      dataIndex: "expiry_date",
      key: "expiry_date",
      width: 100,
    },
    {
      title: "行权价",
      dataIndex: "strike_price",
      key: "strike_price",
      width: 90,
      render: (v: number) => `$${v.toFixed(2)}`,
    },
    {
      title: "类型",
      dataIndex: "option_type",
      key: "option_type",
      width: 70,
      render: (v: string) => (
        <Tag color={v === "P" ? "orange" : "green"}>
          {v === "P" ? "Put" : "Call"}
        </Tag>
      ),
    },
    {
      title: "合约数",
      dataIndex: "contracts",
      key: "contracts",
      width: 80,
    },
    {
      title: "开仓价",
      dataIndex: "open_price",
      key: "open_price",
      width: 80,
      render: (v: number) => `$${v.toFixed(2)}`,
    },
    {
      title: "权利金",
      dataIndex: "open_amount",
      key: "open_amount",
      width: 100,
      render: (v: number) => (
        <Text type="success">${Math.abs(v).toLocaleString()}</Text>
      ),
    },
    {
      title: "佣金",
      dataIndex: "commission",
      key: "commission",
      width: 80,
      render: (v: number) => (
        <Text type="secondary">${Math.abs(v).toLocaleString()}</Text>
      ),
    },
    {
      title: "交易时间",
      dataIndex: "traded_at",
      key: "traded_at",
      width: 120,
      render: (v: string | null) => v ? v.substring(0, 10) : "-",
    },
  ];

  // Table columns for expired contracts
  const expiredColumns = [
    ...activeColumns,
    {
      title: "结果",
      dataIndex: "status",
      key: "result",
      width: 80,
      render: (v: string) => {
        if (v === "assigned") return <Tag color="red">被执行</Tag>;
        if (v === "expired") return <Tag color="green">已到期</Tag>;
        if (v === "closed") return <Tag color="blue">已平仓</Tag>;
        return <Tag>未知</Tag>;
      },
    },
  ];

  // Render active tab content with simulation
  const renderActiveTab = () => (
    <div>
      <Row gutter={16} style={{ marginBottom: 24 }}>
        <Col span={6}>
          <Card>
            <Statistic
              title="累计权利金"
              value={activePremiumStats.total}
              prefix="$"
              precision={0}
              styles={{ content: {  color: "var(--color-success)"  } }}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="最近90天权利金"
              value={activePremiumStats.last90}
              prefix="$"
              precision={0}
              styles={{ content: {  color: "var(--color-success)"  } }}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="最近60天权利金"
              value={activePremiumStats.last60}
              prefix="$"
              precision={0}
              styles={{ content: {  color: "var(--color-success)"  } }}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="最近30天权利金"
              value={activePremiumStats.last30}
              prefix="$"
              precision={0}
              styles={{ content: {  color: "var(--color-success)"  } }}
            />
          </Card>
        </Col>
      </Row>

      <Table
        dataSource={groupedActiveContracts}
        columns={activeColumns}
        rowKey={(record: any) => record.key || record.id}
        size="small"
        pagination={false}
        style={{ marginBottom: 24 }}
        expandable={{
          childrenColumnName: "children",
          expandIcon: ({ expanded, onExpand, record }) =>
            record.children ? (
              expanded ? (
                <MinusOutlined onClick={(e) => onExpand(record, e)} style={{ cursor: "pointer", marginRight: 8 }} />
              ) : (
                <PlusOutlined onClick={(e) => onExpand(record, e)} style={{ cursor: "pointer", marginRight: 8 }} />
              )
            ) : (
              <span style={{ marginRight: 8, width: 14, display: "inline-block" }} />
            ),
        }}
      />

      {activePremiumByStock.length > 0 && (
        <Card title="按股票权利金统计" size="small" style={{ marginBottom: 24 }}>
          <Row gutter={[12, 12]}>
            {activePremiumByStock.map((item) => (
              <Col key={item.underlying} flex="20%">
                <Card size="small" styles={{ body: { padding: "10px 16px" } }}>
                  <Space>
                    <Text strong>{item.underlying}</Text>
                    <Text strong style={{ color: "var(--color-success)" }}>
                      ${item.premium.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                    </Text>
                  </Space>
                </Card>
              </Col>
            ))}
          </Row>
        </Card>
      )}

      {activeUnderlyings.length > 0 && (
        <>
          <Card title="模拟计算 - 输入股票价格" size="small" style={{ marginBottom: 16 }}>
            <Row gutter={[12, 8]}>
              {activeUnderlyings.map((symbol) => (
                <Col key={symbol} flex="20%">
                  <Space>
                    <Text strong>{symbol}</Text>
                    <InputNumber
                      placeholder="输入价格"
                      prefix="$"
                      min={0}
                      step={1}
                      value={stockPrices[symbol] ?? null}
                      onChange={(v) => handlePriceChange(symbol, v)}
                      style={{ width: 100 }}
                    />
                  </Space>
                </Col>
              ))}
            </Row>
          </Card>

          {putSimulations.length > 0 && (
            <Card
              title={
                <Space>
                  <DollarOutlined />
                  <span>Sell Put - 现金需求</span>
                </Space>
              }
              size="small"
              style={{ marginBottom: 16 }}
            >
              {putSimulations.map((sim) => (
                <div key={sim.underlying} style={{ marginBottom: 16 }}>
                  <Title level={5}>{sim.underlying}</Title>
                  <Table
                    dataSource={sim.contracts}
                    rowKey="option_symbol"
                    size="small"
                    pagination={false}
                    columns={[
                      { title: "期权", dataIndex: "option_symbol", width: 220 },
                      {
                        title: "行权价",
                        dataIndex: "strike_price",
                        width: 100,
                        render: (v: number) => `$${v.toFixed(2)}`,
                      },
                      { title: "合约数", dataIndex: "contracts", width: 80 },
                      {
                        title: "是否被执行",
                        dataIndex: "would_be_assigned",
                        width: 100,
                        render: (v: boolean) =>
                          v ? (
                            <Tag color="red">是</Tag>
                          ) : (
                            <Tag color="green">否</Tag>
                          ),
                      },
                      {
                        title: "需要现金",
                        dataIndex: "cash_needed",
                        width: 140,
                        render: (v: number) => (
                          <Text type={v > 0 ? "danger" : undefined}>
                            ${v.toLocaleString()}
                          </Text>
                        ),
                      },
                    ]}
                  />
                  <div style={{ textAlign: "right", marginTop: 4 }}>
                    <Text strong>
                      小计: <Text type="danger">${sim.total_cash_needed.toLocaleString()}</Text>
                    </Text>
                  </div>
                </div>
              ))}
              <div
                style={{
                  textAlign: "right",
                  borderTop: "1px solid #f0f0f0",
                  paddingTop: 8,
                  marginTop: 8,
                }}
              >
                <Title level={5} style={{ margin: 0 }}>
                  总计需要现金:{" "}
                  <Text type="danger">
                    $
                    {putSimulations
                      .reduce((sum, s) => sum + s.total_cash_needed, 0)
                      .toLocaleString()}
                  </Text>
                </Title>
              </div>
            </Card>
          )}

          {callSimulations.length > 0 && (
            <Card
              title={
                <Space>
                  <StockOutlined />
                  <span>Sell Call - 正股需求</span>
                </Space>
              }
              size="small"
            >
              {callSimulations.map((sim) => (
                <div key={sim.underlying} style={{ marginBottom: 16 }}>
                  <Title level={5}>{sim.underlying}</Title>
                  <Table
                    dataSource={sim.contracts}
                    rowKey="option_symbol"
                    size="small"
                    pagination={false}
                    columns={[
                      { title: "期权", dataIndex: "option_symbol", width: 220 },
                      {
                        title: "行权价",
                        dataIndex: "strike_price",
                        width: 100,
                        render: (v: number) => `$${v.toFixed(2)}`,
                      },
                      { title: "合约数", dataIndex: "contracts", width: 80 },
                      {
                        title: "是否被执行",
                        dataIndex: "would_be_assigned",
                        width: 100,
                        render: (v: boolean) =>
                          v ? (
                            <Tag color="red">是</Tag>
                          ) : (
                            <Tag color="green">否</Tag>
                          ),
                      },
                      {
                        title: "需要正股",
                        dataIndex: "shares_needed",
                        width: 140,
                        render: (v: number) => (
                          <Text type={v > 0 ? "danger" : undefined}>
                            {v.toLocaleString()} 股
                          </Text>
                        ),
                      },
                    ]}
                  />
                  <div style={{ textAlign: "right", marginTop: 4 }}>
                    <Text strong>
                      小计:{" "}
                      <Text type="danger">
                        {sim.total_shares_needed.toLocaleString()} 股
                      </Text>
                    </Text>
                  </div>
                </div>
              ))}
            </Card>
          )}
        </>
      )}
    </div>
  );

  // Render expired tab content with stats
  const renderExpiredTab = () => (
    <div>
      {expiredStats && (
        <Row gutter={16} style={{ marginBottom: 24 }}>
          <Col span={5}>
            <Card>
              <Statistic
                title="累计权利金"
                value={expiredTotalPremium}
                prefix="$"
                precision={0}
                styles={{ content: {  color: "var(--color-success)"  } }}
              />
            </Card>
          </Col>
          <Col span={5}>
            <Card>
              <Statistic title="总合约数" value={expiredStats.total_contracts} />
            </Card>
          </Col>
          <Col span={5}>
            <Card>
              <Statistic
                title="被执行合约"
                value={expiredStats.assigned_contracts}
                styles={{ content: {  color: "var(--color-error)"  } }}
              />
            </Card>
          </Col>
          <Col span={5}>
            <Card>
              <Statistic
                title="到期作废合约"
                value={expiredStats.expired_contracts}
                styles={{ content: {  color: "var(--color-success)"  } }}
              />
            </Card>
          </Col>
          <Col span={4}>
            <Card>
              <Statistic
                title="执行比例"
                value={(expiredStats.assignment_ratio * 100).toFixed(1)}
                suffix="%"
              />
            </Card>
          </Col>
        </Row>
      )}

      <Table
        dataSource={groupedExpiredContracts}
        columns={expiredColumns}
        rowKey={(record: any) => record.key || record.id}
        size="small"
        pagination={false}
        expandable={{
          childrenColumnName: "children",
          expandIcon: ({ expanded, onExpand, record }) =>
            record.children ? (
              expanded ? (
                <MinusOutlined onClick={(e) => onExpand(record, e)} style={{ cursor: "pointer", marginRight: 8 }} />
              ) : (
                <PlusOutlined onClick={(e) => onExpand(record, e)} style={{ cursor: "pointer", marginRight: 8 }} />
              )
            ) : (
              <span style={{ marginRight: 8, width: 14, display: "inline-block" }} />
            ),
        }}
      />

      {expiredPremiumByStock.length > 0 && (
        <Card title="按股票权利金统计" size="small" style={{ marginTop: 24 }}>
          <Row gutter={[12, 12]}>
            {expiredPremiumByStock.map((item) => (
              <Col key={item.underlying} flex="20%">
                <Card size="small" styles={{ body: { padding: "10px 16px" } }}>
                  <Space>
                    <Text strong>{item.underlying}</Text>
                    <Text strong style={{ color: "var(--color-success)" }}>
                      ${item.premium.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                    </Text>
                  </Space>
                </Card>
              </Col>
            ))}
          </Row>
        </Card>
      )}
    </div>
  );

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 16,
        }}
      >
        <Title level={3} style={{ margin: 0 }}>
          期权管理
        </Title>
        <Space>
          <Select
            placeholder="选择证券账户"
            style={{ width: 200 }}
            value={selectedAccountId || undefined}
            onChange={setSelectedAccountId}
            options={accounts.map((a) => ({
              label: a.name,
              value: a.id,
            }))}
          />
          <Upload
            accept=".csv"
            showUploadList={false}
            beforeUpload={handleImport}
            disabled={!selectedAccountId}
          >
            <Button icon={<UploadOutlined />} disabled={!selectedAccountId}>
              导入CSV
            </Button>
          </Upload>
          <Button
            icon={<DeleteOutlined />}
            danger
            disabled={!selectedAccountId || contracts.length === 0}
            onClick={openDeleteModal}
          >
            清除记录
          </Button>

          <Modal
            title="清除期权记录"
            open={deleteModalOpen}
            onOk={handleDelete}
            onCancel={() => {
              setDeleteModalOpen(false);
              setConfirmName("");
            }}
            okText="确认删除"
            cancelText="取消"
            okButtonProps={{
              danger: true,
              disabled: confirmName !== selectedAccountName,
            }}
            cancelButtonProps={{
              autoFocus: true,
            }}
          >
            <div style={{ marginBottom: 16 }}>
              <Text type="danger" strong>
                此操作将永久删除该账户的所有期权记录，不可恢复！
              </Text>
            </div>
            <div style={{ marginBottom: 8 }}>
              <Text>请输入账户名称以确认删除：</Text>
              <Text strong style={{ marginLeft: 4 }}>
                {selectedAccountName}
              </Text>
            </div>
            <Input
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              placeholder="请输入账户名称"
              onPressEnter={(e) => {
                if (confirmName === selectedAccountName) {
                  handleDelete();
                } else {
                  e.preventDefault();
                }
              }}
            />
          </Modal>
        </Space>
      </div>

      {!selectedAccountId && (
        <Alert
          title="请先选择证券账户"
          description="选择一个证券账户后，可以导入期权CSV记录并查看期权合约状态。"
          type="info"
          showIcon
        />
      )}

      {selectedAccountId && (
        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          tabBarExtraContent={
            latestTradeTime ? (
              <Text type="secondary" style={{ paddingRight: 8 }}>
                最新交易时间：{latestTradeTime.substring(0, 10)}
              </Text>
            ) : null
          }
          items={[
            {
              key: "active",
              label: `进行中 (${activeContracts.length})`,
              children: renderActiveTab(),
            },
            {
              key: "expired",
              label: `已到期 (${expiredContracts.length})`,
              children: renderExpiredTab(),
            },
          ]}
        />
      )}
    </div>
  );
}
