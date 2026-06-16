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
  Popconfirm,
  Typography,
  Alert,
} from "antd";
import {
  UploadOutlined,
  DeleteOutlined,
  DollarOutlined,
  StockOutlined,
} from "@ant-design/icons";
import { useAccountStore } from "../../stores/accountStore";
import { useOptionStore } from "../../stores/optionStore";
import type {
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
  } = useOptionStore();

  const [selectedAccountId, setSelectedAccountId] = useState<string>(() => {
    return localStorage.getItem("options_selected_account_id") || "";
  });
  const [stockPrices, setStockPrices] = useState<Record<string, number>>({});
  const [activeTab, setActiveTab] = useState<string>("active");

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

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
  }, [selectedAccountId, fetchContracts, fetchExpiredStats]);

  // Get active and expired contracts
  const activeContracts = useMemo(
    () => contracts.filter((c) => c.status === "active"),
    [contracts]
  );
  const expiredContracts = useMemo(
    () => contracts.filter((c) => c.status === "expired"),
    [contracts]
  );

  // Get unique underlyings from active contracts for price inputs
  const activeUnderlyings = useMemo(() => {
    const set = new Set<string>();
    activeContracts.forEach((c) => set.add(c.underlying));
    return Array.from(set).sort();
  }, [activeContracts]);

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
    try {
      await deleteOptionRecords(selectedAccountId);
      message.success("已清除所有期权记录");
    } catch (err) {
      message.error(`删除失败: ${err}`);
    }
  }, [selectedAccountId, deleteOptionRecords]);

  // Table columns for active contracts
  const activeColumns = [
    {
      title: "期权标识",
      dataIndex: "option_symbol",
      key: "option_symbol",
      width: 220,
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
      width: 90,
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
  ];

  // Table columns for expired contracts
  const expiredColumns = [
    ...activeColumns,
    {
      title: "结果",
      dataIndex: "close_code",
      key: "close_code",
      width: 100,
      render: (v: string | null) => {
        if (v === "A;C") return <Tag color="red">被执行</Tag>;
        if (v === "C;Ep") return <Tag color="green">已作废</Tag>;
        return <Tag>未知</Tag>;
      },
    },
  ];

  // Render active tab content with simulation
  const renderActiveTab = () => (
    <div>
      <Table
        dataSource={activeContracts}
        columns={activeColumns}
        rowKey="option_symbol"
        size="small"
        pagination={false}
        style={{ marginBottom: 24 }}
      />

      {activeUnderlyings.length > 0 && (
        <>
          <Card title="模拟计算 - 输入股票价格" size="small" style={{ marginBottom: 16 }}>
            <Row gutter={[16, 8]}>
              {activeUnderlyings.map((symbol) => (
                <Col key={symbol} span={6}>
                  <Space>
                    <Text strong>{symbol}</Text>
                    <InputNumber
                      placeholder="输入价格"
                      prefix="$"
                      min={0}
                      step={1}
                      value={stockPrices[symbol] ?? null}
                      onChange={(v) => handlePriceChange(symbol, v)}
                      style={{ width: 120 }}
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
              <div
                style={{
                  textAlign: "right",
                  borderTop: "1px solid #f0f0f0",
                  paddingTop: 8,
                  marginTop: 8,
                }}
              >
                <Title level={5} style={{ margin: 0 }}>
                  总计需要正股:{" "}
                  <Text type="danger">
                    {callSimulations
                      .reduce((sum, s) => sum + s.total_shares_needed, 0)
                      .toLocaleString()}{" "}
                    股
                  </Text>
                </Title>
              </div>
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
          <Col span={6}>
            <Card>
              <Statistic title="总合约数" value={expiredStats.total_contracts} />
            </Card>
          </Col>
          <Col span={6}>
            <Card>
              <Statistic
                title="被执行合约"
                value={expiredStats.assigned_contracts}
                valueStyle={{ color: "#cf1322" }}
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card>
              <Statistic
                title="到期作废合约"
                value={expiredStats.expired_contracts}
                valueStyle={{ color: "#3f8600" }}
              />
            </Card>
          </Col>
          <Col span={6}>
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
        dataSource={expiredContracts}
        columns={expiredColumns}
        rowKey="option_symbol"
        size="small"
        pagination={false}
      />
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
          <Popconfirm
            title="确定清除该账户所有期权记录？"
            onConfirm={handleDelete}
            disabled={!selectedAccountId || contracts.length === 0}
          >
            <Button
              icon={<DeleteOutlined />}
              danger
              disabled={!selectedAccountId || contracts.length === 0}
            >
              清除记录
            </Button>
          </Popconfirm>
        </Space>
      </div>

      {!selectedAccountId && (
        <Alert
          message="请先选择证券账户"
          description="选择一个证券账户后，可以导入期权CSV记录并查看期权合约状态。"
          type="info"
          showIcon
        />
      )}

      {selectedAccountId && (
        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          items={[
            {
              key: "active",
              label: `在进行中 (${activeContracts.length})`,
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
