import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  RefreshCw,
  RotateCw,
  Search,
  Terminal as TerminalIcon,
  X,
} from 'lucide-react';
import { Highlight, Prism, themes } from 'prism-react-renderer';
import type { FileContent, FileEntry } from './types';

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'tsx',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'markup',
  htm: 'markup',
  xml: 'markup',
  svg: 'markup',
  md: 'markdown',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  toml: 'toml',
  yml: 'yaml',
  yaml: 'yaml',
  sql: 'sql',
  graphql: 'graphql',
};

function CodeView({ text, filePath }: { text: string; filePath: string }) {
  const extension = (filePath.split('.').pop() || '').toLowerCase();
  const requested = LANGUAGE_BY_EXTENSION[extension] || 'plain';
  const language = (Prism.languages[requested] ? requested : 'plain') as any;
  if (text.length > 150_000) {
    return <pre className="file-text">{text}</pre>;
  }
  return (
    <Highlight theme={themes.vsDark} code={text} language={language}>
      {({ className, style, tokens, getLineProps, getTokenProps }) => (
        <pre className={`code-view ${className}`} style={{ ...style, background: 'transparent' }}>
          {tokens.map((line, lineIndex) => (
            <div {...getLineProps({ line })} className="code-line" key={lineIndex}>
              <span className="code-line-number">{lineIndex + 1}</span>
              <span className="code-line-content">
                {line.map((token, tokenIndex) => (
                  <span {...getTokenProps({ token })} key={tokenIndex} />
                ))}
              </span>
            </div>
          ))}
        </pre>
      )}
    </Highlight>
  );
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function baseName(target: string): string {
  return target.split(/[\\/]/).filter(Boolean).pop() || target;
}

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

export function FilesPanel({
  root,
  onReference,
}: {
  root: string;
  onReference: (path: string) => void;
}) {
  const [dirs, setDirs] = useState<Record<string, FileEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState<Set<string>>(() => new Set());
  const [treeError, setTreeError] = useState<string | null>(null);
  const [preview, setPreview] = useState<FileContent | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [fileQuery, setFileQuery] = useState('');
  const [fileResults, setFileResults] = useState<
    { path: string; fileName: string; matchType: string }[]
  >([]);
  const [fileSearchBusy, setFileSearchBusy] = useState(false);
  const fileSearchSeq = useRef(0);

  const loadDir = useCallback(
    async (relPath: string) => {
      if (!root) return;
      setLoading((previous) => new Set(previous).add(relPath));
      try {
        const result = await window.codex.listDir({ root, path: relPath });
        setDirs((previous) => ({ ...previous, [relPath]: result.entries }));
        setTreeError(null);
      } catch (error: any) {
        setTreeError(error?.message || String(error));
      } finally {
        setLoading((previous) => {
          const next = new Set(previous);
          next.delete(relPath);
          return next;
        });
      }
    },
    [root],
  );

  useEffect(() => {
    setDirs({});
    setExpanded(new Set());
    setPreview(null);
    setPreviewError(null);
    setTreeError(null);
    setFileQuery('');
    setFileResults([]);
    if (root) loadDir('');
  }, [loadDir, root]);

  useEffect(() => {
    const openSearch = (event: Event) => {
      const query = (event as CustomEvent<{ query?: string }>).detail?.query || '';
      setPreview(null);
      setPreviewError(null);
      setFileQuery(query);
      setTimeout(() => {
        document.querySelector<HTMLInputElement>('.files-search input')?.focus();
      }, 0);
    };
    window.addEventListener('deepseek-codex:file-search', openSearch);
    return () => window.removeEventListener('deepseek-codex:file-search', openSearch);
  }, []);

  useEffect(() => {
    const query = fileQuery.trim();
    if (!query || !root) {
      setFileResults([]);
      setFileSearchBusy(false);
      return;
    }
    const seq = ++fileSearchSeq.current;
    setFileSearchBusy(true);
    const timer = setTimeout(() => {
      window.codex
        .request('fuzzyFileSearch', {
          query,
          roots: [root],
          cancellationToken: 'files-panel',
        })
        .then((response) => {
          if (seq !== fileSearchSeq.current) return;
          const ignored = /(^|[\\/])(node_modules|\.git|dist|build|release|target|\.next|\.cache)([\\/]|$)/i;
          const files = (response?.files || [])
            .filter((entry: any) => (entry.match_type ?? entry.matchType) !== 'directory')
            .filter((entry: any) => !ignored.test(entry.path))
            .map((entry: any) => ({
              path: entry.path,
              fileName: entry.file_name ?? entry.fileName ?? baseName(entry.path),
              matchType: entry.match_type ?? entry.matchType ?? 'file',
            }));
          setFileResults(files.slice(0, 80));
        })
        .catch(() => {
          if (seq === fileSearchSeq.current) setFileResults([]);
        })
        .finally(() => {
          if (seq === fileSearchSeq.current) setFileSearchBusy(false);
        });
    }, 200);
    return () => clearTimeout(timer);
  }, [fileQuery, root]);

  const toggleDir = (relPath: string) => {
    const open = expanded.has(relPath);
    if (!open && !dirs[relPath]) loadDir(relPath);
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(relPath)) next.delete(relPath);
      else next.add(relPath);
      return next;
    });
  };

  const openFile = async (relPath: string) => {
    if (!root) return;
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const result = await window.codex.readFile({ root, path: relPath });
      setPreview(result);
    } catch (error: any) {
      setPreview(null);
      setPreviewError(error?.message || String(error));
    } finally {
      setPreviewLoading(false);
    }
  };

  const renderEntries = (relPath: string, depth: number): ReactNode => {
    const entries = dirs[relPath];
    if (!entries) {
      return loading.has(relPath) ? (
        <div className="files-hint" style={{ paddingLeft: 12 + depth * 14 }}>
          <Loader2 size={12} className="spin" /> 加载中…
        </div>
      ) : null;
    }
    if (entries.length === 0) {
      return (
        <div className="files-hint" style={{ paddingLeft: 12 + depth * 14 }}>
          空目录
        </div>
      );
    }
    return entries.map((entry) => (
      <div key={entry.path}>
        <button
          className={`file-row ${entry.dir ? 'dir' : 'file'}`}
          style={{ paddingLeft: 6 + depth * 14 }}
          title={entry.path}
          onClick={() => (entry.dir ? toggleDir(entry.path) : openFile(entry.path))}
        >
          {entry.dir ? (
            expanded.has(entry.path) ? (
              <ChevronDown size={12} />
            ) : (
              <ChevronRight size={12} />
            )
          ) : (
            <span className="file-chevron-space" />
          )}
          {entry.dir ? <Folder size={14} /> : <FileText size={14} />}
          <span className="file-name">{entry.name}</span>
          {entry.symlink ? <span className="file-tag">link</span> : null}
        </button>
        {entry.dir && expanded.has(entry.path) ? renderEntries(entry.path, depth + 1) : null}
      </div>
    ));
  };

  if (!root) {
    return <div className="files-empty">先选择一个项目目录，再浏览文件。</div>;
  }

  if (preview || previewLoading || previewError) {
    return (
      <div className="files-panel">
        <div className="files-head">
          <button
            className="rail-icon-btn"
            onClick={() => {
              setPreview(null);
              setPreviewError(null);
            }}
            title="返回文件树"
          >
            <ArrowLeft size={14} />
          </button>
          <span className="files-path" title={preview?.path || ''}>
            {preview?.path || '读取文件…'}
          </span>
          {preview ? (
            <>
              <button
                className="rail-text-btn"
                onClick={() => onReference(preview.path)}
                title="在输入框中引用此文件"
              >
                引用
              </button>
              <button
                className="rail-icon-btn"
                onClick={() => window.codex.showInFolder(preview.absolutePath)}
                title="在文件夹中显示"
              >
                <FolderOpen size={14} />
              </button>
            </>
          ) : null}
        </div>
        <div className="files-preview">
          {previewLoading ? (
            <div className="files-hint">
              <Loader2 size={13} className="spin" /> 读取中…
            </div>
          ) : previewError ? (
            <div className="files-error">{previewError}</div>
          ) : preview?.kind === 'image' ? (
            <img className="file-image" src={preview.dataUrl} alt={preview.path} />
          ) : preview?.kind === 'binary' ? (
            <div className="files-empty">二进制文件 · {formatBytes(preview.size)}</div>
          ) : (
            <>
              {preview?.truncated ? (
                <div className="files-hint">已截断预览（文件 {formatBytes(preview.size)}）</div>
              ) : null}
              <CodeView text={preview?.text || ''} filePath={preview?.path || ''} />
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="files-panel">
      <div className="files-head">
        <FolderOpen size={14} />
        <span className="files-path" title={root}>
          {baseName(root)}
        </span>
        <button className="rail-icon-btn" onClick={() => loadDir('')} title="刷新文件树">
          <RefreshCw size={13} />
        </button>
      </div>
      {fileQuery ? (
        <label className="files-search">
          <Search size={12} />
          <input
            value={fileQuery}
            onChange={(event) => setFileQuery(event.target.value)}
            placeholder="快速打开文件…"
            spellCheck={false}
          />
          <button
            className="files-search-clear"
            onClick={() => setFileQuery('')}
            title="清除搜索"
          >
            ×
          </button>
        </label>
      ) : null}
      {treeError ? <div className="files-error">{treeError}</div> : null}
      {fileQuery.trim() ? (
        <div className="file-tree file-results">
          {fileSearchBusy && fileResults.length === 0 ? (
            <div className="files-hint">
              <Loader2 size={12} className="spin" /> 搜索中…
            </div>
          ) : fileResults.length === 0 ? (
            <div className="files-hint">没有匹配的文件</div>
          ) : (
            fileResults.map((result) => (
              <button
                className="file-row file"
                key={result.path}
                title={result.path}
                onClick={() => openFile(result.path)}
              >
                <span className="file-chevron-space" />
                <FileText size={14} />
                <span className="file-name">{result.fileName}</span>
                <span className="file-result-path">{result.path}</span>
              </button>
            ))
          )}
        </div>
      ) : (
        <div className="file-tree">{renderEntries('', 0)}</div>
      )}
    </div>
  );
}

export function TerminalPanel({ cwd, active }: { cwd: string; active: boolean }) {
  const [status, setStatus] = useState<'idle' | 'starting' | 'running' | 'exited'>('idle');
  const [output, setOutput] = useState('');
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const termIdRef = useRef<string | null>(null);
  const startedRef = useRef(false);
  const mountedRef = useRef(true);
  const outputRef = useRef<HTMLPreElement>(null);

  const append = useCallback((text: string) => {
    setOutput((previous) => (previous + text).slice(-300000));
  }, []);

  const start = useCallback(async () => {
    if (!cwd) return;
    const previous = termIdRef.current;
    if (previous) {
      try {
        await window.codex.terminalStop(previous);
      } catch {
        /* ignore */
      }
      termIdRef.current = null;
    }
    setStatus('starting');
    setOutput('');
    try {
      const result = await window.codex.terminalStart({ cwd });
      if (!mountedRef.current) {
        window.codex.terminalStop(result.id);
        return;
      }
      termIdRef.current = result.id;
      setStatus('running');
      append(`# ${cwd}\n# PowerShell 命令模式 · 关闭面板会结束会话\n\n`);
    } catch (error: any) {
      if (!mountedRef.current) return;
      setStatus('exited');
      append(`# 启动失败：${error?.message || error}\n`);
    }
  }, [append, cwd]);

  useEffect(() => {
    mountedRef.current = true;
    const unsubscribeData = window.codex.onTerminalData((payload) => {
      if (payload.id === termIdRef.current) append(stripAnsi(payload.data));
    });
    const unsubscribeExit = window.codex.onTerminalExit((payload) => {
      if (payload.id === termIdRef.current) {
        termIdRef.current = null;
        setStatus('exited');
        append(`\n[进程已退出${payload.code === null ? '' : ` · code ${payload.code}`}]\n`);
      }
    });
    return () => {
      mountedRef.current = false;
      unsubscribeData();
      unsubscribeExit();
      const current = termIdRef.current;
      if (current) {
        window.codex.terminalStop(current);
        termIdRef.current = null;
      }
    };
  }, [append]);

  useEffect(() => {
    const current = termIdRef.current;
    if (current) {
      window.codex.terminalStop(current);
      termIdRef.current = null;
    }
    startedRef.current = false;
    setStatus('idle');
    setOutput('');
    setInput('');
    setHistory([]);
    setHistoryIndex(-1);
  }, [cwd]);

  useEffect(() => {
    if (!active || !cwd || startedRef.current) return;
    startedRef.current = true;
    start();
  }, [active, cwd, start]);

  useEffect(() => {
    const element = outputRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [output, status]);

  const send = () => {
    const command = input;
    const current = termIdRef.current;
    if (!command.trim() || !current) return;
    window.codex.terminalInput({ id: current, data: command });
    append(`\n❯ ${command}\n`);
    setHistory((previous) => [command, ...previous].slice(0, 50));
    setHistoryIndex(-1);
    setInput('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      send();
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (history.length === 0) return;
      const next = Math.min(historyIndex + 1, history.length - 1);
      setHistoryIndex(next);
      setInput(history[next]);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (historyIndex <= 0) {
        setHistoryIndex(-1);
        setInput('');
        return;
      }
      const next = historyIndex - 1;
      setHistoryIndex(next);
      setInput(history[next]);
    }
  };

  if (!cwd) {
    return <div className="files-empty">先选择一个项目目录，再打开终端。</div>;
  }

  const statusLabel =
    status === 'running'
      ? '运行中'
      : status === 'starting'
        ? '启动中'
        : status === 'exited'
          ? '已退出'
          : '未启动';

  return (
    <div className="terminal-panel">
      <div className="terminal-bar">
        <span className={`terminal-dot ${status}`} />
        <span className="terminal-status">{statusLabel}</span>
        <span className="terminal-cwd" title={cwd}>
          {baseName(cwd)}
        </span>
        <button
          className="rail-icon-btn"
          onClick={() => {
            startedRef.current = true;
            start();
          }}
          title="重启终端"
        >
          <RefreshCw size={13} />
        </button>
        <button
          className="rail-icon-btn"
          onClick={() => setOutput('')}
          title="清空输出"
        >
          <RotateCw size={13} />
        </button>
      </div>
      <pre className="terminal-output" ref={outputRef}>
        {output || '# 打开终端后在此输入命令\n'}
      </pre>
      <div className="terminal-input-wrap">
        <span className="terminal-prompt">❯</span>
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={onKeyDown}
          disabled={status !== 'running'}
          placeholder={status === 'running' ? '输入命令，Enter 执行' : '终端未运行'}
          spellCheck={false}
        />
        <button
          className="rail-icon-btn"
          disabled={status !== 'running' || !input.trim()}
          onClick={send}
          title="执行"
        >
          <TerminalIcon size={13} />
        </button>
      </div>
    </div>
  );
}

function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const withScheme = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

const BROWSER_PRESETS = [
  'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost:8080',
  'http://localhost:8000',
];

export function BrowserPanel({ active }: { active: boolean }) {
  const initial =
    localStorage.getItem('deepseek-codex.browserUrl') || 'http://localhost:3000';
  const [url, setUrl] = useState(initial);
  const [draft, setDraft] = useState(initial);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [canBack, setCanBack] = useState(false);
  const [canForward, setCanForward] = useState(false);
  const [visited, setVisited] = useState(active);
  const [title, setTitle] = useState('');
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<any>(null);

  useEffect(() => {
    if (active) setVisited(true);
  }, [active]);

  useEffect(() => {
    if (!visited || !wrapRef.current || viewRef.current) return;
    const container = wrapRef.current;
    const view = document.createElement('webview') as any;
    view.setAttribute('src', url);
    view.setAttribute('allowpopups', '');
    view.className = 'browser-frame';
    container.appendChild(view);
    viewRef.current = view;

    const sync = () => {
      try {
        setCanBack(Boolean(view.canGoBack()));
        setCanForward(Boolean(view.canGoForward()));
        const current = view.getURL();
        if (current) {
          setUrl(current);
          setDraft(current);
          setTitle(view.getTitle() || '');
          localStorage.setItem('deepseek-codex.browserUrl', current);
        }
      } catch {
        /* webview may not be ready */
      }
    };
    const onStart = () => setLoading(true);
    const onStop = () => {
      setLoading(false);
      sync();
    };
    const onNavigate = () => {
      setUrlError(null);
      onStop();
    };
    const onFail = (event: any) => {
      if (event?.errorCode === -3) return;
      setLoading(false);
      setUrlError(event?.errorDescription || `加载失败（${event?.errorCode ?? 'unknown'}）`);
    };
    view.addEventListener('did-start-loading', onStart);
    view.addEventListener('did-stop-loading', onStop);
    view.addEventListener('did-navigate', onNavigate);
    view.addEventListener('did-navigate-in-page', onNavigate);
    view.addEventListener('page-title-updated', sync);
    view.addEventListener('did-fail-load', onFail);

    return () => {
      view.removeEventListener('did-start-loading', onStart);
      view.removeEventListener('did-stop-loading', onStop);
      view.removeEventListener('did-navigate', onNavigate);
      view.removeEventListener('did-navigate-in-page', onNavigate);
      view.removeEventListener('page-title-updated', sync);
      view.removeEventListener('did-fail-load', onFail);
      try {
        view.remove();
      } catch {
        /* ignore */
      }
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visited]);

  useEffect(() => {
    const open = (event: Event) => {
      const url = (event as CustomEvent<{ url?: string }>).detail?.url;
      if (url) go(url);
    };
    window.addEventListener('deepseek-codex:browser-open', open);
    return () => window.removeEventListener('deepseek-codex:browser-open', open);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.style.display = active ? '' : 'none';
  }, [active, visited]);

  useEffect(() => {
    if (!visited) return;
    const swallow = () => {
      const view = viewRef.current;
      if (!view) return;
      view.style.visibility = document.querySelector('.key-overlay') ? 'hidden' : 'visible';
    };
    swallow();
    const observer = new MutationObserver(swallow);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [visited]);

  const go = (value: string) => {
    const normalized = normalizeUrl(value);
    if (!normalized) {
      setUrlError('仅支持 http/https 地址');
      return;
    }
    setUrlError(null);
    setUrl(normalized);
    setDraft(normalized);
    setVisited(true);
    try {
      localStorage.setItem('deepseek-codex.browserUrl', normalized);
    } catch {
      /* ignore */
    }
    const view = viewRef.current;
    if (view) {
      view.loadURL(normalized).catch((error: Error) => setUrlError(error.message));
    } else {
      window.setTimeout(() => {
        viewRef.current?.loadURL?.(normalized).catch((error: Error) => setUrlError(error.message));
      }, 80);
    }
  };

  return (
    <div className="browser-panel">
      <form
        className="browser-bar"
        onSubmit={(event) => {
          event.preventDefault();
          go(draft);
        }}
      >
        <button
          className="rail-icon-btn"
          type="button"
          disabled={!canBack}
          onClick={() => viewRef.current?.goBack()}
          title="后退"
        >
          <ArrowLeft size={13} />
        </button>
        <button
          className="rail-icon-btn"
          type="button"
          disabled={!canForward}
          onClick={() => viewRef.current?.goForward()}
          title="前进"
        >
          <ArrowRight size={13} />
        </button>
        {loading ? (
          <button
            className="rail-icon-btn"
            type="button"
            onClick={() => viewRef.current?.stop()}
            title="停止加载"
          >
            <X size={13} />
          </button>
        ) : (
          <button
            className="rail-icon-btn"
            type="button"
            onClick={() => viewRef.current?.reload()}
            title="刷新"
          >
            <RotateCw size={13} />
          </button>
        )}
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="http://localhost:3000"
          spellCheck={false}
        />
        <button className="rail-text-btn" type="submit">
          打开
        </button>
        <button
          className="rail-icon-btn"
          type="button"
          onClick={() => window.codex.openExternal(url)}
          title="在外部浏览器打开"
        >
          <ExternalLink size={13} />
        </button>
      </form>
      <div className="browser-presets">
        {BROWSER_PRESETS.map((preset) => (
          <button key={preset} onClick={() => go(preset)} title={preset}>
            :{new URL(preset).port}
          </button>
        ))}
        {loading ? (
          <span className="browser-loading">
            <Loader2 size={11} className="spin" /> 加载中
          </span>
        ) : title ? (
          <span className="browser-title" title={url}>
            {title}
          </span>
        ) : null}
      </div>
      {urlError ? <div className="browser-error">{urlError}</div> : null}
      <div className="browser-stage" ref={wrapRef}>
        {!visited ? <div className="files-empty">输入本地开发服务器地址，预览页面。</div> : null}
      </div>
    </div>
  );
}
