import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Input, Popconfirm, Space, Switch, Tag, Tooltip, Typography, message } from "antd";
import {
  RobotOutlined,
  SendOutlined,
  DeleteOutlined,
  SettingOutlined,
  UserOutlined,
  StopOutlined,
  ClockCircleOutlined,
  ThunderboltOutlined,
  EditOutlined,
  CheckOutlined,
  CloseOutlined,
  PlusOutlined,
  MessageOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  RedoOutlined,
  LoadingOutlined,
} from "@ant-design/icons";
import { useNavigate } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useChatStore, selectSessionTotalTokens } from "../../stores/chatStore";
import { useChatSessionStore } from "../../stores/chatSessionStore";
import { useAiStore } from "../../stores/aiStore";
import type { ChatMessageWithMeta, ChatSession, ChatUsage } from "../../types";

const { Title, Text } = Typography;
const { TextArea } = Input;

// Suggested starter prompts shown beneath the composer in the empty state.
const SUGGESTIONS = [
  "分析一下我当前持仓的集中度和风险",
  "近一年绩效表现如何？哪些标的贡献最大？",
  "基于近期交易，评估我的操作决策质量",
  "给出个性化的投资建议和改进方向",
];

export default function AiAssistantPage() {
  const navigate = useNavigate();
  const {
    sessions,
    currentSessionId,
    fetchSessions,
    deleteSession,
    renameSession,
    setCurrentSession,
  } = useChatSessionStore();
  const { init } = useChatStore();
  // Subscribe to the streaming session id so the sidebar can highlight which
  // session is actively generating (foreground or background). Selector form
  // avoids re-rendering the whole page on every unrelated chatStore change.
  const streamingSessionId = useChatStore((s) => s.streamingSessionIdState);
  const { fetchConfig } = useAiStore();

  const [bootstrapped, setBootstrapped] = useState(false);

  // One-time bootstrap: bind streaming listeners, load AI config, load the
  // session list. We deliberately leave currentSessionId null so the page
  // opens on the "new chat" welcome screen (ChatGPT-style) — the user picks
  // a history item from the sidebar or starts typing to begin a new chat,
  // at which point a session is created lazily.
  useEffect(() => {
    init();
    fetchConfig();
    (async () => {
      await fetchSessions();
      setBootstrapped(true);
    })();
  }, [init, fetchConfig, fetchSessions]);

  // "New chat" button: switch to the welcome screen without creating a
  // session. A session is created lazily when the user actually sends.
  const handleNewChat = () => {
    setCurrentSession(null);
  };

  const handleDeleteSession = async (id: string) => {
    await deleteSession(id);
  };

  return (
    // The global MainLayout wraps every page in a `<Content className="p-6">`
    // that adds 24px of padding on all sides. For most pages that whitespace
    // is desirable, but the AI assistant has its own full-height sidebar
    // that should dock flush against the left edge (next to the nav menu).
    // We cancel the parent's padding with a negative margin and grow to fill
    // the resulting expanded box.
    <div
      className="flex"
      style={{ margin: "-24px", height: "calc(100% + 48px)" }}
    >
      <SessionSidebar
        sessions={sessions}
        currentSessionId={currentSessionId}
        streamingSessionId={streamingSessionId}
        onSelect={setCurrentSession}
        onNew={handleNewChat}
        onDelete={handleDeleteSession}
        onRename={renameSession}
      />
      <div className="flex flex-col h-full flex-1 min-w-0">
        {bootstrapped ? (
          <ChatPanel
            sessionId={currentSessionId}
            navigate={navigate}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-400">
            <Text type="secondary">加载中…</Text>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Session sidebar
// ─────────────────────────────────────────────────────────────────────────────

function SessionSidebar({
  sessions,
  currentSessionId,
  streamingSessionId,
  onSelect,
  onNew,
  onDelete,
  onRename,
}: {
  sessions: ChatSession[];
  currentSessionId: string | null;
  /** Session id whose AI turn is currently generating (foreground or
   * background), or null when idle. Highlighted so the user can tell which
   * session is still replying — especially after switching away. */
  streamingSessionId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
}) {
  // Collapsed by default — users expand it on demand to browse/manage
  // chats. The collapsed rail still shows per-chat icons (with the active
  // one highlighted) so switching is one click away.
  const [collapsed, setCollapsed] = useState(true);

  if (collapsed) {
    // Collapsed rail: a thin icon column. New-chat + toggle on top, chat
    // icons below (active one highlighted). The "new chat" action just
    // switches to the welcome screen — no session is created until send.
    return (
      <aside className="w-14 flex-shrink-0 border-r border-gray-200 bg-gray-50 flex flex-col items-center py-2 gap-1">
        <Tooltip title="新聊天" placement="right">
          <Button
            type="primary"
            shape="circle"
            icon={<PlusOutlined />}
            onClick={onNew}
          />
        </Tooltip>
        <Tooltip title="展开聊天列表" placement="right">
          <Button
            type="text"
            shape="circle"
            icon={<MenuUnfoldOutlined />}
            onClick={() => setCollapsed(false)}
          />
        </Tooltip>
        <div className="w-full h-px bg-gray-200 my-1" />
        <div className="flex-1 overflow-y-auto w-full flex flex-col items-center gap-1 px-1">
          {sessions.map((s) => {
            const isActive = s.id === currentSessionId;
            const isStreaming = s.id === streamingSessionId;
            return (
              <Tooltip
                key={s.id}
                title={
                  isStreaming ? `${s.name}（正在生成…）` : s.name
                }
                placement="right"
              >
                <button
                  onClick={() => onSelect(s.id)}
                  className={`relative w-9 h-9 rounded-full flex items-center justify-center text-sm font-medium transition-colors flex-shrink-0 ${
                    isActive
                      ? "bg-purple-500 text-white"
                      : "bg-gray-200 text-gray-600 hover:bg-gray-300"
                  }`}
                >
                  {sessionInitial(s.name)}
                  {isStreaming && (
                    <span
                      className="absolute inset-0 rounded-full border-2 border-purple-400 animate-ping"
                      style={{ animationDuration: "1.5s" }}
                    />
                  )}
                </button>
              </Tooltip>
            );
          })}
        </div>
      </aside>
    );
  }

  return (
    <aside className="w-60 flex-shrink-0 border-r border-gray-200 bg-gray-50 flex flex-col">
      <div className="p-2 border-b border-gray-200 flex items-center gap-2">
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={onNew}
          style={{ flex: 1 }}
        >
          新聊天
        </Button>
        <Tooltip title="收起聊天列表">
          <Button
            type="text"
            icon={<MenuFoldOutlined />}
            onClick={() => setCollapsed(true)}
          />
        </Tooltip>
      </div>
      <div className="flex-1 overflow-y-auto py-2">
        {sessions.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-gray-400">
            暂无聊天记录
          </div>
        ) : (
          sessions.map((s) => (
            <SessionItem
              key={s.id}
              session={s}
              active={s.id === currentSessionId}
              streaming={s.id === streamingSessionId}
              onSelect={() => onSelect(s.id)}
              onDelete={() => onDelete(s.id)}
              onRename={(name) => onRename(s.id, name)}
            />
          ))
        )}
      </div>
    </aside>
  );
}

/** Pick a 1-2 char label for a collapsed-rail avatar. Prefers the first
 * meaningful (non-ASCII-prefix) character of the name. */
function sessionInitial(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  // For "新聊天 ..." defaults, show the time digits instead of "新".
  const match = trimmed.match(/^新聊天\s+(\d{2}):(\d{2})$/);
  if (match) return match[1];
  return Array.from(trimmed)[0];
}

function SessionItem({
  session,
  active,
  streaming,
  onSelect,
  onDelete,
  onRename,
}: {
  session: { id: string; name: string; updated_at: string };
  active: boolean;
  streaming: boolean;
  onSelect: () => void;
  onDelete: () => Promise<void>;
  onRename: (name: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.name);

  const submitRename = async () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== session.name) {
      await onRename(trimmed);
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="px-2 py-1.5">
        <Input
          size="small"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onPressEnter={submitRename}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setDraft(session.name);
              setEditing(false);
            }
          }}
          suffix={
            <CheckOutlined
              onClick={submitRename}
              style={{ color: "#52c41a", cursor: "pointer" }}
            />
          }
        />
      </div>
    );
  }

  return (
    <div
      className={`group flex items-center gap-2 px-2 mx-2 my-0.5 py-2 rounded cursor-pointer transition-colors ${
        active ? "bg-purple-100 text-purple-900" : "hover:bg-gray-200 text-gray-700"
      }`}
      onClick={onSelect}
    >
      {streaming ? (
        <LoadingOutlined
          style={{ fontSize: 14, flexShrink: 0, color: "#7c3aed" }}
        />
      ) : (
        <MessageOutlined style={{ fontSize: 14, flexShrink: 0 }} />
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <div
            className="truncate text-sm"
            title={session.name}
          >
            {session.name}
          </div>
          {streaming && (
            <span
              className="flex-shrink-0 text-xs text-purple-500"
              style={{ fontSize: 11 }}
            >
              生成中…
            </span>
          )}
        </div>
        <div className="text-xs text-gray-400">
          {streaming ? "AI 正在回复" : formatRelativeTime(session.updated_at)}
        </div>
      </div>
      <div className="flex-shrink-0 opacity-0 group-hover:opacity-100 flex items-center">
        <Button
          type="text"
          size="small"
          icon={<EditOutlined />}
          onClick={(e) => {
            e.stopPropagation();
            setDraft(session.name);
            setEditing(true);
          }}
          style={{ padding: "0 4px" }}
        />
        <Popconfirm
          title="删除该会话？"
          description="会话中的所有对话将一并删除。"
          okText="删除"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          // IMPORTANT: do NOT return the promise. Antd v6's Popconfirm enters a
          // "confirm-button loading" state while awaiting a returned promise,
          // and because deleting the active session re-mounts the chat panel
          // (changing currentSessionId), the Popconfirm can be unmounted
          // mid-flight leaving the button seemingly stuck. Fire-and-forget
          // lets the popover close immediately; the store handles the rest.
          onConfirm={(e) => {
            e?.stopPropagation();
            void onDelete().catch((err) => {
              console.error("[SessionItem] delete failed", err);
              message.error("删除会话失败：" + String(err));
            });
          }}
          onCancel={(e) => e?.stopPropagation()}
        >
          <Button
            type="text"
            size="small"
            danger
            icon={<DeleteOutlined />}
            onClick={(e) => e.stopPropagation()}
            style={{ padding: "0 4px" }}
          />
        </Popconfirm>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Chat panel (right side)
// ─────────────────────────────────────────────────────────────────────────────

function ChatPanel({
  sessionId,
  navigate,
}: {
  // null means "no active session" (welcome screen). A session is created
  // lazily on the first send.
  sessionId: string | null;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const {
    messages,
    sending,
    error,
    contextEnabled,
    streamingInBackground,
    streamingSessionIdState: streamingSessionId,
    sendMessage,
    editAndResend,
    retryLastTurn,
    dismissError,
    stopGeneration,
    clearMessages,
    setContextEnabled,
    loadSessionMessages,
    resetForSessionSwitch,
  } = useChatStore();
  const { config } = useAiStore();
  const touchSession = useChatSessionStore((s) => s.touchSession);
  const autoRenameIfDefault = useChatSessionStore((s) => s.autoRenameIfDefault);
  const createSession = useChatSessionStore((s) => s.createSession);
  // Used by the "background stream" banner's "回到该会话" button to jump
  // directly to the session that's currently generating in the background.
  const setCurrentSession = useChatSessionStore((s) => s.setCurrentSession);

  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const loadedSessionRef = useRef<string | null>(null);
  // Set BEFORE calling ensureSession() when sending from the welcome screen.
  // It tells the session-change effect that the *next* sessionId change
  // (null → newly created id) is the send-from-welcome flow and must NOT
  // reload — the in-memory user + assistant placeholder is about to be
  // pushed and a reload (DB still empty) would wipe it, bouncing the UI
  // back to the welcome screen.
  //
  // This flag must be set *before* the await on ensureSession, not after.
  // createSession() synchronously commits currentSessionId to the store,
  // which schedules a React re-render; that re-render (and this effect) can
  // run during the await, before any code after ensureSession gets a chance
  // to run. Setting the flag post-await loses the race.
  //
  // One-shot: consumed and cleared by the effect on the first sessionId
  // change after being set, so it can't suppress a later genuine switch.
  const expectingSessionCreation = useRef(false);

  // Load messages whenever the active session changes.
  //
  // Three cases to be careful about:
  //  1. Switching history sessions (A → B): reload B from DB.
  //  2. Sending from the new-chat welcome screen: `ensureSession` creates a
  //     session and currentSessionId flips null → newId. That change must NOT
  //     trigger a reload — the store is about to hold the user + assistant
  //     placeholder for the in-flight turn, and a reload (DB still empty)
  //     would wipe them, making the conversation vanish.
  //  3. Switching sessions *while* a stream is running on the current one:
  //     we must abort the stream, persist what we already have, and then load
  //     the newly selected session. Doing nothing (as the old sendingRef flag
  //     did) would leave the right panel stuck on the old session's content.
  //
  // Crucially, `messages.length` is NOT in the dependency array — otherwise
  // every token streamed would retrigger this effect and reload over the
  // in-progress reply.
  useEffect(() => {
    if (sessionId === null) {
      // Switching to "new chat" welcome screen: clear the loaded session
      // marker and wipe the in-memory messages so the welcome hero shows
      // instead of the previous conversation. Abort any in-flight stream.
      loadedSessionRef.current = null;
      expectingSessionCreation.current = false;
      void resetForSessionSwitch();
      return;
    }
    if (loadedSessionRef.current === sessionId) return;
    loadedSessionRef.current = sessionId;
    // Sending from welcome screen: skip reload, keep in-flight messages.
    if (expectingSessionCreation.current) {
      expectingSessionCreation.current = false;
      return;
    }
    (async () => {
      await resetForSessionSwitch();
      await loadSessionMessages(sessionId);
    })();
    // Intentionally exclude messages.length — see comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, resetForSessionSwitch, loadSessionMessages]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sessionTotal = useMemo(
    () => selectSessionTotalTokens(messages),
    [messages],
  );

  const providerIsOllama = config?.provider === "ollama";
  const notConfigured =
    config && (!config.model || (!providerIsOllama && !config.api_key));

  // Resolve the effective session id, creating one on the fly if the user is
  // composing in the no-session welcome state. Returns null if creation
  // failed (so the caller can bail out).
  const ensureSession = async (): Promise<string | null> => {
    if (sessionId) return sessionId;
    try {
      const s = await createSession();
      return s.id;
    } catch (err) {
      message.error("创建会话失败：" + String(err));
      return null;
    }
  };

  const handleSend = async () => {
    if (!input.trim()) return;
    if (notConfigured) {
      message.warning("请先在「设置 → AI 配置」中完成配置");
      return;
    }
    // The backend is single-stream: only one AI turn can run at a time. If a
    // turn is in flight (foreground here, or backgrounded after switching),
    // refuse the send with an actionable hint instead of silently dropping it.
    if (sending) {
      message.warning(
        streamingInBackground
          ? "有一条 AI 回复正在后台生成，请等待完成后再发送"
          : "AI 正在回复中，请等待当前回复完成后再发送",
      );
      return;
    }
    const text = input;
    const wasEmpty = messages.length === 0;
    setInput("");
    // Sending from the welcome screen: ensureSession will create a session
    // and currentSessionId flips null → newId. Set the expectation flag
    // BEFORE the await so the session-change effect (which can run during
    // the await) skips its reload — otherwise resetForSessionSwitch wipes
    // the in-memory placeholder and the UI bounces back to the welcome hero.
    const wasNewChat = !sessionId;
    if (wasNewChat) expectingSessionCreation.current = true;
    const sid = await ensureSession();
    if (!sid) {
      expectingSessionCreation.current = false;
      return;
    }
    await sendMessage(text, sid);
    await touchSession(sid);
    if (wasEmpty) {
      void autoRenameIfDefault(sid, text);
    }
  };

  const handleSuggestion = async (s: string) => {
    if (notConfigured) return;
    if (sending) {
      message.warning(
        streamingInBackground
          ? "有一条 AI 回复正在后台生成，请等待完成后再发送"
          : "AI 正在回复中，请等待当前回复完成后再发送",
      );
      return;
    }
    const wasEmpty = messages.length === 0;
    const wasNewChat = !sessionId;
    if (wasNewChat) expectingSessionCreation.current = true;
    const sid = await ensureSession();
    if (!sid) {
      expectingSessionCreation.current = false;
      return;
    }
    await sendMessage(s, sid);
    await touchSession(sid);
    if (wasEmpty) {
      void autoRenameIfDefault(sid, s);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleClear = async () => {
    if (!sessionId) return;
    await clearMessages(sessionId);
  };

  const hasMessages = messages.length > 0;

  return (
    <div className="flex flex-col h-full">
      {/* Top bar — only shown once the conversation has started. In the empty
          state the title lives in the centered hero block instead. */}
      {hasMessages && (
        <div className="flex items-center justify-between flex-wrap gap-3 mb-3 px-6">
          <Title level={3} style={{ margin: 0 }}>
            <RobotOutlined /> AI 助手
          </Title>
          <Space>
            {sessionTotal > 0 && (
              <Tag icon={<ThunderboltOutlined />} color="purple">
                本会话 {sessionTotal.toLocaleString()} tokens
              </Tag>
            )}
            <Tooltip title="开启后，AI 会参考你的实时持仓与绩效回答">
              <Space size="small">
                <Switch
                  checked={contextEnabled}
                  onChange={setContextEnabled}
                  size="small"
                />
                <Text type="secondary" style={{ fontSize: 13 }}>
                  注入数据
                </Text>
              </Space>
            </Tooltip>
            <Popconfirm
              title="清空当前会话的所有消息？"
              description="该操作不可撤销，会话本身会保留。"
              okText="清空"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={handleClear}
            >
              <Button
                size="small"
                icon={<DeleteOutlined />}
                disabled={sending || messages.length === 0}
              >
                清空对话
              </Button>
            </Popconfirm>
          </Space>
        </div>
      )}

      {error && (
        <Alert
          type="error"
          showIcon
          title={error}
          closable
          className="mb-3"
        />
      )}

      {streamingInBackground && (
        <Alert
          type="info"
          showIcon
          icon={<ClockCircleOutlined />}
          title="另一会话的 AI 回复正在后台生成中，完成前暂时无法发送新消息"
          className="mb-3"
          style={{ paddingBlock: 6, paddingInline: 12 }}
          action={
            streamingSessionId ? (
              <Button
                size="small"
                type="primary"
                onClick={() => setCurrentSession(streamingSessionId)}
              >
                回到该会话
              </Button>
            ) : undefined
          }
        />
      )}

      {hasMessages ? (
        <>
          <div className="flex-1 overflow-y-auto bg-white rounded-lg border border-gray-200 p-6">
            <div className="space-y-6">
              {messages.map((m, i) => (
                <MessageRow
                  key={m.id}
                  message={m}
                  // Only show the streaming indicator when the in-flight turn
                  // is actually on screen (foreground). When it's backgrounded
                  // in another session, the current view's last message is NOT
                  // being streamed into and must not show a pulsing cursor.
                  streaming={
                    sending && !streamingInBackground && i === messages.length - 1
                  }
                  // Editing resends through the single backend stream, so it's
                  // disabled whenever ANY stream is in flight (foreground or
                  // backgrounded). Allowing edit-while-backgrounding would let
                  // the user submit, only for editAndResend to silently no-op.
                  canEdit={!sending}
                  onEdit={(text) => {
                    if (sessionId) editAndResend(m.id, text, sessionId);
                  }}
                  onRetry={
                    m.error && sessionId
                      ? () => void retryLastTurn(sessionId)
                      : undefined
                  }
                  onDismiss={m.error ? () => dismissError(m.id) : undefined}
                />
              ))}
              <div ref={messagesEndRef} />
            </div>
          </div>
          <div className="mt-3">
            <Composer
              input={input}
              setInput={setInput}
              handleKeyDown={handleKeyDown}
              handleSend={handleSend}
              stopGeneration={stopGeneration}
              sending={sending}
              notConfigured={!!notConfigured}
            />
          </div>
        </>
      ) : (
        <div className="flex-1 overflow-y-auto flex items-center justify-center">
          <div className="w-full max-w-3xl px-4">
            <div className="text-center mb-8">
              <div
                className="inline-flex items-center justify-center w-16 h-16 rounded-full text-white text-2xl mb-4"
                style={{ background: "linear-gradient(135deg, #7c3aed 0%, #4f46e5 100%)" }}
              >
                <RobotOutlined />
              </div>
              <Title level={2} style={{ marginBottom: 8 }}>
                今天能帮你分析什么？
              </Title>
              <Text type="secondary">
                {contextEnabled
                  ? "已开启组合数据注入，AI 会参考你的实时持仓与绩效"
                  : "组合数据注入已关闭"}
              </Text>
            </div>

            {notConfigured ? (
              <Alert
                type="warning"
                showIcon
                title="尚未完成 AI 配置"
                description={
                  <Space>
                    <span>需要先配置服务商、API Key 与模型后才能开始对话。</span>
                    <Button
                      size="small"
                      type="link"
                      icon={<SettingOutlined />}
                      onClick={() => navigate("/settings")}
                    >
                      去配置
                    </Button>
                  </Space>
                }
                className="mb-6"
              />
            ) : (
              <Composer
                input={input}
                setInput={setInput}
                handleKeyDown={handleKeyDown}
                handleSend={handleSend}
                stopGeneration={stopGeneration}
                sending={sending}
                notConfigured={!!notConfigured}
                size="large"
              />
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-4">
              {SUGGESTIONS.map((s) => (
                <Button
                  key={s}
                  disabled={!!notConfigured}
                  onClick={() => handleSuggestion(s)}
                  style={{ textAlign: "left", whiteSpace: "normal", height: "auto", padding: "10px 14px" }}
                >
                  {s}
                </Button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Composer({
  input,
  setInput,
  handleKeyDown,
  handleSend,
  stopGeneration,
  sending,
  notConfigured,
  size = "default",
}: {
  input: string;
  setInput: (v: string) => void;
  handleKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  handleSend: () => void;
  stopGeneration: () => void;
  sending: boolean;
  notConfigured: boolean;
  size?: "default" | "large";
}) {
  const minRows = size === "large" ? 2 : 1;
  const canSend = input.trim().length > 0 && !notConfigured;

  // The send/stop button sits in the bottom-right corner of the textarea
  // wrapper. To keep the button inside the box at every textarea height we
  // fix the vertical padding (`py`) and place the button flush with that
  // padding (`bottom: 7`), and bump the small-size min height so there is
  // always room for the 34px button plus breathing space.
  return (
    <div className="relative">
      <TextArea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={notConfigured ? "请先完成 AI 配置…" : "输入问题，Ctrl/⌘+Enter 发送"}
        autoSize={{ minRows, maxRows: 8 }}
        disabled={notConfigured}
        style={{
          paddingRight: 56,
          paddingTop: 12,
          paddingBottom: 12,
          minHeight: size === "large" ? 72 : 60,
          ...(size === "large" ? { fontSize: 15 } : {}),
        }}
      />
      <button
        type="button"
        onClick={sending ? stopGeneration : handleSend}
        disabled={!sending && !canSend}
        aria-label={sending ? "停止生成" : "发送"}
        className="absolute flex items-center justify-center text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
        style={{
          right: 9,
          bottom: 9,
          width: 34,
          height: 34,
          borderRadius: 9999,
          border: "none",
          cursor: "pointer",
          background: sending
            ? "linear-gradient(135deg, #ef4444 0%, #dc2626 100%)"
            : "linear-gradient(135deg, #7c3aed 0%, #4f46e5 100%)",
          boxShadow: "0 2px 6px rgba(0,0,0,0.15)",
        }}
      >
        {sending ? <StopOutlined style={{ fontSize: 16 }} /> : <SendOutlined style={{ fontSize: 16 }} />}
      </button>
    </div>
  );
}

function MessageRow({
  message,
  streaming,
  canEdit,
  onEdit,
  onRetry,
  onDismiss,
}: {
  message: ChatMessageWithMeta;
  streaming: boolean;
  canEdit?: boolean;
  onEdit?: (newContent: string) => void;
  /** Retry the failed assistant turn this row represents. */
  onRetry?: () => void;
  /** Remove this failed assistant row from the list. */
  onDismiss?: () => void;
}) {
  const isUser = message.role === "user";
  const timeLabel = formatTime(message.createdAt);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);

  const avatar = (
    <div
      className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-white text-sm ${
        isUser ? "bg-blue-500" : "bg-gradient-to-br from-purple-500 to-indigo-600"
      }`}
    >
      {isUser ? <UserOutlined /> : <RobotOutlined />}
    </div>
  );

  if (isUser) {
    const startEdit = () => {
      setDraft(message.content);
      setEditing(true);
    };
    const cancelEdit = () => setEditing(false);
    const submitEdit = () => {
      const text = draft.trim();
      if (!text || !onEdit) return;
      setEditing(false);
      onEdit(text);
    };

    if (editing) {
      return (
        <div className="flex gap-3 justify-end">
          <div className="max-w-[75%] w-full">
            <div className="rounded-2xl rounded-tr-sm bg-white border border-blue-300 p-2">
              <TextArea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                autoSize={{ minRows: 1, maxRows: 8 }}
                autoFocus
                onPressEnter={(e) => {
                  if (e.ctrlKey || e.metaKey) {
                    e.preventDefault();
                    submitEdit();
                  }
                }}
              />
              <div className="flex justify-end gap-2 mt-2">
                <Button size="small" icon={<CloseOutlined />} onClick={cancelEdit}>
                  取消
                </Button>
                <Button
                  size="small"
                  type="primary"
                  icon={<CheckOutlined />}
                  disabled={!draft.trim() || draft.trim() === message.content}
                  onClick={submitEdit}
                >
                  保存并提交
                </Button>
              </div>
            </div>
          </div>
          {avatar}
        </div>
      );
    }

    return (
      <div className="group flex gap-3 justify-end">
        <div className="max-w-[75%]">
          <div className="rounded-2xl rounded-tr-sm bg-blue-500 text-white px-4 py-2">
            <div className="whitespace-pre-wrap break-words">{message.content}</div>
          </div>
          <div className="flex items-center justify-end gap-2 mt-1 h-5">
            {canEdit && (
              <Button
                type="text"
                size="small"
                className="opacity-0 group-hover:opacity-100 transition-opacity text-gray-400 hover:text-blue-500"
                style={{ fontSize: 12, padding: "0 4px" }}
                icon={<EditOutlined />}
                onClick={startEdit}
              >
                编辑
              </Button>
            )}
            <MessageMeta time={timeLabel} align="right" inline />
          </div>
        </div>
        {avatar}
      </div>
    );
  }

  return (
    <div className="flex gap-3">
      {avatar}
      <div className="flex-1 min-w-0 pt-0.5">
        {message.error ? (
          <ErrorCard
            error={message.error}
            time={timeLabel}
            onRetry={onRetry}
            onDismiss={onDismiss}
          />
        ) : message.content ? (
          <div className="ai-chat-md">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {message.content}
            </ReactMarkdown>
            {streaming && (
              <span className="inline-block w-2 h-4 ml-0.5 bg-purple-500 animate-pulse align-middle" />
            )}
          </div>
        ) : (
          <Text type="secondary" className="ai-chat-md">
            {streaming ? "思考中…" : ""}
          </Text>
        )}
        {!streaming && !message.error && (
          <MessageMeta
            time={timeLabel}
            usage={message.usage}
            stopped={message.stopped}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Inline error card rendered in place of a failed assistant reply. Shows the
 * error message, a retry button (re-issues the same turn), and a dismiss
 * button (removes the placeholder so the user can move on or re-edit).
 */
function ErrorCard({
  error,
  time,
  onRetry,
  onDismiss,
}: {
  error: string;
  time: string;
  onRetry?: () => void;
  onDismiss?: () => void;
}) {
  return (
    <Alert
      type="error"
      showIcon
      className="rounded-2xl rounded-tl-sm"
      style={{ padding: "8px 12px" }}
      title={
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-red-600 font-medium text-sm">AI 回复失败</div>
            <div
              className="text-xs text-gray-600 mt-0.5 break-words whitespace-pre-wrap"
              style={{ maxHeight: 120, overflow: "auto" }}
            >
              {error}
            </div>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {onRetry && (
              <Button
                size="small"
                type="primary"
                icon={<RedoOutlined />}
                onClick={onRetry}
              >
                重试
              </Button>
            )}
            {onDismiss && (
              <Button
                size="small"
                type="text"
                icon={<CloseOutlined />}
                onClick={onDismiss}
              />
            )}
          </div>
        </div>
      }
      description={
        <div className="text-xs text-gray-400 mt-1">
          <ClockCircleOutlined style={{ fontSize: 11, marginRight: 4 }} />
          {time}
        </div>
      }
    />
  );
}

function MessageMeta({
  time,
  usage,
  stopped,
  align = "left",
  inline = false,
}: {
  time: string;
  usage?: ChatUsage;
  stopped?: boolean;
  align?: "left" | "right";
  inline?: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-2 flex-wrap text-xs text-gray-400 ${
        inline ? "" : "mt-1.5 "
      }${align === "right" ? "justify-end" : ""}`}
    >
      <span className="inline-flex items-center gap-1">
        <ClockCircleOutlined style={{ fontSize: 11 }} />
        {time}
      </span>
      {stopped && (
        <Tag color="orange" style={{ margin: 0, fontSize: 11 }}>
          已停止
        </Tag>
      )}
      {usage && usage.totalTokens > 0 && (
        <span>
          输入{" "}
          <Text strong style={{ fontSize: 12 }}>
            {usage.promptTokens.toLocaleString()}
          </Text>
          {usage.cachedTokens && usage.cachedTokens > 0 ? (
            <Text type="success" style={{ fontSize: 11 }}>
              {" "}
              (缓存 {usage.cachedTokens.toLocaleString()})
            </Text>
          ) : null}
          {" · "}
          输出{" "}
          <Text strong style={{ fontSize: 12 }}>
            {usage.completionTokens.toLocaleString()}
          </Text>
          {" · "}
          共{" "}
          <Text strong style={{ fontSize: 12, color: "#722ed1" }}>
            {usage.totalTokens.toLocaleString()}
          </Text>{" "}
          tokens
        </span>
      )}
    </div>
  );
}

function formatTime(epochMs: number): string {
  const d = new Date(epochMs);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** Render an RFC3339 timestamp as a short Chinese relative label. */
function formatRelativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (isNaN(t)) return "";
  const diffMs = Date.now() - t;
  const sec = Math.floor(diffMs / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);

  if (sec < 60) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  if (hr < 24) return `${hr} 小时前`;
  if (day === 1) return "昨天";
  if (day < 7) return `${day} 天前`;

  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${dd} ${hh}:${mm}`;
}
