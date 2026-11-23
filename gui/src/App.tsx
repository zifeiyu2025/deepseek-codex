import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
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
  Users,
  X,
} from 'lucide-react';
import { BrowserPanel, FilesPanel } from './Workspace';
import { ReviewPanel } from './ReviewPanel';
import { ApprovalPanel } from './components/ApprovalPanel';
import { AutomationsPage } from './components/AutomationsPage';
import { Composer } from './components/Composer';
import { Hero } from './components/Hero';
import { Sidebar } from './components/Sidebar';
import { ActivityStep, MessageItem } from './components/Messages';
import { Modal } from './components/Modal';
import { ThreadActions } from './components/ThreadActions';
import { Topbar } from './components/Topbar';
import { ReviewDialog } from './components/ReviewDialog';
import { UserInputPanel } from './components/UserInputPanel';
import { useDismissOnOutside } from './hooks/useDismissOnOutside';
import { SettingsPanel } from './SettingsPanel';
import { TerminalDock } from './TerminalDock';
import { playCompletionChime } from './lib/audio';
import { friendlyClientError } from './lib/errors';
import {
  buildRelayTurnText,
  parseAgentMentionPrefix,
  uniqueRelayTargets,
} from './lib/mentions';
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
  sandboxSelection,
  splitReviewComments,
  textOfContent,
  timeAgo,
  turnSandboxSelection,
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
  MentionState,
  ModelInfo,
  PendingUserInput,
  ProjectInfo,
  ReviewTarget,
  RuntimeSettings,
  SettingsTab,
  SlashCommandId,
  ThreadGoal,
  ThreadSearchResult,
  ThreadSummary,
  ThreadReadState,
  WorktreeInfo,
} from './types';

type RailTab = 'files' | 'browser' | 'review';

type McpElicitationState = {
  id: number | string;
  serverName?: string;
  message: string;
  computerApp?: {
    appId: string;
    displayName: string;
    process: string;
    title: string;
    path?: string;
    tool?: string;
  };
};

type ComputerPermissionChoice = 'once' | 'session' | 'always';

const DEFAULT_SETTINGS: RuntimeSettings = {
  approvalPolicy: 'on-request',
  approvalsReviewer: 'user',
  sandbox: 'danger-full-access',
  networkAccess: false,
  permissionProfile: null,
  effort: 'high',
};

const GOAL_STATUS_LABELS: Record<string, string> = {
  active: '进行中',
  paused: '已暂停',
  blocked: '受阻',
  usageLimited: '用量受限',
  budgetLimited: '预算受限',
  complete: '已完成',
};

function subagentStatusLabel(status: unknown) {
  if (typeof status === 'string') {
    const labels: Record<string, string> = {
      running: '运行中',
      active: '运行中',
      completed: '已完成',
      waiting: '等待',
      failed: '失败',
    };
    return labels[status.toLowerCase()] || status;
  }
  if (status && typeof status === 'object') {
    const value = status as Record<string, any>;
    if (value.active) {
      return value.active.activeFlags?.length ? '等待审批/输入' : '运行中';
    }
    if (value.idle !== undefined) return '空闲';
    if (value.notLoaded !== undefined) return '未加载';
    if (value.systemError !== undefined) return '错误';
  }
  return '未知';
}

function isRunningSubagent(status: unknown) {
  if (typeof status === 'string') return /running|active/i.test(status);
  return Boolean(status && typeof status === 'object' && 'active' in status);
}

function agentDisplayName(agent: ThreadSummary) {
  return (
    agent.agentNickname ||
    agent.name ||
    String(agent.preview || '')
      .split('/')
      .filter(Boolean)
      .pop() ||
    agent.id.slice(0, 8)
  );
}

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

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [status, setStatus] = useState<'connecting' | 'ready' | 'offline'>('connecting');
  const [engineError, setEngineError] = useState<string | null>(null);
  const [model, setModel] = useState('deepseek-flash');
  const [cwd, setCwd] = useState('');
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [subagentPanelOpen, setSubagentPanelOpen] = useState(false);
  const [subagentParentId, setSubagentParentId] = useState<string | null>(null);
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
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
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
  const [mcpElicitation, setMcpElicitation] = useState<McpElicitationState | null>(null);
  const [mcpElicitationBusy, setMcpElicitationBusy] = useState(false);
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
  const [fileFocus, setFileFocus] = useState<{ path: string; nonce: number } | null>(null);
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
  const [ocrAttachments, setOcrAttachments] = useState<
    { path: string; name: string; pageCount: number; text: string; truncated: boolean }[]
  >([]);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [dragging, setDragging] = useState(false);
  const [mention, setMention] = useState<MentionState | null>(null);
  const [goal, setGoal] = useState<ThreadGoal | null>(null);
  const [goalDialogOpen, setGoalDialogOpen] = useState(false);
  const [goalObjective, setGoalObjective] = useState('');
  const [goalBudgetInput, setGoalBudgetInput] = useState('');
  const [goalBusy, setGoalBusy] = useState(false);
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
  const goalRequestRef = useRef(0);
  const subagentsRef = useRef<ThreadSummary[]>([]);
  const mcpSessionAllowedRef = useRef(new Set<string>());
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

  const openFileInRail = useCallback(
    (filePath: string) => {
      const normalized = filePath.replace(/\\/g, '/');
      const root = activeCwd.replace(/\\/g, '/').replace(/\/+$/, '');
      const isAbsolute = /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith('/');
      const insideRoot =
        !isAbsolute ||
        (root &&
          (normalized.toLowerCase() === root.toLowerCase() ||
            normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)));
      if (!insideRoot) {
        setNotice('该文件不在当前项目，已在资源管理器中定位');
        void window.codex.showInFolder(filePath);
        return;
      }
      setRailTab('files');
      setRailOpen(true);
      setFileFocus({ path: filePath, nonce: Date.now() });
    },
    [activeCwd],
  );

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
    const agentResults = subagentsRef.current
      .filter((agent) => isRunningSubagent(agent.status))
      .filter(
        (agent) =>
          !query || agentDisplayName(agent).toLowerCase().includes(query.toLowerCase()),
      )
      .slice(0, 6)
      .map((agent) => ({
        kind: 'agent' as const,
        path: agent.id,
        fileName: agentDisplayName(agent),
        threadId: agent.id,
        status: agent.status,
        model: agent.model,
      }));
    if (!query || !activeCwd) {
      setMention((current) =>
        current ? { ...current, results: agentResults, index: 0 } : current,
      );
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
          const fileResults = (response?.files || [])
            .filter((entry: any) => (entry.match_type ?? entry.matchType) !== 'directory')
            .filter((entry: any) => !ignored.test(entry.path))
            .slice(0, Math.max(0, 12 - agentResults.length))
            .map((entry: any) => ({
              path: entry.path,
              fileName: entry.file_name ?? entry.fileName ?? entry.path,
            }));
          setMention((current) =>
            current
              ? { ...current, results: [...agentResults, ...fileResults], index: 0 }
              : current,
          );
        })
        .catch(() => {
          if (seq === mentionSeqRef.current) {
            setMention((current) =>
              current ? { ...current, results: agentResults, index: 0 } : current,
            );
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
    (item: { path: string; fileName?: string; kind?: 'file' | 'agent' }) => {
      if (!mention) return;
      const caret = textareaRef.current?.selectionStart ?? input.length;
      const start = Math.max(0, Math.min(mention.tokenStart, caret));
      const token = item.kind === 'agent' ? item.fileName || item.path : item.path;
      const next = `${input.slice(0, start)}@${token} ${input.slice(caret)}`;
      setInput(next);
      setMention(null);
      requestAnimationFrame(() => {
        const position = start + token.length + 2;
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(position, position);
      });
    },
    [input, mention],
  );

  const ingestPaths = useCallback(async (paths: string[]) => {
    if (!paths.length) return;
    const images: string[] = [];
    const inserted: string[] = [];
    const documents: string[] = [];
    for (const path of paths) {
      if (/\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(path)) {
        images.push(path);
      } else if (/\.(pdf|docx?|pptx?)$/i.test(path)) {
        documents.push(path);
      } else {
        let reference = path;
        const cwd = (worktreeRef.current?.path || cwdRef.current || '').replace(/\\/g, '/');
        const normalized = path.replace(/\\/g, '/');
        if (cwd && normalized.toLowerCase().startsWith(`${cwd.toLowerCase()}/`)) {
          reference = normalized.slice(cwd.length + 1);
        }
        inserted.push(`@${reference}`);
      }
    }
    if (images.length) {
      setAttachments((previous) => [...new Set([...previous, ...images])]);
    }
    if (documents.length) {
      let ocrEnabled = false;
      try {
        ocrEnabled = Boolean((await window.codex.localToolsStatus()).ocr);
      } catch {
        ocrEnabled = false;
      }
      if (!ocrEnabled) {
        inserted.push(
          ...documents.map((path) => {
            const cwd = (worktreeRef.current?.path || cwdRef.current || '').replace(/\\/g, '/');
            const normalized = path.replace(/\\/g, '/');
            const reference =
              cwd && normalized.toLowerCase().startsWith(`${cwd.toLowerCase()}/`)
                ? normalized.slice(cwd.length + 1)
                : path;
            return `@${reference}`;
          }),
        );
      } else {
        setOcrBusy(true);
        for (const path of documents) {
          try {
            const result = await window.codex.ocrFile({ path, purpose: 'text_recognition' });
            setOcrAttachments((previous) => [
              ...previous,
              {
                path,
                name: result.name,
                pageCount: result.pageCount,
                text: result.text,
                truncated: result.truncated,
              },
            ]);
            if (result.truncated) {
              setNotice(`${result.name} 的 OCR 文本过长，已截断到 120,000 字符`);
            }
          } catch (error: any) {
            setError(friendlyClientError(error));
            inserted.push(`@${path}`);
          }
        }
        setOcrBusy(false);
      }
    }
    if (inserted.length) {
      setInput((previous) => {
        const prefix = previous && !previous.endsWith('\n') ? `${previous}\n` : previous;
        return `${prefix}${inserted.join('\n')}`;
      });
    }
  }, []);

  const addDroppedFiles = useCallback(
    (files: File[]) => {
      const paths: string[] = [];
      for (const file of files) {
        try {
          const filePath = window.codex.pathForFile(file);
          if (filePath) paths.push(filePath);
        } catch {
          /* ignore unsupported drops */
        }
      }
      void ingestPaths(paths);
    },
    [ingestPaths],
  );

  const refreshThreads = useCallback(async (announce = false) => {
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
    } catch (error) {
      if (announce) setError(friendlyClientError(error));
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
          threadSource: 'user',
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
        case 'thread/goal/updated':
          if (!params.threadId || params.threadId === threadRef.current) {
            setGoal(params.goal ?? null);
          }
          break;
        case 'thread/goal/cleared':
          if (!params.threadId || params.threadId === threadRef.current) {
            setGoal(null);
          }
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
      if (request.method === 'mcpServer/elicitation/request') {
        const serverName = request.params?.serverName;
        const elicitation = request.params?.request;
        const meta = elicitation?._meta || request.params?._meta;
        const computerApp = meta?.shanuiComputerApp;
        if (
          serverName &&
          serverName !== 'shanui_local' &&
          mcpSessionAllowedRef.current.has(serverName)
        ) {
          window.codex.respond(request.id, { action: 'accept', content: null, _meta: null });
          return;
        }
        setMcpElicitation({
          id: request.id,
          serverName,
          message:
            request.params?.message ||
            elicitation?.message ||
            '允许这次 MCP 工具调用？',
          computerApp:
            typeof computerApp?.appId === 'string' && computerApp.appId.trim()
              ? {
                  appId: computerApp.appId,
                  displayName: computerApp.displayName || computerApp.process || '当前应用',
                  process: computerApp.process || '',
                  title: computerApp.title || '',
                  path: computerApp.path || '',
                  tool: computerApp.tool || '',
                }
              : undefined,
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

  const respondMcpElicitation = useCallback(
    async (
      action: 'accept' | 'decline' | 'cancel',
      decision?: ComputerPermissionChoice,
      remember = false,
    ) => {
      if (!mcpElicitation || mcpElicitationBusy) return;
      let content: Record<string, string> | null = null;
      if (action === 'accept' && mcpElicitation.computerApp) {
        const choice = decision || 'once';
        content = { decision: choice };
        if (choice === 'always') {
          setMcpElicitationBusy(true);
          try {
            await window.codex.allowComputerApp(mcpElicitation.computerApp.appId);
          } catch (error) {
            setError(friendlyClientError(error));
            setMcpElicitationBusy(false);
            return;
          }
        }
      } else if (remember && mcpElicitation.serverName) {
        mcpSessionAllowedRef.current.add(mcpElicitation.serverName);
      }
      setMcpElicitationBusy(false);
      setMcpElicitation(null);
      window.codex.respond(mcpElicitation.id, { action, content, _meta: null });
    },
    [mcpElicitation, mcpElicitationBusy],
  );

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

  const togglePlanMode = useCallback(() => {
    setMode((previous) => {
      const next = previous === 'plan' ? 'default' : 'plan';
      modeRef.current = next;
      return next;
    });
  }, []);

  const refreshGoal = useCallback(async (id: string | null) => {
    const seq = ++goalRequestRef.current;
    if (!id) {
      setGoal(null);
      return;
    }
    try {
      const result = await window.codex.request('thread/goal/get', { threadId: id });
      if (seq === goalRequestRef.current) setGoal(result?.goal ?? null);
    } catch {
      if (seq === goalRequestRef.current) setGoal(null);
    }
  }, []);

  useEffect(() => {
    void refreshGoal(threadId);
  }, [threadId, refreshGoal]);

  const openGoalDialog = useCallback(
    (objective?: string) => {
      setGoalObjective(objective?.trim() || goal?.objective || '');
      setGoalBudgetInput(goal?.tokenBudget ? String(goal.tokenBudget) : '');
      setGoalDialogOpen(true);
    },
    [goal],
  );

  const saveGoal = useCallback(async () => {
    const objective = goalObjective.trim();
    if (!objective) return;
    setGoalBusy(true);
    setError(null);
    try {
      let id = threadRef.current;
      if (!id) {
        const created = await window.codex.request('thread/start', {
          cwd: worktreeRef.current?.path || cwdRef.current,
          model: modelRef.current,
          modelProvider: config?.defaultProvider || 'deepseek',
          threadSource: 'user',
          approvalPolicy: settingsRef.current.approvalPolicy,
          approvalsReviewer: settingsRef.current.approvalsReviewer,
          ...sandboxSelection(settingsRef.current),
          projectId: projectIdRef.current || undefined,
        });
        id = created?.thread?.id;
        if (!id) throw new Error('创建会话失败');
        setThreadId(id);
        threadRef.current = id;
        refreshThreads();
      }
      const result = await window.codex.request('thread/goal/set', {
        threadId: id,
        objective,
        status: 'active',
        origin: 'user',
        ...(Number(goalBudgetInput) > 0
          ? { tokenBudget: Math.floor(Number(goalBudgetInput)) }
          : goal
            ? { tokenBudget: null }
            : {}),
      });
      goalRequestRef.current += 1;
      setGoal(result?.goal ?? null);
      setGoalDialogOpen(false);
      setNotice('目标已设置，Codex 会在空闲时继续推进');
    } catch (goalError: any) {
      setError(friendlyClientError(goalError));
    } finally {
      setGoalBusy(false);
    }
  }, [config, goal, goalBudgetInput, goalObjective, refreshThreads]);

  const toggleGoalStatus = useCallback(async () => {
    const id = threadRef.current;
    if (!id || !goal) return;
    setGoalBusy(true);
    try {
      const result = await window.codex.request('thread/goal/set', {
        threadId: id,
        status: goal.status === 'paused' ? 'active' : 'paused',
        origin: 'user',
      });
      goalRequestRef.current += 1;
      setGoal(result?.goal ?? null);
    } catch (goalError: any) {
      setError(friendlyClientError(goalError));
    } finally {
      setGoalBusy(false);
    }
  }, [goal]);

  const clearGoal = useCallback(async () => {
    const id = threadRef.current;
    if (!id || !goal) return;
    setGoalBusy(true);
    try {
      await window.codex.request('thread/goal/clear', { threadId: id, origin: 'user' });
      goalRequestRef.current += 1;
      setGoal(null);
      setGoalDialogOpen(false);
      setNotice('目标已清除');
    } catch (goalError: any) {
      setError(friendlyClientError(goalError));
    } finally {
      setGoalBusy(false);
    }
  }, [goal]);

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
    setOcrAttachments([]);
    mcpSessionAllowedRef.current.clear();
    setSubagentParentId(null);
    setGoal(null);
    setGoalDialogOpen(false);
    setGoalObjective('');
    setGoalBudgetInput('');
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
    return window.codex.onBrowserOpen(() => {
      setRailTab('browser');
      setRailOpen(true);
    });
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

  const resumeThread = useCallback(async (thread: ThreadSummary, record = true, parentId: string | null = null) => {
    setSubagentParentId(parentId);
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
    await ingestPaths(paths);
  }, [ingestPaths]);

  const pickImages = useCallback(async () => {
    const paths = await window.codex.pickImages();
    if (!paths.length) return;
    setAttachments((previous) => [...new Set([...previous, ...paths])]);
  }, []);

  const captureScreen = useCallback(async () => {
    try {
      const path = await window.codex.captureScreen();
      if (path) {
        setAttachments((previous) => [...new Set([...previous, path])]);
        setNotice('已附加屏幕截图');
      }
    } catch (error: any) {
      setError(friendlyClientError(error));
    }
  }, []);

  useEffect(() => {
    const attach = (event: Event) => {
      const detail = (event as CustomEvent<{ path?: string; text?: string }>).detail;
      const path = detail?.path;
      if (!path) return;
      setAttachments((previous) => [...new Set([...previous, path])]);
      if (detail?.text) {
        setInput((previous) => (previous ? `${previous}\n${detail.text}` : detail.text || ''));
      }
      setNotice('已附加页面截图');
    };
    window.addEventListener('deepseek-codex:attach-image', attach);
    return () => window.removeEventListener('deepseek-codex:attach-image', attach);
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

  const updateHook = useCallback(
    async (hook: any, patch: { enabled?: boolean; trust?: boolean }) => {
      setCapabilityBusy(true);
      try {
        const basePath = `hooks.state.${JSON.stringify(hook.key)}`;
        const edits: { keyPath: string; value: unknown; mergeStrategy: 'replace' }[] = [];
        if (patch.enabled !== undefined) {
          edits.push({
            keyPath: `${basePath}.enabled`,
            value: patch.enabled,
            mergeStrategy: 'replace',
          });
        }
        if (patch.trust) {
          const hash = hook.currentHash || hook.current_hash;
          if (!hash) throw new Error('该 Hook 没有可信任的哈希');
          edits.push({
            keyPath: `${basePath}.trusted_hash`,
            value: hash,
            mergeStrategy: 'replace',
          });
        }
        if (!edits.length) return;
        await window.codex.request('config/batchWrite', {
          edits,
          reloadUserConfig: true,
        });
        await openCapabilities();
        setNotice('Hook 设置已更新');
      } catch (hookError: any) {
        setError(friendlyClientError(hookError));
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

  const pinThreadToSidebar = useCallback(
    async (thread: ThreadSummary) => {
      try {
        let sectionId = pinnedSectionId;
        if (!sectionId) {
          const created = await window.codex.request('threadSection/create', { name: 'Pinned' });
          sectionId = created?.section?.id || null;
          if (!sectionId) throw new Error('创建置顶分区失败');
          await refreshSections();
        }
        await window.codex.request('thread/section/move', {
          threadId: thread.id,
          sectionId,
        });
        refreshThreads();
        setNotice('已置顶会话');
      } catch (pinError: any) {
        setError(friendlyClientError(pinError));
      }
    },
    [pinnedSectionId, refreshSections, refreshThreads],
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
            threadSource: 'user',
            approvalPolicy: settingsRef.current.approvalPolicy,
            approvalsReviewer: settingsRef.current.approvalsReviewer,
            ...sandboxSelection(settingsRef.current),
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
      ...ocrAttachments.map((doc) => ({
        type: 'text',
        text: `文件：${doc.name}（${doc.pageCount} 页${doc.truncated ? '，已截断' : ''}）\n${doc.text}`,
        text_elements: [],
      })),
      ...files.map((path) => ({ type: 'localImage', path })),
    ],
    [attachments, ocrAttachments],
  );

  const send = useCallback(async (overrideText?: string) => {
    const text = (typeof overrideText === 'string' ? overrideText : input).trim();
    if (!text || !config || preparing) return;
    if (ocrBusy) {
      setError('文档仍在识别中，请稍后发送');
      return;
    }
    setError(null);

    let relayNames: string[] = [];
    let turnText = text;
    if (!runningRef.current) {
      const agentMention = parseAgentMentionPrefix(text);
      const resolved = (agentMention?.names || []).map((name) =>
        subagentsRef.current.find(
          (agent) =>
            isRunningSubagent(agent.status) &&
            agentDisplayName(agent).toLowerCase() === name.toLowerCase(),
        ),
      );
      if (agentMention && resolved.length && resolved.every(Boolean)) {
        if (subagentParentId) {
          setError('请先返回主会话，再 @ 子代理发送指令');
          return;
        }
        const targets = uniqueRelayTargets(
          resolved
            .filter((agent): agent is ThreadSummary => Boolean(agent))
            .map((agent) => ({ id: agent.id, name: agentDisplayName(agent) })),
        );
        relayNames = targets.map((target) => target.name);
        turnText = buildRelayTurnText(targets, agentMention.message);
      }
    }

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
        setOcrAttachments([]);
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
          threadSource: 'user',
          approvalPolicy: activeSettings.approvalPolicy,
          approvalsReviewer: activeSettings.approvalsReviewer,
          ...sandboxSelection(activeSettings),
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
        ...turnSandboxSelection(activeSettings),
        input: buildTurnInput(turnText, files),
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
      setOcrAttachments([]);
      if (relayNames.length) setNotice(`已请求主代理转发给子代理 ${relayNames.join('、')}`);
    } catch (sendError) {
      setRunning(false);
      pendingUserRef.current = null;
      delete itemTimesRef.current[localId];
      setItems((list) => list.filter((item) => item.id !== localId));
      setInput((previous) => previous || text);
      setError(friendlyClientError(sendError));
    }
  }, [attachments, buildTurnInput, config, input, ocrBusy, preparing, refreshThreads, resumeThread, subagentParentId, worktreeMode]);

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

  const openSubagent = useCallback(
    async (agent: ThreadSummary) => {
      setSubagentPanelOpen(false);
      await resumeThread(agent, true, agent.parentThreadId || threadRef.current || null);
    },
    [resumeThread],
  );

  const subagents = useMemo<ThreadSummary[]>(() => {
    const map = new Map<string, ThreadSummary>();
    for (const item of items) {
      if (item.type === 'collabAgentToolCall') {
        const states = item.agentStates || item.agents_states || {};
        const ids = new Set<string>([
          ...(item.receiverThreadIds || item.receiver_thread_ids || []),
          ...Object.keys(states),
        ]);
        for (const id of ids) {
          if (!id) continue;
          const entry: ThreadSummary =
            map.get(id) || {
              id,
              preview: String(item.prompt || id).slice(0, 100),
              parentThreadId: threadId,
            };
          const state = states[id];
          const status =
            typeof state === 'string'
              ? state
              : state?.status || state?.type || entry.status;
          map.set(id, { ...entry, status });
        }
      }
      if (item.type === 'subAgentActivity') {
        const id = item.agentThreadId || item.agent_thread_id;
        if (!id) continue;
        const kind = String(item.kind || '').toLowerCase();
        const existing: ThreadSummary =
          map.get(id) || {
            id,
            preview: String(item.agentPath || id),
            parentThreadId: threadId,
          };
        map.set(id, {
          ...existing,
          preview: String(item.agentPath || existing.preview),
          agentNickname: item.agentPath
            ? String(item.agentPath).split('/').filter(Boolean).pop()
            : existing.agentNickname,
          model: item.model || existing.model,
          status:
            kind === 'completed'
              ? 'completed'
              : kind === 'started'
                ? 'running'
                : kind === 'interacted'
                  ? existing.status === 'completed'
                    ? 'completed'
                    : 'running'
                  : existing.status,
        });
      }
    }
    return [...map.values()];
  }, [items, threadId]);

  useEffect(() => {
    subagentsRef.current = subagents;
  }, [subagents]);

  const stopAllSubagents = useCallback(async () => {
    const running = subagents.filter((agent) => isRunningSubagent(agent.status));
    if (!running.length) {
      setNotice('没有正在运行的子代理');
      return;
    }
    let stopped = 0;
    await Promise.allSettled(
      running.map(async (agent) => {
        let turns: any[] = [];
        try {
          const page = await window.codex.request('thread/turns/list', {
            threadId: agent.id,
            limit: 20,
            sortDirection: 'desc',
            itemsView: 'summary',
          });
          turns = page?.data || [];
        } catch {
          try {
            const read = await window.codex.request('thread/read', {
              threadId: agent.id,
              includeTurns: true,
            });
            turns = read?.thread?.turns || [];
          } catch {
            turns = [];
          }
        }
        const activeTurn = turns.find(
          (turn: any) =>
            turn.status === 'inProgress' || turn.status === 'in_progress',
        );
        if (!activeTurn?.id) return;
        await window.codex.request('turn/interrupt', {
          threadId: agent.id,
          turnId: activeTurn.id,
        });
        stopped += 1;
      }),
    );
    setNotice(stopped > 0 ? `已停止 ${stopped} 个子代理` : '没有可中断的子代理');
  }, [subagents]);

  const runSlashCommand = useCallback(
    (id: SlashCommandId, argument?: string) => {
      const activeThread =
        threads.find((thread) => thread.id === threadRef.current) ||
        (threadRef.current
          ? ({ id: threadRef.current, preview: '' } as ThreadSummary)
          : null);
      switch (id) {
        case 'plan':
          togglePlanMode();
          break;
        case 'goal':
          openGoalDialog(argument);
          break;
        case 'new':
          newSession();
          break;
        case 'chat':
          if (projectIdRef.current) selectProject(null);
          else newSession();
          break;
        case 'project':
          setProjectPickerOpen(true);
          break;
        case 'plan-skill':
          if (modeRef.current !== 'plan') togglePlanMode();
          setNotice('已启用计划模式');
          break;
        case 'model':
        case 'reasoning':
          setModelMenuOpen(true);
          break;
        case 'compact':
          void compactThread();
          break;
        case 'worktree':
          toggleWorktree();
          break;
        case 'mcp':
          void openCapabilities();
          break;
        case 'fork':
          if (activeThread) void forkThread(activeThread);
          else setError('当前会话尚未就绪，暂时不能分支');
          break;
        case 'archive':
          if (activeThread) void archiveThread(activeThread);
          else setError('当前会话尚未就绪，暂时不能归档');
          break;
        case 'rename':
          if (activeThread) {
            setRenameTarget(activeThread);
            setRenameInput(activeThread.name || activeThread.preview || '');
          } else {
            setError('当前会话尚未就绪，暂时不能重命名');
          }
          break;
        case 'pin':
          if (activeThread) void pinThreadToSidebar(activeThread);
          else setError('当前会话尚未就绪，暂时不能置顶');
          break;
        case 'delete':
          if (activeThread) void deleteThread(activeThread);
          else setError('当前会话尚未就绪，暂时不能删除');
          break;
        case 'init':
          if (modeRef.current === 'plan') {
            modeRef.current = 'default';
            setMode('default');
          }
          void send(
            '请先检查仓库结构、已有说明和构建方式，然后在仓库根目录创建或更新 AGENTS.md，写明构建、测试、代码风格、目录结构与注意事项；除非必要，不要修改其他文件。',
          );
          break;
        case 'status':
          setNotice(
            threadRef.current
              ? `会话 ${threadRef.current.slice(0, 8)} · ${model} · ${mode === 'plan' ? '计划模式' : '执行模式'}${goal ? ` · 目标${GOAL_STATUS_LABELS[goal.status] || goal.status}` : ''}`
              : '尚未开始会话',
          );
          break;
        case 'agents':
          setSubagentPanelOpen(true);
          break;
        default:
          break;
      }
    },
    [
      archiveThread,
      compactThread,
      deleteThread,
      forkThread,
      goal,
      mode,
      model,
      newSession,
      openCapabilities,
      openGoalDialog,
      pinThreadToSidebar,
      selectProject,
      send,
      threads,
      togglePlanMode,
      toggleWorktree,
    ],
  );

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
        ...turnSandboxSelection(settingsRef.current),
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

  const artifacts = useMemo(() => {
    const seen = new Set<string>();
    const list: { path: string; kind?: string }[] = [];
    for (const item of items) {
      if (item.type === 'fileChange') {
        for (const change of Array.isArray(item.changes) ? item.changes : []) {
          const filePath = change?.path || change?.file;
          if (typeof filePath !== 'string' || !filePath || seen.has(filePath)) continue;
          seen.add(filePath);
          list.push({ path: filePath, kind: change?.kind });
        }
      } else if (item.type === 'imageGeneration') {
        const filePath = item.savedPath || item.path;
        if (typeof filePath !== 'string' || !filePath || seen.has(filePath)) continue;
        seen.add(filePath);
        list.push({ path: filePath, kind: 'image' });
      }
    }
    return list.slice(-12);
  }, [items]);

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
      <Sidebar
        config={config}
        automations={automations}
        projects={projects}
        projectId={projectId}
        projectMenuId={projectMenuId}
        setProjectMenuId={setProjectMenuId}
        setProjectRenameTarget={setProjectRenameTarget}
        setProjectRenameInput={setProjectRenameInput}
        addProject={() => void addProject()}
        removeProject={removeProject}
        removeSection={removeSection}
        selectProject={selectProject}
        newSession={newSession}
        openCapabilities={() => void openCapabilities()}
        openSettings={openSettings}
        setSearchOpen={setSearchOpen}
        setAutomationOpen={setAutomationOpen}
        setCapabilitiesOpen={setCapabilitiesOpen}
        setRailOpen={setRailOpen}
        threadQuery={threadQuery}
        setThreadQuery={setThreadQuery}
        searchOpen={searchOpen}
        searchResults={searchResults}
        searchBusy={searchBusy}
        openSearchResult={openSearchResult}
        threadHeadingMenu={threadHeadingMenu}
        setThreadHeadingMenu={setThreadHeadingMenu}
        toggleArchived={toggleArchived}
        refreshThreads={refreshThreads}
        showArchived={showArchived}
        threadGroups={threadGroups}
        readStates={readStates}
        threadId={threadId}
        resumeThread={resumeThread}
        menuThreadId={menuThreadId}
        setMenuThreadId={setMenuThreadId}
        sectionMenuId={sectionMenuId}
        setSectionMenuId={setSectionMenuId}
        setMoveThreadId={setMoveThreadId}
        moveThreadId={moveThreadId}
        pinnedSectionId={pinnedSectionId}
        sections={sections}
        lastTurnId={lastTurnId}
        running={running}
        setRenameTarget={setRenameTarget}
        setRenameInput={setRenameInput}
        setSectionDialog={setSectionDialog}
        togglePinThread={togglePinThread}
        moveThreadToSection={moveThreadToSection}
        compactThread={compactThread}
        revertLastTurn={revertLastTurn}
        forkThread={forkThread}
        archiveThread={archiveThread}
        unarchiveThread={unarchiveThread}
        markThreadUnread={markThreadUnread}
        deleteThread={deleteThread}
        threadCursor={threadCursor}
        threadLoadingMore={threadLoadingMore}
        loadMoreThreads={loadMoreThreads}
        accountMenuOpen={accountMenuOpen}
        setAccountMenuOpen={setAccountMenuOpen}
      />

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
        <Topbar
          activeCwd={activeCwd}
          pickFolder={pickFolder}
          currentThread={currentThread}
          projectName={projectName}
          worktree={worktree}
          worktreeBusy={worktreeBusy}
          running={running}
          applyWorktreeChanges={applyWorktreeChanges}
          removeWorktreeSession={removeWorktreeSession}
          cwd={cwd}
          headerMenuOpen={headerMenuOpen}
          setHeaderMenuOpen={setHeaderMenuOpen}
          threadId={threadId}
          showArchived={showArchived}
          lastTurnId={lastTurnId}
          pinnedSectionId={pinnedSectionId}
          togglePinThread={togglePinThread}
          setRenameTarget={setRenameTarget}
          setRenameInput={setRenameInput}
          compactThread={compactThread}
          revertLastTurn={revertLastTurn}
          forkThread={forkThread}
          archiveThread={archiveThread}
          unarchiveThread={unarchiveThread}
          deleteThread={deleteThread}
          config={config}
          setKeyDialog={setKeyDialog}
          terminalOpen={terminalOpen}
          setTerminalOpen={setTerminalOpen}
          reviewBusy={reviewBusy}
          status={status}
          setReviewDialogOpen={setReviewDialogOpen}
          railOpen={railOpen}
          setRailOpen={setRailOpen}
          reviewCount={reviewCount}
        />

        {null}

        {subagentParentId ? (
          <div className="subagent-banner">
            <Users size={13} />
            <span>正在查看子代理</span>
            <button
              onClick={() =>
                void resumeThread({ id: subagentParentId, preview: '' }, true, null)
              }
            >
              返回主会话
            </button>
          </div>
        ) : null}

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
                          <ActivityStep
                            key={item.id}
                            item={item}
                            busy={running}
                            onOpenFile={openFileInRail}
                          />
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
                        onOpenFile={openFileInRail}
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

        <Composer
          activeCwd={activeCwd}
          activeModel={activeModel}
          addDroppedFiles={addDroppedFiles}
          applySettings={applySettings}
          attachMenuOpen={attachMenuOpen}
          attachments={attachments}
          autonomyHidden={autonomyHidden}
          goal={goal}
          hasThread={Boolean(threadId)}
          captureScreen={captureScreen}
          dragging={dragging}
          effortOptions={effortOptions}
          input={input}
          insertMention={insertMention}
          itemsCount={items.length}
          mention={mention}
          mode={mode}
          model={model}
          modelListOpen={modelListOpen}
          modelMenuOpen={modelMenuOpen}
          models={models}
          ocrAttachments={ocrAttachments}
          ocrBusy={ocrBusy}
          onKeyDown={onKeyDown}
          onOpenGoal={() => openGoalDialog()}
          onOpenSubagent={openSubagent}
          onStopAllSubagents={() => void stopAllSubagents()}
          onSlashCommand={runSlashCommand}
          openCapabilities={openCapabilities}
          openSettings={openSettings}
          pickFiles={pickFiles}
          pickFolder={pickFolder}
          pickImages={pickImages}
          preparing={preparing}
          projectName={projectName}
          refreshMention={refreshMention}
          running={running}
          send={send}
          setAttachMenuOpen={setAttachMenuOpen}
          setAttachments={setAttachments}
          setAutomationOpen={setAutomationOpen}
          setAutonomyHidden={setAutonomyHidden}
          setDragging={setDragging}
          setInput={setInput}
          setModel={setModel}
          setModelListOpen={setModelListOpen}
          setModelMenuOpen={setModelMenuOpen}
          setMode={setMode}
          setOcrAttachments={setOcrAttachments}
          setRailOpen={setRailOpen}
          setSearchOpen={setSearchOpen}
          settings={settings}
          subagents={subagents}
          textareaRef={textareaRef}
          thumbnails={thumbnails}
          toggleWorktree={toggleWorktree}
          worktreeMode={worktreeMode}
        />

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
                  {tab.id === 'files' && artifacts.length > 0 ? (
                    <span className="rail-badge">{artifacts.length}</span>
                  ) : null}
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
              <FilesPanel
                root={activeCwd}
                focusFile={fileFocus}
                artifacts={artifacts}
                onReference={referenceFile}
              />
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

      {mcpElicitation ? (
        <Modal
          onClose={() => void respondMcpElicitation('cancel')}
          labelledBy="mcp-approval-title"
        >
          <div className={`key-card ${mcpElicitation.computerApp ? 'mcp-permission-card' : ''}`}>
            <div className="key-kicker">
              {mcpElicitation.computerApp ? 'COMPUTER USE' : 'MCP TOOL'}
            </div>
            <h2 id="mcp-approval-title">
              {mcpElicitation.computerApp
                ? `允许控制 ${mcpElicitation.computerApp.displayName}？`
                : mcpElicitation.serverName
                  ? `允许 ${mcpElicitation.serverName} 执行操作？`
                  : '允许这次操作？'}
            </h2>
            <p>{mcpElicitation.message}</p>
            {mcpElicitation.computerApp ? (
              <div className="mcp-app-meta">
                <strong>{mcpElicitation.computerApp.title || mcpElicitation.computerApp.displayName}</strong>
                <span>
                  {mcpElicitation.computerApp.path || mcpElicitation.computerApp.appId}
                </span>
                {mcpElicitation.computerApp.tool ? (
                  <span>{mcpElicitation.computerApp.tool}</span>
                ) : null}
              </div>
            ) : null}
            {mcpElicitation.computerApp ? (
              <div className="key-actions mcp-permission-actions">
                <button
                  disabled={mcpElicitationBusy}
                  onClick={() => void respondMcpElicitation('decline')}
                >
                  拒绝
                </button>
                <button
                  disabled={mcpElicitationBusy}
                  onClick={() => void respondMcpElicitation('accept', 'once')}
                >
                  允许本次
                </button>
                <button
                  disabled={mcpElicitationBusy}
                  onClick={() => void respondMcpElicitation('accept', 'session')}
                >
                  本次会话允许
                </button>
                <button
                  className="primary"
                  disabled={mcpElicitationBusy}
                  onClick={() => void respondMcpElicitation('accept', 'always')}
                >
                  {mcpElicitationBusy ? '正在保存…' : '始终允许'}
                </button>
              </div>
            ) : (
              <div className="key-actions">
                <button onClick={() => void respondMcpElicitation('decline')}>拒绝</button>
                {mcpElicitation.serverName ? (
                  <button onClick={() => void respondMcpElicitation('accept', undefined, true)}>
                    本次会话允许
                  </button>
                ) : null}
                <button className="primary" onClick={() => void respondMcpElicitation('accept')}>
                  允许
                </button>
              </div>
            )}
          </div>
        </Modal>
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
                    aria-haspopup="menu"
                    aria-expanded={addMenuOpen}
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
                    return hooks.map((hook: any) => {
                      const trust = String(hook.trustStatus || hook.trust_status || 'unknown').toLowerCase();
                      const trustLabel: Record<string, string> = {
                        trusted: '已信任',
                        untrusted: '未信任',
                        modified: '已修改',
                        managed: '托管',
                      };
                      return (
                        <div className="cap-row" key={hook.key}>
                          <div>
                            <strong>
                              <span className={`cap-status-dot ${hook.enabled ? 'ok' : 'off'}`} />
                              {hook.eventName || hook.event_name || 'hook'}
                            </strong>
                            <span>
                              {hook.matcher ? `${hook.matcher} · ` : ''}
                              {trustLabel[trust] || trust} · {hook.sourcePath || hook.source_path || ''}
                            </span>
                          </div>
                          <div className="cap-actions">
                            <button
                              className="cap-btn"
                              disabled={capabilityBusy || hook.isManaged || hook.is_managed}
                              onClick={() => void updateHook(hook, { enabled: !hook.enabled })}
                            >
                              {hook.enabled ? '禁用' : '启用'}
                            </button>
                            {trust !== 'trusted' && trust !== 'managed' && !hook.isManaged && !hook.is_managed ? (
                              <button
                                className="cap-btn"
                                disabled={capabilityBusy}
                                onClick={() => void updateHook(hook, { trust: true })}
                              >
                                信任
                              </button>
                            ) : null}
                            <span className="cap-meta">
                              {hook.timeoutSec ?? hook.timeout_sec ?? '-'}s
                            </span>
                          </div>
                        </div>
                      );
                    });
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

      {subagentPanelOpen ? (
        <Modal onClose={() => setSubagentPanelOpen(false)} labelledBy="subagent-panel-title">
          <div className="key-card subagent-card">
            <div className="key-kicker">
              SUBAGENTS · Active {subagents.filter((agent) => isRunningSubagent(agent.status)).length}
            </div>
            <h2 id="subagent-panel-title">子代理</h2>
            <p>当前会话派生的子代理；打开会切换到对应线程。</p>
            <div className="subagent-list">
              {subagents.length > 0 ? (
                subagents.map((agent) => (
                  <button
                    type="button"
                    className="subagent-row"
                    key={agent.id}
                    onClick={() => void openSubagent(agent)}
                  >
                    <span className="subagent-name">
                      {agent.agentNickname ||
                        agent.name ||
                        agent.preview?.slice(0, 60) ||
                        agent.id.slice(0, 8)}
                    </span>
                    <span className="subagent-state">{subagentStatusLabel(agent.status)}</span>
                    <small>
                      {agent.agentRole || agent.model || ''}
                      {agent.updatedAt ? ` · ${timeAgo(agent.updatedAt)}` : ''}
                    </small>
                  </button>
                ))
              ) : (
                <div className="cap-empty">当前会话没有子代理</div>
              )}
            </div>
            <div className="key-actions">
              <button onClick={() => setSubagentPanelOpen(false)}>关闭</button>
            </div>
          </div>
        </Modal>
      ) : null}

      {projectPickerOpen ? (
        <Modal onClose={() => setProjectPickerOpen(false)} labelledBy="project-picker-title">
          <div className="key-card">
            <div className="key-kicker">PROJECT</div>
            <h2 id="project-picker-title">选择项目</h2>
            <p>之后的新会话会在所选项目中创建。</p>
            <div className="project-picker-list">
              <button
                className={!projectId ? 'active' : ''}
                onClick={() => {
                  selectProject(null);
                  setProjectPickerOpen(false);
                }}
              >
                <FolderOpen size={13} />
                <span>无项目</span>
                {!projectId ? <Check size={12} /> : null}
              </button>
              {projects.map((project) => (
                <button
                  key={project.id}
                  className={projectId === project.id ? 'active' : ''}
                  onClick={() => {
                    selectProject(project);
                    setProjectPickerOpen(false);
                  }}
                >
                  <FolderOpen size={13} />
                  <span>{project.name}</span>
                  <small>{project.roots?.[0]?.path || ''}</small>
                  {projectId === project.id ? <Check size={12} /> : null}
                </button>
              ))}
            </div>
            <div className="key-actions">
              <button
                onClick={() => {
                  setProjectPickerOpen(false);
                  void addProject();
                }}
              >
                添加项目
              </button>
              <button onClick={() => setProjectPickerOpen(false)}>取消</button>
            </div>
          </div>
        </Modal>
      ) : null}

      {goalDialogOpen ? (
        <Modal onClose={() => setGoalDialogOpen(false)} labelledBy="goal-dialog-title">
          <div className="key-card">
            <div className="key-kicker">GOAL</div>
            <h2 id="goal-dialog-title">{goal ? '持续目标' : '设置目标'}</h2>
            <p>Codex 会在会话空闲时继续朝这个目标推进；随时可以暂停或清除。</p>
            <textarea
              className="goal-textarea"
              value={goalObjective}
              onChange={(event) => setGoalObjective(event.target.value)}
              placeholder="描述目标与可衡量的完成条件"
              rows={5}
            />
            <label className="goal-budget">
              <span>Token 预算（留空表示不限）</span>
              <input
                type="number"
                min={0}
                value={goalBudgetInput}
                onChange={(event) => setGoalBudgetInput(event.target.value)}
                placeholder="例如 200000"
              />
            </label>
            {goal ? (
              <div className="goal-meta">
                <span>{GOAL_STATUS_LABELS[goal.status] || goal.status}</span>
                <span>已用 {formatTokens(goal.tokensUsed)} tokens</span>
                {goal.tokenBudget ? <span>预算 {formatTokens(goal.tokenBudget)}</span> : null}
              </div>
            ) : null}
            <div className="key-actions">
              {goal ? (
                <button onClick={() => void toggleGoalStatus()} disabled={goalBusy}>
                  {goal.status === 'paused' ? '继续' : '暂停'}
                </button>
              ) : null}
              {goal ? (
                <button onClick={() => void clearGoal()} disabled={goalBusy}>
                  清除目标
                </button>
              ) : null}
              <button onClick={() => setGoalDialogOpen(false)}>取消</button>
              <button
                className="primary"
                disabled={!goalObjective.trim() || goalBusy}
                onClick={() => void saveGoal()}
              >
                {goalBusy ? '保存中…' : '保存目标'}
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
