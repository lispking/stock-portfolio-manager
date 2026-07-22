import { useMemo, useState } from "react";
import { Collapse, Tooltip } from "antd";
import {
  CheckCircleFilled,
  CloseCircleFilled,
  DatabaseOutlined,
  LineChartOutlined,
  LoadingOutlined,
  PieChartOutlined,
  SwapOutlined,
  BellOutlined,
  TableOutlined,
  FundOutlined,
} from "@ant-design/icons";
import type { ToolCallInfo } from "../../types";

// Friendly Chinese labels for tool names. Kept in sync with the backend's
// tool definitions (src-tauri/src/services/ai_tools.rs). Exported so the chat
// page can reuse it for the legacy name-only badge fallback.
export const TOOL_LABELS: Record<string, string> = {
  get_market_overview: "大盘总览",
  get_stock_quote: "实时行情",
  get_price_history: "价格历史",
  search_stock: "代码查询",
  get_portfolio_overview: "组合总览",
  get_holdings_detail: "持仓明细",
  get_dashboard_summary: "资产总览",
  get_transactions: "交易记录",
  get_performance_metrics: "绩效指标",
  get_return_attribution: "收益归因",
  get_monthly_returns: "月度收益",
  get_drawdown_analysis: "回撤分析",
  get_risk_metrics: "风险指标",
  get_holding_ranking: "持仓排名",
  get_dividend_income: "分红收入",
  check_price_alerts: "价格提醒",
  get_option_positions: "期权持仓",
};

/** Pick an icon for a tool based on its category, inferred from the name. */
function toolIcon(name: string) {
  if (name.startsWith("get_market_overview") || name.startsWith("get_stock_quote") || name.startsWith("get_price_history")) {
    return <LineChartOutlined />;
  }
  if (name.startsWith("get_performance") || name.startsWith("get_risk") || name.startsWith("get_drawdown") || name.startsWith("get_holding_ranking")) {
    return <FundOutlined />;
  }
  if (name.startsWith("get_return") || name.startsWith("get_monthly") || name.startsWith("get_dividend")) {
    return <PieChartOutlined />;
  }
  if (name.startsWith("get_transactions")) return <SwapOutlined />;
  if (name.startsWith("check_price_alerts")) return <BellOutlined />;
  if (name.startsWith("search_stock")) return <DatabaseOutlined />;
  if (name.startsWith("get_option")) return <TableOutlined />;
  return <DatabaseOutlined />;
}

/** Pretty-print a JSON string, falling back to the raw text if invalid. */
function prettyJson(raw?: string): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return raw;
  }
}

function StatusBadge({ status }: { status: ToolCallInfo["status"] }) {
  if (status === "running") {
    return (
      <Tooltip title="执行中">
        <LoadingOutlined className="text-blue-500" />
      </Tooltip>
    );
  }
  if (status === "success") {
    return (
      <Tooltip title="成功">
        <CheckCircleFilled className="text-green-500" />
      </Tooltip>
    );
  }
  return (
    <Tooltip title="失败">
      <CloseCircleFilled className="text-red-500" />
    </Tooltip>
  );
}

/**
 * One tool invocation rendered as a Claude-style expandable card.
 *
 * Collapsed (default): a single line with icon, friendly name, status, and
 * duration. Expanded: the arguments and (on success) the returned data, each
 * as pretty-printed JSON in a scrollable code block. The user opts in to
 * expand — the collapsed row carries enough signal (status spinner/check, name,
 * duration) for the common scan-the-conversation case.
 */
export function ToolCallCard({ tool }: { tool: ToolCallInfo }) {
  // Always start collapsed — the collapsed row (icon + name + status + duration)
  // is enough signal at a glance; the user expands to inspect args/results.
  const [expanded, setExpanded] = useState(false);
  const label = TOOL_LABELS[tool.name] ?? tool.name;

  const argsPretty = useMemo(() => prettyJson(tool.arguments), [tool.arguments]);
  const resultPretty = useMemo(() => prettyJson(tool.result), [tool.result]);

  const durationLabel =
    typeof tool.durationMs === "number"
      ? tool.durationMs < 1000
        ? `${tool.durationMs} ms`
        : `${(tool.durationMs / 1000).toFixed(1)} s`
      : null;

  return (
    <div className="ai-tool-card">
      <Collapse
        size="small"
        // Default collapsed; the user opts in to inspect args/results.
        activeKey={expanded ? ["1"] : []}
        onChange={(key) => setExpanded(Array.isArray(key) && key.length > 0)}
        className="ai-tool-card-collapse"
        items={[
          {
            key: "1",
            label: (
              <div className="flex items-center gap-2 w-full min-w-0">
                <span className="text-gray-500 flex-shrink-0">{toolIcon(tool.name)}</span>
                <span className="text-gray-700 truncate">{label}</span>
                <span className="flex-shrink-0 ml-auto flex items-center gap-2">
                  {durationLabel && (
                    <span className="text-gray-400 text-xs">{durationLabel}</span>
                  )}
                  <StatusBadge status={tool.status} />
                </span>
              </div>
            ),
            children: (
              <div className="space-y-2">
                {tool.status === "error" && tool.error ? (
                  <div className="text-red-600 text-sm whitespace-pre-wrap break-words">
                    {tool.error}
                  </div>
                ) : null}
                {argsPretty && (
                  <div>
                    <div className="text-gray-400 text-xs mb-0.5">入参</div>
                    <pre className="ai-tool-card-code">{argsPretty}</pre>
                  </div>
                )}
                {tool.status === "running" && !resultPretty && (
                  <div className="text-gray-400 text-sm flex items-center gap-1.5">
                    <LoadingOutlined /> 正在执行…
                  </div>
                )}
                {resultPretty && (
                  <div>
                    <div className="text-gray-400 text-xs mb-0.5">返回结果</div>
                    <pre className="ai-tool-card-code">{resultPretty}</pre>
                  </div>
                )}
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}

/** Renders a list of tool calls as stacked cards. */
export function ToolCallList({ tools }: { tools: ToolCallInfo[] }) {
  if (!tools || tools.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 mb-1.5">
      {tools.map((t) => (
        <ToolCallCard key={t.id} tool={t} />
      ))}
    </div>
  );
}
