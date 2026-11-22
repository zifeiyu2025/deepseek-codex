import { useCallback, useEffect, useState, type MouseEvent } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Loader2,
  RefreshCw,
  Upload,
  ArrowUp,
} from 'lucide-react';
import type { GitReview, ReviewFile, ReviewScope } from './types';
import { readStorage, writeStorage } from './lib/storage';

type Scope = ReviewScope | 'thread';

type ThreadChange = {
  path: string;
  kind?: string;
  diff?: string;
};

function splitDiff(diff: string): { header: string[]; hunks: string[][] } {
  const lines = String(diff || '').split('\n');
  const header: string[] = [];
  const hunks: string[][] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith('@@')) {
      current = [line];
      hunks.push(current);
    } else if (current) {
      current.push(line);
    } else {
      header.push(line);
    }
  }
  return { header, hunks };
}

function lineKind(line: string): string {
  if (
    line.startsWith('+++') ||
    line.startsWith('---') ||
    line.startsWith('diff --git') ||
    line.startsWith('index ') ||
    line.startsWith('new file') ||
    line.startsWith('deleted file') ||
    line.startsWith('rename ')
  ) {
    return 'meta';
  }
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'remove';
  return 'ctx';
}

function DiffLines({ lines }: { lines: string[] }) {
  return (
    <pre className="diff review-diff">
      {lines.map((line, index) => {
        const kind = lineKind(line);
        return (
          <span className={`diff-line ${kind}`} key={`${kind}-${index}`}>
            {line}
            {'\n'}
          </span>
        );
      })}
    </pre>
  );
}

function kindClass(status: string): string {
  if (status === 'A') return 'add';
  if (status === 'D') return 'del';
  if (status === 'R') return 'ren';
  return 'mod';
}

function threadKind(kind?: string): string {
  const value = (kind || '').toLowerCase();
  if (value.startsWith('a')) return 'A';
  if (value.startsWith('d')) return 'D';
  if (value.startsWith('r')) return 'R';
  return 'M';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const SCOPES: { id: Scope; label: string }[] = [
  { id: 'unstaged', label: '未暂存' },
  { id: 'staged', label: '已暂存' },
  { id: 'branch', label: '全分支' },
  { id: 'thread', label: '本轮' },
];

export function ReviewPanel({
  cwd,
  threadChanges,
  liveDiff,
  active,
  refreshToken,
  onMutate,
  onCountChange,
}: {
  cwd: string;
  threadChanges: ThreadChange[];
  liveDiff: string;
  active: boolean;
  refreshToken: number;
  onMutate?: () => void;
  onCountChange?: (count: number) => void;
}) {
  const [scope, setScope] = useState<Scope>(() => {
    const saved = readStorage('deepseek-codex.review.scope');
    return saved === 'staged' || saved === 'branch' || saved === 'thread' ? saved : 'unstaged';
  });
  const [data, setData] = useState<GitReview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    if (!cwd || scope === 'thread') return;
    setLoading(true);
    setError(null);
    try {
      const result = await window.codex.gitReview({ cwd, scope });
      setData(result);
      if (result.error) setError(result.error);
      onCountChange?.(result.files.length);
    } catch (loadError) {
      setError(errorText(loadError));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [cwd, onCountChange, scope]);

  useEffect(() => {
    setData(null);
    setError(null);
    setNotice(null);
    setMessage('');
  }, [cwd]);

  useEffect(() => {
    if (!active) return;
    if (scope === 'thread') {
      onCountChange?.(threadChanges.length);
      return;
    }
    load();
  }, [active, load, onCountChange, refreshToken, scope, threadChanges.length]);

  useEffect(() => {
    writeStorage('deepseek-codex.review.scope', scope);
  }, [scope]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const stop = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const run = async (key: string, action: () => Promise<unknown>, success: string) => {
    setBusyKey(key);
    setError(null);
    try {
      await action();
      setNotice(success);
      await load();
      onMutate?.();
    } catch (actionError) {
      setError(errorText(actionError));
    } finally {
      setBusyKey(null);
    }
  };

  const stageFile = (file: ReviewFile) => {
    void run(`stage:${file.path}`, () => window.codex.gitStage({ cwd, paths: [file.path] }), '已暂存');
  };

  const unstageFile = (file: ReviewFile) => {
    void run(
      `unstage:${file.path}`,
      () => window.codex.gitUnstage({ cwd, paths: [file.path] }),
      '已取消暂存',
    );
  };

  const discardFile = (file: ReviewFile) => {
    const detail = file.untracked ? '该文件未跟踪，将被删除。' : '未暂存的修改会丢失。';
    if (!window.confirm(`撤销 ${file.path}？\n${detail}`)) return;
    void run(
      `discard:${file.path}`,
      () => window.codex.gitDiscard({ cwd, paths: [file.path], untracked: file.untracked }),
      '已撤销',
    );
  };

  const applyHunk = (file: ReviewFile, hunkIndex: number, mode: 'stage' | 'unstage' | 'revert') => {
    if (mode === 'revert' && !window.confirm('撤销这一块修改？此操作会改写工作区文件。')) return;
    const label = mode === 'stage' ? '已暂存该块' : mode === 'unstage' ? '已取消暂存该块' : '已撤销该块';
    void run(
      `hunk:${file.path}:${hunkIndex}:${mode}`,
      () =>
        window.codex.gitHunk({
          cwd,
          diff: file.diff,
          hunkIndex,
          mode,
        }),
      label,
    );
  };

  const commit = async () => {
    const value = message.trim();
    if (!value) return;
    setBusyKey('commit');
    setError(null);
    try {
      await window.codex.gitCommit({ cwd, message: value });
      setMessage('');
      setNotice('已提交');
      await load();
      onMutate?.();
    } catch (commitError) {
      setError(errorText(commitError));
    } finally {
      setBusyKey(null);
    }
  };

  const push = () => {
    if (!window.confirm('推送到远程仓库？')) return;
    void run('push', () => window.codex.gitPush({ cwd }), '已推送');
  };

  const fileActions = (file: ReviewFile) => {
    if (scope === 'unstaged') {
      return (
        <span className="review-actions" onClick={stop}>
          <button
            className="review-action"
            disabled={busyKey !== null}
            onClick={(event) => {
              stop(event);
              stageFile(file);
            }}
          >
            暂存
          </button>
          <button
            className="review-action danger"
            disabled={busyKey !== null}
            onClick={(event) => {
              stop(event);
              discardFile(file);
            }}
          >
            撤销
          </button>
        </span>
      );
    }
    if (scope === 'staged') {
      return (
        <span className="review-actions" onClick={stop}>
          <button
            className="review-action"
            disabled={busyKey !== null}
            onClick={(event) => {
              stop(event);
              unstageFile(file);
            }}
          >
            取消暂存
          </button>
        </span>
      );
    }
    return null;
  };

  const renderFile = (file: ReviewFile) => {
    const { header, hunks } = splitDiff(file.diff);
    return (
      <details className="review-file" key={file.path} open>
        <summary className="review-file-head">
          <ChevronRight size={11} className="chev" />
          <span className={`review-kind ${kindClass(file.status)}`}>{file.status}</span>
          <span className="review-file-path" title={file.path}>
            {file.path}
          </span>
          <span className="review-file-stats">
            <span className="add">+{file.additions}</span>
            <span className="del">-{file.deletions}</span>
          </span>
          {fileActions(file)}
        </summary>
        {hunks.length === 0 ? (
          <DiffLines lines={header.filter((line) => line.trim())} />
        ) : (
          hunks.map((hunk, index) => (
            <div className="review-hunk" key={`${file.path}-${index}`}>
              <div className="review-hunk-head">
                <span className="review-hunk-title">{hunk[0]}</span>
                {scope === 'unstaged' ? (
                  <span className="hunk-actions">
                    <button
                      className="review-action"
                      disabled={busyKey !== null}
                      onClick={() => applyHunk(file, index, 'stage')}
                    >
                      暂存
                    </button>
                    {!file.untracked ? (
                      <button
                        className="review-action danger"
                        disabled={busyKey !== null}
                        onClick={() => applyHunk(file, index, 'revert')}
                      >
                        撤销
                      </button>
                    ) : null}
                  </span>
                ) : scope === 'staged' ? (
                  <span className="hunk-actions">
                    <button
                      className="review-action"
                      disabled={busyKey !== null}
                      onClick={() => applyHunk(file, index, 'unstage')}
                    >
                      取消暂存
                    </button>
                  </span>
                ) : null}
              </div>
              <DiffLines lines={hunk.slice(1)} />
            </div>
          ))
        )}
      </details>
    );
  };

  const gitFiles = data?.repo ? data.files : [];

  return (
    <div className="review-shell">
      <div className="review-toolbar">
        <div className="review-scopes">
          {SCOPES.map((entry) => (
            <button
              key={entry.id}
              className={`review-scope ${scope === entry.id ? 'active' : ''}`}
              onClick={() => setScope(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <button className="rail-icon-btn" onClick={() => load()} title="刷新变更">
          <RefreshCw size={13} className={loading ? 'spin' : undefined} />
        </button>
      </div>
      <div className="review-meta">
        <span>
          {scope === 'thread'
            ? `本轮 · ${threadChanges.length} 个文件`
            : data?.repo
              ? `${gitFiles.length} 个文件 · +${data.additions} -${data.deletions}`
              : scope === 'branch'
                ? '全分支变更'
                : '未提交变更'}
        </span>
        <span>
          {scope !== 'thread' && data?.repo
            ? `${data.branch || 'HEAD'}${
                data.base && data.base !== data.branch ? ` · 对比 ${data.base}` : ''
              }`
            : ''}
        </span>
      </div>
      <div className="review-scroll">
        {notice ? (
          <div className="review-banner notice">
            <Check size={12} /> {notice}
          </div>
        ) : null}
        {error ? (
          <div className="review-banner error">
            <AlertTriangle size={12} /> {error}
          </div>
        ) : null}
        {loading && !data ? (
          <div className="review-empty">
            <Loader2 size={14} className="spin" /> 正在读取 Git 变更…
          </div>
        ) : scope === 'thread' ? (
          <>
            {liveDiff ? (
              <details className="review-file" open>
                <summary className="review-file-head">
                  <ChevronRight size={11} className="chev" />
                  <span className="review-kind add">Δ</span>
                  <span className="review-file-path">本轮实时 diff</span>
                </summary>
                <DiffLines lines={splitDiff(liveDiff).hunks.flatMap((hunk) => hunk.slice(1))} />
              </details>
            ) : null}
            {threadChanges.length === 0 && !liveDiff ? (
              <div className="review-empty">本轮还没有文件变更</div>
            ) : (
              threadChanges.map((change) => (
                <details className="review-file" key={change.path} open>
                  <summary className="review-file-head">
                    <ChevronRight size={11} className="chev" />
                    <span className={`review-kind ${kindClass(threadKind(change.kind))}`}>
                      {threadKind(change.kind)}
                    </span>
                    <span className="review-file-path" title={change.path}>
                      {change.path}
                    </span>
                  </summary>
                  <DiffLines
                    lines={splitDiff(change.diff || '').hunks.flatMap((hunk) => hunk.slice(1))}
                  />
                </details>
              ))
            )}
          </>
        ) : !data ? (
          <div className="review-empty">{cwd ? '没有可显示的变更' : '先选择一个项目目录'}</div>
        ) : !data.repo ? (
          <div className="review-empty">当前目录不是 Git 仓库，无法读取变更。</div>
        ) : gitFiles.length === 0 ? (
          error ? null : (
            <div className="review-empty">
              {scope === 'staged'
                ? '没有已暂存的变更'
                : scope === 'branch'
                  ? '当前分支相对基线没有变更'
                  : '工作区没有未暂存变更'}
            </div>
          )
        ) : (
          gitFiles.map(renderFile)
        )}
      </div>
      {data?.repo && scope !== 'thread' && scope !== 'branch' ? (
        <div className="review-footer">
          <div className="review-commit-row">
            <input
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="提交已暂存内容…"
            />
            <button
              className="review-primary"
              disabled={!message.trim() || busyKey !== null}
              onClick={commit}
              title="提交已暂存内容"
            >
              <ArrowUp size={12} /> 提交
            </button>
            <button
              className="review-action"
              disabled={busyKey !== null}
              onClick={push}
              title="推送到远程仓库"
            >
              <Upload size={12} /> 推送
            </button>
          </div>
          <div className="review-footer-hint">提交只包含已暂存的改动</div>
        </div>
      ) : null}
    </div>
  );
}