import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ArrowLeft, Loader2, Search } from 'lucide-react';
import type { AppConfig, ModelInfo, RuntimeSettings, SettingsTab } from './types';
import { friendlyClientError } from './lib/errors';
import { effortLabel, formatTokens } from './lib/format';
import { readStorage, removeStorage } from './lib/storage';

export function SettingsPanel({
  settings,
  effortOptions,
  models,
  provider,
  config,
  theme,
  onTheme,
  notifyOnComplete,
  onNotifyOnComplete,
  onOpenKey,
  initialTab,
  onSave,
  onClose,
}: {
  settings: RuntimeSettings;
  effortOptions: string[];
  models: ModelInfo[];
  provider: string;
  config: AppConfig | null;
  theme: 'official' | 'warm';
  onTheme: (theme: 'official' | 'warm') => void;
  notifyOnComplete: boolean;
  onNotifyOnComplete: (value: boolean) => void;
  onOpenKey: () => void;
  initialTab?: SettingsTab;
  onSave: (next: RuntimeSettings) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(settings);
  const [navQuery, setNavQuery] = useState('');
  const [tab, setTab] = useState<SettingsTab>(initialTab ?? 'runtime');
  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab]);
  const [features, setFeatures] = useState<any[]>([]);
  const [featuresLoading, setFeaturesLoading] = useState(false);
  const [featureBusy, setFeatureBusy] = useState<string | null>(null);
  const [engineBusy, setEngineBusy] = useState(false);
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null);
  const [sandboxReadiness, setSandboxReadiness] = useState<string | null>(null);
  const applyDraft = (next: RuntimeSettings) => {
    setDraft(next);
    onSave(next);
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);
  const [sandboxBusy, setSandboxBusy] = useState(false);
  const [sandboxSetupMessage, setSandboxSetupMessage] = useState<string | null>(null);
  const [localTools, setLocalTools] = useState<{
    browser: boolean;
    computer: boolean;
    search: boolean;
    ocr: boolean;
    searchProvider: 'auto' | 'deepseek' | 'local';
    computerAllowedApps: string[];
    browserOriginPolicy: 'any' | 'allowlist';
    browserAllowedOrigins: string[];
    browserFullCdp: boolean;
  } | null>(null);
  const [computerAppsInput, setComputerAppsInput] = useState('');
  const [browserOriginsInput, setBrowserOriginsInput] = useState('');
  const [localToolsBusy, setLocalToolsBusy] = useState(false);
  const [browserHistory, setBrowserHistory] = useState<{ url: string; title: string; at: number }[]>(
    [],
  );
  const [browserBusy, setBrowserBusy] = useState(false);
  const [computerHistory, setComputerHistory] = useState<
    { at: number; tool: string; args: Record<string, unknown>; ok: boolean; error?: string }[]
  >([]);
  const [permissionProfiles, setPermissionProfiles] = useState<
    { id: string; description: string | null; allowed: boolean }[]
  >([]);
  const approvals: { value: RuntimeSettings['approvalPolicy']; title: string; description: string }[] = [
    { value: 'on-request', title: '按需确认', description: '只在需要越权或执行敏感操作时询问' },
    { value: 'untrusted', title: '全部确认', description: '每个命令与修改都需要你确认' },
    { value: 'never', title: '自主执行', description: '不再逐条确认，适合无人值守的长任务' },
  ];
  const sandboxes: { value: RuntimeSettings['sandbox']; title: string; description: string }[] = [
    { value: 'read-only', title: '只读', description: '可以读取和运行命令，但不能修改文件' },
    {
      value: 'workspace-write',
      title: '工作区可写',
      description: '只能修改当前工作区与临时目录，网络由下方开关控制',
    },
    {
      value: 'danger-full-access',
      title: '完全访问',
      description: '不启用沙箱，可修改任意文件；请只在可信目录使用',
    },
  ];

  const loadFeatures = useCallback(async () => {
    setFeaturesLoading(true);
    try {
      const response = await window.codex.request('experimentalFeature/list', { limit: 100 });
      setFeatures(response?.data || []);
    } catch (error: any) {
      setSettingsNotice(friendlyClientError(error));
    } finally {
      setFeaturesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === 'features' && features.length === 0 && !featuresLoading) {
      void loadFeatures();
    }
  }, [features.length, featuresLoading, loadFeatures, tab]);

  useEffect(() => {
    if (tab !== 'features') return;
    try {
      const parsed = JSON.parse(readStorage('deepseek-codex.browserHistory') || '[]');
      setBrowserHistory(Array.isArray(parsed) ? parsed.slice(0, 20) : []);
    } catch {
      setBrowserHistory([]);
    }
    window.codex
      .getComputerHistory()
      .then((list) => setComputerHistory(Array.isArray(list) ? list : []))
      .catch(() => setComputerHistory([]));
    window.codex
      .localToolsStatus()
      .then((status) => {
        setLocalTools(status);
        setComputerAppsInput((status.computerAllowedApps || []).join(', '));
        setBrowserOriginsInput((status.browserAllowedOrigins || []).join(', '));
      })
      .catch(() =>
        setLocalTools({
          browser: false,
          computer: false,
          search: false,
          ocr: false,
          searchProvider: 'auto',
          computerAllowedApps: [],
          browserOriginPolicy: 'any',
          browserAllowedOrigins: [],
          browserFullCdp: false,
        }),
      );
  }, [tab]);

  const updateLocalTools = async (patch: Partial<{
    browser: boolean;
    computer: boolean;
    search: boolean;
    ocr: boolean;
    searchProvider: 'auto' | 'deepseek' | 'local';
    computerAllowedApps: string[];
    browserOriginPolicy: 'any' | 'allowlist';
    browserAllowedOrigins: string[];
    browserFullCdp: boolean;
  }>) => {
    if (!localTools || localToolsBusy) return;
    setLocalToolsBusy(true);
    try {
      const saved = await window.codex.setLocalTools({ ...localTools, ...patch });
      setLocalTools(saved);
      setSettingsNotice('本地 AI 工具已更新；新建会话后生效。');
    } catch (error: any) {
      setSettingsNotice(friendlyClientError(error));
    } finally {
      setLocalToolsBusy(false);
    }
  };

  const clearBrowserHistory = () => {
    removeStorage('deepseek-codex.browserHistory');
    setBrowserHistory([]);
    setSettingsNotice('浏览记录已清除');
  };

  const clearBrowserData = async (kind: 'cache' | 'cookies') => {
    if (kind === 'cookies' && !window.confirm('清除 Cookie、站点数据与登录状态？')) return;
    setBrowserBusy(true);
    try {
      await window.codex.browserClearData(
        kind === 'cache' ? { cache: true } : { cookies: true },
      );
      setSettingsNotice(kind === 'cache' ? '浏览器缓存已清除' : '浏览器 Cookie 与站点数据已清除');
    } catch (error: any) {
      setSettingsNotice(friendlyClientError(error));
    } finally {
      setBrowserBusy(false);
    }
  };

  const clearComputerHistoryLog = async () => {
    try {
      await window.codex.clearComputerHistory();
      setComputerHistory([]);
      setSettingsNotice('电脑操作历史已清除');
    } catch (error: any) {
      setSettingsNotice(friendlyClientError(error));
    }
  };

  useEffect(() => {
    if (tab !== 'runtime') return;
    window.codex
      .request('permissionProfile/list', {})
      .then((response) =>
        setPermissionProfiles(
          (response?.data || []).filter((profile: any) => profile?.allowed !== false),
        ),
      )
      .catch(() => setPermissionProfiles([]));
  }, [tab]);

  useEffect(() => {
    if (tab !== 'diagnostics' || sandboxReadiness !== null) return;
    window.codex
      .request('windowsSandbox/readiness', {})
      .then((response) => setSandboxReadiness(response?.status || 'unknown'))
      .catch(() => setSandboxReadiness('unavailable'));
  }, [sandboxReadiness, tab]);

  useEffect(() => {
    const unsubscribe = window.codex.onNotification((notification) => {
      if (notification.method !== 'windowsSandbox/setupCompleted') return;
      const success = Boolean(notification.params?.success);
      setSandboxBusy(false);
      setSandboxReadiness(success ? 'ready' : 'notConfigured');
      setSandboxSetupMessage(
        success
          ? '沙箱初始化完成，可重新选择“工作区可写”'
          : `沙箱初始化失败：${notification.params?.error || '未知错误'}`,
      );
    });
    return unsubscribe;
  }, []);

  const setupSandbox = async (mode: 'elevated' | 'unelevated') => {
    setSandboxBusy(true);
    setSandboxSetupMessage(null);
    try {
      const response = await window.codex.request('windowsSandbox/setupStart', {
        mode,
        cwd: config?.defaultCwd || undefined,
      });
      if (!response?.started) {
        setSandboxBusy(false);
        setSandboxSetupMessage('无法启动沙箱初始化');
      } else {
        setSandboxSetupMessage('沙箱初始化已在后台开始…');
      }
    } catch (error: any) {
      setSandboxBusy(false);
      setSandboxSetupMessage(error?.message || String(error));
    }
  };

  const sandboxReadinessLabel = (() => {
    if (sandboxReadiness === 'ready') return '已就绪';
    if (sandboxReadiness === 'notConfigured') return '未配置（可初始化）';
    if (sandboxReadiness === 'updateRequired') return '需要更新';
    if (sandboxReadiness === 'unavailable') return '不可用';
    return sandboxReadiness || '检查中…';
  })();

  const toggleFeature = async (feature: any) => {
    setFeatureBusy(feature.name);
    try {
      await window.codex.request('experimentalFeature/enablement/set', {
        enablement: { [feature.name]: !feature.enabled },
      });
      await loadFeatures();
    } catch (error: any) {
      setSettingsNotice(friendlyClientError(error));
    } finally {
      setFeatureBusy(null);
    }
  };

  const shortcuts: { keys: string; action: string }[] = [
    { keys: 'Ctrl+N', action: '新对话' },
    { keys: 'Ctrl+P', action: '文件快速打开' },
    { keys: 'Ctrl+J', action: '打开 / 收起终端' },
    { keys: 'Ctrl+T', action: '打开内置浏览器' },
    { keys: 'Ctrl+,', action: '打开设置' },
    { keys: 'Enter', action: '发送 / 追加到当前任务' },
    { keys: 'Shift+Enter', action: '输入换行' },
    { keys: 'Esc', action: '关闭补全 / 弹层' },
  ];
  const pages: { id: typeof tab; title: string; subtitle: string; group: string }[] = [
    { id: 'runtime', title: '通用', subtitle: '审批、沙箱、模型与推理强度', group: '应用' },
    { id: 'appearance', title: '外观', subtitle: '主题与界面风格', group: '应用' },
    { id: 'notifications', title: '通知', subtitle: '任务完成提醒与提示音', group: '应用' },
    { id: 'features', title: '实验功能', subtitle: '引擎提供的实验特性', group: '系统' },
    { id: 'shortcuts', title: '快捷键', subtitle: '键盘操作一览', group: '系统' },
    { id: 'diagnostics', title: '诊断', subtitle: '引擎、Windows 沙箱与日志', group: '系统' },
    { id: 'about', title: '关于', subtitle: '版本与本地数据', group: '系统' },
  ];
  const activePage = pages.find((page) => page.id === tab) || pages[0];
  const navGroups = [...new Set(pages.map((page) => page.group))];
  const navFilter = navQuery.trim().toLowerCase();
  const visiblePages = pages.filter(
    (page) =>
      !navFilter ||
      page.title.toLowerCase().includes(navFilter) ||
      page.subtitle.toLowerCase().includes(navFilter),
  );

  return (
    <div className="settings-page">
      <aside className="settings-nav">
        <button className="settings-back" onClick={onClose}>
          <ArrowLeft size={14} />
          返回应用
        </button>
        <label className="settings-search">
          <Search size={12} />
          <input
            value={navQuery}
            onChange={(event) => setNavQuery(event.target.value)}
            placeholder="搜索设置…"
            spellCheck={false}
          />
        </label>
        {navGroups.map((group) => {
          const items = visiblePages.filter((page) => page.group === group);
          if (items.length === 0) return null;
          return (
            <div className="settings-nav-group" key={group}>
              <div className="settings-nav-label">{group}</div>
              {items.map((page) => (
                <button
                  key={page.id}
                  className={`settings-nav-item ${tab === page.id ? 'active' : ''}`}
                  onClick={() => {
                    setTab(page.id);
                    setSettingsNotice(null);
                  }}
                >
                  {page.title}
                </button>
              ))}
            </div>
          );
        })}
      </aside>
      <main className="settings-main">
        <div className="settings-main-inner">
          <h1 className="settings-title">{activePage.title}</h1>
          <p className="settings-subtitle">{activePage.subtitle}</p>
          {settingsNotice ? <div className="settings-notice">{settingsNotice}</div> : null}

        <div className={tab === 'runtime' ? 'settings-pane' : 'settings-pane hidden'}>

        <div className="setting-group">
          <div className="setting-row">
            <div className="setting-row-text">
              <strong>审批策略</strong>
              <span>
                {approvals.find((option) => option.value === draft.approvalPolicy)?.description}
              </span>
            </div>
            <select
              className="setting-select"
              value={draft.approvalPolicy}
              onChange={(event) =>
                applyDraft({
                  ...draft,
                  approvalPolicy: event.target.value as RuntimeSettings['approvalPolicy'],
                })
              }
            >
              {approvals.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.title}
                </option>
              ))}
            </select>
          </div>
          <div className="setting-row">
            <div className="setting-row-text">
              <strong>审批审查者</strong>
              <span>
                {draft.approvalsReviewer === 'auto_review'
                  ? '由模型预审风险后再决定是否批准（新会话生效）'
                  : '所有审批请求都交给你确认'}
              </span>
            </div>
            <select
              className="setting-select"
              value={draft.approvalsReviewer}
              onChange={(event) =>
                applyDraft({
                  ...draft,
                  approvalsReviewer: event.target.value as RuntimeSettings['approvalsReviewer'],
                })
              }
            >
              <option value="user">由我审批</option>
              <option value="auto_review">自动审查</option>
            </select>
          </div>
          <div className="setting-row">
            <div className="setting-row-text">
              <strong>沙箱权限</strong>
              <span>{sandboxes.find((option) => option.value === draft.sandbox)?.description}</span>
            </div>
            <select
              className="setting-select"
              value={draft.sandbox}
              disabled={Boolean(draft.permissionProfile)}
              onChange={(event) =>
                applyDraft({
                  ...draft,
                  sandbox: event.target.value as RuntimeSettings['sandbox'],
                })
              }
            >
              {sandboxes.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.title}
                </option>
              ))}
            </select>
          </div>
          <div className="setting-row">
            <div className="setting-row-text">
              <strong>权限配置（Profiles）</strong>
              <span>选择后在 config.toml 的 permissions profile 中解析权限，覆盖沙箱与网络设置</span>
            </div>
            <select
              className="setting-select"
              value={draft.permissionProfile || ''}
              onChange={(event) =>
                applyDraft({
                  ...draft,
                  permissionProfile: event.target.value || null,
                })
              }
            >
              <option value="">使用沙箱选项</option>
              {permissionProfiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.id}
                  {profile.description ? ` · ${profile.description}` : ''}
                </option>
              ))}
            </select>
          </div>
          {draft.sandbox === 'workspace-write' && !draft.permissionProfile ? (
            <div className="setting-row">
              <div className="setting-row-text">
                <strong>工作区网络访问</strong>
                <span>允许工作区内的命令访问网络；关闭时仅能访问本地资源</span>
              </div>
              <button
                className={`switch ${draft.networkAccess ? 'on' : ''}`}
                role="switch"
                aria-checked={draft.networkAccess}
                onClick={() => applyDraft({ ...draft, networkAccess: !draft.networkAccess })}
              >
                <span />
              </button>
            </div>
          ) : null}
        </div>

        <div className="setting-group">
          <div className="setting-label">推理强度</div>
          <div className="setting-inline">
            {effortOptions.map((effort) => (
              <button
                key={effort}
                className={`question-option ${draft.effort === effort ? 'selected' : ''}`}
                onClick={() => applyDraft({ ...draft, effort: effort as RuntimeSettings['effort'] })}
              >
                {effortLabel(effort)}
              </button>
            ))}
          </div>
        </div>

        <div className="setting-group">
          <div className="setting-label">DeepSeek API Key</div>
          <button className="setting-option" onClick={onOpenKey}>
            <strong>{config?.apiKeyConfigured ? '已配置' : '未配置'}</strong>
            <span>更换或更新本地加密存储的 DeepSeek 密钥</span>
          </button>
        </div>

        <div className="setting-group">
          <div className="setting-label">模型提供方</div>
          <div className="setting-provider">
            <span className="provider-badge">{provider}</span>
            <span>仅使用 DeepSeek 模型 · 本地 app-server</span>
          </div>
          <div className="setting-inline">
            {models.map((entry) => (
              <span className="model-chip" key={entry.slug}>
                {entry.display_name || entry.slug}
                {entry.context_window ? ` · ${formatTokens(entry.context_window)}` : ''}
              </span>
            ))}
          </div>
        </div>

        {draft.sandbox === 'danger-full-access' ? (
          <div className="setting-warning">
            <AlertTriangle size={14} />
            <span>完全访问不启用沙箱，可修改任意文件；请只在可信工作目录使用。</span>
          </div>
        ) : draft.approvalPolicy === 'never' ? (
          <div className="setting-warning">
            <AlertTriangle size={14} />
            <span>自主执行不会逐条确认命令与文件修改；请确认沙箱边界适合当前项目。</span>
          </div>
        ) : null}
        </div>

        <div className={tab === 'appearance' ? 'settings-pane' : 'settings-pane hidden'}>
          <div className="setting-group">
            <div className="setting-row">
              <div className="setting-row-text">
                <strong>主题</strong>
                <span>
                  {theme === 'official'
                    ? '中性灰黑与白色强调，对齐官方桌面端'
                    : '铜色点缀与本项目原有气质'}
                </span>
              </div>
              <select
                className="setting-select"
                value={theme}
                onChange={(event) => onTheme(event.target.value as 'official' | 'warm')}
              >
                <option value="official">官方深灰</option>
                <option value="warm">暖色</option>
              </select>
            </div>
          </div>
          <div className="setting-note">主题立即生效，并会记住选择。</div>
        </div>

        <div className={tab === 'notifications' ? 'settings-pane' : 'settings-pane hidden'}>
          <div className="setting-group">
            <div className="setting-row">
              <div className="setting-row-text">
                <strong>任务完成提醒</strong>
                <span>窗口不在前台时发送系统通知并播放提示音；关闭后仅在界面内提示</span>
              </div>
              <button
                className={`switch ${notifyOnComplete ? 'on' : ''}`}
                role="switch"
                aria-checked={notifyOnComplete}
                onClick={() => onNotifyOnComplete(!notifyOnComplete)}
              >
                <span />
              </button>
            </div>
          </div>
          <div className="setting-note">点击系统通知可回到应用；通知内容不会包含代码或密钥。</div>
        </div>

        <div className={tab === 'features' ? 'settings-pane' : 'settings-pane hidden'}>
          <div className="setting-group">
            <div className="setting-label">浏览器数据</div>
            <div className="setting-note">
              内置 Browser 使用独立会话；AI 后台搜索与读取使用另一个隔离分区。
            </div>
            {browserHistory.length > 0 ? (
              <div className="browser-history-list">
                {browserHistory.slice(0, 6).map((entry) => (
                  <div className="browser-history-row" key={`${entry.url}-${entry.at}`}>
                    <span>{entry.title || entry.url}</span>
                    <small title={entry.url}>{entry.url}</small>
                  </div>
                ))}
              </div>
            ) : (
              <div className="cap-empty">暂无浏览记录</div>
            )}
            <div className="settings-inline-actions">
              <button onClick={clearBrowserHistory} disabled={browserHistory.length === 0}>
                清除浏览记录
              </button>
              <button onClick={() => void clearBrowserData('cache')} disabled={browserBusy}>
                清除缓存
              </button>
              <button onClick={() => void clearBrowserData('cookies')} disabled={browserBusy}>
                清除 Cookie 与站点数据
              </button>
            </div>
          </div>
          <div className="setting-group">
            <div className="setting-label">本地 AI 工具</div>
            <div className="setting-row">
              <div className="setting-row-text">
                <strong>浏览器控制</strong>
                <span>允许 AI 打开并操作内置浏览器中的页面、读取内容与截图</span>
              </div>
              <button
                className={`switch ${localTools?.browser ? 'on' : ''}`}
                role="switch"
                aria-checked={Boolean(localTools?.browser)}
                disabled={!localTools || localToolsBusy}
                onClick={() => void updateLocalTools({ browser: !localTools?.browser })}
              >
                <span />
              </button>
            </div>
            {localTools?.browser ? (
              <div className="setting-row">
                <div className="setting-row-text">
                  <strong>AI 站点访问</strong>
                  <span>限制 AI 浏览器工具可以访问的站点，新会话生效</span>
                </div>
                <select
                  className="setting-select"
                  value={localTools.browserOriginPolicy}
                  disabled={localToolsBusy}
                  onChange={(event) =>
                    void updateLocalTools({
                      browserOriginPolicy:
                        event.target.value === 'allowlist' ? 'allowlist' : 'any',
                    })
                  }
                >
                  <option value="any">所有站点</option>
                  <option value="allowlist">仅允许列表</option>
                </select>
              </div>
            ) : null}
            {localTools?.browser && localTools.browserOriginPolicy === 'allowlist' ? (
              <div className="setting-row">
                <div className="setting-row-text">
                  <strong>允许的站点</strong>
                  <span>逗号分隔 host 或 *.domain，例如 example.com, *.github.com</span>
                </div>
                <input
                  className="setting-input"
                  value={browserOriginsInput}
                  placeholder="example.com, *.github.com"
                  spellCheck={false}
                  onChange={(event) => setBrowserOriginsInput(event.target.value)}
                  onBlur={() => {
                    const origins = [
                      ...new Set(
                        browserOriginsInput
                          .split(/[,\n]/)
                          .map((origin) => origin.trim())
                          .filter(Boolean),
                      ),
                    ];
                    setBrowserOriginsInput(origins.join(', '));
                    void updateLocalTools({ browserAllowedOrigins: origins });
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur();
                  }}
                />
              </div>
            ) : null}
            {localTools?.browser ? (
              <div className="setting-row">
                <div className="setting-row-text">
                  <strong>完整 CDP</strong>
                  <span>允许 AI 在页面中执行任意脚本，风险较高；新会话生效</span>
                </div>
                <button
                  className={`switch ${localTools.browserFullCdp ? 'on' : ''}`}
                  role="switch"
                  aria-checked={localTools.browserFullCdp}
                  disabled={localToolsBusy}
                  onClick={() =>
                    void updateLocalTools({ browserFullCdp: !localTools.browserFullCdp })
                  }
                >
                  <span />
                </button>
              </div>
            ) : null}
            <div className="setting-row">
              <div className="setting-row-text">
                <strong>网页搜索与读取</strong>
                <span>有 API Key 时优先使用 DeepSeek，失败自动回退本地必应</span>
              </div>
              <button
                className={`switch ${localTools?.search ? 'on' : ''}`}
                role="switch"
                aria-checked={Boolean(localTools?.search)}
                disabled={!localTools || localToolsBusy}
                onClick={() => void updateLocalTools({ search: !localTools?.search })}
              >
                <span />
              </button>
            </div>
            {localTools?.search ? (
              <div className="setting-row">
                <div className="setting-row-text">
                  <strong>搜索提供方</strong>
                  <span>DeepSeek Search/Fetch 按成功请求计费；本地必应无需 Key</span>
                </div>
                <select
                  className="setting-select"
                  value={localTools.searchProvider}
                  disabled={localToolsBusy}
                  onChange={(event) =>
                    void updateLocalTools({
                      searchProvider: event.target.value as 'auto' | 'deepseek' | 'local',
                    })
                  }
                >
                  <option value="auto">自动（推荐）</option>
                  <option value="deepseek">DeepSeek Search API</option>
                  <option value="local">本地必应</option>
                </select>
              </div>
            ) : null}
            <div className="setting-row">
              <div className="setting-row-text">
                <strong>文档识别（OCR）</strong>
                <span>PDF、Word、PPT 与图片自动识别文字；按页计费</span>
              </div>
              <button
                className={`switch ${localTools?.ocr ? 'on' : ''}`}
                role="switch"
                aria-checked={Boolean(localTools?.ocr)}
                disabled={!localTools || localToolsBusy}
                onClick={() => void updateLocalTools({ ocr: !localTools?.ocr })}
              >
                <span />
              </button>
            </div>
            <div className="setting-row">
              <div className="setting-row-text">
                <strong>电脑控制</strong>
                <span>允许 AI 截屏并使用鼠标、键盘操作本机窗口</span>
              </div>
              <button
                className={`switch ${localTools?.computer ? 'on' : ''}`}
                role="switch"
                aria-checked={Boolean(localTools?.computer)}
                disabled={!localTools || localToolsBusy}
                onClick={() => void updateLocalTools({ computer: !localTools?.computer })}
              >
                <span />
              </button>
            </div>
            {localTools?.computer ? (
              <div className="setting-row">
                <div className="setting-row-text">
                  <strong>允许操作的应用</strong>
                  <span>逗号分隔进程名；留空表示所有应用，新会话生效</span>
                </div>
                <input
                  className="setting-input"
                  value={computerAppsInput}
                  placeholder="Code.exe, notepad.exe"
                  spellCheck={false}
                  onChange={(event) => setComputerAppsInput(event.target.value)}
                  onBlur={() => {
                    const apps = [
                      ...new Set(
                        computerAppsInput
                          .split(/[,\n]/)
                          .map((name) => name.trim())
                          .filter(Boolean),
                      ),
                    ];
                    setComputerAppsInput(apps.join(', '));
                    void updateLocalTools({ computerAllowedApps: apps });
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur();
                  }}
                />
              </div>
            ) : null}
            <div className="setting-note">
              每次工具调用仍需在对话中确认；新建会话后生效。浏览器控制只作用于内置 Browser 面板；网页搜索与读取在后台完成；文档识别会上传文件到 DeepSeek OCR；电脑控制仅在本机、仅在你明确授权的任务中使用。
            </div>
          </div>
          <div className="setting-group">
            <div className="setting-label">电脑操作历史</div>
            {computerHistory.length > 0 ? (
              <div className="browser-history-list">
                {computerHistory.slice(0, 8).map((entry) => (
                  <div
                    className="browser-history-row"
                    key={`${entry.at}-${entry.tool}`}
                    title={entry.error || ''}
                  >
                    <span>
                      {entry.tool.replace(/^computer_/, '')} {entry.ok ? '✓' : '✗'}
                    </span>
                    <small>
                      {new Date(entry.at).toLocaleString('zh-CN', { hour12: false })} ·{' '}
                      {JSON.stringify(entry.args)}
                    </small>
                  </div>
                ))}
              </div>
            ) : (
              <div className="cap-empty">暂无电脑操作记录</div>
            )}
            <div className="settings-inline-actions">
              <button onClick={() => void clearComputerHistoryLog()} disabled={!computerHistory.length}>
                清除历史
              </button>
            </div>
          </div>
          <div className="setting-group">
            <div className="setting-label">实验功能</div>
            {featuresLoading ? (
              <div className="cap-loading">
                <Loader2 size={13} className="spin" /> 读取实验功能…
              </div>
            ) : features.length === 0 ? (
              <div className="cap-empty">没有可用的实验功能</div>
            ) : (
              features.map((feature: any) => (
                <div className="cap-row" key={feature.name}>
                  <div>
                    <strong>{feature.displayName || feature.name}</strong>
                    <span>
                      {feature.stage || 'stable'}
                      {feature.description ? ` · ${feature.description}` : ''}
                    </span>
                  </div>
                  <button
                    className={`switch ${feature.enabled ? 'on' : ''}`}
                    role="switch"
                    aria-checked={feature.enabled}
                    disabled={featureBusy === feature.name}
                    onClick={() => toggleFeature(feature)}
                  >
                    <span />
                  </button>
                </div>
              ))
            )}
            <div className="setting-note">部分实验功能需要重启引擎后生效。</div>
          </div>
        </div>

        <div className={tab === 'shortcuts' ? 'settings-pane' : 'settings-pane hidden'}>
          <div className="setting-group">
            <div className="setting-label">键盘快捷键</div>
            {shortcuts.map((entry) => (
              <div className="shortcut-row" key={entry.keys}>
                <kbd>{entry.keys}</kbd>
                <span>{entry.action}</span>
              </div>
            ))}
          </div>
        </div>

        <div className={tab === 'diagnostics' ? 'settings-pane' : 'settings-pane hidden'}>
          <div className="setting-group">
            <div className="setting-label">引擎诊断</div>
            <div className="diag-row">
              <span>状态</span>
              <strong>{config?.online ? '在线' : '离线'}</strong>
            </div>
            <div className="diag-row">
              <span>二进制</span>
              <code>{config?.codexBin || '未找到'}</code>
            </div>
            <div className="diag-row">
              <span>数据目录</span>
              <code>{config?.codexHome || '未知'}</code>
            </div>
            <div className="diag-row">
              <span>应用版本</span>
              <span>{config?.appVersion || '0.7.0'}</span>
            </div>
            <div className="diag-actions">
              <button
                disabled={engineBusy}
                onClick={async () => {
                  setEngineBusy(true);
                  try {
                    await window.codex.restartEngine();
                    setSettingsNotice('引擎已重启');
                  } catch (error: any) {
                    setSettingsNotice(friendlyClientError(error));
                  } finally {
                    setEngineBusy(false);
                  }
                }}
              >
                {engineBusy ? '重启中…' : '重启引擎'}
              </button>
              <button onClick={() => window.codex.openPath(config?.codexHome || '')}>
                打开配置目录
              </button>
            </div>
            <div className="setting-label">Windows 沙箱</div>
            <div className="diag-row">
              <span>状态</span>
              <strong>{sandboxReadinessLabel}</strong>
            </div>
            {sandboxSetupMessage ? (
              <div className="settings-notice">{sandboxSetupMessage}</div>
            ) : null}
            <div className="diag-actions">
              <button
                disabled={sandboxBusy}
                onClick={() => setSandboxReadiness(null)}
              >
                重新检查
              </button>
              <button
                disabled={sandboxBusy}
                onClick={() => void setupSandbox('unelevated')}
              >
                {sandboxBusy ? '初始化中…' : '初始化（免提权）'}
              </button>
              <button
                disabled={sandboxBusy}
                onClick={() => void setupSandbox('elevated')}
              >
                初始化（管理员）
              </button>
            </div>
            <div className="setting-note">
              免提权初始化后，工作区可写通常立即可用；若命令仍被拒绝，再尝试管理员初始化。初始化会配置本机沙箱权限；管理员模式会弹出 UAC。
            </div>
            <div className="setting-label">最近引擎日志</div>
            <pre className="diag-log">{(config?.log || []).join('\n') || '暂无日志'}</pre>
          </div>
        </div>

        <div className={tab === 'about' ? 'settings-pane' : 'settings-pane hidden'}>
          <div className="about-card">
            <div className="brand-mark">◇</div>
            <h3>DeepSeek Codex</h3>
            <p>本地化 Codex 桌面端 · 仅使用 DeepSeek 模型 · app-server 本地运行</p>
            <div className="diag-row">
              <span>版本</span>
              <span>{config?.appVersion || '0.7.0'}</span>
            </div>
            <div className="diag-row">
              <span>引擎</span>
              <code>{config?.codexBin || '未找到'}</code>
            </div>
            <div className="diag-row">
              <span>模型</span>
              <span>{models.map((entry) => entry.display_name || entry.slug).join(' · ')}</span>
            </div>
          </div>
        </div>

        </div>
      </main>
    </div>
  );
}
