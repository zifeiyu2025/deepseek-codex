export type ModelInfo = {
  slug: string;
  display_name: string;
  description?: string;
  context_window?: number | null;
  input_modalities?: string[];
  reasoning_levels?: string[];
};

export type AppConfig = {
  appVersion?: string;
  codexBin: string | null;
  codexHome: string;
  models: ModelInfo[];
  defaultModel: string;
  defaultProvider: string;
  defaultCwd: string;
  online: boolean;
  error: string | null;
  apiKeyConfigured: boolean;
  log: string[];
};

export type Item = {
  id: string;
  type: string;
  [key: string]: any;
};

export type Turn = {
  id: string;
  items: Item[];
  status?: string;
  error?: { message?: string } | null;
};

export type ThreadReadState = {
  firstUnread: { type: string } | null;
  revision: string;
};

export type ThreadSummary = {
  id: string;
  preview: string;
  name?: string | null;
  model?: string | null;
  modelProvider?: string;
  projectId?: string | null;
  section?: { id: string; name: string } | null;
  cwd?: string;
  createdAt?: number;
  updatedAt?: number;
  status?: unknown;
  turns?: Turn[];
};

export type ProjectInfo = {
  id: string;
  name: string;
  roots: { path: string }[];
  metadata?: Record<string, string>;
  createdAt?: number;
  updatedAt?: number;
  recencyAt?: number | null;
};

export type ThreadSearchResult = {
  thread: ThreadSummary;
  snippet: string;
};

export type CollaborationModeInfo = {
  name: string;
  mode: 'default' | 'plan' | string | null;
  model?: string | null;
  reasoning_effort?: string | null;
};

export type Automation = {
  id: string;
  name: string;
  prompt: string;
  projectId: string | null;
  cwd: string;
  intervalMinutes: number;
  enabled: boolean;
  lastRunAt?: number;
  nextRunAt?: number;
  lastStatus?: 'running' | 'ok' | 'error';
  lastThreadId?: string;
  lastError?: string;
  runs?: { at: number; status: 'ok' | 'error'; error?: string }[];
};

export type RpcNotification = {
  method: string;
  params?: any;
};

export type RuntimeSettings = {
  approvalPolicy: 'untrusted' | 'on-request' | 'never';
  approvalsReviewer: 'user' | 'auto_review';
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  networkAccess: boolean;
  effort: 'low' | 'high' | 'max';
};

export type SettingsTab =
  | 'runtime'
  | 'appearance'
  | 'notifications'
  | 'features'
  | 'shortcuts'
  | 'diagnostics'
  | 'about';

export type MentionState = {
  query: string;
  tokenStart: number;
  index: number;
  results: { path: string; fileName: string }[];
};

export type ThreadGoalStatus =
  | 'active'
  | 'paused'
  | 'blocked'
  | 'usageLimited'
  | 'budgetLimited'
  | 'complete';

export type ThreadGoal = {
  threadId: string;
  objective: string;
  status: ThreadGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
};

export type SlashCommandId =
  | 'plan'
  | 'goal'
  | 'new'
  | 'model'
  | 'reasoning'
  | 'compact'
  | 'worktree'
  | 'fork'
  | 'archive'
  | 'rename'
  | 'mcp'
  | 'init'
  | 'status'
  | 'chat'
  | 'delete'
  | 'pin'
  | 'project'
  | 'plan-skill';

export type UserInputOption = {
  label: string;
  description?: string;
};

export type UserInputQuestion = {
  id: string;
  header: string;
  question: string;
  isOther?: boolean;
  isSecret?: boolean;
  options?: UserInputOption[] | null;
};

export type PendingUserInput = {
  id: number | string;
  questions: UserInputQuestion[];
};

export type WorktreeInfo = {
  repoRoot: string;
  path: string;
  branch: string;
};

export type FileEntry = {
  name: string;
  path: string;
  dir: boolean;
  symlink: boolean;
};

export type FileContent = {
  kind: 'text' | 'image' | 'binary';
  text?: string;
  dataUrl?: string;
  truncated?: boolean;
  size: number;
  path: string;
  absolutePath: string;
};

export type TerminalData = {
  id: string;
  data: string;
};

export type TerminalExit = {
  id: string;
  code: number | null;
};

export type ReviewScope = 'unstaged' | 'staged' | 'branch';

export type ReviewFile = {
  path: string;
  status: string;
  diff: string;
  additions: number;
  deletions: number;
  untracked: boolean;
};

export type GitReview = {
  repo: boolean;
  scope: ReviewScope;
  repoRoot?: string;
  branch?: string;
  base?: string;
  files: ReviewFile[];
  additions: number;
  deletions: number;
  error?: string;
};

export type ReviewTarget =
  | { type: 'uncommittedChanges' }
  | { type: 'baseBranch'; branch: string }
  | { type: 'commit'; sha: string; title?: string }
  | { type: 'custom'; instructions: string };

export type ServerRequest = {
  id: number | string;
  method: string;
  params?: any;
};

export type ApprovalRequest = {
  id: number | string;
  kind: 'command' | 'file' | 'permissions';
  threadId?: string;
  turnId?: string;
  itemId?: string;
  approvalId?: string | null;
  command?: string | null;
  cwd?: string | null;
  reason?: string | null;
  grantRoot?: string | null;
  permissions?: any;
};

declare global {
  interface Window {
    desktop: {
      minimize(): Promise<void>;
      toggleMaximize(): Promise<boolean>;
      close(): Promise<void>;
      isMaximized(): Promise<boolean>;
      onMaximized(callback: (maximized: boolean) => void): () => void;
    };
    codex: {
      getConfig(): Promise<AppConfig>;
      rendererReady(): void;
      request(method: string, params?: unknown): Promise<any>;
      respond(id: number | string, result?: unknown, error?: unknown): void;
      setApiKey(key: string): Promise<{ ok: boolean }>;
      apiKeyStatus(): Promise<{ configured: boolean; env: boolean }>;
      pickFolder(): Promise<string | null>;
      pickFiles(): Promise<string[]>;
      pickImages(): Promise<string[]>;
      savePastedImage(): Promise<string | null>;
      pathForFile(file: File): string;
      createWorktree(repoPath: string): Promise<WorktreeInfo>;
      imageDataUrl(filePath: string): Promise<string>;
      showInFolder(targetPath: string): Promise<boolean>;
      openPath(targetPath: string): Promise<string>;
      restartEngine(): Promise<boolean>;
      localToolsStatus(): Promise<{
        browser: boolean;
        computer: boolean;
        search: boolean;
        ocr: boolean;
        searchProvider: 'auto' | 'deepseek' | 'local';
        computerAllowedApps: string[];
        browserOriginPolicy: 'any' | 'allowlist';
        browserAllowedOrigins: string[];
        browserFullCdp: boolean;
      }>;
      setLocalTools(prefs: {
        browser: boolean;
        computer: boolean;
        search: boolean;
        ocr: boolean;
        searchProvider: 'auto' | 'deepseek' | 'local';
        computerAllowedApps: string[];
        browserOriginPolicy: 'any' | 'allowlist';
        browserAllowedOrigins: string[];
        browserFullCdp: boolean;
      }): Promise<{
        browser: boolean;
        computer: boolean;
        search: boolean;
        ocr: boolean;
        searchProvider: 'auto' | 'deepseek' | 'local';
        computerAllowedApps: string[];
        browserOriginPolicy: 'any' | 'allowlist';
        browserAllowedOrigins: string[];
        browserFullCdp: boolean;
      }>;
      ocrFile(payload: {
        path: string;
        purpose?: 'text_recognition' | 'rich_layout_recognition';
      }): Promise<{
        name: string;
        path: string;
        purpose: string;
        pageCount: number;
        usage: { input_tokens?: number; output_tokens?: number; total_tokens?: number } | null;
        text: string;
        truncated: boolean;
      }>;
      browserClearData(payload: {
        cache?: boolean;
        cookies?: boolean;
      }): Promise<boolean>;
      browserActivate(webContentsId: number): Promise<boolean>;
      captureScreen(): Promise<string>;
      browserSavePageShot(dataUrl: string): Promise<string>;
      getComputerHistory(): Promise<
        {
          at: number;
          tool: string;
          args: Record<string, unknown>;
          ok: boolean;
          error?: string;
        }[]
      >;
      clearComputerHistory(): Promise<boolean>;
      gitInfo(targetPath: string): Promise<{
        repo: boolean;
        root?: string;
        branch?: string;
        changed?: number;
      }>;
      listDir(payload: { root: string; path?: string }): Promise<{
        path: string;
        entries: FileEntry[];
      }>;
      readFile(payload: { root: string; path: string }): Promise<FileContent>;
      openExternal(url: string): Promise<boolean>;
      copyText(text: string): Promise<boolean>;
      notify(payload: { title: string; body?: string; sound?: boolean }): Promise<boolean>;
      terminalStart(payload: { cwd: string; cols?: number; rows?: number }): Promise<{
        id: string;
        cwd: string;
      }>;
      terminalInput(payload: { id: string; data: string }): Promise<boolean>;
      terminalResize(payload: { id: string; cols: number; rows: number }): Promise<boolean>;
      terminalStop(id: string): Promise<boolean>;
      onTerminalData(callback: (data: TerminalData) => void): () => void;
      onTerminalExit(callback: (data: TerminalExit) => void): () => void;
      gitReview(payload: { cwd: string; scope: ReviewScope; base?: string }): Promise<GitReview>;
      gitStage(payload: { cwd: string; paths: string[] }): Promise<{ ok: boolean }>;
      gitUnstage(payload: { cwd: string; paths: string[] }): Promise<{ ok: boolean }>;
      gitDiscard(payload: {
        cwd: string;
        paths: string[];
        untracked?: boolean;
      }): Promise<{ ok: boolean }>;
      gitHunk(payload: {
        cwd: string;
        diff: string;
        hunkIndex: number;
        mode: 'stage' | 'unstage' | 'revert';
      }): Promise<{ ok: boolean }>;
      gitCommit(payload: { cwd: string; message: string }): Promise<{ output: string }>;
      gitPush(payload: { cwd: string }): Promise<{ output: string }>;
      applyWorktree(payload: { repoRoot: string; worktreePath: string }): Promise<{
        applied: boolean;
        message?: string;
      }>;
      removeWorktree(payload: {
        repoRoot: string;
        worktreePath: string;
        branch?: string;
      }): Promise<{ removed: boolean }>;
      onNotification(callback: (notification: RpcNotification) => void): () => void;
      onServerRequest(callback: (request: ServerRequest) => void): () => void;
      onStatus(callback: (status: { online: boolean; error?: string | null }) => void): () => void;
      onTrayAction(callback: (action: string) => void): () => void;
      onBrowserOpen(callback: () => void): () => void;
    };
  }
}
