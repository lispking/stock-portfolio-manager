import { useEffect, useState } from "react";
import { Collapse, Tooltip } from "antd";
import { BulbOutlined } from "@ant-design/icons";

/**
 * Renders a model's chain-of-thought (`reasoning_content`) as a collapsible
 * "思考过程" block, streamed live. Mirrors the reasoning UX in Claude / ZCode:
 *
 * - While streaming: expanded by default, with a blinking pulse cursor at the
 *   end so the user sees the model is actively thinking.
 * - When finished: collapsed by default (the answer is what matters), with a
 *   character count in the header.
 *
 * The block is intentionally lightweight — reasoning is plain prose (not
 * markdown), so we render it with `whitespace-pre-wrap` to preserve line
 * breaks the model emits between reasoning steps.
 */
export function ReasoningBlock({
  reasoning,
  streaming,
}: {
  reasoning: string;
  streaming: boolean;
}) {
  // Auto-collapse once streaming finishes and we already showed it expanded.
  // We track whether we've seen streaming end so a later re-mount (e.g.
  // scrolling) doesn't re-collapse something the user opened.
  const [autoCollapsed, setAutoCollapsed] = useState(false);
  useEffect(() => {
    if (streaming) {
      setAutoCollapsed(false);
    } else if (!autoCollapsed) {
      setAutoCollapsed(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming]);

  if (!reasoning || reasoning.trim().length === 0) return null;

  const charCount = reasoning.length;
  const header = (
    <span className="flex items-center gap-1.5">
      <BulbOutlined style={{ color: "var(--color-warning)" }} />
      <span className="font-normal" style={{ color: "var(--color-text-secondary)" }}>
        {streaming ? "正在思考…" : "思考过程"}
      </span>
      <span className="text-xs font-normal" style={{ color: "var(--color-text-tertiary)" }}>
        · {charCount > 1000 ? `${(charCount / 1000).toFixed(1)}k` : charCount} 字
      </span>
    </span>
  );

  return (
    <div className="ai-reasoning mb-2">
      <Collapse
        // `activeKey` = ["1"] expands; [] collapses. We only auto-collapse on
        // stream end — explicit user toggles are still honored by Collapse
        // because we don't force `activeKey` after the first collapse.
        // Simpler approach: default expanded while streaming, collapsed after.
        defaultActiveKey={streaming ? ["1"] : []}
        activeKey={autoCollapsed ? [] : ["1"]}
        onChange={(key) => setAutoCollapsed(!Array.isArray(key) || key.length === 0)}
        size="small"
        className="ai-reasoning-collapse"
        items={[
          {
            key: "1",
            label: header,
            children: (
              <div className="ai-reasoning-body">
                <span className="whitespace-pre-wrap break-words">{reasoning}</span>
                {streaming && (
                  <Tooltip title="正在生成思考过程">
                    <span className="inline-block w-1.5 h-3.5 ml-0.5 bg-amber-500 animate-pulse align-middle rounded-sm" />
                  </Tooltip>
                )}
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}
