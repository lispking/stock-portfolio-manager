import { useState, useEffect, useRef, useCallback } from "react";
import { Button, Space, Typography, message } from "antd";
import MDEditor from "@uiw/react-md-editor";
import { useQuarterlyStore } from "../../stores/quarterlyStore";

const { Text } = Typography;

interface Props {
  snapshotId: string;
  initialNotes: string;
}

const MARKET_SECTION = `### 本季度回顾
- 整体市场环境：
- 主要操作：
- 收益来源：
- 亏损来源：

### 经验教训
- 

### 下季度计划
- 关注标的：
- 仓位调整计划：
- 风险控制：
`;

const NOTE_TEMPLATE = `## 🇨🇳 A股

${MARKET_SECTION}
---

## 🇭🇰 港股

${MARKET_SECTION}
---

## 🇺🇸 美股

${MARKET_SECTION}`;

const INDENT = "  "; // 2 spaces

export default function QuarterlyNotesEditor({ snapshotId, initialNotes }: Props) {
  const { updateQuarterlyNotes } = useQuarterlyStore();
  const [notes, setNotes] = useState(initialNotes);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const pendingSelection = useRef<{ start: number; end: number } | null>(null);

  useEffect(() => {
    if (!editing) {
      setNotes(initialNotes);
    }
  }, [initialNotes, editing]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateQuarterlyNotes(snapshotId, notes);
      setEditing(false);
    } catch (err) {
      message.error("保存失败: " + String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setNotes(initialNotes);
    setEditing(false);
  };

  const handleIndent = useCallback((increase: boolean) => {
    const textarea = editorContainerRef.current?.querySelector("textarea");
    if (!textarea) return;

    const { value, selectionStart, selectionEnd } = textarea;
    const lineStart = value.lastIndexOf("\n", selectionStart - 1) + 1;
    const before = value.slice(0, lineStart);
    const region = value.slice(lineStart, selectionEnd);
    const after = value.slice(selectionEnd);

    const newRegion = increase
      ? region.replace(/^/gm, INDENT)
      : region.replace(/^  /gm, "");

    const firstLineDelta =
      newRegion.split("\n")[0].length - region.split("\n")[0].length;
    const totalDelta = newRegion.length - region.length;
    const newSelStart = Math.max(lineStart, selectionStart + firstLineDelta);
    const newSelEnd = selectionEnd + totalDelta;

    pendingSelection.current = { start: newSelStart, end: newSelEnd };
    setNotes(before + newRegion + after);
  }, []);

  useEffect(() => {
    if (pendingSelection.current) {
      const sel = pendingSelection.current;
      pendingSelection.current = null;
      requestAnimationFrame(() => {
        const textarea = editorContainerRef.current?.querySelector("textarea");
        if (textarea) {
          textarea.setSelectionRange(sel.start, sel.end);
          textarea.focus();
        }
      });
    }
  }, [notes]);

  if (!editing) {
    return (
      <div>
        {notes ? (
          <div data-color-mode="light">
            <MDEditor.Markdown source={notes} style={{ background: "transparent" }} />
          </div>
        ) : (
          <Text type="secondary">尚未填写季度总结</Text>
        )}
        <div className="mt-3">
          <Button size="small" onClick={() => setEditing(true)}>
            {notes ? "编辑总结" : "写季度总结"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <Space className="mb-2" wrap>
        {!notes && (
          <Button size="small" onClick={() => setNotes(NOTE_TEMPLATE)}>
            使用模板
          </Button>
        )}
        <Button
          size="small"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => handleIndent(true)}
        >
          增加缩进
        </Button>
        <Button
          size="small"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => handleIndent(false)}
        >
          减少缩进
        </Button>
      </Space>
      <div data-color-mode="light" ref={editorContainerRef}>
        <MDEditor value={notes} onChange={(v) => setNotes(v ?? "")} height={350} />
      </div>
      <Space className="mt-3">
        <Button onClick={handleCancel}>取消</Button>
        <Button type="primary" loading={saving} onClick={handleSave}>
          保存
        </Button>
      </Space>
    </div>
  );
}
