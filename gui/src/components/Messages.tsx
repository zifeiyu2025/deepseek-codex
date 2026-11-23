import {
  Children,
  isValidElement,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Boxes,
  Check,
  ChevronRight,
  Copy,
  FileText,
  Globe,
  Image as ImageIcon,
  Layers,
  List,
  MoreHorizontal,
  Search,
  ShieldCheck,
  Terminal,
} from 'lucide-react';
import type { Item } from '../types';
import { splitReviewComments, textOfContent } from '../lib/format';
import { itemOutput } from '../lib/items';

function StatusPill({ status }: { status?: string }) {
  const normalized = (status || 'inProgress').toLowerCase();
  const label =
    normalized === 'completed'
      ? 'DONE'
      : normalized === 'failed' || normalized === 'declined'
        ? 'FAILED'
        : 'RUNNING';
  return <span className={`status ${normalized}`}>{label}</span>;
}

function LocalImage({
  path,
  src,
  alt,
}: {
  path?: string | null;
  src?: string | null;
  alt?: string;
}) {
  const [url, setUrl] = useState<string | null>(src || null);
  const [zoom, setZoom] = useState(false);
  useEffect(() => {
    if (src) {
      setUrl(src);
      return;
    }
    if (!path) {
      setUrl(null);
      return;
    }
    let active = true;
    window.codex
      .imageDataUrl(path)
      .then((dataUrl) => {
        if (active) setUrl(dataUrl);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [path, src]);
  if (!url) return <span className="image-placeholder">图片</span>;
  return (
    <>
      <img
        className="message-image"
        src={url}
        alt={alt || path || '图片'}
        onClick={() => setZoom(true)}
      />
      {zoom
        ? createPortal(
            <div
              className="image-lightbox"
              onClick={() => setZoom(false)}
              title="点击关闭"
              role="presentation"
            >
              <img src={url} alt={alt || path || '图片'} />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

const DiffView = memo(function DiffView({ diff }: { diff: string }) {
  const lines = (diff || '').split('\n');
  return (
    <pre className="diff">
      {lines.map((line, index) => {
        let kind = 'ctx';
        if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git')) {
          kind = 'meta';
        } else if (line.startsWith('@@')) {
          kind = 'hunk';
        } else if (line.startsWith('+')) {
          kind = 'add';
        } else if (line.startsWith('-')) {
          kind = 'remove';
        }
        return (
          <span className={`diff-line ${kind}`} key={`${kind}-${index}`}>
            {line}
            {'\n'}
          </span>
        );
      })}
    </pre>
  );
});

function ToolCard({
  icon,
  title,
  status,
  children,
}: {
  icon: ReactNode;
  title: string;
  status?: string;
  children: ReactNode;
}) {
  return (
    <div className="tool-card">
      <div className="tool-head">
        {icon}
        <span className="tool-title">{title}</span>
        <StatusPill status={status} />
      </div>
      {children}
    </div>
  );
}

function ReviewCommentActions({
  review,
  busy,
  onFix,
}: {
  review: string;
  busy: boolean;
  onFix: (text: string) => void;
}) {
  const comments = useMemo(() => splitReviewComments(review), [review]);
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(comments.map((_, index) => index)),
  );

  useEffect(() => {
    setSelected(new Set(comments.map((_, index) => index)));
  }, [comments]);

  const toggle = (index: number) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  return (
    <div className="review-actions">
      {comments.length > 0 ? (
        <div className="review-comment-list">
          {comments.map((comment, index) => (
            <label
              className={`review-comment ${selected.has(index) ? 'selected' : ''}`}
              key={`${index}-${comment.slice(0, 24)}`}
            >
              <input
                type="checkbox"
                checked={selected.has(index)}
                onChange={() => toggle(index)}
              />
              <span>{comment.replace(/^[\s>*•-]+/, '').slice(0, 240)}</span>
            </label>
          ))}
        </div>
      ) : null}
      <div className="review-comment-buttons">
        {comments.length > 0 ? (
          <button
            disabled={busy || selected.size === 0}
            onClick={() =>
              onFix(
                comments
                  .filter((_, index) => selected.has(index))
                  .join('\n\n'),
              )
            }
          >
            修复选中（{selected.size}）
          </button>
        ) : null}
        <button className="primary" disabled={busy} onClick={() => onFix(review)}>
          修复全部评论
        </button>
      </div>
    </div>
  );
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const child = Children.toArray(children)[0];
  const className = isValidElement(child)
    ? String((child.props as { className?: string }).className || '')
    : '';
  const language = /language-([\w-]+)/.exec(className)?.[1] || 'text';
  return (
    <div className="code-block">
      <div className="code-block-head">
        <span>{language}</span>
        <button
          className="code-copy"
          title={copied ? '已复制' : '复制代码'}
          onClick={() => {
            const text = ref.current?.textContent || '';
            if (!text) return;
            window.codex
              .copyText(text)
              .then((ok) => {
                if (ok) setCopied(true);
              })
              .catch(() => {});
          }}
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
        </button>
      </div>
      <pre ref={ref}>{children}</pre>
    </div>
  );
}

const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
        a: ({ href, children }) => (
          <a
            href={href}
            title={href}
            onClick={(event) => {
              event.preventDefault();
              if (href && /^https?:\/\//i.test(href)) {
                window.codex.openExternal(href).catch(() => {});
              }
            }}
          >
            {children}
          </a>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
});

export function MessageItem({
  item,
  busy,
  onFixReview,
  onOpenThread,
  onRetry,
  onQuote,
  onOpenFile,
}: {
  item: Item;
  busy?: boolean;
  onFixReview?: (text: string) => void;
  onOpenThread?: (threadId: string) => void;
  onRetry?: () => void;
  onQuote?: (text: string) => void;
  onOpenFile?: (path: string) => void;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  if (item.type === 'userMessage') {
    const images = Array.isArray(item.content)
      ? item.content.filter(
          (part: any) =>
            part &&
            (part.type === 'localImage' || part.type === 'image' || part.type === 'image_url'),
        )
      : [];
    return (
      <div className="message msg-user">
        <div className="bubble">
          {textOfContent(item.content)}
          {images.length > 0 ? (
            <div className="image-grid">
              {images.map((part: any, index: number) => {
                const source =
                  typeof part.image_url === 'string'
                    ? part.image_url
                    : part.image_url?.url || part.url;
                return (
                  <LocalImage
                    key={`${part.path || source || 'image'}-${index}`}
                    path={part.path}
                    src={source}
                  />
                );
              })}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  if (item.type === 'agentMessage') {
    return (
      <div className="message assistant">
        <div className="markdown">
          <Markdown text={item.text || ''} />
          {item.streaming ? <span className="caret" /> : null}
        </div>
        {!item.streaming && item.text ? (
          <div className="message-actions">
            <button
              title="复制消息"
              onClick={() => window.codex.copyText(item.text).catch(() => {})}
            >
              <Copy size={12} />
            </button>
            <div className="message-more-wrap">
              <button
                title="更多操作"
                onClick={() => setMoreOpen((previous) => !previous)}
              >
                <MoreHorizontal size={12} />
              </button>
              {moreOpen ? (
                <div className="message-more-menu">
                  <button
                    onClick={() => {
                      window.codex.copyText(item.text).catch(() => {});
                      setMoreOpen(false);
                    }}
                  >
                    复制
                  </button>
                  {onQuote ? (
                    <button
                      onClick={() => {
                        onQuote(item.text);
                        setMoreOpen(false);
                      }}
                    >
                      引用到输入框
                    </button>
                  ) : null}
                  {onRetry ? (
                    <button
                      onClick={() => {
                        onRetry();
                        setMoreOpen(false);
                      }}
                    >
                      重新生成
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  if (item.type === 'reasoning') {
    const text = [...(item.summary || []), ...(item.content || [])].join('\n\n');
    if (!text) return null;
    return (
      <details className="reasoning">
        <summary>思考过程</summary>
        <pre>{text}</pre>
      </details>
    );
  }

  if (item.type === 'commandExecution') {
    const output = itemOutput(item);
    return (
      <ToolCard icon={<Terminal size={13} />} title="命令执行" status={item.status}>
        {item.command ? <pre>{item.command}</pre> : null}
        {output ? <pre className="out">{output}</pre> : null}
      </ToolCard>
    );
  }

  if (item.type === 'fileChange') {
    const changes: any[] = Array.isArray(item.changes) ? item.changes : [];
    return (
      <ToolCard icon={<FileText size={13} />} title="文件变更" status={item.status}>
        {changes.length === 0 ? (
          <pre className="out">{itemOutput(item) || '无变更明细'}</pre>
        ) : (
          changes.map((change, index) => (
            <details className="change-block" key={`${change.path || 'change'}-${index}`}>
              <summary>
                <span className="kind">{change.kind?.[0]?.toUpperCase() || 'M'}</span>
                <code>{change.path || change.file || 'unknown'}</code>
                {onOpenFile && (change.path || change.file) ? (
                  <button
                    type="button"
                    className="change-open"
                    title="在右侧打开"
                    aria-label={`在右侧打开 ${change.path || change.file}`}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onOpenFile(change.path || change.file);
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                  >
                    打开
                  </button>
                ) : null}
                <ChevronRight size={12} className="chev" />
              </summary>
              <DiffView diff={change.diff || ''} />
            </details>
          ))
        )}
      </ToolCard>
    );
  }

  if (item.type === 'plan') {
    return (
      <ToolCard icon={<Layers size={13} />} title="执行计划">
        <pre>{item.text || ''}</pre>
      </ToolCard>
    );
  }

  if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') {
    const name =
      item.type === 'mcpToolCall'
        ? `${item.server || 'mcp'} · ${item.tool || 'tool'}`
        : `${item.namespace || 'tool'} · ${item.tool || 'tool'}`;
    return (
      <ToolCard icon={<Layers size={13} />} title={name} status={item.status}>
        {item.arguments ? <pre className="out">{JSON.stringify(item.arguments, null, 2)}</pre> : null}
        {item.result ? (
          <pre className="out">{JSON.stringify(item.result, null, 2)}</pre>
        ) : null}
        {item.error ? <pre className="out">{JSON.stringify(item.error, null, 2)}</pre> : null}
      </ToolCard>
    );
  }

  const collabAgentToolCall = item.type === 'collabAgentToolCall';
  if (collabAgentToolCall) {
    const receivers: string[] =
      item.receiverThreadIds || item.receiver_thread_ids || [];
    const states: Record<string, any> = item.agentsStates || item.agents_states || {};
    const ids = Array.from(new Set([...receivers, ...Object.keys(states)]));
    return (
      <ToolCard
        icon={<Layers size={13} />}
        title={`协作 · ${String(item.tool || 'agent')}`}
        status={item.status}
      >
        {item.prompt ? <pre className="out">{String(item.prompt)}</pre> : null}
        {ids.length > 0 ? (
          <div className="agent-list">
            {ids.map((id) => {
              const state = states[id];
              const label =
                typeof state === 'string'
                  ? state
                  : state?.status || state?.type || 'unknown';
              return (
                <div className="agent-row" key={id}>
                  <span className="agent-name">{id.slice(0, 8)}</span>
                  <span className={`agent-state ${String(label).toLowerCase()}`}>
                    {String(label)}
                  </span>
                  {onOpenThread ? (
                    <button onClick={() => onOpenThread(id)}>打开子线程</button>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </ToolCard>
    );
  }

  if (item.type === 'subAgentActivity') {
    const threadIdActive = item.agentThreadId || item.agent_thread_id;
    return (
      <ToolCard
        icon={<Layers size={13} />}
        title={`子代理 · ${String(item.kind || 'activity')}`}
        status={String(item.kind || '')}
      >
        <div className="agent-row">
          <span className="agent-name">{item.agentPath || threadIdActive || 'agent'}</span>
          {item.model ? <span className="agent-meta">{item.model}</span> : null}
          {onOpenThread && threadIdActive ? (
            <button onClick={() => onOpenThread(threadIdActive)}>打开子线程</button>
          ) : null}
        </div>
      </ToolCard>
    );
  }

  if (item.type === 'webSearch') {
    return (
      <ToolCard icon={<Search size={13} />} title="网页搜索" status={item.status}>
        {item.query ? <pre>{String(item.query)}</pre> : null}
      </ToolCard>
    );
  }

  if (item.type === 'imageView') {
    return (
      <ToolCard icon={<ImageIcon size={13} />} title="图片">
        <div className="image-grid">
          <LocalImage path={item.path} />
        </div>
      </ToolCard>
    );
  }

  if (item.type === 'imageGeneration') {
    const savedPath = item.savedPath || item.saved_path;
    const rawResult = typeof item.result === 'string' ? item.result : '';
    const src =
      rawResult.startsWith('data:') || rawResult.startsWith('http')
        ? rawResult
        : rawResult && rawResult.length > 200
          ? `data:image/png;base64,${rawResult}`
          : '';
    const revisedPrompt = item.revisedPrompt || item.revised_prompt;
    return (
      <ToolCard icon={<ImageIcon size={13} />} title="生成图片" status={item.status}>
        {savedPath || src ? (
          <div className="image-grid">
            <LocalImage path={savedPath} src={src} />
          </div>
        ) : null}
        {revisedPrompt ? <pre className="out">{String(revisedPrompt)}</pre> : null}
        {item.failure?.message ? <pre className="out">{item.failure.message}</pre> : null}
      </ToolCard>
    );
  }

  if (item.type === 'enteredReviewMode' || item.type === 'exitedReviewMode') {
    const exited = item.type === 'exitedReviewMode';
    return (
      <div className={`review-mode ${exited ? 'exited' : 'entered'}`}>
        <div className="review-mode-head">
          <ShieldCheck size={14} />
          <span>{exited ? '审查结果' : '代码审查'}</span>
          <span className="review-mode-tag">{exited ? 'REVIEW DONE' : 'REVIEW RUNNING'}</span>
        </div>
        {exited ? (
          <>
            <div className="markdown review-mode-body">
              <Markdown text={item.review || ''} />
            </div>
            {onFixReview ? (
              <ReviewCommentActions
                review={item.review || ''}
                busy={Boolean(busy)}
                onFix={onFixReview}
              />
            ) : null}
          </>
        ) : (
          <details className="review-mode-body">
            <summary>审查提示词</summary>
            <pre className="out">{item.review || ''}</pre>
          </details>
        )}
      </div>
    );
  }

  const output = itemOutput(item);
  return (
    <ToolCard icon={<Terminal size={13} />} title={item.type} status={item.status}>
      {output ? <pre className="out">{output}</pre> : null}
    </ToolCard>
  );
}

export function ActivityStep({
  item,
  busy,
  onOpenFile,
}: {
  item: Item;
  busy?: boolean;
  onOpenFile?: (path: string) => void;
}) {
  const label = (() => {
    switch (item.type) {
      case 'commandExecution':
        return '运行了命令';
      case 'fileChange':
        return '编辑了文件';
      case 'reasoning':
        return '思考过程';
      case 'mcpToolCall':
        return `${item.server || 'MCP'} · ${item.tool || '工具'}`;
      case 'dynamicToolCall':
        return `${item.namespace || '工具'} · ${item.tool || '调用'}`;
      case 'webSearch':
        return '搜索了网页';
      case 'imageGeneration':
        return '生成了图片';
      default:
        return item.type;
    }
  })();
  return (
    <details className="activity-step">
      <summary>
        {item.type === 'commandExecution' ? (
          <Terminal size={12} />
        ) : item.type === 'fileChange' ? (
          <FileText size={12} />
        ) : item.type === 'webSearch' ? (
          <Globe size={12} />
        ) : item.type === 'mcpToolCall' || item.type === 'dynamicToolCall' ? (
          <Boxes size={12} />
        ) : (
          <List size={12} />
        )}
        <span>{label}</span>
      </summary>
      <div className="activity-step-body">
        {item.type === 'reasoning' ? (
          <pre className="activity-reasoning">
            {[...(item.summary || []), ...(item.content || [])].join('\n\n')}
          </pre>
        ) : item.type === 'commandExecution' ? (
          <div className="activity-command">
            {item.command ? <pre className="activity-cmd">{item.command}</pre> : null}
            {itemOutput(item) ? <pre className="activity-out">{itemOutput(item)}</pre> : null}
          </div>
        ) : item.type === 'fileChange' ? (
          <div className="activity-changes">
            {(Array.isArray(item.changes) ? item.changes : []).map(
              (change: any, changeIndex: number) => (
                <details
                  className="activity-change"
                  key={`${change.path || 'change'}-${changeIndex}`}
                >
                  <summary>
                    <span>{change.kind?.[0]?.toUpperCase() || 'M'}</span>
                    <code>{change.path || change.file || 'unknown'}</code>
                    {onOpenFile && (change.path || change.file) ? (
                      <button
                        type="button"
                        className="change-open"
                        title="在右侧打开"
                        aria-label={`在右侧打开 ${change.path || change.file}`}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          onOpenFile(change.path || change.file);
                        }}
                        onMouseDown={(event) => event.stopPropagation()}
                      >
                        打开
                      </button>
                    ) : null}
                  </summary>
                  <DiffView diff={change.diff || ''} />
                </details>
              ),
            )}
          </div>
        ) : item.type === 'mcpToolCall' || item.type === 'dynamicToolCall' ? (
          <div className="activity-tool">
            {item.arguments ? (
              <pre className="activity-cmd">{JSON.stringify(item.arguments, null, 2)}</pre>
            ) : null}
            {item.result ? (
              <pre className="activity-out">
                {typeof item.result === 'string'
                  ? item.result
                  : JSON.stringify(item.result, null, 2)}
              </pre>
            ) : null}
          </div>
        ) : (
          <MessageItem item={item} busy={busy} onOpenFile={onOpenFile} />
        )}
      </div>
    </details>
  );
}
