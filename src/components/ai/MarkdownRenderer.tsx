import { memo, useCallback, type ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Tooltip, message as antdMessage } from "antd";
import { CopyOutlined, CheckOutlined } from "@ant-design/icons";
import { useState } from "react";

/**
 * Markdown renderer tuned for AI chat output, mirroring the Claude / ZCode
 * reading experience:
 *
 * - GFM (tables, strikethrough, task lists) via remark-gfm.
 * - Syntax highlighting for fenced code blocks via rehype-highlight
 *   (lowlight / highlight.js, which is already a transitive dep). Theme
 *   colors come from the `.hljs` CSS in global.css.
 * - A custom `code` renderer that wraps fenced blocks with a header bar
 *   showing the language label and a copy button. Inline code is untouched.
 *
 * Memoized so streaming token appends only re-render this subtree (not the
 * whole message list).
 */
function CodeBlockHeader({
  language,
  code,
}: {
  language: string | null;
  code: string;
}) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      antdMessage.success("已复制代码");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      antdMessage.error("复制失败");
    }
  }, [code]);

  return (
    <div className="ai-code-header">
      <span className="ai-code-lang">{language ?? "code"}</span>
      <Tooltip title="复制代码">
        <button
          type="button"
          className="ai-code-copy"
          onClick={onCopy}
          aria-label="复制代码"
        >
          {copied ? <CheckOutlined /> : <CopyOutlined />}
        </button>
      </Tooltip>
    </div>
  );
}

/**
 * react-markdown v10 no longer passes an `inline` prop to the `code` renderer.
 * We detect a fenced block by the presence of a `language-*` className (set by
 * the markdown parser for fenced blocks; absent for inline code). This is the
 * recommended detection approach for v9+.
 *
 * For fenced blocks we render our own <pre> wrapper (with header + highlight)
 * so we suppress react-markdown's default <pre> by also overriding `pre`.
 */
function CodeRenderer({ className, children, ...rest }: ComponentProps<"code">) {
  const match = /language-(\w+)/.exec(className ?? "");
  const isBlock = !!match || String(children).includes("\n");

  if (!isBlock) {
    // Inline code — let the global CSS style it as a pill.
    return (
      <code className={className} {...rest}>
        {children}
      </code>
    );
  }

  const language = match?.[1] ?? null;
  const codeText = String(children).replace(/\n$/, "");

  return (
    <div className="ai-code-block">
      <CodeBlockHeader language={language} code={codeText} />
      <pre>
        {/* rehype-highlight decorates this <code> with .hljs + spans.
            Keep className so highlight tokens apply. */}
        <code className={className} {...rest}>
          {children}
        </code>
      </pre>
    </div>
  );
}

// Suppress react-markdown's own <pre> wrapper: we render <pre> ourselves
// inside the code renderer (above), wrapped in the header container.
function PreRenderer({ children }: ComponentProps<"pre">) {
  return <>{children}</>;
}

export const MarkdownRenderer = memo(function MarkdownRenderer({
  content,
}: {
  content: string;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
      components={{ code: CodeRenderer, pre: PreRenderer }}
    >
      {content}
    </ReactMarkdown>
  );
});
