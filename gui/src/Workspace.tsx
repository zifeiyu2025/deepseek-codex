import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileText,
  Folder,
  FolderOpen,
  Globe,
  Loader2,
  Plus,
  RefreshCw,
  RotateCw,
  Search,
  Terminal as TerminalIcon,
  X,
} from 'lucide-react';
import { Highlight, Prism, themes } from 'prism-react-renderer';
import type { FileContent, FileEntry } from './types';
import { friendlyClientError } from './lib/errors';
import { readStorage, writeStorage } from './lib/storage';
import { Modal } from './components/Modal';

const BROWSER_HISTORY_KEY = 'deepseek-codex.browserHistory';
const PDF_ANNOTATIONS_KEY = 'deepseek-codex.pdfAnnotations';

type PdfAnnotation = {
  id: string;
  page: number;
  text: string;
  at: number;
};

function pdfAnnotationKey(filePath: string) {
  return filePath.replace(/\\/g, '/').toLowerCase();
}

function readPdfAnnotations(filePath: string): PdfAnnotation[] {
  try {
    const map = JSON.parse(readStorage(PDF_ANNOTATIONS_KEY) || '{}');
    const list = map?.[pdfAnnotationKey(filePath)];
    if (!Array.isArray(list)) return [];
    return list
      .filter(
        (entry: any) =>
          entry &&
          Number.isInteger(entry.page) &&
          entry.page > 0 &&
          typeof entry.text === 'string' &&
          entry.text.trim(),
      )
      .slice(0, 100);
  } catch {
    return [];
  }
}

function writePdfAnnotations(filePath: string, list: PdfAnnotation[]) {
  try {
    const map = JSON.parse(readStorage(PDF_ANNOTATIONS_KEY) || '{}');
    const next = map && typeof map === 'object' && !Array.isArray(map) ? map : {};
    const key = pdfAnnotationKey(filePath);
    if (list.length) next[key] = list.slice(0, 100);
    else delete next[key];
    writeStorage(PDF_ANNOTATIONS_KEY, JSON.stringify(next));
  } catch {
    /* annotations are best-effort */
  }
}

function recordBrowserHistory(url: string, title: string) {
  try {
    const current = JSON.parse(readStorage(BROWSER_HISTORY_KEY) || '[]');
    const list = Array.isArray(current) ? current : [];
    const next = [
      { url, title: title || url, at: Date.now() },
      ...list.filter((entry: any) => entry?.url !== url),
    ].slice(0, 100);
    writeStorage(BROWSER_HISTORY_KEY, JSON.stringify(next));
  } catch {
    /* history is best-effort */
  }
}

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
  focusFile,
  artifacts = [],
  onReference,
}: {
  root: string;
  focusFile?: { path: string; nonce: number } | null;
  artifacts?: { path: string; kind?: string }[];
  onReference: (path: string) => void;
}) {
  const [dirs, setDirs] = useState<Record<string, FileEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState<Set<string>>(() => new Set());
  const [treeError, setTreeError] = useState<string | null>(null);
  const [preview, setPreview] = useState<FileContent | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [pdfPage, setPdfPage] = useState(1);
  const [pdfPageInput, setPdfPageInput] = useState('1');
  const [pdfAnnotations, setPdfAnnotations] = useState<PdfAnnotation[]>([]);
  const [pdfAnnotationText, setPdfAnnotationText] = useState('');
  const [pdfAnnotationsOpen, setPdfAnnotationsOpen] = useState(true);
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
        setTreeError(friendlyClientError(error));
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
      setPreviewError(friendlyClientError(error));
    } finally {
      setPreviewLoading(false);
    }
  };

  useEffect(() => {
    if (preview?.kind !== 'pdf') return;
    setPdfPage(1);
    setPdfPageInput('1');
    setPdfAnnotations(readPdfAnnotations(preview.absolutePath));
    setPdfAnnotationText('');
    setPdfAnnotationsOpen(true);
  }, [preview?.absolutePath, preview?.kind]);

  const jumpPdfPage = (value: number | string) => {
    const page = Math.max(1, Math.trunc(Number(value) || 1));
    setPdfPage(page);
    setPdfPageInput(String(page));
  };

  const persistPdfAnnotations = (next: PdfAnnotation[]) => {
    setPdfAnnotations(next);
    if (preview?.absolutePath) writePdfAnnotations(preview.absolutePath, next);
  };

  const addPdfAnnotation = () => {
    const text = pdfAnnotationText.trim();
    if (!text) return;
    const next = [
      ...pdfAnnotations,
      {
        id: `pdf-note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        page: pdfPage,
        text: text.slice(0, 2000),
        at: Date.now(),
      },
    ].slice(-100);
    persistPdfAnnotations(next);
    setPdfAnnotationText('');
  };

  const removePdfAnnotation = (id: string) => {
    persistPdfAnnotations(pdfAnnotations.filter((entry) => entry.id !== id));
  };

  const isPathInsideRoot = (filePath: string) => {
    const normalized = filePath.replace(/\\/g, '/');
    const rootNorm = root.replace(/\\/g, '/').replace(/\/+$/, '');
    const isAbsolute = /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith('/');
    if (!isAbsolute) return true;
    return Boolean(
      rootNorm &&
        (normalized.toLowerCase() === rootNorm.toLowerCase() ||
          normalized.toLowerCase().startsWith(`${rootNorm.toLowerCase()}/`)),
    );
  };

  const toRelativePath = (filePath: string) => {
    const rootNorm = root.replace(/\\/g, '/').replace(/\/+$/, '');
    let relative = filePath.replace(/\\/g, '/');
    if (relative.toLowerCase().startsWith(`${rootNorm.toLowerCase()}/`)) {
      relative = relative.slice(rootNorm.length + 1);
    }
    return relative.replace(/^\.?\//, '').replace(/^\/+/, '');
  };

  useEffect(() => {
    if (!focusFile?.path || !root) return;
    let cancelled = false;
    const relative = toRelativePath(focusFile.path);
    const parts = relative.split('/').filter(Boolean);
    if (parts.length === 0) return;
    const parents = parts.slice(0, -1);
    (async () => {
      for (let index = 1; index <= parents.length; index += 1) {
        await loadDir(parents.slice(0, index).join('/'));
        if (cancelled) return;
      }
      if (cancelled) return;
      setExpanded((previous) => {
        const next = new Set(previous);
        for (let index = 1; index <= parents.length; index += 1) {
          next.add(parents.slice(0, index).join('/'));
        }
        return next;
      });
      await openFile(relative);
    })();
    return () => {
      cancelled = true;
    };
    // focusFile.nonce identifies an explicit open request; the loaders are
    // intentionally read at effect time to avoid re-running on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusFile?.nonce, root]);

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
          ) : preview?.kind === 'pdf' ? (
            <div className="pdf-preview-shell">
              <div className="pdf-toolbar">
                <button
                  className="rail-icon-btn"
                  onClick={() => jumpPdfPage(pdfPage - 1)}
                  disabled={pdfPage <= 1}
                  title="上一页"
                >
                  <ArrowLeft size={14} />
                </button>
                <input
                  className="pdf-page-input"
                  type="number"
                  min={1}
                  value={pdfPageInput}
                  aria-label="PDF 页码"
                  onChange={(event) => setPdfPageInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') jumpPdfPage(pdfPageInput);
                  }}
                />
                <button className="rail-text-btn" onClick={() => jumpPdfPage(pdfPageInput)}>
                  跳转
                </button>
                <button
                  className="rail-icon-btn"
                  onClick={() => jumpPdfPage(pdfPage + 1)}
                  title="下一页"
                >
                  <ArrowRight size={14} />
                </button>
                <button
                  className="rail-text-btn pdf-annotation-toggle"
                  onClick={() => setPdfAnnotationsOpen((open) => !open)}
                >
                  批注 {pdfAnnotations.length}
                </button>
              </div>
              <div className="pdf-stage">
                <iframe
                  key={`${preview.absolutePath}-${pdfPage}`}
                  className="pdf-frame"
                  title={`PDF ${preview.path} 第 ${pdfPage} 页`}
                  src={`${preview.dataUrl}#page=${pdfPage}&zoom=page-width`}
                />
              </div>
              {pdfAnnotationsOpen ? (
                <div className="pdf-annotations">
                  <div className="pdf-annotation-form">
                    <span className="pdf-annotation-page">第 {pdfPage} 页</span>
                    <input
                      className="setting-input"
                      value={pdfAnnotationText}
                      placeholder="添加页级批注"
                      onChange={(event) => setPdfAnnotationText(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') addPdfAnnotation();
                      }}
                    />
                    <button
                      className="settings-button"
                      disabled={!pdfAnnotationText.trim()}
                      onClick={addPdfAnnotation}
                    >
                      <Plus size={13} />
                      添加
                    </button>
                  </div>
                  {pdfAnnotations.length ? (
                    <div className="pdf-annotation-list">
                      {pdfAnnotations.map((annotation) => (
                        <div className="pdf-annotation-row" key={annotation.id}>
                          <button
                            className="pdf-annotation-text"
                            onClick={() => jumpPdfPage(annotation.page)}
                            title={`跳到第 ${annotation.page} 页`}
                          >
                            <span>第 {annotation.page} 页</span>
                            <p>{annotation.text}</p>
                          </button>
                          <button
                            className="icon-button"
                            aria-label="删除批注"
                            onClick={() => removePdfAnnotation(annotation.id)}
                          >
                            <X size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="files-hint">当前 PDF 还没有批注</div>
                  )}
                </div>
              ) : null}
            </div>
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
      {artifacts.length > 0 ? (
        <div className="files-artifacts">
          <div className="files-artifacts-label">产物 · {artifacts.length}</div>
          {artifacts.map((artifact) => (
            <button
              key={artifact.path}
              className="artifact-row"
              title={artifact.path}
              onClick={() => {
                if (isPathInsideRoot(artifact.path)) {
                  void openFile(toRelativePath(artifact.path));
                } else {
                  void window.codex.showInFolder(artifact.path);
                }
              }}
            >
              <FileText size={12} />
              <span className="artifact-name">{baseName(artifact.path)}</span>
              <span className="artifact-path">{artifact.path}</span>
            </button>
          ))}
        </div>
      ) : null}
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

type BrowserTab = {
  id: string;
  url: string;
  draft: string;
  title: string;
  loading: boolean;
  canBack: boolean;
  canForward: boolean;
  error: string | null;
};

function browserTabLabel(tab: BrowserTab) {
  if (tab.title) return tab.title;
  try {
    return new URL(tab.url).hostname || tab.url || '新标签';
  } catch {
    return tab.url || '新标签';
  }
}

export function BrowserPanel({ active }: { active: boolean }) {
  const initialUrl = useRef(
    readStorage('deepseek-codex.browserUrl') || 'http://localhost:3000',
  ).current;
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [visited, setVisited] = useState(active);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const viewsRef = useRef<Map<string, any>>(new Map());
  const tabSeqRef = useRef(0);
  const activeIdRef = useRef<string | null>(null);
  const activeTab = tabs.find((tab) => tab.id === activeId) || null;
  const [shotEditor, setShotEditor] = useState<{ dataUrl: string; comment: string } | null>(null);
  const [shotSelection, setShotSelection] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);
  const [shotBusy, setShotBusy] = useState(false);
  const shotImgRef = useRef<HTMLImageElement | null>(null);
  const shotDragRef = useRef<{ x: number; y: number } | null>(null);

  const patchTab = (id: string, patch: Partial<BrowserTab>) => {
    setTabs((list) => list.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)));
  };

  const activateGuest = (view: any) => {
    try {
      const id = view.getWebContentsId();
      if (id) void window.codex.browserActivate(id);
    } catch {
      /* webview may not be ready */
    }
  };

  const createTab = (value: string, makeActive = true) => {
    const normalized =
      normalizeUrl(value) || normalizeUrl(initialUrl) || 'http://localhost:3000';
    const id = `tab-${Date.now().toString(36)}-${++tabSeqRef.current}`;
    setVisited(true);
    setTabs((list) => [
      ...list,
      {
        id,
        url: normalized,
        draft: normalized,
        title: '',
        loading: true,
        canBack: false,
        canForward: false,
        error: null,
      },
    ]);
    if (makeActive) setActiveId(id);
    return id;
  };

  const getActiveView = () => (activeId ? viewsRef.current.get(activeId) : null);

  const go = (value: string) => {
    const normalized = normalizeUrl(value);
    if (!normalized) {
      if (activeId) patchTab(activeId, { error: '仅支持 http/https 地址' });
      return;
    }
    writeStorage('deepseek-codex.browserUrl', normalized);
    if (!activeId) {
      createTab(normalized);
      return;
    }
    patchTab(activeId, { url: normalized, draft: normalized, error: null, loading: true });
    const view = getActiveView();
    if (view) {
      view.loadURL(normalized).catch((error: Error) => patchTab(activeId, { error: error.message }));
    }
  };

  const closeTab = (id: string) => {
    const index = tabs.findIndex((tab) => tab.id === id);
    const remaining = tabs.filter((tab) => tab.id !== id);
    setTabs(remaining);
    if (activeId === id) {
      const next = remaining[Math.min(index, remaining.length - 1)];
      if (next) setActiveId(next.id);
      else {
        setActiveId(null);
        createTab(initialUrl);
      }
    }
  };

  const capturePage = async () => {
    const view = getActiveView();
    if (!view) return;
    try {
      let image = null;
      let lastError = null;
      for (let attempt = 0; attempt < 3 && !image; attempt += 1) {
        try {
          image = await view.capturePage();
        } catch (error: any) {
          lastError = error;
          await new Promise((resolve) => setTimeout(resolve, 600));
        }
      }
      if (!image) throw lastError || new Error('页面截图为空');
      setShotSelection(null);
      setShotEditor({ dataUrl: image.toDataURL(), comment: '' });
    } catch (error: any) {
      if (activeId) patchTab(activeId, { error: friendlyClientError(error) });
    }
  };

  const selectionPoint = (event: ReactPointerEvent<HTMLDivElement>) => {
    const image = shotImgRef.current;
    if (!image) return { x: 0, y: 0 };
    const rect = image.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
      y: Math.max(0, Math.min(rect.height, event.clientY - rect.top)),
    };
  };

  const saveShot = async () => {
    if (!shotEditor || shotBusy) return;
    setShotBusy(true);
    try {
      let dataUrl = shotEditor.dataUrl;
      const image = shotImgRef.current;
      if (
        image &&
        shotSelection &&
        shotSelection.w > 4 &&
        shotSelection.h > 4 &&
        image.clientWidth > 0 &&
        image.clientHeight > 0
      ) {
        const scaleX = image.naturalWidth / image.clientWidth;
        const scaleY = image.naturalHeight / image.clientHeight;
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(shotSelection.w * scaleX));
        canvas.height = Math.max(1, Math.round(shotSelection.h * scaleY));
        const context = canvas.getContext('2d');
        if (context) {
          context.drawImage(
            image,
            shotSelection.x * scaleX,
            shotSelection.y * scaleY,
            shotSelection.w * scaleX,
            shotSelection.h * scaleY,
            0,
            0,
            canvas.width,
            canvas.height,
          );
          dataUrl = canvas.toDataURL('image/png');
        }
      }
      const path = await window.codex.browserSavePageShot(dataUrl);
      if (path) {
        window.dispatchEvent(
          new CustomEvent('deepseek-codex:attach-image', {
            detail: { path, text: shotEditor.comment.trim() || undefined },
          }),
        );
      }
      setShotEditor(null);
      setShotSelection(null);
    } catch (error: any) {
      if (activeId) patchTab(activeId, { error: friendlyClientError(error) });
    } finally {
      setShotBusy(false);
    }
  };

  useEffect(() => {
    if (active) setVisited(true);
  }, [active]);

  useEffect(() => {
    if (visited && tabs.length === 0) createTab(initialUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visited, tabs.length]);

  useEffect(() => {
    if (!visited || !wrapRef.current) return;
    const container = wrapRef.current;
    for (const tab of tabs) {
      if (viewsRef.current.has(tab.id)) continue;
      const view = document.createElement('webview') as any;
      view.setAttribute('partition', 'persist:shanui-browser');
      view.setAttribute('src', tab.url);
      view.setAttribute('allowpopups', '');
      view.className = 'browser-frame';
      view.style.display = 'none';
      const sync = () => {
        try {
          const current = view.getURL();
          patchTab(tab.id, {
            canBack: Boolean(view.canGoBack()),
            canForward: Boolean(view.canGoForward()),
            ...(current
              ? { url: current, draft: current, title: view.getTitle() || '' }
              : {}),
          });
          if (current) {
            writeStorage('deepseek-codex.browserUrl', current);
            recordBrowserHistory(current, view.getTitle() || '');
          }
        } catch {
          /* webview may not be ready */
        }
      };
      view.addEventListener('did-start-loading', () => patchTab(tab.id, { loading: true }));
      view.addEventListener('did-stop-loading', () => {
        patchTab(tab.id, { loading: false });
        sync();
      });
      view.addEventListener('did-navigate', () => {
        patchTab(tab.id, { error: null, loading: false });
        sync();
      });
      view.addEventListener('did-navigate-in-page', () => {
        patchTab(tab.id, { error: null });
        sync();
      });
      view.addEventListener('page-title-updated', sync);
      view.addEventListener('did-fail-load', (event: any) => {
        if (event?.errorCode === -3) return;
        patchTab(tab.id, {
          loading: false,
          error: event?.errorDescription || `加载失败（${event?.errorCode ?? 'unknown'}）`,
        });
      });
      view.addEventListener('dom-ready', () => {
        if (activeIdRef.current === tab.id) activateGuest(view);
      });
      container.appendChild(view);
      viewsRef.current.set(tab.id, view);
    }
    for (const [id, view] of [...viewsRef.current]) {
      if (!tabs.some((tab) => tab.id === id)) {
        try {
          view.remove();
        } catch {
          /* ignore */
        }
        viewsRef.current.delete(id);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, visited]);

  useEffect(
    () => () => {
      for (const view of viewsRef.current.values()) {
        try {
          view.remove();
        } catch {
          /* ignore */
        }
      }
      viewsRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    activeIdRef.current = activeId;
    for (const [id, view] of viewsRef.current) {
      view.style.display = active && id === activeId ? '' : 'none';
    }
    const view = activeId ? viewsRef.current.get(activeId) : null;
    if (view) activateGuest(view);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, activeId, tabs.length]);

  useEffect(() => {
    const open = (event: Event) => {
      const url = (event as CustomEvent<{ url?: string }>).detail?.url;
      if (url) createTab(url);
      else if (tabs.length === 0) createTab(initialUrl);
    };
    window.addEventListener('deepseek-codex:browser-open', open);
    return () => window.removeEventListener('deepseek-codex:browser-open', open);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs.length]);

  useEffect(() => {
    if (!visited) return;
    let frame = 0;
    let hidden: boolean | null = null;
    const apply = () => {
      frame = 0;
      const next = Boolean(document.querySelector('.key-overlay'));
      if (next === hidden) return;
      hidden = next;
      for (const view of viewsRef.current.values()) {
        view.style.visibility = next ? 'hidden' : 'visible';
      }
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(apply);
    };
    schedule();
    const observer = new MutationObserver(schedule);
    const appFrame = document.querySelector('.app-frame');
    if (appFrame) observer.observe(appFrame, { childList: true, subtree: true });
    observer.observe(document.body, { childList: true });
    return () => {
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [visited, tabs.length]);

  const view = getActiveView();

  return (
    <div className="browser-panel">
      <div className="browser-tabs">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`browser-tab ${tab.id === activeId ? 'active' : ''}`}
            onClick={() => setActiveId(tab.id)}
            title={tab.url}
          >
            {tab.loading ? (
              <Loader2 size={10} className="spin" />
            ) : (
              <Globe size={10} />
            )}
            <span>{browserTabLabel(tab)}</span>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                closeTab(tab.id);
              }}
              aria-label="关闭标签"
            >
              <X size={9} />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="browser-tab-new"
          onClick={() => createTab(activeTab?.url || initialUrl)}
          title="新建标签"
          aria-label="新建标签"
        >
          <Plus size={12} />
        </button>
      </div>
      <form
        className="browser-bar"
        onSubmit={(event) => {
          event.preventDefault();
          go(activeTab?.draft ?? '');
        }}
      >
        <button
          className="rail-icon-btn"
          type="button"
          disabled={!activeTab?.canBack}
          onClick={() => view?.goBack()}
          title="后退"
        >
          <ArrowLeft size={13} />
        </button>
        <button
          className="rail-icon-btn"
          type="button"
          disabled={!activeTab?.canForward}
          onClick={() => view?.goForward()}
          title="前进"
        >
          <ArrowRight size={13} />
        </button>
        {activeTab?.loading ? (
          <button
            className="rail-icon-btn"
            type="button"
            onClick={() => view?.stop()}
            title="停止加载"
          >
            <X size={13} />
          </button>
        ) : (
          <button
            className="rail-icon-btn"
            type="button"
            onClick={() => view?.reload()}
            title="刷新"
          >
            <RotateCw size={13} />
          </button>
        )}
        <input
          value={activeTab?.draft ?? ''}
          onChange={(event) => {
            if (activeId) patchTab(activeId, { draft: event.target.value });
          }}
          placeholder="http://localhost:3000"
          spellCheck={false}
        />
        <button className="rail-text-btn" type="submit">
          打开
        </button>
        <button
          className="rail-icon-btn"
          type="button"
          onClick={() => void capturePage()}
          title="截取页面并附加到输入框"
        >
          <Camera size={13} />
        </button>
        <button
          className="rail-icon-btn"
          type="button"
          onClick={() => activeTab?.url && window.codex.openExternal(activeTab.url)}
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
        {activeTab?.loading ? (
          <span className="browser-loading">
            <Loader2 size={11} className="spin" /> 加载中
          </span>
        ) : activeTab?.title ? (
          <span className="browser-title" title={activeTab.url}>
            {activeTab.title}
          </span>
        ) : null}
      </div>
      {activeTab?.error ? <div className="browser-error">{activeTab.error}</div> : null}
      <div className="browser-stage" ref={wrapRef}>
        {!visited || tabs.length === 0 ? (
          <div className="files-empty">输入本地开发服务器地址，预览页面。</div>
        ) : null}
      </div>
      {shotEditor ? (
        <Modal
          onClose={() => {
            if (!shotBusy) {
              setShotEditor(null);
              setShotSelection(null);
            }
          }}
          labelledBy="shot-editor-title"
        >
          <div className="key-card shot-card">
            <div className="key-kicker">PAGE SHOT</div>
            <h2 id="shot-editor-title">截取页面区域</h2>
            <p>拖动选择区域；不选择则使用整页可见截图。</p>
            <div
              className="shot-canvas"
              onPointerDown={(event) => {
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                const point = selectionPoint(event);
                shotDragRef.current = point;
                setShotSelection({ x: point.x, y: point.y, w: 0, h: 0 });
              }}
              onPointerMove={(event) => {
                const start = shotDragRef.current;
                if (!start) return;
                const point = selectionPoint(event);
                setShotSelection({
                  x: Math.min(start.x, point.x),
                  y: Math.min(start.y, point.y),
                  w: Math.abs(point.x - start.x),
                  h: Math.abs(point.y - start.y),
                });
              }}
              onPointerUp={() => {
                shotDragRef.current = null;
              }}
            >
              <img
                ref={shotImgRef}
                src={shotEditor.dataUrl}
                alt="页面截图"
                draggable={false}
              />
              {shotSelection ? (
                <div
                  className="shot-selection"
                  style={{
                    left: shotSelection.x,
                    top: shotSelection.y,
                    width: shotSelection.w,
                    height: shotSelection.h,
                  }}
                />
              ) : null}
            </div>
            <input
              className="shot-comment"
              value={shotEditor.comment}
              onChange={(event) =>
                setShotEditor((current) =>
                  current ? { ...current, comment: event.target.value } : current,
                )
              }
              placeholder="给这张截图的说明（可选）"
            />
            <div className="key-actions">
              <button onClick={() => void saveShot()} disabled={shotBusy}>
                {shotBusy ? '保存中…' : '附加截图'}
              </button>
              <button
                onClick={() => {
                  setShotEditor(null);
                  setShotSelection(null);
                }}
                disabled={shotBusy}
              >
                取消
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
