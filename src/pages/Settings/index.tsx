import { Tabs, Typography, Space, Tag } from "antd";
import { SettingOutlined } from "@ant-design/icons";
import AIPage from "../AI";
import GeneralSettings from "./GeneralSettings";
import StockSplitSettings from "./StockSplitSettings";
import BackupSettings from "./BackupSettings";

const { Title } = Typography;

export default function SettingsPage() {
  const items = [
    {
      key: "general",
      label: "⚙️ 通用设置",
      children: <GeneralSettings />,
    },
    {
      key: "stockSplits",
      label: "📊 期权管理",
      children: <StockSplitSettings />,
    },
    {
      key: "backup",
      label: "💾 SQLite 备份",
      children: <BackupSettings />,
    },
    {
      key: "ai",
      label: (
        <Space>
          🤖 AI 配置
          <Tag color="orange" style={{ fontSize: 10 }}>实验性</Tag>
        </Space>
      ),
      children: <AIPage />,
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Title level={2}>
        <SettingOutlined /> 设置
      </Title>
      <Tabs items={items} />
    </div>
  );
}
