import type { Dispatch, SetStateAction } from 'react';
import {
  FolderOpen,
  GitBranch,
  KeyRound,
  MoreHorizontal,
  PanelRight,
  ShieldCheck,
  Terminal,
} from 'lucide-react';
import type { AppConfig, ThreadSummary, WorktreeInfo } from '../types';
import { ThreadActions } from './ThreadActions';

export function Topbar({
  activeCwd,
  pickFolder,
  currentThread,
  projectName,
  worktree,
  worktreeBusy,
  running,
  applyWorktreeChanges,
  removeWorktreeSession,
  cwd,
  headerMenuOpen,
  setHeaderMenuOpen,
  threadId,
  showArchived,
  lastTurnId,
  pinnedSectionId,
  togglePinThread,
  setRenameTarget,
  setRenameInput,
  compactThread,
  revertLastTurn,
  forkThread,
  archiveThread,
  unarchiveThread,
  deleteThread,
  config,
  setKeyDialog,
  terminalOpen,
  setTerminalOpen,
  reviewBusy,
  status,
  setReviewDialogOpen,
  railOpen,
  setRailOpen,
  reviewCount,
}: {
  activeCwd: string;
  pickFolder: () => void;
  currentThread?: ThreadSummary | null;
  projectName: string;
  worktree: WorktreeInfo | null;
  worktreeBusy: boolean;
  running: boolean;
  applyWorktreeChanges: () => void;
  removeWorktreeSession: () => void;
  cwd: string;
  headerMenuOpen: boolean;
  setHeaderMenuOpen: Dispatch<SetStateAction<boolean>>;
  threadId: string | null;
  showArchived: boolean;
  lastTurnId: string | null;
  pinnedSectionId: string | null;
  togglePinThread: (thread: ThreadSummary) => void;
  setRenameTarget: Dispatch<SetStateAction<ThreadSummary | null>>;
  setRenameInput: Dispatch<SetStateAction<string>>;
  compactThread: () => void;
  revertLastTurn: () => void;
  forkThread: (thread: ThreadSummary) => void;
  archiveThread: (thread: ThreadSummary) => void;
  unarchiveThread: (thread: ThreadSummary) => void;
  deleteThread: (thread: ThreadSummary) => void;
  config: AppConfig | null;
  setKeyDialog: Dispatch<SetStateAction<boolean>>;
  terminalOpen: boolean;
  setTerminalOpen: Dispatch<SetStateAction<boolean>>;
  reviewBusy: boolean;
  status: string;
  setReviewDialogOpen: Dispatch<SetStateAction<boolean>>;
  railOpen: boolean;
  setRailOpen: Dispatch<SetStateAction<boolean>>;
  reviewCount: number;
}) {
  return (
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
  );
}
