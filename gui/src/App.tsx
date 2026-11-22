import {
  Children,
  Fragment,
  isValidElement,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Boxes,
  Clock,
  Check,
  ChevronDown,
  ChevronRight,
  Compass,
  Copy,
  FileText,
  FolderOpen,
  FolderPlus,
  GitBranch,
  Globe,
  Image as ImageIcon,
  KeyRound,
  Layers,
  List,
  ListChecks,
  Loader2,
  Minus,
  MoreHorizontal,
  PanelRight,
  Paperclip,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings as SettingsIcon,
  SquarePen,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  Terminal,
  X,
} from 'lucide-react';
import { BrowserPanel, FilesPanel } from './Workspace';
import { ReviewPanel } from './ReviewPanel';
import { AutomationsPage } from './components/AutomationsPage';
import { Modal } from './components/Modal';
import { ThreadActions } from './components/ThreadActions';
import { ReviewDialog } from './components/ReviewDialog';
import { UserInputPanel } from './components/UserInputPanel';
import { useDismissOnOutside } from './hooks/useDismissOnOutside';
import { SettingsPanel } from './SettingsPanel';
import { TerminalDock } from './TerminalDock';
import { playCompletionChime } from './lib/audio';
import { friendlyClientError } from './lib/errors';
import {
  approvalLabel,
  automationScheduleLabel,
  cleanSnippet,
  collaborationModeLabel,
  effortLabel,
  formatThreadTime,
  formatTokens,
  nextRunLabel,
  sandboxLabel,
  sandboxPolicyFor,
  splitReviewComments,
  textOfContent,
  timeAgo,
} from './lib/format';
import {
  activitySummary,
  appendOutputDelta,
  appendReasoningDelta,
  appendTextDelta,
  isActivityItem,
  itemOutput,
  upsertItem,
} from './lib/items';
import {
  readJsonStorage,
  readStorage,
  removeStorage,
  writeJsonStorage,
  writeStorage,
} from './lib/storage';
import type {
  AppConfig,
  ApprovalRequest,
  Automation,
  CollaborationModeInfo,
  Item,
  ModelInfo,
  PendingUserInput,
  ProjectInfo,
  ReviewTarget,
  RuntimeSettings,
  SettingsTab,
  ThreadSearchResult,
  ThreadSummary,
  ThreadReadState,
  WorktreeInfo,
} from './types';

type RailTab = 'files' | 'browser' | 'review';

const DEFAULT_SETTINGS: RuntimeSettings = {
  approvalPolicy: 'on-request',
  sandbox: 'danger-full-access',
  effort: 'high',
};

function loadSettings(): RuntimeSettings {
  const saved = readJsonStorage<Partial<RuntimeSettings> | null>(
    'deepseek-codex.settings',
    null,
  );
  return saved ? { ...DEFAULT_SETTINGS, ...saved } : DEFAULT_SETTINGS;
}

function loadAutomations(): Automation[] {
  const parsed = readJsonStorage<Automation[]>('deepseek-codex.automations', []);
  if (!Array.isArray(parsed)) return [];
  return parsed.map((entry) =>
    entry.lastStatus === 'running'
      ? { ...entry, lastStatus: 'error', lastError: '上次运行未完成' }
      : entry,
  );
}

function saveAutomations(list: Automation[]) {
  writeJsonStorage('deepseek-codex.automations', list);
}

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

function MessageItem({
  item,
  busy,
  onFixReview,
  onOpenThread,
  onRetry,
  onQuote,
}: {
  item: Item;
  busy?: boolean;
  onFixReview?: (text: string) => void;
  onOpenThread?: (threadId: string) => void;
  onRetry?: () => void;
  onQuote?: (text: string) => void;
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

function ActivityStep({ item, busy }: { item: Item; busy?: boolean }) {
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
          <MessageItem item={item} busy={busy} />
        )}
      </div>
    </details>
  );
}

function ApprovalPanel({
  approval,
  onDecide,
}: {
  approval: ApprovalRequest;
  onDecide: (decision: string) => void;
}) {
  const title =
    approval.kind === 'command'
      ? '命令执行需要确认'
      : approval.kind === 'file'
        ? '文件修改需要确认'
        : '需要额外权限';
  return (
    <div className="approval">
      <div className="approval-head">
        <ShieldAlert size={16} />
        <span>{title}</span>
      </div>
      {approval.command ? <pre>{approval.command}</pre> : null}
      {approval.kind === 'permissions' && approval.permissions ? (
        <pre>{JSON.stringify(approval.permissions, null, 2)}</pre>
      ) : null}
      {approval.cwd ? <div className="approval-meta">目录 · {approval.cwd}</div> : null}
      {approval.grantRoot ? <div className="approval-meta">范围 · {approval.grantRoot}</div> : null}
      {approval.reason ? <div className="approval-meta">原因 · {approval.reason}</div> : null}
      <div className="approval-actions">
        <button className="decline" onClick={() => onDecide('decline')}>
          <X size={14} /> 拒绝
        </button>
        <button onClick={() => onDecide('acceptForSession')}>本会话允许</button>
        <button className="accept" onClick={() => onDecide('accept')}>
          <Check size={14} /> {approval.kind === 'permissions' ? '本次允许' : '允许'}
        </button>
      </div>
    </div>
  );
}

function Hero() {
  return (
    <div className="hero">
      <h1>我们该做些什么？</h1>
    </div>
  );
}

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [status, setStatus] = useState<'connecting' | 'ready' | 'offline'>('connecting');
  const [engineError, setEngineError] = useState<string | null>(null);
  const [model, setModel] = useState('deepseek-flash');
  const [cwd, setCwd] = useState('');
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [threadQuery, setThreadQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [readStates, setReadStates] = useState<Record<string, ThreadReadState>>({});
  const [threadCursor, setThreadCursor] = useState<string | null>(null);
  const [threadLoadingMore, setThreadLoadingMore] = useState(false);
  const [searchResults, setSearchResults] = useState<ThreadSearchResult[]>([]);
  const [searchBusy, setSearchBusy] = useState(false);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [projectId, setProjectId] = useState<string | null>(() => {
    try {
      return readStorage('deepseek-codex.project');
    } catch {
      return null;
    }
  });
  const [projectMenuId, setProjectMenuId] = useState<string | null>(null);
  const [projectRenameTarget, setProjectRenameTarget] = useState<ProjectInfo | null>(null);
  const [projectRenameInput, setProjectRenameInput] = useState('');
  const [mode, setMode] = useState<'default' | 'plan'>(() => {
    try {
      return readStorage('deepseek-codex.mode') === 'plan' ? 'plan' : 'default';
    } catch {
      return 'default';
    }
  });
  const [collaborationModes, setCollaborationModes] = useState<CollaborationModeInfo[]>([]);
  const [pinnedSectionId, setPinnedSectionId] = useState<string | null>(null);
  const [sections, setSections] = useState<{ id: string; name: string }[]>([]);
  const [sectionMenuId, setSectionMenuId] = useState<string | null>(null);
  const [moveThreadId, setMoveThreadId] = useState<string | null>(null);
  const [sectionDialog, setSectionDialog] = useState<{
    mode: 'create' | 'rename';
    id?: string;
    name: string;
  } | null>(null);
  const [maximized, setMaximized] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [lastTurnId, setLastTurnId] = useState<string | null>(null);
  const [visibleItemCount, setVisibleItemCount] = useState(120);
  const [theme, setTheme] = useState<'official' | 'warm'>(() =>
    readStorage('deepseek-codex.theme') === 'warm' ? 'warm' : 'official',
  );
  const [items, setItems] = useState<Item[]>([]);
  const [running, setRunning] = useState(false);
  const [turnId, setTurnId] = useState<string | null>(null);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [pendingInput, setPendingInput] = useState<PendingUserInput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [keyDialog, setKeyDialog] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [keySaving, setKeySaving] = useState(false);
  const [settings, setSettings] = useState<RuntimeSettings>(loadSettings);
  const [autonomyHidden, setAutonomyHidden] = useState(() => {
    const until = Number(readStorage('deepseek-codex.autonomyHiddenUntil') || 0);
    return until > Date.now();
  });
  const [notifyOnComplete, setNotifyOnComplete] = useState(
    () => readStorage('deepseek-codex.notify') !== '0',
  );
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [threadHeadingMenu, setThreadHeadingMenu] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [railQuick, setRailQuick] = useState('');

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab>('runtime');
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const openSettings = useCallback((tab: SettingsTab = 'runtime') => {
    setSettingsInitialTab(tab);
    setSettingsOpen(true);
  }, []);
  const [railOpen, setRailOpen] = useState(
    () => readStorage('deepseek-codex.rail.open') !== '0',
  );
  const [terminalOpen, setTerminalOpen] = useState(
    () => readStorage('deepseek-codex.terminal') === '1',
  );
  const [terminalMounted, setTerminalMounted] = useState(
    () => readStorage('deepseek-codex.terminal') === '1',
  );
  const [railTab, setRailTab] = useState<RailTab>(() => {
    const saved = readStorage('deepseek-codex.rail.tab');
    return saved === 'browser' || saved === 'review' ? saved : 'files';
  });
  const [reviewCount, setReviewCount] = useState(0);
  const [reviewTick, setReviewTick] = useState(0);
  const [reviewDialogOpen, setReviewDialogOpen] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [liveDiff, setLiveDiff] = useState('');
  const [capabilitiesOpen, setCapabilitiesOpen] = useState(false);
  const [pluginTab, setPluginTab] = useState<'plugins' | 'skills'>('plugins');
  const [pluginFilter, setPluginFilter] = useState<'public' | 'installed'>('public');
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [capabilities, setCapabilities] = useState<{
    loading: boolean;
    mcp: any;
    skills: any;
    plugins: any;
    hooks: any;
    error: string | null;
  }>({ loading: false, mcp: null, skills: null, plugins: null, hooks: null, error: null });
  const [pluginQuery, setPluginQuery] = useState('');
  const [pluginResults, setPluginResults] = useState<any[]>([]);
  const [pluginResultsBusy, setPluginResultsBusy] = useState(false);
  const [pluginDetail, setPluginDetail] = useState<any>(null);
  const [marketplaceSource, setMarketplaceSource] = useState('');
  const [marketplaceRef, setMarketplaceRef] = useState('');
  const [marketplaceBusy, setMarketplaceBusy] = useState(false);
  const [mcpCall, setMcpCall] = useState<{
    kind: 'tool' | 'resource';
    server: string;
    tool?: string;
    args: string;
    uri: string;
    result: string | null;
    busy: boolean;
  } | null>(null);
  const [pluginBusy, setPluginBusy] = useState(false);
  const [automations, setAutomations] = useState<Automation[]>(loadAutomations);
  const [automationOpen, setAutomationOpen] = useState(false);
  const [editingAutomationId, setEditingAutomationId] = useState<string | null>(null);
  const [automationForm, setAutomationForm] = useState({
    name: '',
    prompt: '',
    intervalMinutes: 0,
    projectId: '',
  });
  const [worktreeBusy, setWorktreeBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [worktreeMode, setWorktreeMode] = useState(
    () => readStorage('deepseek-codex.worktree') === '1',
  );
  const [worktree, setWorktree] = useState<WorktreeInfo | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [dragging, setDragging] = useState(false);
  const [mention, setMention] = useState<{
    query: string;
    tokenStart: number;
    index: number;
    results: { path: string; fileName: string }[];
  } | null>(null);
  const [usage, setUsage] = useState<{
    total: number;
    context: number | null;
    lastInput: number;
    lastOutput: number;
    input: number;
    cached: number;
  }>({
    total: 0,
    context: null,
    lastInput: 0,
    lastOutput: 0,
    input: 0,
    cached: 0,
  });
  const [mcpForm, setMcpForm] = useState({ name: '', command: '', args: '', env: '' });
  const [capabilityBusy, setCapabilityBusy] = useState(false);
  const [menuThreadId, setMenuThreadId] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<ThreadSummary | null>(null);
  const [renameInput, setRenameInput] = useState('');
  const [git, setGit] = useState<{
    repo: boolean;
    root?: string;
    branch?: string;
    changed?: number;
  } | null>(null);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelListOpen, setModelListOpen] = useState(false);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);

  const activeCwd = worktree?.path || cwd;

  const threadRef = useRef<string | null>(null);
  const runningRef = useRef(false);
  const turnIdRef = useRef<string | null>(null);
  const cwdRef = useRef('');
  const modelRef = useRef('deepseek-flash');
  const settingsRef = useRef(settings);
  const projectIdRef = useRef<string | null>(projectId);
  const modeRef = useRef(mode);
  const searchSeqRef = useRef(0);
  const archivedRef = useRef(false);
  const readStatesRef = useRef<Record<string, ThreadReadState>>({});
  const lastTurnIdRef = useRef<string | null>(null);
  const itemTimesRef = useRef<Record<string, number>>({});
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef(-1);
  const statusRef = useRef<'connecting' | 'ready' | 'offline'>('connecting');
  const automationsRef = useRef<Automation[]>(automations);
  const automationRunsRef = useRef(new Map<string, string>());
  const automationWatchdogsRef = useRef(new Map<string, number>());
  const mentionSeqRef = useRef(0);
  const worktreeRef = useRef<WorktreeInfo | null>(null);
  const pendingUserRef = useRef<string | null>(null);
  const gitRequestRef = useRef(0);
  const streamRef = useRef<HTMLElement>(null);
  const streamAtBottomRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    threadRef.current = threadId;
  }, [threadId]);
  useEffect(() => {
    runningRef.current = running;
  }, [running]);
  useEffect(() => {
    turnIdRef.current = turnId;
  }, [turnId]);
  useEffect(() => {
    cwdRef.current = cwd;
  }, [cwd]);
  useEffect(() => {
    modelRef.current = model;
  }, [model]);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);
  useEffect(() => {
    worktreeRef.current = worktree;
  }, [worktree]);
  useEffect(() => {
    projectIdRef.current = projectId;
    try {
      if (projectId) writeStorage('deepseek-codex.project', projectId);
      else removeStorage('deepseek-codex.project');
    } catch {
      /* ignore */
    }
  }, [projectId]);
  useEffect(() => {
    readStatesRef.current = readStates;
  }, [readStates]);
  useEffect(() => {
    lastTurnIdRef.current = lastTurnId;
  }, [lastTurnId]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      writeStorage('deepseek-codex.theme', theme);
    } catch {
      /* ignore */
    }
  }, [theme]);
  useEffect(() => {
    modeRef.current = mode;
    try {
      writeStorage('deepseek-codex.mode', mode);
    } catch {
      /* ignore */
    }
  }, [mode]);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);
  useEffect(() => {
    automationsRef.current = automations;
    saveAutomations(automations);
  }, [automations]);
  useEffect(() => {
    if (!window.desktop) return;
    window.desktop.isMaximized().then(setMaximized).catch(() => {});
    return window.desktop.onMaximized(setMaximized);
  }, []);

  const recordHistory = useCallback((id: string) => {
    const list = historyRef.current.slice(0, historyIndexRef.current + 1);
    if (list[list.length - 1] !== id) list.push(id);
    if (list.length > 40) list.shift();
    historyRef.current = list;
    historyIndexRef.current = list.length - 1;
    setHistory(list);
    setHistoryIndex(list.length - 1);
  }, []);

  const refreshGitInfo = useCallback(async () => {
    const requestId = ++gitRequestRef.current;
    if (!activeCwd) {
      setGit(null);
      return;
    }
    try {
      const info = await window.codex.gitInfo(activeCwd);
      if (requestId === gitRequestRef.current) setGit(info);
    } catch {
      if (requestId === gitRequestRef.current) setGit({ repo: false });
    }
  }, [activeCwd]);

  useEffect(() => {
    void refreshGitInfo();
  }, [refreshGitInfo]);


  useEffect(() => {
    if (searchOpen) {
      setAutomationOpen(false);
      setCapabilitiesOpen(false);
    }
  }, [searchOpen]);

  useEffect(() => {
    if (automationOpen) {
      setSearchOpen(false);
      setCapabilitiesOpen(false);
    }
  }, [automationOpen]);

  useEffect(() => {
    if (capabilitiesOpen) {
      setSearchOpen(false);
      setAutomationOpen(false);
    }
  }, [capabilitiesOpen]);

  useEffect(() => {
    if (terminalOpen) setTerminalMounted(true);
  }, [terminalOpen]);

  useDismissOnOutside([
    {
      isOpen: headerMenuOpen,
      selector: '.header-menu-wrap',
      close: () => setHeaderMenuOpen(false),
    },
    {
      isOpen: modelMenuOpen,
      selector: '.model-pill-wrap',
      close: () => setModelMenuOpen(false),
    },
    {
      isOpen: attachMenuOpen,
      selector: '.attach-wrap',
      close: () => setAttachMenuOpen(false),
    },
    {
      isOpen: Boolean(projectMenuId),
      selector: '.project-wrap',
      close: () => setProjectMenuId(null),
    },
    {
      isOpen: Boolean(menuThreadId),
      selector: '.thread-wrap',
      close: () => setMenuThreadId(null),
    },
    {
      isOpen: Boolean(sectionMenuId),
      selector: '.thread-group',
      close: () => setSectionMenuId(null),
    },
    {
      isOpen: threadHeadingMenu,
      selector: '.thread-heading-actions',
      close: () => setThreadHeadingMenu(false),
    },
    {
      isOpen: accountMenuOpen,
      selector: '.account-row',
      close: () => setAccountMenuOpen(false),
    },
    {
      isOpen: addMenuOpen,
      selector: '.add-menu-wrap',
      close: () => setAddMenuOpen(false),
    },
  ]);

  useEffect(() => {
    if (!menuThreadId) setMoveThreadId(null);
  }, [menuThreadId]);

  useEffect(() => {
    try {
      writeStorage('deepseek-codex.rail.open', railOpen ? '1' : '0');
      writeStorage('deepseek-codex.rail.tab', railTab);
      writeStorage('deepseek-codex.terminal', terminalOpen ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [railOpen, railTab, terminalOpen]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (document.querySelector('.key-overlay')) return;
      const key = event.key.toLowerCase();
      const pageOpen = searchOpen || automationOpen || capabilitiesOpen || settingsOpen;
      if (pageOpen && key !== 'n' && key !== ',') return;
      if (key === 'j') {
        event.preventDefault();
        setTerminalOpen((previous) => !previous);
        return;
      }
      if (key === 'p') {
        event.preventDefault();
        setRailTab('files');
        setRailOpen(true);
        setTimeout(() => {
          window.dispatchEvent(new Event('deepseek-codex:file-search'));
        }, 80);
        return;
      }
      if (key === 't') {
        event.preventDefault();
        setRailTab('browser');
        setRailOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    automationOpen,
    capabilitiesOpen,
    railOpen,
    railTab,
    searchOpen,
    settingsOpen,
  ]);

  const openRail = useCallback((tab?: RailTab) => {
    if (tab) setRailTab(tab);
    setRailOpen(true);
  }, []);

  const referenceFile = useCallback((relPath: string) => {
    setInput((previous) => {
      const prefix = previous && !previous.endsWith('\n') ? `${previous}\n` : previous;
      return `${prefix}@${relPath}`;
    });
    textareaRef.current?.focus();
  }, []);

  const effortOptions = useMemo(() => {
    const selected = models.find((entry) => entry.slug === model);
    const levels = selected?.reasoning_levels?.filter(Boolean) || [];
    return levels.length ? levels : ['low', 'high', 'max'];
  }, [model, models]);

  const changeList = useMemo(
    () =>
      items
        .filter((item) => item.type === 'fileChange')
        .flatMap((item) => (item.changes || []).map((change: any) => ({
          path: change.path || change.file || 'unknown',
          kind: change.kind || 'update',
          diff: change.diff || '',
        }))),
    [items],
  );

  const activeProject = useMemo(
    () => projects.find((project) => project.id === projectId) || null,
    [projectId, projects],
  );

  const projectName = useMemo(() => {
    if (activeProject?.name) return activeProject.name;
    if (!activeCwd) return '';
    return activeCwd.split(/[\\/]/).filter(Boolean).pop() || activeCwd;
  }, [activeCwd, activeProject]);

  const activeModel = models.find((entry) => entry.slug === model);

  const planMarkdown = useMemo(() => {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (item.type === 'plan' && String(item.text || '').trim()) {
        return String(item.text);
      }
    }
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (item.type === 'agentMessage' && String(item.text || '').trim()) {
        return String(item.text);
      }
    }
    return '';
  }, [items]);

  const filteredThreads = useMemo(() => {
    const query = threadQuery.trim().toLowerCase();
    if (!query) return threads;
    return threads.filter((thread) =>
      `${thread.name || ''} ${thread.preview || ''}`.toLowerCase().includes(query),
    );
  }, [threadQuery, threads]);

  const threadGroups = useMemo(() => {
    const result: { label: string; items: ThreadSummary[]; sectionId?: string }[] = [];
    if (pinnedSectionId) {
      const pinned = filteredThreads.filter((thread) => thread.section?.id === pinnedSectionId);
      if (pinned.length) {
        result.push({ label: '置顶', items: pinned, sectionId: pinnedSectionId });
      }
    }
    for (const section of sections) {
      if (section.id === pinnedSectionId) continue;
      const items = filteredThreads.filter((thread) => thread.section?.id === section.id);
      if (items.length) result.push({ label: section.name, items, sectionId: section.id });
    }
    const knownSectionIds = new Set(sections.map((section) => section.id));
    const recentItems = filteredThreads.filter(
      (thread) => !(thread.section?.id && knownSectionIds.has(thread.section.id)),
    );
    const combined: { label: string; items: ThreadSummary[]; sectionId?: string }[] = [
      ...result,
      ...(recentItems.length ? [{ label: '最近', items: recentItems }] : []),
    ];
    return combined;
  }, [filteredThreads, pinnedSectionId, sections]);

  useEffect(() => {
    const query = threadQuery.trim();
    if (query.length < 2) {
      setSearchResults([]);
      setSearchBusy(false);
      return;
    }
    const seq = ++searchSeqRef.current;
    setSearchBusy(true);
    const timer = setTimeout(() => {
      window.codex
        .request('thread/search', {
          searchTerm: query,
          limit: 30,
          archived: showArchived || undefined,
        })
        .then((response) => {
          if (seq === searchSeqRef.current) setSearchResults(response?.data || []);
        })
        .catch(() => {
          if (seq === searchSeqRef.current) setSearchResults([]);
        })
        .finally(() => {
          if (seq === searchSeqRef.current) setSearchBusy(false);
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [showArchived, threadQuery]);

  const mentionQuery = mention?.query ?? null;

  useEffect(() => {
    if (mentionQuery == null) return;
    const query = mentionQuery.trim();
    if (!query || !activeCwd) {
      setMention((current) => (current ? { ...current, results: [], index: 0 } : current));
      return;
    }
    const seq = ++mentionSeqRef.current;
    const timer = setTimeout(() => {
      window.codex
        .request('fuzzyFileSearch', {
          query,
          roots: [activeCwd],
          cancellationToken: 'composer-mention',
        })
        .then((response) => {
          if (seq !== mentionSeqRef.current) return;
          const ignored = /(^|[\\/])(node_modules|\.git|dist|build|release|target|\.next|\.cache)([\\/]|$)/i;
          const results = (response?.files || [])
            .filter((entry: any) => (entry.match_type ?? entry.matchType) !== 'directory')
            .filter((entry: any) => !ignored.test(entry.path))
            .slice(0, 12)
            .map((entry: any) => ({
              path: entry.path,
              fileName: entry.file_name ?? entry.fileName ?? entry.path,
            }));
          setMention((current) =>
            current ? { ...current, results, index: 0 } : current,
          );
        })
        .catch(() => {
          if (seq === mentionSeqRef.current) {
            setMention((current) => (current ? { ...current, results: [] } : current));
          }
        });
    }, 160);
    return () => clearTimeout(timer);
  }, [activeCwd, mentionQuery]);

  const refreshMention = useCallback((value: string, caret: number) => {
    const before = value.slice(0, caret);
    const match = /(^|\s)@([^\s@]*)$/.exec(before);
    if (!match) {
      setMention(null);
      return;
    }
    const tokenStart = caret - match[2].length - 1;
    setMention((current) =>
      current && current.query === match[2] && current.tokenStart === tokenStart
        ? current
        : { query: match[2], tokenStart, index: 0, results: [] },
    );
  }, []);

  const insertMention = useCallback(
    (item: { path: string }) => {
      if (!mention) return;
      const caret = textareaRef.current?.selectionStart ?? input.length;
      const start = Math.max(0, Math.min(mention.tokenStart, caret));
      const next = `${input.slice(0, start)}@${item.path} ${input.slice(caret)}`;
      setInput(next);
      setMention(null);
      requestAnimationFrame(() => {
        const position = start + item.path.length + 2;
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(position, position);
      });
    },
    [input, mention],
  );

  const addDroppedFiles = useCallback(
    (files: File[]) => {
      if (!files.length) return;
      const inserted: string[] = [];
      const images: string[] = [];
      for (const file of files) {
        let filePath = '';
        try {
          filePath = window.codex.pathForFile(file);
        } catch {
          filePath = '';
        }
        if (!filePath) continue;
        if (/\.(png|jpe?g|webp|gif|bmp)$/i.test(filePath)) {
          images.push(filePath);
        } else {
          let reference = filePath;
          const cwd = (worktreeRef.current?.path || cwdRef.current || '').replace(/\\/g, '/');
          const normalized = filePath.replace(/\\/g, '/');
          if (cwd && normalized.toLowerCase().startsWith(`${cwd.toLowerCase()}/`)) {
            reference = normalized.slice(cwd.length + 1);
          }
          inserted.push(`@${reference}`);
        }
      }
      if (images.length) {
        setAttachments((previous) => [...new Set([...previous, ...images])]);
      }
      if (inserted.length) {
        setInput((previous) => {
          const prefix = previous && !previous.endsWith('\n') ? `${previous}\n` : previous;
          return `${prefix}${inserted.join('\n')}`;
        });
      }
    },
    [],
  );

  const refreshThreads = useCallback(async () => {
    try {
      const params: Record<string, unknown> = {
        limit: 50,
        sortKey: 'updated_at',
        sortDirection: 'desc',
      };
      if (projectIdRef.current) params.projectId = projectIdRef.current;
      if (archivedRef.current) params.archived = true;
      const response = await window.codex.request('thread/list', params);
      setThreads(response?.data || []);
      setThreadCursor(response?.nextCursor || null);
      setReadStates(response?.readStates || {});
    } catch {
      /* history is best-effort */
    }
  }, []);

  const loadMoreThreads = useCallback(async () => {
    const cursor = threadCursor;
    if (!cursor || threadLoadingMore) return;
    setThreadLoadingMore(true);
    try {
      const params: Record<string, unknown> = {
        limit: 50,
        cursor,
        sortKey: 'updated_at',
        sortDirection: 'desc',
      };
      if (projectIdRef.current) params.projectId = projectIdRef.current;
      if (archivedRef.current) params.archived = true;
      const response = await window.codex.request('thread/list', params);
      setThreads((previous) => {
        const seen = new Set(previous.map((thread) => thread.id));
        return [...previous, ...(response?.data || []).filter((thread: ThreadSummary) => !seen.has(thread.id))];
      });
      setThreadCursor(response?.nextCursor || null);
      if (response?.readStates) {
        setReadStates((previous) => ({ ...previous, ...response.readStates }));
      }
    } catch (loadError: any) {
      setError(friendlyClientError(loadError));
    } finally {
      setThreadLoadingMore(false);
    }
  }, [threadCursor, threadLoadingMore]);

  const refreshProjects = useCallback(async () => {
    try {
      const response = await window.codex.request('project/list', { limit: 100 });
      const list: ProjectInfo[] = response?.data || [];
      setProjects(list);
      const selected = projectIdRef.current
        ? list.find((project) => project.id === projectIdRef.current)
        : null;
      if (projectIdRef.current && !selected) {
        setProjectId(null);
      } else if (selected?.roots?.[0]?.path) {
        setCwd(selected.roots[0].path);
      }
    } catch {
      /* project store may be unavailable */
    }
  }, []);

  const refreshSections = useCallback(async () => {
    try {
      const response = await window.codex.request('threadSection/list', { limit: 50 });
      const list = (response?.data || []).map((section: any) => ({
        id: section.id,
        name: section.name,
      }));
      setSections(list);
      const pinned = list.find(
        (section: any) => String(section.name || '').toLowerCase() === 'pinned',
      );
      setPinnedSectionId(pinned?.id || null);
    } catch {
      /* sections are optional */
    }
  }, []);

  const clearAutomationWatchdog = useCallback((automationId: string) => {
    const timer = automationWatchdogsRef.current.get(automationId);
    if (timer) {
      window.clearTimeout(timer);
      automationWatchdogsRef.current.delete(automationId);
    }
  }, []);

  const finishAutomationRun = useCallback(
    (threadId: string | undefined, error?: { message?: string } | null) => {
      if (!threadId) return;
      const entry = [...automationRunsRef.current.entries()].find(([, id]) => id === threadId);
      if (!entry) return;
      const [automationId] = entry;
      automationRunsRef.current.delete(automationId);
      clearAutomationWatchdog(automationId);
      const message = error?.message ? friendlyClientError(error.message) : undefined;
      const now = Date.now() / 1000;
      setAutomations((list) =>
        list.map((automation) =>
          automation.id === automationId
            ? {
                ...automation,
                lastStatus: message ? 'error' : 'ok',
                lastError: message,
                lastRunAt: now,
                runs: [
                  {
                    at: now,
                    status: (message ? 'error' : 'ok') as 'ok' | 'error',
                    error: message,
                  },
                  ...(automation.runs || []),
                ].slice(0, 10),
                nextRunAt: automation.intervalMinutes
                  ? now + automation.intervalMinutes * 60
                  : undefined,
              }
            : automation,
        ),
      );
      setNotice(message ? `自动化执行失败：${message}` : '自动化已执行完成');
    },
    [clearAutomationWatchdog],
  );

  const runAutomation = useCallback(
    async (automation: Automation, manual = false) => {
      if (!config || statusRef.current !== 'ready') {
        if (manual) setError('引擎未就绪，无法运行自动化');
        return;
      }
      if (automationRunsRef.current.has(automation.id)) return;
      if (runningRef.current) {
        if (manual) setError('当前任务运行中，请稍后再运行自动化');
        return;
      }
      const now = Date.now() / 1000;
      automationRunsRef.current.set(automation.id, '');
      clearAutomationWatchdog(automation.id);
      const watchdog = window.setTimeout(
        () => {
          const activeThread = automationRunsRef.current.get(automation.id);
          if (!activeThread) {
            automationRunsRef.current.delete(automation.id);
            setAutomations((list) =>
              list.map((entry) =>
                entry.id === automation.id
                  ? {
                      ...entry,
                      lastStatus: 'error',
                      lastError: '自动化启动超时',
                      lastRunAt: Date.now() / 1000,
                      nextRunAt: entry.intervalMinutes
                        ? Date.now() / 1000 + Math.max(300, entry.intervalMinutes * 60)
                        : undefined,
                    }
                  : entry,
              ),
            );
            return;
          }
          finishAutomationRun(activeThread, { message: '自动化执行超时' });
        },
        30 * 60 * 1000,
      );
      automationWatchdogsRef.current.set(automation.id, watchdog);
      setAutomations((list) =>
        list.map((entry) =>
          entry.id === automation.id
            ? { ...entry, lastStatus: 'running', lastError: undefined }
            : entry,
        ),
      );
      try {
        const created = await window.codex.request('thread/start', {
          cwd: automation.cwd || cwdRef.current,
          model: modelRef.current,
          modelProvider: config.defaultProvider || 'deepseek',
          approvalPolicy: 'never',
          sandbox: 'danger-full-access',
          projectId: automation.projectId || undefined,
        });
        const threadIdActive: string | undefined = created?.thread?.id;
        if (!threadIdActive) throw new Error('创建自动化会话失败');
        automationRunsRef.current.set(automation.id, threadIdActive);
        await window.codex.request('turn/start', {
          threadId: threadIdActive,
          model: modelRef.current,
          approvalPolicy: 'never',
          effort: settingsRef.current.effort,
          sandboxPolicy: { type: 'dangerFullAccess' },
          input: [{ type: 'text', text: automation.prompt, text_elements: [] }],
        });
        setAutomations((list) =>
          list.map((entry) =>
            entry.id === automation.id
              ? {
                  ...entry,
                  lastStatus: 'running',
                  lastThreadId: threadIdActive,
                  nextRunAt: automation.intervalMinutes
                    ? now + automation.intervalMinutes * 60
                    : undefined,
                }
              : entry,
          ),
        );
        setNotice(`自动化「${automation.name}」已启动`);
        refreshThreads();
      } catch (runError: any) {
        automationRunsRef.current.delete(automation.id);
        clearAutomationWatchdog(automation.id);
        const message = friendlyClientError(runError);
        setAutomations((list) =>
          list.map((entry) =>
            entry.id === automation.id
              ? {
                  ...entry,
                  lastStatus: 'error',
                  lastError: message,
                  lastRunAt: now,
                  nextRunAt: entry.intervalMinutes
                    ? now + Math.max(300, entry.intervalMinutes * 60)
                    : undefined,
                }
              : entry,
          ),
        );
        if (manual) setError(message);
      }
    },
    [clearAutomationWatchdog, config, finishAutomationRun, refreshThreads],
  );

  useEffect(() => {
    const timer = setInterval(() => {
      if (statusRef.current !== 'ready' || runningRef.current) return;
      if (automationRunsRef.current.size > 0) return;
      const now = Date.now() / 1000;
      const due = automationsRef.current.find(
        (automation) =>
          automation.enabled &&
          automation.intervalMinutes > 0 &&
          (!automation.nextRunAt || automation.nextRunAt <= now),
      );
      if (due) void runAutomation(due);
    }, 30000);
    return () => clearInterval(timer);
  }, [runAutomation]);

  useEffect(() => {
    if (status === 'ready' || automationRunsRef.current.size === 0) return;
    for (const [automationId, activeThread] of [...automationRunsRef.current.entries()]) {
      if (activeThread) {
        finishAutomationRun(activeThread, { message: '引擎离线，自动化已中断' });
      } else {
        automationRunsRef.current.delete(automationId);
        clearAutomationWatchdog(automationId);
      }
    }
  }, [clearAutomationWatchdog, finishAutomationRun, status]);

  useEffect(
    () => () => {
      for (const timer of automationWatchdogsRef.current.values()) {
        window.clearTimeout(timer);
      }
      automationWatchdogsRef.current.clear();
    },
    [],
  );

  const saveAutomation = useCallback(() => {
    const name = automationForm.name.trim();
    const prompt = automationForm.prompt.trim();
    if (!name || !prompt) {
      setError('请填写自动化名称与任务内容');
      return;
    }
    const project = projects.find((entry) => entry.id === automationForm.projectId) || null;
    const interval = automationForm.intervalMinutes;
    const base = {
      name,
      prompt,
      projectId: project?.id ?? null,
      cwd: project?.roots?.[0]?.path || cwdRef.current,
      intervalMinutes: interval,
      enabled: interval > 0,
      nextRunAt: interval ? Date.now() / 1000 + interval * 60 : undefined,
    };
    if (editingAutomationId) {
      setAutomations((list) =>
        list.map((entry) =>
          entry.id === editingAutomationId ? { ...entry, ...base } : entry,
        ),
      );
      setNotice(`自动化「${name}」已更新`);
    } else {
      const automation: Automation = {
        id: `auto-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        ...base,
        runs: [],
      };
      setAutomations((list) => [automation, ...list]);
      setNotice(`自动化「${name}」已创建`);
    }
    setEditingAutomationId(null);
    setAutomationForm({ name: '', prompt: '', intervalMinutes: 0, projectId: '' });
  }, [automationForm, editingAutomationId, projects]);

  const toggleAutomation = useCallback((automation: Automation) => {
    setAutomations((list) =>
      list.map((entry) =>
        entry.id === automation.id
          ? {
              ...entry,
              enabled: !entry.enabled,
              nextRunAt:
                !entry.enabled && entry.intervalMinutes
                  ? Date.now() / 1000 + entry.intervalMinutes * 60
                  : undefined,
            }
          : entry,
      ),
    );
  }, []);

  const removeAutomation = useCallback((automation: Automation) => {
    if (automationRunsRef.current.has(automation.id)) {
      setError('自动化正在运行，请等待完成后再删除');
      return;
    }
    if (!window.confirm(`删除自动化「${automation.name}」？`)) return;
    setAutomations((list) => list.filter((entry) => entry.id !== automation.id));
  }, []);

  const toggleArchived = useCallback(() => {
    const next = !archivedRef.current;
    archivedRef.current = next;
    setShowArchived(next);
    setThreadQuery('');
    refreshThreads();
  }, [refreshThreads]);

  const refreshReviewMeta = useCallback(() => {
    void refreshThreads();
    void refreshGitInfo();
  }, [refreshGitInfo, refreshThreads]);

  const updateReviewCount = useCallback((count: number) => {
    setReviewCount(count);
  }, []);

  useEffect(() => {
    setReviewCount(0);
  }, [activeCwd]);

  useEffect(() => {
    if (railOpen && railTab === 'review') return;
    setReviewCount(git?.repo ? git.changed || 0 : 0);
  }, [activeCwd, git?.changed, git?.repo, railOpen, railTab]);

  useEffect(() => {
    window.codex
      .getConfig()
      .then((loaded) => {
        setConfig(loaded);
        setModels(loaded.models || []);
        setModel(loaded.defaultModel || loaded.models?.[0]?.slug || 'deepseek-flash');
        setCwd(loaded.defaultCwd || '');
        setEngineError(loaded.error);
        setStatus(loaded.online ? 'ready' : 'offline');
        setKeyDialog(!loaded.apiKeyConfigured);
        refreshThreads();
        refreshProjects();
        refreshSections();
        window.codex
          .request('collaborationMode/list', {})
          .then((response) => setCollaborationModes(response?.data || []))
          .catch(() => {});
      })
      .catch((loadError: Error) => {
        setStatus('offline');
        setEngineError(loadError.message);
      });
    const unsubscribe = window.codex.onStatus((next) => {
      setStatus(next.online ? 'ready' : 'offline');
      if (next.error) setEngineError(next.error);
      if (!next.online) {
        setRunning(false);
        setTurnId(null);
      }
      if (next.online) {
        refreshThreads();
        refreshProjects();
        refreshSections();
      }
    });
    return unsubscribe;
  }, [refreshProjects, refreshSections, refreshThreads]);

  useEffect(() => {
    const unsubscribe = window.codex.onNotification((notification) => {
      const params = notification.params || {};
      const notifThreadId: string | undefined = params.threadId || params.thread?.id;
      if (notification.method === 'turn/completed') {
        finishAutomationRun(params.threadId, params.turn?.error);
      }
      if (notifThreadId && [...automationRunsRef.current.values()].includes(notifThreadId)) {
        return;
      }
      if (notifThreadId && threadRef.current && notifThreadId !== threadRef.current) {
        return;
      }
      switch (notification.method) {
        case 'thread/started':
          if (params.thread?.id && pendingUserRef.current) setThreadId(params.thread.id);
          break;
        case 'turn/started':
          setRunning(true);
          setTurnId(params.turn?.id || null);
          setLastTurnId(params.turn?.id || null);
          setLiveDiff('');
          break;
        case 'turn/diff/updated':
          if (!params.threadId || !threadRef.current || params.threadId === threadRef.current) {
            setLiveDiff(params.diff || '');
          }
          break;
        case 'turn/completed':
          setRunning(false);
          setTurnId(null);
          if (params.turn?.id) setLastTurnId(params.turn.id);
          if (params.turn?.error?.message) {
            setError(friendlyClientError(params.turn.error.message));
          }
          setReviewTick((previous) => previous + 1);
          refreshThreads();
          if (!document.hasFocus() && notifyOnComplete) {
            playCompletionChime();
            window.codex
              .notify({
                title: params.turn?.error?.message ? '任务未完成' : '任务完成',
                body: params.turn?.error?.message || 'Codex 已结束本轮工作，点击回到应用。',
              })
              .catch(() => {});
          }
          break;
        case 'item/started':
          if (params.item) {
            const incoming: Item = params.item;
            if (incoming.type === 'userMessage' && pendingUserRef.current) {
              const localId = pendingUserRef.current;
              pendingUserRef.current = null;
              if (itemTimesRef.current[localId]) {
                itemTimesRef.current[incoming.id] = itemTimesRef.current[localId];
                delete itemTimesRef.current[localId];
              }
              setItems((list) => list.map((entry) => (entry.id === localId ? incoming : entry)));
            } else {
              setItems((list) => upsertItem(list, incoming));
            }
          }
          break;
        case 'item/completed':
          if (params.item) setItems((list) => upsertItem(list, params.item));
          break;
        case 'item/agentMessage/delta':
          if (params.itemId) {
            setItems((list) => appendTextDelta(list, params.itemId, params.delta || ''));
          }
          break;
        case 'item/reasoning/textDelta':
        case 'item/reasoning/summaryTextDelta':
          if (params.itemId) {
            setItems((list) => appendReasoningDelta(list, params.itemId, params.delta || ''));
          }
          break;
        case 'item/commandExecution/outputDelta':
        case 'item/fileChange/outputDelta':
          if (params.itemId) {
            setItems((list) => appendOutputDelta(list, params.itemId, params.delta || ''));
          }
          break;
        case 'warning':
          if (params.message) setError(friendlyClientError(params.message));
          break;
        case 'project/changed':
          refreshProjects();
          refreshThreads();
          break;
        case 'thread/project/updated':
          refreshThreads();
          break;
        case 'thread/section/changed':
          refreshSections();
          refreshThreads();
          break;
        case 'thread/archived':
        case 'thread/unarchived':
          refreshThreads();
          break;
        case 'thread/readState/changed':
          if (params.threadId && params.readState) {
            setReadStates((previous) => ({
              ...previous,
              [params.threadId]: params.readState,
            }));
          }
          break;
        case 'thread/tokenUsage/updated': {
          if (params.threadId && threadRef.current && params.threadId !== threadRef.current) break;
          const last = params.tokenUsage?.last || {};
          const total = params.tokenUsage?.total || {};
          const context = params.tokenUsage?.modelContextWindow ?? null;
          setUsage({
            total: total.totalTokens ?? 0,
            context,
            lastInput: last.inputTokens ?? 0,
            lastOutput: last.outputTokens ?? 0,
            input: total.inputTokens ?? 0,
            cached: total.cachedInputTokens ?? 0,
          });
          break;
        }
        case 'error':
          setError(
            params.error?.message ? friendlyClientError(params.error.message) : '请求出错',
          );
          break;
        default:
          break;
      }
    });
    return unsubscribe;
  }, [finishAutomationRun, refreshProjects, refreshSections, refreshThreads]);

  useEffect(() => {
    const unsubscribe = window.codex.onServerRequest((request) => {
      if (request.method === 'item/commandExecution/requestApproval') {
        setApproval({
          id: request.id,
          kind: 'command',
          threadId: request.params?.threadId,
          turnId: request.params?.turnId,
          itemId: request.params?.itemId,
          approvalId: request.params?.approvalId,
          command: request.params?.command,
          cwd: request.params?.cwd,
          reason: request.params?.reason,
        });
        return;
      }
      if (request.method === 'item/fileChange/requestApproval') {
        setApproval({
          id: request.id,
          kind: 'file',
          threadId: request.params?.threadId,
          turnId: request.params?.turnId,
          itemId: request.params?.itemId,
          reason: request.params?.reason,
          grantRoot: request.params?.grantRoot,
        });
        return;
      }
      if (request.method === 'item/permissions/requestApproval') {
        setApproval({
          id: request.id,
          kind: 'permissions',
          threadId: request.params?.threadId,
          turnId: request.params?.turnId,
          itemId: request.params?.itemId,
          cwd: request.params?.cwd,
          reason: request.params?.reason,
          permissions: request.params?.permissions,
        });
        return;
      }
      if (request.method === 'item/tool/requestUserInput') {
        setPendingInput({
          id: request.id,
          questions: request.params?.questions || [],
        });
        return;
      }
      window.codex.respond(request.id, undefined, {
        code: -32601,
        message: `客户端暂不支持：${request.method}`,
      });
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    let cancelled = false;
    for (const filePath of attachments) {
      if (thumbnails[filePath]) continue;
      window.codex
        .imageDataUrl(filePath)
        .then((dataUrl) => {
          if (!cancelled) setThumbnails((previous) => ({ ...previous, [filePath]: dataUrl }));
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [attachments, thumbnails]);

  useEffect(() => {
    streamAtBottomRef.current = true;
    const element = streamRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [threadId]);

  useEffect(() => {
    const element = streamRef.current;
    if (element && streamAtBottomRef.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [items, running, approval, pendingInput]);

  const handleStreamScroll = useCallback(() => {
    const element = streamRef.current;
    if (!element) return;
    streamAtBottomRef.current =
      element.scrollHeight - element.scrollTop - element.clientHeight < 80;
  }, []);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 180)}px`;
  }, [input]);

  const decide = useCallback(
    (decision: string) => {
      if (!approval) return;
      if (approval.kind === 'permissions') {
        if (decision === 'decline') {
          window.codex.respond(approval.id, undefined, {
            code: -32000,
            message: 'permission denied',
          });
        } else {
          window.codex.respond(approval.id, {
            permissions: approval.permissions ?? {},
            scope: decision === 'acceptForSession' ? 'session' : 'turn',
          });
        }
      } else {
        window.codex.respond(approval.id, { decision });
      }
      setApproval(null);
    },
    [approval],
  );

  const submitUserInput = useCallback(
    (answers: Record<string, string>) => {
      if (!pendingInput) return;
      const payload: Record<string, { answers: string[] }> = {};
      for (const question of pendingInput.questions) {
        payload[question.id] = { answers: [answers[question.id] || ''] };
      }
      window.codex.respond(pendingInput.id, { answers: payload });
      setPendingInput(null);
    },
    [pendingInput],
  );

  const declineUserInput = useCallback(() => {
    if (!pendingInput) return;
    window.codex.respond(pendingInput.id, undefined, {
      code: -32000,
      message: 'user declined to answer',
    });
    setPendingInput(null);
  }, [pendingInput]);

  const applySettings = useCallback((next: RuntimeSettings) => {
    setSettings(next);
    try {
      writeJsonStorage('deepseek-codex.settings', next);
    } catch {
      /* ignore */
    }
  }, []);

  const newSession = useCallback(() => {
    setAutomationOpen(false);
    setCapabilitiesOpen(false);
    setSearchOpen(false);
    setThreadId(null);
    threadRef.current = null;
    setItems([]);
    setRunning(false);
    setTurnId(null);
    setLastTurnId(null);
    setVisibleItemCount(120);
    setApproval(null);
    setPendingInput(null);
    setError(null);
    setMenuThreadId(null);
    setWorktree(null);
    worktreeRef.current = null;
    setAttachments([]);
    setUsage({ total: 0, context: null, lastInput: 0, lastOutput: 0, input: 0, cached: 0 });
    setLiveDiff('');
  }, []);

  useEffect(() => {
    const off = window.codex.onTrayAction((action) => {
      if (action === 'new-session') newSession();
      if (action === 'settings') openSettings();
    });
    return off;
  }, [newSession]);

  useEffect(() => {
    window.codex.rendererReady();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (document.querySelector('.key-overlay')) return;
      const key = event.key.toLowerCase();
      if (key === 'n') {
        event.preventDefault();
        newSession();
      } else if (key === ',') {
        event.preventDefault();
        openSettings();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [newSession]);

  const resumeThread = useCallback(async (thread: ThreadSummary, record = true) => {
    try {
      setAutomationOpen(false);
      setCapabilitiesOpen(false);
      setSearchOpen(false);
      setError(null);
      setApproval(null);
      setMenuThreadId(null);
      const response = await window.codex.request('thread/resume', { threadId: thread.id });
      const resumed = response?.thread;
      if (!resumed) throw new Error('恢复会话失败');
      setThreadId(resumed.id);
      threadRef.current = resumed.id;
      if (record) recordHistory(resumed.id);
      const readState = readStatesRef.current[resumed.id];
      if (readState?.revision) {
        window.codex
          .request('thread/readState/update', {
            threadId: resumed.id,
            operation: { type: 'read' },
            expectedRevision: readState.revision,
          })
          .then((result) => {
            setReadStates((previous) => ({
              ...previous,
              [resumed.id]: result?.readState || { ...readState, firstUnread: null },
            }));
          })
          .catch(() => {});
      }
      const nextProjectId = resumed.projectId ?? null;
      setProjectId(nextProjectId);
      projectIdRef.current = nextProjectId;
      if (resumed.cwd) setCwd(resumed.cwd);
      const history: Item[] = (resumed.turns || []).flatMap((turn: any) => turn.items || []);
      const itemTimes: Record<string, number> = {};
      for (const turn of resumed.turns || []) {
        const at = turn.startedAt || turn.completedAt;
        if (!at) continue;
        for (const item of turn.items || []) {
          if (item.type === 'userMessage') itemTimes[item.id] = at;
        }
      }
      itemTimesRef.current = itemTimes;
      setItems(history);
      setVisibleItemCount(120);
      const resumedTurns: any[] = resumed.turns || [];
      setLastTurnId(resumedTurns[resumedTurns.length - 1]?.id || null);
      setRunning(false);
      setTurnId(null);
      setUsage({ total: 0, context: null, lastInput: 0, lastOutput: 0, input: 0, cached: 0 });
      setLiveDiff('');
      refreshThreads();
    } catch (resumeError: any) {
      setError(friendlyClientError(resumeError));
    }
  }, [recordHistory, refreshThreads]);

  const navigateHistory = useCallback(
    async (delta: number) => {
      const next = historyIndexRef.current + delta;
      const id = historyRef.current[next];
      if (!id) return;
      historyIndexRef.current = next;
      setHistoryIndex(next);
      await resumeThread({ id, preview: '' }, false);
    },
    [resumeThread],
  );

  const pickFolder = useCallback(async () => {
    const picked = await window.codex.pickFolder();
    if (!picked) return;
    setCwd(picked);
    const match = projects.find((project) =>
      project.roots?.some((root) => root.path.toLowerCase() === picked.toLowerCase()),
    );
    if (match) {
      setProjectId(match.id);
      projectIdRef.current = match.id;
    } else if (projectIdRef.current) {
      setProjectId(null);
      projectIdRef.current = null;
    }
    refreshThreads();
  }, [projects, refreshThreads]);

  const selectProject = useCallback(
    (project: ProjectInfo | null) => {
      setProjectMenuId(null);
      const nextId = project?.id ?? null;
      if (nextId === projectIdRef.current) return;
      setProjectId(nextId);
      projectIdRef.current = nextId;
      if (project?.roots?.[0]?.path) setCwd(project.roots[0].path);
      newSession();
      refreshThreads();
    },
    [newSession, refreshThreads],
  );

  const addProject = useCallback(async () => {
    const picked = await window.codex.pickFolder();
    if (!picked) return;
    const existing = projects.find((project) =>
      project.roots?.some((root) => root.path.toLowerCase() === picked.toLowerCase()),
    );
    if (existing) {
      selectProject(existing);
      return;
    }
    try {
      const name = picked.split(/[\\/]/).filter(Boolean).pop() || picked;
      const created = await window.codex.request('project/create', {
        name,
        roots: [{ path: picked }],
        idempotencyKey: `gui-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
      });
      const project: ProjectInfo | undefined = created?.project;
      if (!project) throw new Error('创建项目失败');
      await refreshProjects();
      selectProject(project);
    } catch (projectError: any) {
      setError(friendlyClientError(projectError));
    }
  }, [projects, refreshProjects, selectProject]);

  const removeProject = useCallback(
    async (project: ProjectInfo) => {
      setProjectMenuId(null);
      if (!window.confirm(`移除项目「${project.name}」？项目内的会话不会被删除。`)) return;
      try {
        await window.codex.request('project/delete', { projectId: project.id });
        if (projectIdRef.current === project.id) {
          setProjectId(null);
          projectIdRef.current = null;
        }
        await refreshProjects();
        refreshThreads();
      } catch (projectError: any) {
        setError(friendlyClientError(projectError));
      }
    },
    [refreshProjects, refreshThreads],
  );

  const saveProjectRename = useCallback(async () => {
    if (!projectRenameTarget) return;
    const name = projectRenameInput.trim();
    if (!name) return;
    try {
      await window.codex.request('project/update', {
        projectId: projectRenameTarget.id,
        name,
      });
      setProjectRenameTarget(null);
      setProjectRenameInput('');
      refreshProjects();
    } catch (projectError: any) {
      setError(friendlyClientError(projectError));
    }
  }, [projectRenameInput, projectRenameTarget, refreshProjects]);

  const pickFiles = useCallback(async () => {
    const paths = await window.codex.pickFiles();
    if (!paths.length) return;
    setInput((previous) => {
      const prefix = previous && !previous.endsWith('\n') ? `${previous}\n` : previous;
      return `${prefix}${paths.map((file) => `@${file}`).join('\n')}`;
    });
  }, []);

  const pickImages = useCallback(async () => {
    const paths = await window.codex.pickImages();
    if (!paths.length) return;
    setAttachments((previous) => [...new Set([...previous, ...paths])]);
  }, []);

  const toggleWorktree = useCallback(() => {
    setWorktreeMode((previous) => {
      const next = !previous;
      try {
        writeStorage('deepseek-codex.worktree', next ? '1' : '0');
      } catch {
        /* ignore */
      }
      if (!next) {
        setWorktree(null);
        worktreeRef.current = null;
      }
      return next;
    });
  }, []);

  const openCapabilities = useCallback(async () => {
    setCapabilitiesOpen(true);
    setRailOpen(false);
    setCapabilities({
      loading: true,
      mcp: null,
      skills: null,
      plugins: null,
      hooks: null,
      error: null,
    });
    const withTimeout = <T,>(promise: Promise<T>, ms: number): Promise<T> =>
      Promise.race([
        promise,
        new Promise<T>((_resolve, reject) =>
          setTimeout(() => reject(new Error('读取能力信息超时（MCP 可能未就绪）')), ms),
        ),
      ]);
    const cwdList = cwdRef.current ? [cwdRef.current] : [];
    const [mcp, skills, plugins, hooks] = await Promise.all([
      withTimeout(window.codex.request('mcpServerStatus/list', { limit: 50 }), 8000).catch(
        (error: any) => ({ error: error?.message || String(error) }),
      ),
      withTimeout(window.codex.request('skills/list', { cwds: cwdList }), 8000).catch(
        (error: any) => ({ error: error?.message || String(error) }),
      ),
      withTimeout(window.codex.request('plugin/list', { cwds: cwdList }), 8000).catch(
        (error: any) => ({ error: error?.message || String(error) }),
      ),
      withTimeout(window.codex.request('hooks/list', { cwds: cwdList }), 8000).catch(
        (error: any) => ({ error: error?.message || String(error) }),
      ),
    ]);
    setCapabilities({ loading: false, mcp, skills, plugins, hooks, error: null });
  }, []);

  const toggleSkill = useCallback(
    async (skill: any) => {
      setCapabilityBusy(true);
      try {
        await window.codex.request('skills/config/write', {
          name: skill.name,
          enabled: !skill.enabled,
        });
        await openCapabilities();
      } catch (toggleError: any) {
        setError(friendlyClientError(toggleError));
      } finally {
        setCapabilityBusy(false);
      }
    },
    [openCapabilities],
  );

  const saveMcp = useCallback(async () => {
    const name = mcpForm.name.trim();
    if (!/^[A-Za-z0-9_-]+$/.test(name) || !mcpForm.command.trim()) {
      setError('MCP 名称只能是字母/数字/-/_，且必须填写启动命令');
      return;
    }
    const env: Record<string, string> = {};
    for (const line of mcpForm.env.split(/\r?\n/)) {
      const index = line.indexOf('=');
      if (index > 0) env[line.slice(0, index).trim()] = line.slice(index + 1).trim();
    }
    const value: any = {
      command: mcpForm.command.trim(),
      args: mcpForm.args.trim() ? mcpForm.args.trim().split(/\s+/) : [],
    };
    if (Object.keys(env).length) value.env = env;
    setCapabilityBusy(true);
    try {
      await window.codex.request('config/batchWrite', {
        edits: [
          {
            keyPath: `mcp_servers.${name}`,
            value,
            mergeStrategy: 'replace',
          },
        ],
        reloadUserConfig: true,
      });
      setMcpForm({ name: '', command: '', args: '', env: '' });
      await openCapabilities();
    } catch (saveError: any) {
      setError(friendlyClientError(saveError));
    } finally {
      setCapabilityBusy(false);
    }
  }, [mcpForm, openCapabilities]);

  const removeMcp = useCallback(
    async (name: string) => {      if (!window.confirm(`移除 MCP 服务器「${name}」？`)) return;
      setCapabilityBusy(true);
      try {
        await window.codex.request('config/batchWrite', {
          edits: [
            {
              keyPath: `mcp_servers.${name}`,
              value: null,
              mergeStrategy: 'replace',
            },
          ],
          reloadUserConfig: true,
        });
        await openCapabilities();
      } catch (removeError: any) {
        setError(friendlyClientError(removeError));
      } finally {
        setCapabilityBusy(false);
      }
    },
    [openCapabilities],
  );

  const loginMcp = useCallback(
    async (server: any) => {
      setCapabilityBusy(true);
      try {
        const response = await window.codex.request('mcpServer/oauth/login', {
          name: server.name,
        });
        if (response?.authorizationUrl) {
          await window.codex.openExternal(response.authorizationUrl);
          setNotice(`已打开 ${server.name} 的授权页面，完成后刷新能力列表`);
        } else {
          setNotice('登录请求已发出');
        }
      } catch (loginError: any) {
        setError(friendlyClientError(loginError));
      } finally {
        setCapabilityBusy(false);
      }
    },
    [],
  );

  const installPlugin = useCallback(
    async (marketplace: any, plugin: any) => {
      setPluginBusy(true);
      try {
        await window.codex.request('plugin/install', {
          marketplacePath: marketplace.path || undefined,
          remoteMarketplaceName: marketplace.path ? undefined : marketplace.name,
          pluginName: plugin.name,
        });
        setNotice(`已安装插件 ${plugin.name}`);
        await openCapabilities();
      } catch (pluginError: any) {
        setError(friendlyClientError(pluginError));
      } finally {
        setPluginBusy(false);
      }
    },
    [openCapabilities],
  );

  const uninstallPlugin = useCallback(
    async (plugin: any) => {
      if (!window.confirm(`卸载插件「${plugin.name}」？`)) return;
      setPluginBusy(true);
      try {
        await window.codex.request('plugin/uninstall', { pluginId: plugin.id });
        setNotice(`已卸载插件 ${plugin.name}`);
        await openCapabilities();
      } catch (pluginError: any) {
        setError(friendlyClientError(pluginError));
      } finally {
        setPluginBusy(false);
      }
    },
    [openCapabilities],
  );

  const searchPlugins = useCallback(async () => {
    const query = pluginQuery.trim();
    if (!query) {
      setPluginResults([]);
      return;
    }
    setPluginResultsBusy(true);
    try {
      const response = await window.codex.request('plugin/search', {
        searchTerm: query,
        cwds: cwdRef.current ? [cwdRef.current] : undefined,
        limit: 20,
      });
      setPluginResults(response?.data || []);
    } catch (searchError: any) {
      setError(friendlyClientError(searchError));
    } finally {
      setPluginResultsBusy(false);
    }
  }, [pluginQuery]);

  const addMarketplace = useCallback(async () => {
    const source = marketplaceSource.trim();
    if (!source) return;
    setMarketplaceBusy(true);
    try {
      const response = await window.codex.request('marketplace/add', {
        source,
        refName: marketplaceRef.trim() || undefined,
      });
      setNotice(
        response?.alreadyAdded ? '该市场已存在' : `已添加市场 ${response?.marketplaceName || source}`,
      );
      setMarketplaceSource('');
      setMarketplaceRef('');
      await openCapabilities();
    } catch (marketplaceError: any) {
      setError(friendlyClientError(marketplaceError));
    } finally {
      setMarketplaceBusy(false);
    }
  }, [marketplaceRef, marketplaceSource, openCapabilities]);

  const upgradeMarketplaces = useCallback(
    async (marketplaceName?: string) => {
      setMarketplaceBusy(true);
      try {
        const response = await window.codex.request('marketplace/upgrade', {
          marketplaceName: marketplaceName || null,
        });
        const errors = response?.errors || [];
        setNotice(
          errors.length
            ? `已升级 ${response?.selectedMarketplaces?.length || 0} 个市场，${errors.length} 个失败`
            : `已升级 ${response?.selectedMarketplaces?.length || 0} 个市场`,
        );
        await openCapabilities();
      } catch (marketplaceError: any) {
        setError(friendlyClientError(marketplaceError));
      } finally {
        setMarketplaceBusy(false);
      }
    },
    [openCapabilities],
  );

  const removeMarketplace = useCallback(
    async (marketplaceName: string) => {
      if (!window.confirm(`移除插件市场「${marketplaceName}」？`)) return;
      setMarketplaceBusy(true);
      try {
        await window.codex.request('marketplace/remove', { marketplaceName });
        setNotice(`已移除市场 ${marketplaceName}`);
        await openCapabilities();
      } catch (marketplaceError: any) {
        setError(friendlyClientError(marketplaceError));
      } finally {
        setMarketplaceBusy(false);
      }
    },
    [openCapabilities],
  );

  const readPlugin = useCallback(async (plugin: any, marketplaceName: string, marketplacePath?: string) => {
    try {
      const response = await window.codex.request('plugin/read', {
        pluginName: plugin.name,
        marketplacePath: marketplacePath || undefined,
        remoteMarketplaceName: marketplacePath ? undefined : marketplaceName,
      });
      setPluginDetail(response?.plugin || null);
    } catch (pluginError: any) {
      setError(friendlyClientError(pluginError));
    }
  }, []);

  const reloadMcp = useCallback(async () => {
    setCapabilityBusy(true);
    try {
      await window.codex.request('config/mcpServer/reload', {});
      await openCapabilities();
    } catch (mcpError: any) {
      setError(friendlyClientError(mcpError));
    } finally {
      setCapabilityBusy(false);
    }
  }, [openCapabilities]);

  const runMcpCall = useCallback(async () => {
    if (!mcpCall) return;
    setMcpCall({ ...mcpCall, busy: true, result: null });
    try {
      let response: any;
      if (mcpCall.kind === 'tool') {
        if (!threadRef.current) throw new Error('请先打开一个会话再调用 MCP 工具');
        const parsedArgs = mcpCall.args.trim() ? JSON.parse(mcpCall.args) : {};
        response = await window.codex.request('mcpServer/tool/call', {
          threadId: threadRef.current,
          server: mcpCall.server,
          tool: mcpCall.tool,
          arguments: parsedArgs,
        });
      } else {
        response = await window.codex.request('mcpServer/resource/read', {
          server: mcpCall.server,
          uri: mcpCall.uri,
          threadId: threadRef.current || undefined,
        });
      }
      setMcpCall((current) =>
        current ? { ...current, busy: false, result: JSON.stringify(response, null, 2) } : null,
      );
    } catch (mcpError: any) {
      setMcpCall((current) =>
        current
          ? { ...current, busy: false, result: `错误：${mcpError?.message || String(mcpError)}` }
          : null,
      );
    }
  }, [mcpCall]);

  const applyWorktreeChanges = useCallback(async () => {
    if (!worktree) return;
    setWorktreeBusy(true);
    try {
      const result = await window.codex.applyWorktree({
        repoRoot: worktree.repoRoot,
        worktreePath: worktree.path,
      });
      setNotice(result.applied ? result.message || '已应用到主仓库工作区' : result.message || '没有可应用的变更');
    } catch (applyError: any) {
      setError(friendlyClientError(applyError));
    } finally {
      setWorktreeBusy(false);
    }
  }, [worktree]);

  const removeWorktreeSession = useCallback(async () => {
    if (!worktree) return;
    if (runningRef.current) {
      setError('任务运行中，不能清理 Worktree');
      return;
    }
    if (!window.confirm(`删除 Worktree「${worktree.branch}」？未应用的变更会丢失。`)) return;
    setWorktreeBusy(true);
    try {
      await window.codex.removeWorktree({
        repoRoot: worktree.repoRoot,
        worktreePath: worktree.path,
        branch: worktree.branch,
      });
      newSession();
      setNotice('Worktree 已清理');
    } catch (removeError: any) {
      setError(friendlyClientError(removeError));
    } finally {
      setWorktreeBusy(false);
    }
  }, [newSession, worktree]);

  const deleteThread = useCallback(
    async (thread: ThreadSummary) => {
      if (!window.confirm(`删除会话「${thread.name || thread.preview || thread.id}」？此操作不可撤销。`)) {
        return;
      }
      try {
        await window.codex.request('thread/delete', { threadId: thread.id });
        if (threadRef.current === thread.id) newSession();
        refreshThreads();
      } catch (deleteError: any) {
        setError(friendlyClientError(deleteError));
      }
    },
    [newSession, refreshThreads],
  );

  const archiveThread = useCallback(
    async (thread: ThreadSummary) => {
      try {
        await window.codex.request('thread/archive', { threadId: thread.id });
        if (threadRef.current === thread.id) newSession();
        refreshThreads();
      } catch (archiveError: any) {
        setError(friendlyClientError(archiveError));
      }
    },
    [newSession, refreshThreads],
  );

  const unarchiveThread = useCallback(
    async (thread: ThreadSummary) => {
      try {
        await window.codex.request('thread/unarchive', { threadId: thread.id });
        refreshThreads();
      } catch (archiveError: any) {
        setError(friendlyClientError(archiveError));
      }
    },
    [refreshThreads],
  );

  const forkThread = useCallback(
    async (thread: ThreadSummary) => {
      try {
        const response = await window.codex.request('thread/fork', {
          threadId: thread.id,
        });
        const forked = response?.thread;
        if (!forked?.id) throw new Error('分叉会话失败');
        setMenuThreadId(null);
        refreshThreads();
        await resumeThread({ id: forked.id, preview: forked.preview || '分叉会话' });
      } catch (forkError: any) {
        setError(friendlyClientError(forkError));
      }
    },
    [refreshThreads, resumeThread],
  );

  const revertLastTurn = useCallback(async () => {
    if (!threadRef.current || !lastTurnIdRef.current || runningRef.current) return;
    if (!window.confirm('回退最后一轮？该轮及之后的内容会从会话历史中移除。')) return;
    try {
      const activeThread = threadRef.current;
      await window.codex.request('thread/revert', {
        threadId: activeThread,
        beforeTurnId: lastTurnIdRef.current,
      });
      setMenuThreadId(null);
      await resumeThread({ id: activeThread, preview: '' }, false);
      setNotice('已回退最后一轮');
    } catch (revertError: any) {
      setError(friendlyClientError(revertError));
    }
  }, [resumeThread]);

  const togglePinThread = useCallback(
    async (thread: ThreadSummary) => {
      if (!pinnedSectionId) return;
      try {
        await window.codex.request('thread/section/move', {
          threadId: thread.id,
          sectionId: thread.section?.id === pinnedSectionId ? null : pinnedSectionId,
        });
        setMenuThreadId(null);
        refreshThreads();
      } catch (pinError: any) {
        setError(friendlyClientError(pinError));
      }
    },
    [pinnedSectionId, refreshThreads],
  );

  const markThreadUnread = useCallback(async (thread: ThreadSummary) => {
    const state = readStatesRef.current[thread.id];
    if (!state?.revision) return;
    try {
      const result = await window.codex.request('thread/readState/update', {
        threadId: thread.id,
        operation: { type: 'unread' },
        expectedRevision: state.revision,
      });
      if (result?.readState) {
        setReadStates((previous) => ({ ...previous, [thread.id]: result.readState }));
      }
      setMenuThreadId(null);
    } catch (unreadError: any) {
      setError(friendlyClientError(unreadError));
    }
  }, []);

  const moveThreadToSection = useCallback(
    async (thread: ThreadSummary, sectionId: string | null) => {
      try {
        await window.codex.request('thread/section/move', {
          threadId: thread.id,
          sectionId,
        });
        setMoveThreadId(null);
        setMenuThreadId(null);
        refreshThreads();
      } catch (moveError: any) {
        setError(friendlyClientError(moveError));
      }
    },
    [refreshThreads],
  );

  const saveSectionDialog = useCallback(async () => {
    if (!sectionDialog) return;
    const name = sectionDialog.name.trim();
    if (!name) return;
    try {
      if (sectionDialog.mode === 'create') {
        await window.codex.request('threadSection/create', { name });
      } else if (sectionDialog.id) {
        await window.codex.request('threadSection/update', {
          sectionId: sectionDialog.id,
          name,
        });
      }
      setSectionDialog(null);
      refreshSections();
      refreshThreads();
    } catch (sectionError: any) {
      setError(friendlyClientError(sectionError));
    }
  }, [refreshSections, refreshThreads, sectionDialog]);

  const removeSection = useCallback(
    async (section: { id: string; name: string }) => {
      setSectionMenuId(null);
      if (!window.confirm(`删除分区「${section.name}」？其中的会话会回到未分区列表。`)) return;
      try {
        await window.codex.request('threadSection/delete', { sectionId: section.id });
        refreshSections();
        refreshThreads();
      } catch (sectionError: any) {
        setError(friendlyClientError(sectionError));
      }
    },
    [refreshSections, refreshThreads],
  );

  const compactThread = useCallback(async () => {
    if (!threadRef.current) return;
    try {
      await window.codex.request('thread/compact/start', { threadId: threadRef.current });
      setMenuThreadId(null);
      setError(null);
    } catch (compactError: any) {
      setError(friendlyClientError(compactError));
    }
  }, []);

  const saveRename = useCallback(async () => {
    if (!renameTarget) return;
    const name = renameInput.trim();
    if (!name) return;
    try {
      await window.codex.request('thread/name/set', {
        threadId: renameTarget.id,
        name,
      });
      setThreads((list) =>
        list.map((thread) => (thread.id === renameTarget.id ? { ...thread, name } : thread)),
      );
      setRenameTarget(null);
      setRenameInput('');
    } catch (renameError: any) {
      setError(friendlyClientError(renameError));
    }
  }, [renameInput, renameTarget]);

  const saveKey = useCallback(async () => {
    const key = keyInput.trim();
    if (!key) return;
    setKeySaving(true);
    setError(null);
    try {
      await window.codex.setApiKey(key);
      setKeyInput('');
      setKeyDialog(false);
      setStatus('connecting');
      const refreshed = await window.codex.getConfig();
      setConfig(refreshed);
      setStatus(refreshed.online ? 'ready' : 'offline');
      refreshThreads();
    } catch (saveError: any) {
      setError(friendlyClientError(saveError));
    } finally {
      setKeySaving(false);
    }
  }, [keyInput, refreshThreads]);

  const stop = useCallback(async () => {
    if (!threadRef.current || !turnIdRef.current) return;
    try {
      await window.codex.request('turn/interrupt', {
        threadId: threadRef.current,
        turnId: turnIdRef.current,
      });
    } catch (stopError) {
      setError(friendlyClientError(stopError));
      return;
    }
    setRunning(false);
  }, []);

  const startReview = useCallback(
    async (target: ReviewTarget) => {
      if (!config || reviewBusy) return;
      if (runningRef.current) {
        setError('当前任务运行中，完成或停止后再开始审查');
        return;
      }
      setReviewBusy(true);
      setError(null);
      try {
        let activeThread = threadRef.current;
        if (!activeThread) {
          const created = await window.codex.request('thread/start', {
            cwd: worktreeRef.current?.path || cwdRef.current,
            model: modelRef.current,
            modelProvider: config.defaultProvider || 'deepseek',
            approvalPolicy: settingsRef.current.approvalPolicy,
            sandbox: settingsRef.current.sandbox,
            projectId: projectIdRef.current || undefined,
          });
          activeThread = created?.thread?.id;
          if (!activeThread) throw new Error('创建会话失败');
          setThreadId(activeThread);
          threadRef.current = activeThread;
        }
        const response = await window.codex.request('review/start', {
          threadId: activeThread,
          target,
          delivery: 'inline',
        });
        setTurnId(response?.turn?.id || null);
        setRunning(true);
        setLiveDiff('');
        setReviewDialogOpen(false);
        openRail('review');
        refreshThreads();
      } catch (reviewError) {
        setError(friendlyClientError(reviewError));
      } finally {
        setReviewBusy(false);
      }
    },
    [config, openRail, refreshThreads, reviewBusy],
  );

  const buildTurnInput = useCallback(
    (text: string, files: string[] = attachments) => [
      { type: 'text', text, text_elements: [] },
      ...files.map((path) => ({ type: 'localImage', path })),
    ],
    [attachments],
  );

  const send = useCallback(async (overrideText?: string) => {
    const text = (typeof overrideText === 'string' ? overrideText : input).trim();
    if (!text || !config || preparing) return;
    setError(null);

    if (runningRef.current) {
      const activeThread = threadRef.current;
      const activeTurn = turnIdRef.current;
      if (!activeThread || !activeTurn) {
        setError('当前任务状态未知，请稍后重试');
        return;
      }
      const files = attachments;
      setInput('');
      try {
        await window.codex.request('turn/steer', {
          threadId: activeThread,
          expectedTurnId: activeTurn,
          input: buildTurnInput(text, files),
        });
        setAttachments([]);
      } catch (steerError) {
        setInput((previous) => previous || text);
        setError(friendlyClientError(steerError));
      }
      return;
    }

    let effectiveCwd = worktreeRef.current?.path || cwdRef.current;
    if (!threadRef.current && worktreeMode && !worktreeRef.current) {
      const alreadyWorktree = /\.codex[\\/]worktrees[\\/]/.test(cwdRef.current);
      if (!alreadyWorktree) {
        setPreparing(true);
        try {
          const info = await window.codex.createWorktree(cwdRef.current);
          worktreeRef.current = info;
          setWorktree(info);
          effectiveCwd = info.path;
        } catch (worktreeError: any) {
          setError(friendlyClientError(worktreeError));
          return;
        } finally {
          setPreparing(false);
        }
      }
    }

    setInput('');
    streamAtBottomRef.current = true;
    const localId = `local-${Date.now()}`;
    itemTimesRef.current[localId] = Math.floor(Date.now() / 1000);
    pendingUserRef.current = localId;
    const files = attachments;
    setItems((list) => [
      ...list,
      {
        id: localId,
        type: 'userMessage',
        content: [
          { type: 'text', text },
          ...files.map((path) => ({ type: 'localImage', path })),
        ],
      },
    ]);
    setRunning(true);
    const activeSettings = settingsRef.current;
    try {
      let activeThread = threadRef.current;
      if (!activeThread) {
        const created = await window.codex.request('thread/start', {
          cwd: effectiveCwd,
          model: modelRef.current,
          modelProvider: config.defaultProvider || 'deepseek',
          approvalPolicy: activeSettings.approvalPolicy,
          sandbox: activeSettings.sandbox,
          projectId: projectIdRef.current || undefined,
        });
        activeThread = created?.thread?.id;
        if (!activeThread) throw new Error('创建会话失败');
        setThreadId(activeThread);
        threadRef.current = activeThread;
        refreshThreads();
      }
      const turnParams: Record<string, unknown> = {
        threadId: activeThread,
        model: modelRef.current,
        approvalPolicy: activeSettings.approvalPolicy,
        effort: activeSettings.effort,
        sandboxPolicy: sandboxPolicyFor(activeSettings.sandbox),
        input: buildTurnInput(text, files),
      };
      if (modeRef.current === 'plan') {
        turnParams.collaborationMode = {
          mode: 'plan',
          settings: {
            model: modelRef.current,
            reasoning_effort: activeSettings.effort,
            developer_instructions: null,
          },
        };
      }
      const turn = await window.codex.request('turn/start', turnParams);
      setTurnId(turn?.turn?.id || null);
      setLastTurnId(turn?.turn?.id || null);
      setAttachments([]);
    } catch (sendError) {
      setRunning(false);
      pendingUserRef.current = null;
      delete itemTimesRef.current[localId];
      setItems((list) => list.filter((item) => item.id !== localId));
      setInput((previous) => previous || text);
      setError(friendlyClientError(sendError));
    }
  }, [attachments, buildTurnInput, config, input, preparing, refreshThreads, worktreeMode]);

  const retryLastTurn = useCallback(async () => {
    if (!threadRef.current || !lastTurnIdRef.current || runningRef.current) return;
    const lastUser = [...items].reverse().find((item) => item.type === 'userMessage');
    const text = textOfContent(lastUser?.content).trim();
    if (!text) {
      setError('找不到可重试的用户消息');
      return;
    }
    if (!window.confirm('重新生成最后一轮？当前回答会被移除并重新执行。')) return;
    try {
      const activeThread = threadRef.current;
      await window.codex.request('thread/revert', {
        threadId: activeThread,
        beforeTurnId: lastTurnIdRef.current,
      });
      await resumeThread({ id: activeThread, preview: '' }, false);
      setNotice('已回退，正在重新生成…');
      await send(text);
    } catch (retryError) {
      setError(friendlyClientError(retryError));
    }
  }, [items, resumeThread, send]);

  const fixReviewComments = useCallback(
    (reviewText: string) => {
      if (runningRef.current) return;
      if (modeRef.current === 'plan') {
        modeRef.current = 'default';
        setMode('default');
      }
      void send(`请修复以下代码审查结果中的问题：\n\n${reviewText}`);
    },
    [send],
  );

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (mention) {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMention(null);
        return;
      }
      if (mention.results.length > 0) {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setMention({
            ...mention,
            index: (mention.index + 1) % mention.results.length,
          });
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          setMention({
            ...mention,
            index: (mention.index - 1 + mention.results.length) % mention.results.length,
          });
          return;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault();
          insertMention(mention.results[mention.index] || mention.results[0]);
          return;
        }
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  const currentThread = threads.find((thread) => thread.id === threadId);

  const canApprovePlan = mode === 'plan' && !running && Boolean(planMarkdown) && Boolean(threadId);

  const approvePlan = useCallback(async () => {
    if (!threadRef.current || !planMarkdown || runningRef.current) return;
    setError(null);
    setRunning(true);
    try {
      const prepared = await window.codex.request('thread/prepareApprovedPlan', {
        threadId: threadRef.current,
        markdown: planMarkdown,
      });
      const prompt: string = prepared?.prompt || 'Implement the plan.';
      const turn = await window.codex.request('turn/start', {
        threadId: threadRef.current,
        model: modelRef.current,
        approvalPolicy: settingsRef.current.approvalPolicy,
        effort: settingsRef.current.effort,
        sandboxPolicy: sandboxPolicyFor(settingsRef.current.sandbox),
        input: [{ type: 'text', text: prompt, text_elements: [] }],
      });
      setTurnId(turn?.turn?.id || null);
      setLastTurnId(turn?.turn?.id || null);
      setMode('default');
      setLiveDiff('');
    } catch (approveError) {
      setRunning(false);
      setError(friendlyClientError(approveError));
    }
  }, [planMarkdown]);

  const openSearchResult = useCallback(
    async (result: ThreadSearchResult) => {
      const query = threadQuery.trim();
      let itemId: string | null = null;
      if (query) {
        try {
          const response = await window.codex.request('thread/searchOccurrences', {
            threadId: result.thread.id,
            searchTerm: query,
            limit: 1,
          });
          const first = response?.data?.[0];
          itemId = first?.item_id ?? first?.itemId ?? null;
        } catch {
          itemId = null;
        }
      }
      setThreadQuery('');
      await resumeThread(result.thread);
      if (itemId) {
        const escaped = itemId.replace(/["\\]/g, '\\$&');
        const find = () =>
          document.querySelector<HTMLElement>(`[data-item-id="${escaped}"]`);
        const focus = () => {
          const target = find();
          if (!target) return false;
          target.scrollIntoView({ block: 'center' });
          target.classList.add('search-hit');
          window.setTimeout(() => target.classList.remove('search-hit'), 2600);
          return true;
        };
        window.setTimeout(() => {
          if (focus()) return;
          setVisibleItemCount(Number.MAX_SAFE_INTEGER);
          window.setTimeout(focus, 140);
        }, 260);
      }
    },
    [resumeThread, threadQuery],
  );

  const visibleItems = useMemo(
    () => items.slice(Math.max(0, items.length - visibleItemCount)),
    [items, visibleItemCount],
  );
  const itemGroups = useMemo(() => {
    const groups: (
      | { kind: 'single'; item: Item }
      | { kind: 'activity'; items: Item[]; key: string }
    )[] = [];
    const turns: Item[][] = [];
    let currentTurn: Item[] = [];
    for (const item of visibleItems) {
      if (item.type === 'userMessage' && currentTurn.length > 0) {
        turns.push(currentTurn);
        currentTurn = [];
      }
      currentTurn.push(item);
    }
    if (currentTurn.length > 0) turns.push(currentTurn);
    for (const turn of turns) {
      const activities = turn.filter((item) => isActivityItem(item));
      const hasTools = activities.some((item) => item.type !== 'reasoning');
      const activityGroup = hasTools
        ? { kind: 'activity' as const, items: activities, key: `activity-${activities[0].id}` }
        : null;
      let activityInserted = false;
      for (const item of turn) {
        if (isActivityItem(item)) {
          if (activityGroup && !activityInserted) {
            groups.push(activityGroup);
            activityInserted = true;
          }
          continue;
        }
        groups.push({ kind: 'single', item });
      }
    }
    return groups;
  }, [visibleItems]);

  const railTabs: { id: RailTab; label: string; icon: ReactNode; shortcut?: string }[] = [
    { id: 'files', label: '文件', icon: <FolderOpen size={13} />, shortcut: 'Ctrl+P' },
    { id: 'browser', label: '浏览器', icon: <Globe size={13} />, shortcut: 'Ctrl+T' },
    { id: 'review', label: '审阅', icon: <PanelRight size={13} /> },
  ];

  return (
    <div className="app-frame">
      <div className="titlebar">
        <div className="titlebar-nav">
          <button
            className="tb-btn"
            disabled={historyIndex <= 0}
            onClick={() => navigateHistory(-1)}
            title="返回上一个会话"
            aria-label="返回"
          >
            <ArrowLeft size={14} />
          </button>
          <button
            className="tb-btn"
            disabled={history.length === 0 || historyIndex >= history.length - 1}
            onClick={() => navigateHistory(1)}
            title="前进到下一个会话"
            aria-label="前进"
          >
            <ArrowRight size={14} />
          </button>
        </div>
        <div className="titlebar-drag" />
        <div className="titlebar-controls">
          <button
            className="win-btn"
            onClick={() => window.desktop?.minimize()}
            title="最小化"
            aria-label="最小化"
          >
            <Minus size={14} />
          </button>
          <button
            className="win-btn"
            onClick={() => {
              window.desktop
                ?.toggleMaximize()
                .then((state) => setMaximized(Boolean(state)))
                .catch(() => {});
            }}
            title={maximized ? '还原' : '最大化'}
            aria-label={maximized ? '还原' : '最大化'}
          >
            {maximized ? <Copy size={12} /> : <Square size={12} />}
          </button>
          <button
            className="win-btn close"
            onClick={() => window.desktop?.close()}
            title="关闭"
            aria-label="关闭"
          >
            <X size={15} />
          </button>
        </div>
      </div>

      <div className={`shell ${railOpen ? 'with-rail' : ''}`}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">◇</div>
          <div className="brand-info">
            <div className="brand-title">
              ShaNiu <span className="brand-badge">harness</span>
            </div>
          </div>
          <button
            className="brand-search"
            title="搜索会话"
            onClick={() => {
              setSearchOpen(true);
              setAutomationOpen(false);
              setCapabilitiesOpen(false);
              setRailOpen(false);
              setThreadQuery('');
              window.setTimeout(
                () => document.getElementById('global-search-input')?.focus(),
                60,
              );
            }}
          >
            <Search size={15} />
          </button>
        </div>

        <nav className="side-nav">
          <button className="nav-row" onClick={newSession}>
            <SquarePen size={16} /> 新对话
          </button>
          <button
            className="nav-row"
            onClick={() => {
              setAutomationOpen(true);
              setRailOpen(false);
            }}
          >
            <Clock size={16} /> 定时任务
            {automations.some((automation) => automation.enabled) ? (
              <span className="nav-state ok">已启用</span>
            ) : null}
          </button>
          <button className="nav-row" onClick={openCapabilities}>
            <Boxes size={16} /> 插件
          </button>
        </nav>

        <div className="side-section">
          <div className="side-label">项目</div>
          {projects.length === 0 ? <div className="projects-empty">暂无项目</div> : null}
          <button
            className={`project-row ${!projectId ? 'active' : ''}`}
            onClick={() => selectProject(null)}
            title="显示全部项目的会话"
          >
            <Layers size={15} />
            <span>全部项目</span>
            {!projectId ? <Check size={12} /> : null}
          </button>
          {projects.map((project) => (
            <div className="project-wrap" key={project.id}>
              <button
                className={`project-row ${projectId === project.id ? 'active' : ''}`}
                onClick={() => selectProject(project)}
                title={project.roots?.[0]?.path || project.name}
              >
                <FolderOpen size={15} />
                <span>{project.name}</span>
                {projectId === project.id ? <Check size={12} /> : null}
              </button>
              <button
                className="project-more"
                title="项目操作"
                onClick={(event) => {
                  event.stopPropagation();
                  setProjectMenuId(projectMenuId === project.id ? null : project.id);
                }}
              >
                ⋯
              </button>
              {projectMenuId === project.id ? (
                <div className="project-menu">
                  <button
                    onClick={() => {
                      setProjectRenameTarget(project);
                      setProjectRenameInput(project.name);
                      setProjectMenuId(null);
                    }}
                  >
                    重命名
                  </button>
                  <button className="danger" onClick={() => removeProject(project)}>
                    移除
                  </button>
                </div>
              ) : null}
            </div>
          ))}
          <button className="project-row project-add" onClick={addProject} title="添加本地文件夹为项目">
            <FolderPlus size={15} />
            <span>添加项目</span>
          </button>
        </div>

        <div className="thread-heading">
          <span>{showArchived ? '归档会话' : '最近'}</span>
          <div className="thread-heading-actions">
            <button
              onClick={(event) => {
                event.stopPropagation();
                setThreadHeadingMenu((previous) => !previous);
              }}
              title="更多"
            >
              ⋯
            </button>
            {threadHeadingMenu ? (
              <div className="thread-heading-menu">
                <button
                  onClick={() => {
                    setSectionDialog({ mode: 'create', name: '' });
                    setThreadHeadingMenu(false);
                  }}
                >
                  新建分区
                </button>
                <button
                  onClick={() => {
                    toggleArchived();
                    setThreadHeadingMenu(false);
                  }}
                >
                  {showArchived ? '返回对话列表' : '查看已归档会话'}
                </button>
                <button
                  onClick={() => {
                    refreshThreads();
                    setThreadHeadingMenu(false);
                  }}
                >
                  刷新
                </button>
              </div>
            ) : null}
          </div>
        </div>

        {!searchOpen && threadQuery ? (
          <label className="thread-search">
            <Search size={12} />
            <input
              value={threadQuery}
              onChange={(event) => setThreadQuery(event.target.value)}
              placeholder={showArchived ? '搜索归档会话…' : '搜索会话…'}
            />
          </label>
        ) : null}

        <div className="thread-list">
          {threadQuery.trim().length >= 2 ? (
            searchBusy && searchResults.length === 0 ? (
              <div className="thread-empty">正在搜索全部会话…</div>
            ) : searchResults.length === 0 ? (
              <div className="thread-empty">没有匹配的会话</div>
            ) : (
              <>
                <div className="thread-group-label">搜索结果</div>
                {searchResults.map((result) => (
                  <button
                    className={`search-result ${threadId === result.thread.id ? 'active' : ''}`}
                    key={result.thread.id}
                    onClick={() => openSearchResult(result)}
                  >
                    <span className="search-result-title">
                      {result.thread.name || result.thread.preview || '未命名会话'}
                    </span>
                    <span className="search-result-snippet">
                      {cleanSnippet(result.snippet) || cleanSnippet(result.thread.preview) || '无摘要'}
                    </span>
                    <span className="search-result-meta">
                      {timeAgo(result.thread.updatedAt)}
                      {result.thread.projectId
                        ? ` · ${
                            projects.find((project) => project.id === result.thread.projectId)
                              ?.name || '项目'
                          }`
                        : ''}
                    </span>
                  </button>
                ))}
              </>
            )
          ) : threadGroups.length === 0 ? (
            <div className="thread-empty">
              {showArchived ? '没有已归档的会话' : '还没有会话'}
            </div>
          ) : (
            threadGroups.map((group) => (
              <div className="thread-group" key={group.sectionId || group.label}>
                {group.sectionId ? (
                <div className="thread-group-label">
                  <span>{group.label}</span>
                  {group.sectionId && group.sectionId !== pinnedSectionId ? (
                    <button
                      className="section-more"
                      title="分区操作"
                      onClick={(event) => {
                        event.stopPropagation();
                        setSectionMenuId(
                          sectionMenuId === group.sectionId ? null : group.sectionId || null,
                        );
                      }}
                    >
                      ⋯
                    </button>
                  ) : null}
                </div>
                ) : null}
                {sectionMenuId && sectionMenuId === group.sectionId ? (
                  <div className="section-menu">
                    <button
                      onClick={() => {
                        setSectionDialog({
                          mode: 'rename',
                          id: group.sectionId,
                          name: group.label,
                        });
                        setSectionMenuId(null);
                      }}
                    >
                      重命名
                    </button>
                    <button
                      className="danger"
                      onClick={() =>
                        removeSection({ id: group.sectionId as string, name: group.label })
                      }
                    >
                      删除
                    </button>
                  </div>
                ) : null}
                {group.items.map((thread) => (
                  <div key={thread.id} className="thread-wrap">
                    <div
                      className={`thread ${threadId === thread.id ? 'active' : ''}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => resumeThread(thread)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') resumeThread(thread);
                      }}
                    >
                      <span className="thread-preview">
                        {readStates[thread.id]?.firstUnread ? (
                          <span className="unread-dot" title="未读" />
                        ) : null}
                        {thread.name || thread.preview || '未命名会话'}
                      </span>
                      <button
                        className="thread-more"
                        title="会话操作"
                        onClick={(event) => {
                          event.stopPropagation();
                          setMenuThreadId(menuThreadId === thread.id ? null : thread.id);
                        }}
                      >
                        ⋯
                      </button>
                    </div>
                    {menuThreadId === thread.id ? (
                      <ThreadActions
                        className="thread-menu"
                        thread={thread}
                        active={threadId === thread.id}
                        archivedView={showArchived}
                        running={running}
                        canRevert={threadId === thread.id && Boolean(lastTurnId) && !running}
                        canMarkUnread={Boolean(readStates[thread.id]?.revision)}
                        pinnedSectionId={pinnedSectionId}
                        sections={sections}
                        moveOpen={moveThreadId === thread.id}
                        showMove
                        onToggleMove={() =>
                          setMoveThreadId(moveThreadId === thread.id ? null : thread.id)
                        }
                        onMove={(sectionId) => void moveThreadToSection(thread, sectionId)}
                        onTogglePin={() => void togglePinThread(thread)}
                        onRename={() => {
                          setRenameTarget(thread);
                          setRenameInput(thread.name || thread.preview || '');
                        }}
                        onCompact={() => void compactThread()}
                        onRevert={() => void revertLastTurn()}
                        onFork={() => void forkThread(thread)}
                        onArchive={() => void archiveThread(thread)}
                        onUnarchive={() => void unarchiveThread(thread)}
                        onMarkUnread={() => void markThreadUnread(thread)}
                        onDelete={() => void deleteThread(thread)}
                        onClose={() => setMenuThreadId(null)}
                      />
                    ) : null}
                  </div>
                ))}
              </div>
            ))
          )}
          {!threadQuery.trim() && threadCursor ? (
            <button
              className="thread-load-more"
              disabled={threadLoadingMore}
              onClick={() => void loadMoreThreads()}
            >
              {threadLoadingMore ? '加载中…' : '加载更多会话'}
            </button>
          ) : null}
        </div>

        <div className="sidebar-foot">
          <div className="account-row" title={config?.codexHome || ''}>
            <button
              className="account-main"
              onClick={() => setAccountMenuOpen((previous) => !previous)}
            >
              <span className="account-dot" />
              <span>{config?.defaultProvider || 'deepseek'}</span>
            </button>
            <button
              className="account-settings"
              onClick={() => setAccountMenuOpen((previous) => !previous)}
              title="账户"
              aria-label="账户"
            >
              <SettingsIcon size={14} />
            </button>
            {accountMenuOpen ? (
              <div className="account-menu">
                <button
                  onClick={() => {
                    openSettings();
                    setAccountMenuOpen(false);
                  }}
                >
                  设置
                  <span className="account-shortcut">Ctrl+,</span>
                </button>
                <button
                  onClick={() => {
                    openSettings('shortcuts');
                    setAccountMenuOpen(false);
                  }}
                >
                  帮助
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </aside>

      <main
        className={`main ${
          automationOpen || searchOpen || capabilitiesOpen
            ? 'page-mode'
            : items.length === 0
              ? 'empty'
              : ''
        }`}
      >
        {automationOpen ? (
          <AutomationsPage
            automations={automations}
            form={automationForm}
            editingId={editingAutomationId}
            projects={projects}
            onForm={setAutomationForm}
            onEditing={setEditingAutomationId}
            onSave={saveAutomation}
            onRun={(automation, manual) => void runAutomation(automation, manual)}
            onToggle={toggleAutomation}
            onRemove={removeAutomation}
            onClose={() => setAutomationOpen(false)}
          />
        ) : searchOpen ? (
          <div className="page-view search-page">
            <div className="page-head">
              <div>
                <h1>搜索</h1>
                <p>搜索全部会话的名称与内容。</p>
              </div>
              <div className="page-head-actions">
                <button
                  className="page-ghost"
                  onClick={() => {
                    setSearchOpen(false);
                    setThreadQuery('');
                  }}
                >
                  返回应用
                </button>
              </div>
            </div>
            <div className="page-toolbar">
              <label className="page-search">
                <Search size={13} />
                <input
                  id="global-search-input"
                  value={threadQuery}
                  onChange={(event) => setThreadQuery(event.target.value)}
                  placeholder="搜索会话…"
                  autoFocus
                />
              </label>
            </div>
            <div className="search-page-results">
              {threadQuery.trim().length < 2 ? (
                <div className="page-empty">输入至少 2 个字符开始搜索</div>
              ) : searchBusy && searchResults.length === 0 ? (
                <div className="page-empty">正在搜索全部会话…</div>
              ) : searchResults.length === 0 ? (
                <div className="page-empty">没有匹配的会话</div>
              ) : (
                searchResults.map((result) => (
                  <button
                    className="search-page-row"
                    key={result.thread.id}
                    onClick={() => {
                      setSearchOpen(false);
                      void openSearchResult(result);
                    }}
                  >
                    <span className="search-page-title">
                      {result.thread.name || result.thread.preview || '未命名会话'}
                    </span>
                    <span className="search-page-snippet">
                      {cleanSnippet(result.snippet) ||
                        cleanSnippet(result.thread.preview) ||
                        '无摘要'}
                    </span>
                    <span className="search-page-meta">
                      {timeAgo(result.thread.updatedAt)}
                      {result.thread.projectId
                        ? ` · ${
                            projects.find((project) => project.id === result.thread.projectId)
                              ?.name || '项目'
                          }`
                        : ''}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        ) : (
          <>
        <header className="topbar">
          <div className="top-left">
            <button className="folder" onClick={pickFolder} title={activeCwd || '选择工作目录'}>
              <FolderOpen size={14} />
              <span>
                {currentThread
                  ? currentThread.name || currentThread.preview || '未命名会话'
                  : projectName || '选择工作目录'}
              </span>
            </button>
            {worktree ? (
              <button
                className="branch-chip"
                title={`打开 ${worktree.path}`}
                onClick={() => window.codex.showInFolder(worktree.path)}
              >
                <GitBranch size={12} /> {worktree.branch} <FolderOpen size={10} />
              </button>
            ) : null}
            {worktree ? (
              <div className="worktree-actions">
                <button
                  disabled={worktreeBusy || running}
                  onClick={applyWorktreeChanges}
                  title="把 Worktree 变更应用到主仓库工作区（不提交）"
                >
                  应用
                </button>
                <button
                  className="danger"
                  disabled={worktreeBusy || running}
                  onClick={removeWorktreeSession}
                  title="删除 Worktree 与分支"
                >
                  清理
                </button>
              </div>
            ) : null}
            {!worktree && /\.codex[\\/]worktrees[\\/]/.test(cwd) ? (
              <button
                className="branch-chip"
                title={`打开 ${cwd}`}
                onClick={() => window.codex.showInFolder(cwd)}
              >
                <GitBranch size={12} /> Worktree <FolderOpen size={10} />
              </button>
            ) : null}
          </div>
          <div className="top-actions">
            <div className="header-menu-wrap">
              <button
                className="icon-btn"
                disabled={!currentThread}
                onClick={() => setHeaderMenuOpen((previous) => !previous)}
                title="会话操作"
                aria-label="会话操作"
              >
                <MoreHorizontal size={16} />
              </button>
              {headerMenuOpen && currentThread ? (
                <ThreadActions
                  className="header-menu"
                  thread={currentThread}
                  active={threadId === currentThread.id}
                  archivedView={showArchived}
                  running={running}
                  canRevert={threadId === currentThread.id && Boolean(lastTurnId) && !running}
                  canMarkUnread={false}
                  pinnedSectionId={pinnedSectionId}
                  sections={[]}
                  moveOpen={false}
                  showMove={false}
                  onToggleMove={() => {}}
                  onMove={() => {}}
                  onTogglePin={() => void togglePinThread(currentThread)}
                  onRename={() => {
                    setRenameTarget(currentThread);
                    setRenameInput(currentThread.name || currentThread.preview || '');
                  }}
                  onCompact={() => void compactThread()}
                  onRevert={() => void revertLastTurn()}
                  onFork={() => void forkThread(currentThread)}
                  onArchive={() => void archiveThread(currentThread)}
                  onUnarchive={() => void unarchiveThread(currentThread)}
                  onMarkUnread={() => {}}
                  onDelete={() => void deleteThread(currentThread)}
                  onClose={() => setHeaderMenuOpen(false)}
                />
              ) : null}
            </div>
            <button
              className="icon-btn"
              disabled={!currentThread || running}
              onClick={() => currentThread && void forkThread(currentThread)}
              title="分叉会话"
              aria-label="分叉会话"
            >
              <GitBranch size={15} />
            </button>
            <button
              className="icon-btn key-icon"
              onClick={() => setKeyDialog(true)}
              title={config?.apiKeyConfigured ? 'DeepSeek API Key 已配置' : '设置 DeepSeek API Key'}
              aria-label="设置 DeepSeek API Key"
            >
              <KeyRound size={15} />
              {config?.apiKeyConfigured ? null : <span className="key-dot" />}
            </button>
            <button
              className={`icon-btn ${terminalOpen ? 'active' : ''}`}
              onClick={() => setTerminalOpen((previous) => !previous)}
              title="终端 (Ctrl+J)"
              aria-label="终端"
            >
              <Terminal size={15} />
            </button>
            <button
              className="icon-btn"
              disabled={running || reviewBusy || status !== 'ready'}
              onClick={() => setReviewDialogOpen(true)}
              title="用引擎审查代码变更"
              aria-label="用引擎审查代码变更"
            >
              <ShieldCheck size={14} />
            </button>
            <button
              className={`icon-btn ${railOpen ? 'active' : ''}`}
              onClick={() => setRailOpen((previous) => !previous)}
              title="工作区面板"
            >
              <PanelRight size={14} />
              {reviewCount > 0 ? <span className="badge">{reviewCount}</span> : null}
            </button>
          </div>
        </header>

        {null}

        {mode === 'plan' ? (
          <div className="plan-banner">
            <ListChecks size={13} />
            计划模式 · 先梳理方案与待办，确认后再动手修改
          </div>
        ) : null}

        {canApprovePlan ? (
          <div className="plan-approve">
            <ListChecks size={14} />
            <span>计划已生成，确认后开始实现。</span>
            <button onClick={() => setMode('default')}>退出计划模式</button>
            <button className="primary" onClick={approvePlan}>
              批准并实现
            </button>
          </div>
        ) : null}

        {status !== 'ready' ? (
          <div className="banner">
            {status === 'connecting' ? '正在连接本地 app-server…' : engineError || '本地引擎未就绪'}
            {status === 'offline' && !config?.codexBin ? (
              <span className="banner-hint">
                {' '}
                · 构建命令 <code>bash build.sh</code>
              </span>
            ) : null}
          </div>
        ) : null}

        <section className="stream" ref={streamRef} onScroll={handleStreamScroll}>
          {items.length === 0 ? (
            <Hero />
          ) : (
            <>
              {items.length > visibleItemCount ? (
                <button
                  className="stream-earlier"
                  onClick={() =>
                    setVisibleItemCount((count) => Math.min(items.length, count + 120))
                  }
                >
                  显示更早的 {items.length - visibleItemCount} 条消息
                </button>
              ) : null}
              {itemGroups.map((entry, groupIndex) =>
                entry.kind === 'activity' ? (
                  <div className="activity-block" key={entry.key}>
                    <div className="activity-label">Activity</div>
                    <details className="activity-details">
                      <summary>
                        <List size={12} />
                        <span>{activitySummary(entry.items)}</span>
                        {running && groupIndex === itemGroups.length - 1 ? (
                          <span className="activity-working">正在工作</span>
                        ) : null}
                      </summary>
                      <div className="activity-body">
                        {entry.items.map((item) => (
                          <ActivityStep key={item.id} item={item} busy={running} />
                        ))}
                      </div>
                    </details>
                  </div>
                ) : (
                  <Fragment key={entry.item.id}>
                    {entry.item.type === 'userMessage' && itemTimesRef.current[entry.item.id] ? (
                      <div className="message-time">
                        {formatThreadTime(itemTimesRef.current[entry.item.id])}
                      </div>
                    ) : null}
                    <div className="item-row" data-item-id={entry.item.id}>
                      <MessageItem
                        item={entry.item}
                        busy={running}
                        onFixReview={fixReviewComments}
                        onQuote={(text) => setInput(text)}
                        onOpenThread={(subThreadId) =>
                          void resumeThread({ id: subThreadId, preview: '' })
                        }
                        onRetry={
                          entry.item.id === items[items.length - 1]?.id &&
                          entry.item.type === 'agentMessage' &&
                          !running &&
                          lastTurnId
                            ? () => void retryLastTurn()
                            : undefined
                        }
                      />
                    </div>
                  </Fragment>
                ),
              )}
            </>
          )}
          {running ? (
            <div className="thinking">
              <Loader2 size={14} className="spin" />
              <span>Codex 正在工作…</span>
              {turnId ? (
                <button onClick={stop}>
                  <Square size={11} /> 停止
                </button>
              ) : null}
            </div>
          ) : null}
        </section>

        {approval ? <ApprovalPanel approval={approval} onDecide={decide} /> : null}

        {error ? (
          <div className="error-toast">
            <span>{error}</span>
            <button onClick={() => setError(null)}>
              <X size={13} />
            </button>
          </div>
        ) : null}

        {notice ? (
          <div className="notice-toast">
            <Check size={13} />
            <span>{notice}</span>
            <button onClick={() => setNotice(null)}>
              <X size={13} />
            </button>
          </div>
        ) : null}

        <footer className="composer">
          {!autonomyHidden &&
          items.length > 0 &&
          (settings.approvalPolicy === 'never' || settings.sandbox === 'danger-full-access') ? (
            <div className="autonomy-banner">
              <AlertTriangle size={15} />
              <div className="autonomy-body">
                <strong>
                  {settings.sandbox === 'danger-full-access' ? '已开启完全访问' : '已开启自主执行'}
                </strong>
                <span>
                  {settings.sandbox === 'danger-full-access'
                    ? 'Codex 可以编辑任意文件并运行命令，无需逐条确认。这会增加数据丢失或信息泄露的风险。'
                    : 'Codex 会执行命令与修改文件而不再逐条确认；请确认工作区与沙箱范围可信。'}{' '}
                  <button
                    className="autonomy-learn"
                    onClick={() =>
                      window.codex
                        .openExternal('https://learn.chatgpt.com/docs/sandboxing?surface=app')
                        .catch(() => {})
                    }
                  >
                    了解详情
                  </button>
                </span>
              </div>
              <button
                className="autonomy-dismiss"
                onClick={() => {
                  writeStorage(
                    'deepseek-codex.autonomyHiddenUntil',
                    String(Date.now() + 28 * 24 * 60 * 60 * 1000),
                  );
                  setAutonomyHidden(true);
                }}
              >
                28 天内不再显示
              </button>
              <button
                className="autonomy-close"
                title="关闭"
                onClick={() => setAutonomyHidden(true)}
              >
                <X size={13} />
              </button>
            </div>
          ) : null}
          <div
            className={`composer-box ${dragging ? 'dragging' : ''}`}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'copy';
              setDragging(true);
            }}
            onDragLeave={(event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node)) return;
              setDragging(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              addDroppedFiles(Array.from(event.dataTransfer.files));
            }}
          >
            {dragging ? <div className="drop-overlay">松开以添加文件或图片</div> : null}
            {mention ? (
              <div className="mention-menu">
                {mention.results.length > 0 ? (
                  mention.results.map((item, index) => (
                    <button
                      key={item.path}
                      className={`mention-item ${index === mention.index ? 'active' : ''}`}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        insertMention(item);
                      }}
                    >
                      <FileText size={12} />
                      <span className="mention-name">{item.fileName}</span>
                      <span className="mention-path">{item.path}</span>
                    </button>
                  ))
                ) : (
                  <div className="mention-empty">
                    {mention.query ? '没有匹配的文件' : '继续输入文件名…'}
                  </div>
                )}
              </div>
            ) : null}
            {attachments.length > 0 ? (
              <div className="attachment-row">
                {attachments.map((path) => (
                  <span className="attachment-chip" key={path} title={path}>
                    {thumbnails[path] ? (
                      <img className="attachment-thumb" src={thumbnails[path]} alt="" />
                    ) : (
                      <ImageIcon size={12} />
                    )}
                    {path.split(/[\\/]/).pop()}
                    <button
                      onClick={() =>
                        setAttachments((list) => list.filter((entry) => entry !== path))
                      }
                    >
                      <X size={10} />
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(event) => {
                const value = event.target.value;
                setInput(value);
                refreshMention(value, event.target.selectionStart ?? value.length);
              }}
              onKeyDown={onKeyDown}
              onPaste={(event) => {
                const hasImage = Array.from(event.clipboardData.items).some((item) =>
                  item.type.startsWith('image/'),
                );
                if (!hasImage) return;
                event.preventDefault();
                window.codex
                  .savePastedImage()
                  .then((filePath) => {
                    if (filePath) {
                      setAttachments((previous) => [...new Set([...previous, filePath])]);
                    }
                  })
                  .catch(() => {});
              }}
              placeholder={
                preparing
                  ? '正在创建 Worktree…'
                  : running
                    ? '追加到当前任务…'
                    : '与 Codex 一起工作…'
              }
              rows={1}
            />
            <div className="composer-foot">
              <div className="composer-tools">
                <div className="attach-wrap">
                  <button
                    className="file-button"
                    onClick={() => setAttachMenuOpen((previous) => !previous)}
                    title="添加附件"
                    aria-label="添加附件"
                  >
                    <Plus size={15} />
                  </button>
                  {attachMenuOpen ? (
                    <div className="attach-menu">
                      <button
                        onClick={() => {
                          setAttachMenuOpen(false);
                          pickFiles();
                        }}
                      >
                        <Paperclip size={13} /> 引用文件
                      </button>
                      <button
                        onClick={() => {
                          setAttachMenuOpen(false);
                          pickImages();
                        }}
                      >
                        <ImageIcon size={13} /> 添加图片
                      </button>
                      <div className="menu-divider" />
                      <button
                        onClick={() => {
                          setAttachMenuOpen(false);
                          setSearchOpen(false);
                          setAutomationOpen(false);
                          void openCapabilities();
                        }}
                      >
                        <Boxes size={13} /> 插件
                      </button>
                      <button
                        onClick={() => {
                          setAttachMenuOpen(false);
                          toggleWorktree();
                        }}
                      >
                        <GitBranch size={13} /> {worktreeMode ? '关闭 Worktree' : '使用 Worktree'}
                      </button>
                      <button
                        onClick={() => {
                          setAttachMenuOpen(false);
                          setMode('default');
                        }}
                      >
                        <Compass size={13} /> 执行模式
                        {mode === 'default' ? <Check size={12} /> : null}
                      </button>
                      <button
                        onClick={() => {
                          setAttachMenuOpen(false);
                          setMode('plan');
                        }}
                      >
                        <ListChecks size={13} /> 计划模式
                        {mode === 'plan' ? <Check size={12} /> : null}
                      </button>
                      <button
                        onClick={() => {
                          setAttachMenuOpen(false);
                          openSettings();
                        }}
                      >
                        <ShieldCheck size={13} /> 权限与沙箱
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
              <div className="composer-submit">
                <div className="model-pill-wrap">
                  <button
                    className="model-pill"
                    onClick={() => setModelMenuOpen((previous) => !previous)}
                    title="切换模型与推理强度"
                  >
                    <span className="model-pill-name">{activeModel?.display_name || model}</span>
                    <span className="model-pill-effort">{effortLabel(settings.effort)}</span>
                    <ChevronDown size={12} />
                  </button>
                  {modelMenuOpen ? (
                    <div className="model-menu">
                      <div className="model-menu-title">{effortLabel(settings.effort)}</div>
                      <button
                        className="model-menu-model"
                        onClick={() => setModelListOpen((previous) => !previous)}
                      >
                        <span>{activeModel?.display_name || model}</span>
                        <ChevronRight size={13} />
                      </button>
                      {modelListOpen ? (
                        <div className="model-menu-list">
                          {(models.length > 0 ? models : [{ slug: model, display_name: model }]).map(
                            (entry) => (
                              <button
                                key={entry.slug}
                                className={`menu-item ${entry.slug === model ? 'active' : ''}`}
                                onClick={() => {
                                  setModel(entry.slug);
                                  setModelListOpen(false);
                                }}
                              >
                                <span>
                                  <strong>{entry.display_name || entry.slug}</strong>
                                  {entry.description ? <small>{entry.description}</small> : null}
                                </span>
                                {entry.slug === model ? <Check size={13} /> : null}
                              </button>
                            ),
                          )}
                        </div>
                      ) : null}
                      <div className="effort-slider">
                        <input
                          type="range"
                          min={0}
                          max={Math.max(0, effortOptions.length - 1)}
                          step={1}
                          value={Math.max(0, effortOptions.indexOf(settings.effort))}
                          onChange={(event) => {
                            const next =
                              effortOptions[Number(event.target.value)] || settings.effort;
                            applySettings({
                              ...settings,
                              effort: next as RuntimeSettings['effort'],
                            });
                          }}
                        />
                        <div className="effort-slider-labels">
                          {effortOptions.map((effort) => (
                            <span
                              key={effort}
                              className={settings.effort === effort ? 'active' : ''}
                            >
                              {effortLabel(effort)}
                            </span>
                          ))}
                        </div>
                      </div>
                      <button
                        className="model-menu-apply"
                        onClick={() => setModelMenuOpen(false)}
                      >
                        选择强度
                      </button>
                    </div>
                  ) : null}
                </div>
                <button
                  className={`send ${input.trim() && !preparing ? 'ready' : ''}`}
                  disabled={!input.trim() || preparing}
                  onClick={() => send()}
                  title={running ? '追加' : '发送'}
                  aria-label={running ? '追加到当前任务' : '发送'}
                >
                  <ArrowUp size={16} />
                </button>
              </div>
            </div>
            <div className="composer-subrow">
              <button
                className="subrow-btn"
                onClick={pickFolder}
                title={activeCwd || projectName || '选择项目'}
                aria-label="选择项目目录"
              >
                <FolderOpen size={12} />
              </button>
              <button
                className="subrow-btn"
                title="提及文件"
                aria-label="提及文件"
                onClick={() => {
                  const next = `${input}${input && !input.endsWith(' ') ? ' ' : ''}@`;
                  setInput(next);
                  refreshMention(next, next.length);
                  textareaRef.current?.focus();
                }}
              >
                <span className="at-mark">@</span>
              </button>
              <button
                className="subrow-btn subrow-panel"
                onClick={() => setRailOpen((previous) => !previous)}
                title="工作区面板"
                aria-label="工作区面板"
              >
                <PanelRight size={12} />
              </button>
            </div>
          </div>
        </footer>

          </>
        )}
        {terminalMounted ? (
          <TerminalDock
            cwd={activeCwd}
            threadId={threadId}
            visible={
              terminalOpen && !automationOpen && !searchOpen && !capabilitiesOpen
            }
            onClose={() => setTerminalOpen(false)}
          />
        ) : null}
      </main>

      {railOpen ? (
        <aside className="workspace-rail">
          <div className="rail-head">
            <div className="rail-tabs">
              {railTabs.map((tab) => (
                <button
                  key={tab.id}
                  className={`rail-tab ${railTab === tab.id ? 'active' : ''}`}
                  onClick={() => setRailTab(tab.id)}
                  title={tab.shortcut ? `${tab.label} · ${tab.shortcut}` : tab.label}
                >
                  {tab.icon}
                  <span>{tab.label}</span>
                  {tab.id === 'review' && reviewCount > 0 ? (
                    <span className="rail-badge">{reviewCount}</span>
                  ) : null}
                </button>
              ))}
            </div>
            <button
              className="rail-icon-btn"
              onClick={() => setRailOpen(false)}
              title="关闭面板"
            >
              <X size={15} />
            </button>
          </div>
          <div className="rail-quick">
            <Search size={12} />
            <input
              value={railQuick}
              onChange={(event) => setRailQuick(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                const value = railQuick.trim();
                if (!value) return;
                const looksLikeUrl =
                  /^(https?:\/\/|localhost[:/]|[\w.-]+\.[a-z]{2,}(:\d+)?(\/|$))/i.test(value);
                if (looksLikeUrl) {
                  const url = /^https?:\/\//i.test(value) ? value : `http://${value}`;
                  setRailTab('browser');
                  window.dispatchEvent(
                    new CustomEvent('deepseek-codex:browser-open', { detail: { url } }),
                  );
                } else {
                  setRailTab('files');
                  window.dispatchEvent(
                    new CustomEvent('deepseek-codex:file-search', { detail: { query: value } }),
                  );
                }
                setRailQuick('');
              }}
              placeholder="搜索文件或输入 URL…"
              spellCheck={false}
            />
          </div>
          <div className="rail-body">
            <div className={`rail-pane ${railTab === 'files' ? 'active' : ''}`}>
              <FilesPanel root={activeCwd} onReference={referenceFile} />
            </div>
            <div className={`rail-pane ${railTab === 'browser' ? 'active' : ''}`}>
              <BrowserPanel active={railTab === 'browser'} />
            </div>
            <div className={`rail-pane ${railTab === 'review' ? 'active' : ''}`}>
              <ReviewPanel
                cwd={activeCwd}
                threadChanges={changeList}
                liveDiff={liveDiff}
                active={railTab === 'review'}
                refreshToken={reviewTick}
                onMutate={refreshReviewMeta}
                onCountChange={updateReviewCount}
              />
            </div>
          </div>
        </aside>
      ) : null}

      <footer className={`statusbar ${status}`}>
        <div className="status-left">
          <span className="status-item engine-inline" title={engineError || config?.codexBin || ''}>
            <span className="dot" />
            {status === 'ready' ? '引擎在线' : status === 'offline' ? '引擎离线' : '连接中'}
          </span>
          <span className="status-divider" />
          <button
            className="status-item status-button"
            onClick={pickFolder}
            title={activeCwd || '选择项目'}
          >
            <FolderOpen size={12} />
            {projectName || '未选择项目'}
          </button>
          {git?.repo && git.branch ? (
            <button
              className="status-item status-button"
              onClick={() => (git.root ? window.codex.showInFolder(git.root) : undefined)}
              title={git.root || ''}
            >
              <GitBranch size={12} />
              {git.branch}
              {git.changed ? <span className="status-change">{git.changed} 项变更</span> : null}
            </button>
          ) : null}
          {worktree ? (
            <button
              className="status-item status-button"
              onClick={() => window.codex.showInFolder(worktree.path)}
              title={worktree.path}
            >
              <Layers size={12} /> Worktree
            </button>
          ) : null}
        </div>
        <div className="status-right">
          <span className="status-item">
            上下文 {formatTokens(usage.total)}
            {usage.context ? ` / ${formatTokens(usage.context)}` : ''}
          </span>
          {usage.input > 0 ? (
            <span
              className="status-item"
              title={`缓存命中 ${formatTokens(usage.cached)} / 输入 ${formatTokens(usage.input)}`}
            >
              缓存 {((usage.cached / usage.input) * 100).toFixed(1)}%
            </span>
          ) : null}
          {usage.lastInput || usage.lastOutput ? (
            <span className="status-item">
              ↑{formatTokens(usage.lastInput)} ↓{formatTokens(usage.lastOutput)}
            </span>
          ) : null}
          <span className="status-divider" />
          <span className="status-item">{activeModel?.display_name || model}</span>
          <span className="status-item">{effortLabel(settings.effort)}</span>
        </div>
      </footer>

      {settingsOpen ? (
        <SettingsPanel
          settings={settings}
          effortOptions={effortOptions}
          models={models}
          provider={config?.defaultProvider || 'deepseek'}
          config={config}
          theme={theme}
          onTheme={setTheme}
          initialTab={settingsInitialTab}
          notifyOnComplete={notifyOnComplete}
          onNotifyOnComplete={(value) => {
            writeStorage('deepseek-codex.notify', value ? '1' : '0');
            setNotifyOnComplete(value);
          }}
          onOpenKey={() => {
            setSettingsOpen(false);
            setKeyDialog(true);
          }}
          onSave={applySettings}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}

      {reviewDialogOpen ? (
        <ReviewDialog
          cwd={worktree?.path || cwd}
          busy={reviewBusy}
          onStart={startReview}
          onClose={() => setReviewDialogOpen(false)}
        />
      ) : null}

      {pendingInput ? (
        <UserInputPanel
          pending={pendingInput}
          onSubmit={submitUserInput}
          onDecline={declineUserInput}
        />
      ) : null}


      {capabilitiesOpen ? (
        <div className="plugins-page" data-tab={pluginTab}>
          <div className="page-view plugins-view">
            <div className="page-head">
              <div>
                <h1>插件</h1>
                <p>连接插件，让 Codex 使用你的工具。</p>
              </div>
              <div className="page-head-actions plugins-toolbar">
                <label className="page-search compact">
                  <Search size={12} />
                  <input
                    value={pluginQuery}
                    onChange={(event) => setPluginQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        setPluginTab('plugins');
                        void searchPlugins();
                      }
                    }}
                    placeholder="搜索插件…"
                  />
                  <button
                    className="page-search-submit"
                    disabled={pluginResultsBusy || !pluginQuery.trim()}
                    onClick={() => {
                      setPluginTab('plugins');
                      void searchPlugins();
                    }}
                  >
                    {pluginResultsBusy ? '…' : '搜索'}
                  </button>
                </label>
                <button
                  className="page-icon-btn"
                  onClick={() => openSettings()}
                  title="设置"
                  aria-label="设置"
                >
                  <SettingsIcon size={14} />
                </button>
                <div className="add-menu-wrap">
                  <button
                    className="page-primary add-btn"
                    onClick={() => setAddMenuOpen((previous) => !previous)}
                  >
                    添加 <ChevronDown size={12} />
                  </button>
                  {addMenuOpen ? (
                    <div className="add-menu">
                      <button
                        onClick={() => {
                          setPluginTab('plugins');
                          setAddMenuOpen(false);
                          window.setTimeout(
                            () => document.getElementById('mcp-name')?.focus(),
                            50,
                          );
                        }}
                      >
                        添加 MCP 服务器
                      </button>
                      <button
                        onClick={() => {
                          setPluginTab('plugins');
                          setAddMenuOpen(false);
                          window.setTimeout(
                            () => document.getElementById('plugin-market-source')?.focus(),
                            50,
                          );
                        }}
                      >
                        添加插件市场
                      </button>
                    </div>
                  ) : null}
                </div>
                <button className="page-ghost" onClick={() => setCapabilitiesOpen(false)}>
                  返回应用
                </button>
              </div>
            </div>
            <div className="page-tabs">
              <button
                className={pluginTab === 'plugins' ? 'active' : ''}
                onClick={() => setPluginTab('plugins')}
              >
                插件
              </button>
              <button
                className={pluginTab === 'skills' ? 'active' : ''}
                onClick={() => setPluginTab('skills')}
              >
                技能
              </button>
            </div>
            {pluginTab === 'plugins' ? (
              <div className="plugin-filters">
                <button
                  className={pluginFilter === 'public' ? 'active' : ''}
                  onClick={() => setPluginFilter('public')}
                >
                  Public
                </button>
                <button
                  className={pluginFilter === 'installed' ? 'active' : ''}
                  onClick={() => setPluginFilter('installed')}
                >
                  已安装
                </button>
              </div>
            ) : null}
            {capabilities.loading ? (
              <div className="cap-loading">
                <Loader2 size={14} className="spin" /> 正在读取 MCP 与 Skills…
              </div>
            ) : (
              <>
                <div className="cap-section plugin-section">
                  <div className="cap-section-head">
                    <div className="setting-label">MCP 服务器</div>
                    <button
                      className="cap-btn"
                      disabled={capabilityBusy}
                      onClick={reloadMcp}
                    >
                      刷新
                    </button>
                  </div>
                  {capabilities.mcp?.error ? (
                    <div className="cap-empty">{capabilities.mcp.error}</div>
                  ) : Array.isArray(capabilities.mcp?.data) && capabilities.mcp.data.length > 0 ? (
                    capabilities.mcp.data.map((server: any) => (
                      <div className="cap-row" key={server.name}>
                        <div>
                          <strong>
                            <span
                              className={`cap-status-dot ${
                                server.runtimeStatus === 'ready' ||
                                server.runtimeStatus === 'connected'
                                  ? 'ok'
                                  : 'warn'
                              }`}
                            />
                            {server.name}
                          </strong>
                          <span>
                            {server.runtimeStatus || 'configured'} · {server.authStatus || 'unknown'}
                            {server.toolsError ? ' · tools error' : ''}
                          </span>
                        </div>
                        <div className="cap-actions">
                          <details className="cap-tools">
                            <summary>{Object.keys(server.tools || {}).length} tools</summary>
                            <div>
                              {Object.keys(server.tools || {}).map((toolName) => (
                                <button
                                  className="mcp-tool-button"
                                  key={toolName}
                                  onClick={() =>
                                    setMcpCall({
                                      kind: 'tool',
                                      server: server.name,
                                      tool: toolName,
                                      args: '{}',
                                      uri: '',
                                      result: null,
                                      busy: false,
                                    })
                                  }
                                >
                                  {toolName}
                                </button>
                              ))}
                            </div>
                          </details>
                          {Array.isArray(server.resources) && server.resources.length > 0 ? (
                            <details className="cap-tools">
                              <summary>{server.resources.length} resources</summary>
                              <div>
                                {server.resources.map((resource: any) => (
                                  <button
                                    className="mcp-tool-button"
                                    key={resource.uri}
                                    onClick={() =>
                                      setMcpCall({
                                        kind: 'resource',
                                        server: server.name,
                                        args: '',
                                        uri: resource.uri,
                                        result: null,
                                        busy: false,
                                      })
                                    }
                                  >
                                    {resource.uri}
                                  </button>
                                ))}
                              </div>
                            </details>
                          ) : null}
                          <button
                            className="cap-btn"
                            onClick={() =>
                              setMcpCall({
                                kind: 'resource',
                                server: server.name,
                                args: '',
                                uri: '',
                                result: null,
                                busy: false,
                              })
                            }
                          >
                            资源
                          </button>
                          {server.authStatus === 'notLoggedIn' ? (
                            <button
                              className="cap-btn"
                              disabled={capabilityBusy}
                              onClick={() => loginMcp(server)}
                            >
                              登录
                            </button>
                          ) : null}
                          <button
                            className="cap-btn danger"
                            disabled={capabilityBusy}
                            onClick={() => removeMcp(server.name)}
                          >
                            移除
                          </button>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="cap-empty">未配置 MCP 服务器</div>
                  )}
                  <div className="mcp-form">
                    <div className="setting-label">添加 / 更新 MCP</div>
                    <input
                      id="mcp-name"
                      value={mcpForm.name}
                      onChange={(event) => setMcpForm({ ...mcpForm, name: event.target.value })}
                      placeholder="名称，如 context7"
                    />
                    <input
                      value={mcpForm.command}
                      onChange={(event) => setMcpForm({ ...mcpForm, command: event.target.value })}
                      placeholder="启动命令，如 npx"
                    />
                    <input
                      value={mcpForm.args}
                      onChange={(event) => setMcpForm({ ...mcpForm, args: event.target.value })}
                      placeholder="参数，空格分隔，如 -y @upstash/context7-mcp"
                    />
                    <textarea
                      value={mcpForm.env}
                      onChange={(event) => setMcpForm({ ...mcpForm, env: event.target.value })}
                      placeholder="环境变量 KEY=VALUE，每行一个"
                      rows={2}
                    />
                    <button
                      className="primary"
                      disabled={
                        capabilityBusy || !mcpForm.name.trim() || !mcpForm.command.trim()
                      }
                      onClick={saveMcp}
                    >
                      保存 MCP
                    </button>
                  </div>
                </div>

                <div className="cap-section skills-section">
                  <div className="setting-label">Skills</div>
                  {capabilities.skills?.error ? (
                    <div className="cap-empty">{capabilities.skills.error}</div>
                  ) : (
                    (() => {
                      const entries = Array.isArray(capabilities.skills?.data)
                        ? capabilities.skills.data
                        : [];
                      const skills = entries.flatMap((entry: any) => entry.skills || []);
                      if (skills.length === 0) {
                        return <div className="cap-empty">当前目录没有可用 Skills</div>;
                      }
                      return skills.map((skill: any) => (
                        <div className="cap-row" key={`${skill.path}-${skill.name}`}>
                          <div>
                            <strong>{skill.name}</strong>
                            <span>{skill.description || skill.shortDescription || ''}</span>
                          </div>
                          <button
                            className="cap-btn"
                            disabled={capabilityBusy}
                            onClick={() => toggleSkill(skill)}
                          >
                            {skill.enabled ? '禁用' : '启用'}
                          </button>
                        </div>
                      ));
                    })()
                  )}
                </div>

                <div className="cap-section plugin-section">
                  <div className="cap-section-head">
                    <div className="setting-label">插件</div>
                    <button
                      className="cap-btn"
                      disabled={marketplaceBusy}
                      onClick={() => upgradeMarketplaces()}
                    >
                      升级全部
                    </button>
                  </div>
                  <div className="mcp-form marketplace-form">
                    <input
                      id="plugin-market-source"
                      value={marketplaceSource}
                      onChange={(event) => setMarketplaceSource(event.target.value)}
                      placeholder="市场路径或 Git 地址"
                    />
                    <input
                      value={marketplaceRef}
                      onChange={(event) => setMarketplaceRef(event.target.value)}
                      placeholder="分支 / 标签（可选）"
                    />
                    <button
                      className="primary"
                      disabled={marketplaceBusy || !marketplaceSource.trim()}
                      onClick={addMarketplace}
                    >
                      添加市场
                    </button>
                  </div>
                  {capabilities.plugins?.error ? (
                    <div className="cap-empty">{capabilities.plugins.error}</div>
                  ) : (
                    (() => {
                      const marketplaces = Array.isArray(capabilities.plugins?.marketplaces)
                        ? capabilities.plugins.marketplaces
                        : [];
                      if (marketplaces.length === 0) {
                        return <div className="cap-empty">没有发现本地插件市场</div>;
                      }
                      return marketplaces.map((marketplace: any) => {
                        const visiblePlugins = (marketplace.plugins || []).filter(
                          (plugin: any) => pluginFilter === 'public' || plugin.installed,
                        );
                        return (
                        <div
                          className="marketplace-block"
                          key={`${marketplace.name}-${marketplace.path || ''}`}
                        >
                          <div className="marketplace-head">
                            <strong>{marketplace.name}</strong>
                            <span title={marketplace.path || ''}>
                              {marketplace.path || '远程市场'}
                            </span>
                            <button
                              className="cap-btn"
                              disabled={marketplaceBusy}
                              onClick={() => upgradeMarketplaces(marketplace.name)}
                            >
                              升级
                            </button>
                            <button
                              className="cap-btn danger"
                              disabled={marketplaceBusy}
                              onClick={() => removeMarketplace(marketplace.name)}
                            >
                              移除
                            </button>
                          </div>
                          {visiblePlugins.length === 0 ? (
                            <div className="cap-empty">该市场没有插件</div>
                          ) : (
                            visiblePlugins.map((plugin: any) => (
                              <div className="cap-row" key={`${marketplace.name}-${plugin.id}`}>
                                <div>
                                  <strong>{plugin.name}</strong>
                                  <span>
                                    {plugin.interface?.short_description ||
                                      plugin.interface?.shortDescription ||
                                      marketplace.name}
                                    {' · '}
                                    {plugin.installed
                                      ? plugin.enabled
                                        ? '已安装/启用'
                                        : '已安装/禁用'
                                      : '可安装'}
                                  </span>
                                </div>
                                <div className="cap-actions">
                                  <button
                                    className="cap-btn"
                                    onClick={() =>
                                      readPlugin(plugin, marketplace.name, marketplace.path)
                                    }
                                  >
                                    详情
                                  </button>
                                  <button
                                    className={`cap-btn ${plugin.installed ? 'danger' : ''}`}
                                    disabled={pluginBusy}
                                    onClick={() =>
                                      plugin.installed
                                        ? uninstallPlugin(plugin)
                                        : installPlugin(marketplace, plugin)
                                    }
                                  >
                                    {plugin.installed ? '卸载' : '安装'}
                                  </button>
                                </div>
                              </div>
                            ))
                          )}
                        </div>
                        );
                      });
                    })()
                  )}
                  {pluginResults
                    .filter(
                      (result: any) => pluginFilter === 'public' || result.plugin?.installed,
                    )
                    .map((result: any) => (
                    <div
                      className="cap-row"
                      key={`${result.marketplaceName}-${result.plugin?.id || result.plugin?.name}`}
                    >
                      <div>
                        <strong>{result.plugin?.name}</strong>
                        <span>
                          {result.plugin?.interface?.short_description ||
                            result.plugin?.interface?.shortDescription ||
                            result.marketplaceName}
                          {' · '}
                          {result.plugin?.installed ? '已安装' : '可安装'}
                        </span>
                      </div>
                      <div className="cap-actions">
                        <button
                          className="cap-btn"
                          onClick={() =>
                            readPlugin(
                              result.plugin,
                              result.marketplaceName,
                              result.marketplacePath,
                            )
                          }
                        >
                          详情
                        </button>
                        <button
                          className={`cap-btn ${result.plugin?.installed ? 'danger' : ''}`}
                          disabled={pluginBusy}
                          onClick={() =>
                            result.plugin?.installed
                              ? uninstallPlugin(result.plugin)
                              : installPlugin(
                                  {
                                    name: result.marketplaceName,
                                    path: result.marketplacePath,
                                  },
                                  result.plugin,
                                )
                          }
                        >
                          {result.plugin?.installed ? '卸载' : '安装'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="cap-section skills-section">
                  <div className="setting-label">Hooks</div>
                  {capabilities.hooks?.error ? (
                    <div className="cap-empty">{capabilities.hooks.error}</div>
                  ) : (() => {
                    const entries = Array.isArray(capabilities.hooks?.data)
                      ? capabilities.hooks.data
                      : [];
                    const hooks = entries.flatMap((entry: any) => entry.hooks || []);
                    if (hooks.length === 0) {
                      return <div className="cap-empty">当前目录没有配置 Hooks</div>;
                    }
                    return hooks.map((hook: any) => (
                      <div className="cap-row" key={hook.key}>
                        <div>
                          <strong>
                            <span className={`cap-status-dot ${hook.enabled ? 'ok' : 'off'}`} />
                            {hook.eventName || hook.event_name || 'hook'}
                          </strong>
                          <span>
                            {hook.matcher ? `${hook.matcher} · ` : ''}
                            {hook.enabled ? '启用' : '禁用'} · {hook.sourcePath || hook.source_path || ''}
                          </span>
                        </div>
                        <span className="cap-meta">{hook.timeoutSec ?? hook.timeout_sec ?? '-'}s</span>
                      </div>
                    ));
                  })()}
                </div>

                <div className="cap-section plugin-section">
                  <div className="setting-label">模型</div>
                  {models.map((entry) => (
                    <div className="cap-row" key={entry.slug}>
                      <div>
                        <strong>{entry.display_name || entry.slug}</strong>
                        <span>{entry.description || ''}</span>
                      </div>
                      <span className="cap-meta">
                        {entry.context_window
                          ? `${Math.round(entry.context_window / 1024)}k ctx`
                          : ''}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}

      {pluginDetail ? (
        <Modal onClose={() => setPluginDetail(null)} labelledBy="plugin-detail-title">
          <div className="key-card capabilities-card">
            <div className="key-kicker">PLUGIN DETAIL</div>
            <h2 id="plugin-detail-title">
              {pluginDetail.summary?.name || pluginDetail.name || '插件详情'}
            </h2>
            <p>
              {pluginDetail.description ||
                pluginDetail.summary?.interface?.short_description ||
                pluginDetail.summary?.interface?.shortDescription ||
                '暂无描述'}
            </p>
            <div className="diag-row">
              <span>市场</span>
              <code>{pluginDetail.marketplaceName || '-'}</code>
            </div>
            <div className="diag-row">
              <span>版本</span>
              <span>
                {pluginDetail.summary?.version ||
                  pluginDetail.summary?.localVersion ||
                  '未知'}
              </span>
            </div>
            <div className="diag-row">
              <span>Skills</span>
              <span>
                {(pluginDetail.skills || [])
                  .map((skill: any) => skill.name)
                  .filter(Boolean)
                  .join(' · ') || '无'}
              </span>
            </div>
            <div className="diag-row">
              <span>MCP</span>
              <span>{(pluginDetail.mcpServers || []).join(' · ') || '无'}</span>
            </div>
            <div className="diag-row">
              <span>Hooks</span>
              <span>{pluginDetail.hooks?.length || 0}</span>
            </div>
            {pluginDetail.shareUrl ? (
              <div className="diag-actions">
                <button onClick={() => window.codex.openExternal(pluginDetail.shareUrl)}>
                  打开分享页
                </button>
              </div>
            ) : null}
            <div className="key-actions">
              <button className="primary" onClick={() => setPluginDetail(null)}>
                关闭
              </button>
            </div>
          </div>
        </Modal>
      ) : null}

      {mcpCall ? (
        <Modal onClose={() => setMcpCall(null)} labelledBy="mcp-call-title">
          <div className="key-card capabilities-card">
            <div className="key-kicker">MCP DIRECT</div>
            <h2 id="mcp-call-title">
              {mcpCall.server} · {mcpCall.kind === 'tool' ? mcpCall.tool : '读取资源'}
            </h2>
            {mcpCall.kind === 'tool' ? (
              <>
                <p>工具参数（JSON）</p>
                <textarea
                  value={mcpCall.args}
                  onChange={(event) => setMcpCall({ ...mcpCall, args: event.target.value })}
                  rows={6}
                  spellCheck={false}
                />
              </>
            ) : (
              <>
                <p>资源 URI</p>
                <input
                  value={mcpCall.uri}
                  onChange={(event) => setMcpCall({ ...mcpCall, uri: event.target.value })}
                  placeholder="例如 file:///path 或 https://…"
                  spellCheck={false}
                />
              </>
            )}
            <div className="key-actions">
              <button onClick={() => setMcpCall(null)}>关闭</button>
              <button
                className="primary"
                disabled={
                  mcpCall.busy || (mcpCall.kind === 'resource' && !mcpCall.uri.trim())
                }
                onClick={() => void runMcpCall()}
              >
                {mcpCall.busy
                  ? '执行中…'
                  : mcpCall.kind === 'tool'
                    ? '调用工具'
                    : '读取资源'}
              </button>
            </div>
            {mcpCall.result ? (
              <pre className="diag-log mcp-result">{mcpCall.result}</pre>
            ) : null}
          </div>
        </Modal>
      ) : null}

      {sectionDialog ? (
        <Modal onClose={() => setSectionDialog(null)} labelledBy="section-dialog-title">
          <div className="key-card">
            <div className="key-kicker">THREAD SECTION</div>
            <h2 id="section-dialog-title">
              {sectionDialog.mode === 'create' ? '新建分区' : '重命名分区'}
            </h2>
            <input
              value={sectionDialog.name}
              onChange={(event) =>
                setSectionDialog({ ...sectionDialog, name: event.target.value })
              }
              onKeyDown={(event) => {
                if (event.key === 'Enter') void saveSectionDialog();
              }}
              placeholder="分区名称"
              autoFocus
            />
            <div className="key-actions">
              <button onClick={() => setSectionDialog(null)}>取消</button>
              <button
                className="primary"
                disabled={!sectionDialog.name.trim()}
                onClick={saveSectionDialog}
              >
                保存
              </button>
            </div>
          </div>
        </Modal>
      ) : null}

      {projectRenameTarget ? (
        <Modal onClose={() => setProjectRenameTarget(null)} labelledBy="project-rename-title">
          <div className="key-card">
            <div className="key-kicker">RENAME PROJECT</div>
            <h2 id="project-rename-title">重命名项目</h2>
            <input
              value={projectRenameInput}
              onChange={(event) => setProjectRenameInput(event.target.value)}
              placeholder="项目名称"
              autoFocus
            />
            <div className="key-actions">
              <button onClick={() => setProjectRenameTarget(null)}>取消</button>
              <button
                className="primary"
                disabled={!projectRenameInput.trim()}
                onClick={saveProjectRename}
              >
                保存
              </button>
            </div>
          </div>
        </Modal>
      ) : null}

      {renameTarget ? (
        <Modal onClose={() => setRenameTarget(null)} labelledBy="thread-rename-title">
          <div className="key-card">
            <div className="key-kicker">RENAME THREAD</div>
            <h2 id="thread-rename-title">重命名会话</h2>
            <input
              value={renameInput}
              onChange={(event) => setRenameInput(event.target.value)}
              placeholder="会话名称"
              autoFocus
            />
            <div className="key-actions">
              <button onClick={() => setRenameTarget(null)}>取消</button>
              <button className="primary" disabled={!renameInput.trim()} onClick={saveRename}>
                保存
              </button>
            </div>
          </div>
        </Modal>
      ) : null}

      {keyDialog ? (
        <Modal onClose={() => setKeyDialog(false)} labelledBy="key-dialog-title">
          <div className="key-card">
            <div className="key-kicker">DEEPSEEK ACCESS</div>
            <h2 id="key-dialog-title">连接 DeepSeek</h2>
            <p>
              密钥只保存在本机（Electron 加密存储），启动本地 app-server 时以环境变量注入，
              不会写入日志。
            </p>
            <input
              type="password"
              value={keyInput}
              onChange={(event) => setKeyInput(event.target.value)}
              placeholder="sk-..."
              autoFocus
            />
            <div className="key-actions">
              <button onClick={() => setKeyDialog(false)}>稍后</button>
              <button
                className="primary"
                disabled={!keyInput.trim() || keySaving}
                onClick={saveKey}
              >
                {keySaving ? '保存中…' : '保存并重启引擎'}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
      </div>
    </div>
  );
}
