import type { Dispatch, SetStateAction } from 'react';
import {
  Boxes,
  Check,
  Clock,
  FolderOpen,
  FolderPlus,
  Layers,
  Search,
  Settings as SettingsIcon,
  SquarePen,
} from 'lucide-react';
import type {
  AppConfig,
  Automation,
  ProjectInfo,
  SettingsTab,
  ThreadReadState,
  ThreadSearchResult,
  ThreadSummary,
} from '../types';
import { cleanSnippet, timeAgo } from '../lib/format';
import { ThreadActions } from './ThreadActions';

type ThreadGroup = { label: string; items: ThreadSummary[]; sectionId?: string };

export function Sidebar({
  config,
  automations,
  projects,
  projectId,
  projectMenuId,
  setProjectMenuId,
  setProjectRenameTarget,
  setProjectRenameInput,
  addProject,
  removeProject,
  removeSection,
  selectProject,
  newSession,
  openCapabilities,
  openSettings,
  setSearchOpen,
  setAutomationOpen,
  setCapabilitiesOpen,
  setRailOpen,
  threadQuery,
  setThreadQuery,
  searchOpen,
  searchResults,
  searchBusy,
  openSearchResult,
  threadHeadingMenu,
  setThreadHeadingMenu,
  toggleArchived,
  refreshThreads,
  showArchived,
  threadGroups,
  readStates,
  threadId,
  resumeThread,
  menuThreadId,
  setMenuThreadId,
  sectionMenuId,
  setSectionMenuId,
  setMoveThreadId,
  moveThreadId,
  pinnedSectionId,
  sections,
  lastTurnId,
  running,
  setRenameTarget,
  setRenameInput,
  setSectionDialog,
  togglePinThread,
  moveThreadToSection,
  compactThread,
  revertLastTurn,
  forkThread,
  archiveThread,
  unarchiveThread,
  markThreadUnread,
  deleteThread,
  threadCursor,
  threadLoadingMore,
  loadMoreThreads,
  accountMenuOpen,
  setAccountMenuOpen,
}: {
  config: AppConfig | null;
  automations: Automation[];
  projects: ProjectInfo[];
  projectId: string | null;
  projectMenuId: string | null;
  setProjectMenuId: Dispatch<SetStateAction<string | null>>;
  setProjectRenameTarget: Dispatch<SetStateAction<ProjectInfo | null>>;
  setProjectRenameInput: Dispatch<SetStateAction<string>>;
  addProject: () => void;
  removeProject: (project: ProjectInfo) => void;
  removeSection: (section: { id: string; name: string }) => void;
  selectProject: (project: ProjectInfo | null) => void;
  newSession: () => void;
  openCapabilities: () => void;
  openSettings: (tab?: SettingsTab) => void;
  setSearchOpen: Dispatch<SetStateAction<boolean>>;
  setAutomationOpen: Dispatch<SetStateAction<boolean>>;
  setCapabilitiesOpen: Dispatch<SetStateAction<boolean>>;
  setRailOpen: Dispatch<SetStateAction<boolean>>;
  threadQuery: string;
  setThreadQuery: Dispatch<SetStateAction<string>>;
  searchOpen: boolean;
  searchResults: ThreadSearchResult[];
  searchBusy: boolean;
  openSearchResult: (result: ThreadSearchResult) => void;
  threadHeadingMenu: boolean;
  setThreadHeadingMenu: Dispatch<SetStateAction<boolean>>;
  toggleArchived: () => void;
  refreshThreads: (announce?: boolean) => void;
  showArchived: boolean;
  threadGroups: ThreadGroup[];
  readStates: Record<string, ThreadReadState>;
  threadId: string | null;
  resumeThread: (thread: ThreadSummary) => void;
  menuThreadId: string | null;
  setMenuThreadId: Dispatch<SetStateAction<string | null>>;
  sectionMenuId: string | null;
  setSectionMenuId: Dispatch<SetStateAction<string | null>>;
  setMoveThreadId: Dispatch<SetStateAction<string | null>>;
  moveThreadId: string | null;
  pinnedSectionId: string | null;
  sections: { id: string; name: string }[];
  lastTurnId: string | null;
  running: boolean;
  setRenameTarget: Dispatch<SetStateAction<ThreadSummary | null>>;
  setRenameInput: Dispatch<SetStateAction<string>>;
  setSectionDialog: Dispatch<
    SetStateAction<{ mode: 'create' | 'rename'; id?: string; name: string } | null>
  >;
  togglePinThread: (thread: ThreadSummary) => void;
  moveThreadToSection: (thread: ThreadSummary, sectionId: string | null) => void;
  compactThread: () => void;
  revertLastTurn: () => void;
  forkThread: (thread: ThreadSummary) => void;
  archiveThread: (thread: ThreadSummary) => void;
  unarchiveThread: (thread: ThreadSummary) => void;
  markThreadUnread: (thread: ThreadSummary) => void;
  deleteThread: (thread: ThreadSummary) => void;
  threadCursor: string | null;
  threadLoadingMore: boolean;
  loadMoreThreads: () => void;
  accountMenuOpen: boolean;
  setAccountMenuOpen: Dispatch<SetStateAction<boolean>>;
}) {
  return (
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
            aria-label="搜索会话"
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
                    void refreshThreads(true);
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
                        aria-label="会话操作"
                        aria-haspopup="menu"
                        aria-expanded={menuThreadId === thread.id}
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
              aria-haspopup="menu"
              aria-expanded={accountMenuOpen}
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
  );
}
