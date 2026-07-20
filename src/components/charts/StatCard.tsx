import { Card, Statistic } from "antd";
import { ArrowUpOutlined, ArrowDownOutlined } from "@ant-design/icons";
import { usePnlColor } from "../../hooks/usePnlColor";

interface StatCardProps {
  title: string;
  value: string | number;
  prefix?: React.ReactNode;
  suffix?: string;
  change?: number;
  changeLabel?: string;
  valueStyle?: React.CSSProperties;
  loading?: boolean;
}

export default function StatCard({
  title,
  value,
  prefix,
  suffix,
  change,
  changeLabel,
  valueStyle,
  loading,
}: StatCardProps) {
  const { pnlColor } = usePnlColor();
  const changeColor =
    change === undefined ? undefined : pnlColor(change);

  return (
    <Card loading={loading} styles={{ body: { padding: "16px 20px" } }}>
      <Statistic
        title={title}
        value={value}
        prefix={prefix}
        suffix={suffix}
        styles={{ content: valueStyle }}
      />
      {change !== undefined && (
        <div style={{ marginTop: 4, color: changeColor, fontSize: 13 }}>
          {change >= 0 ? <ArrowUpOutlined /> : <ArrowDownOutlined />}{" "}
          {Math.abs(change).toFixed(2)}%
          {changeLabel && <span style={{ color: "#888", marginLeft: 4 }}>{changeLabel}</span>}
        </div>
      )}
    </Card>
  );
}
