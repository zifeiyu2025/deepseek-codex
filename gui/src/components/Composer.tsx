import type {
  Dispatch,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  RefObject,
  SetStateAction,
} from 'react';
import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  ArrowUp,
  Boxes,
  Check,
  ChevronDown,
  ChevronRight,
  Compass,
  Cpu,
  FileText,
  FolderOpen,
  Gauge,
  GitBranch,
  GitFork,
  Image as ImageIcon,
  Info,
  ListChecks,
  Loader2,
  Minimize2,
  Monitor,
  Pencil,
  PanelRight,
  Paperclip,
  Pin,
  Plus,
  Server,
  ShieldCheck,
  Target,
  Trash2,
  X,
} from 'lucide-react';
import type {
  MentionState,
  ModelInfo,
  RuntimeSettings,
  SlashCommandId,
  ThreadGoal,
} from '../types';
import { effortLabel } from '../lib/format';
import { writeStorage } from '../lib/storage';

export function Composer({
  activeCwd,
  activeModel,
  addDroppedFiles,
  applySettings,
  attachMenuOpen,
  attachments,
  autonomyHidden,
  captureScreen,
  dragging,
  effortOptions,
  goal,
  hasThread,
  input,
  insertMention,
  itemsCount,
  mention,
  mode,
  model,
  modelListOpen,
  modelMenuOpen,
  models,
  ocrAttachments,
  ocrBusy,
  onKeyDown,
  onOpenGoal,
  onSlashCommand,
  openCapabilities,
  openSettings,
  pickFiles,
  pickFolder,
  pickImages,
  preparing,
  projectName,
  refreshMention,
  running,
  send,
  setAttachMenuOpen,
  setAttachments,
  setAutomationOpen,
  setAutonomyHidden,
  setDragging,
  setInput,
  setModel,
  setModelListOpen,
  setModelMenuOpen,
  setMode,
  setOcrAttachments,
  setRailOpen,
  setSearchOpen,
  settings,
  textareaRef,
  thumbnails,
  toggleWorktree,
  worktreeMode,
}: {
  activeCwd: string;
  activeModel?: ModelInfo;
  addDroppedFiles: (files: File[]) => void;
  applySettings: (next: RuntimeSettings) => void;
  attachMenuOpen: boolean;
  attachments: string[];
  autonomyHidden: boolean;
  captureScreen: () => void;
  dragging: boolean;
  effortOptions: string[];
  goal: ThreadGoal | null;
  hasThread: boolean;
  input: string;
  insertMention: (item: { path: string; fileName?: string }) => void;
  itemsCount: number;
  mention: MentionState | null;
  mode: 'default' | 'plan';
  model: string;
  modelListOpen: boolean;
  modelMenuOpen: boolean;
  models: ModelInfo[];
  ocrAttachments: { path: string; name: string; pageCount: number; truncated: boolean }[];
  ocrBusy: boolean;
  onKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  onOpenGoal: () => void;
  onSlashCommand: (id: SlashCommandId, argument?: string) => void;
  openCapabilities: () => void;
  openSettings: () => void;
  pickFiles: () => void;
  pickFolder: () => void;
  pickImages: () => void;
  preparing: boolean;
  projectName: string;
  refreshMention: (value: string, caret: number) => void;
  running: boolean;
  send: (overrideText?: string) => void;
  setAttachMenuOpen: Dispatch<SetStateAction<boolean>>;
  setAttachments: Dispatch<SetStateAction<string[]>>;
  setAutomationOpen: Dispatch<SetStateAction<boolean>>;
  setAutonomyHidden: Dispatch<SetStateAction<boolean>>;
  setDragging: Dispatch<SetStateAction<boolean>>;
  setInput: Dispatch<SetStateAction<string>>;
  setModel: Dispatch<SetStateAction<string>>;
  setModelListOpen: Dispatch<SetStateAction<boolean>>;
  setModelMenuOpen: Dispatch<SetStateAction<boolean>>;
  setMode: Dispatch<SetStateAction<'default' | 'plan'>>;
  setOcrAttachments: Dispatch<
    SetStateAction<{ path: string; name: string; pageCount: number; text: string; truncated: boolean }[]>
  >;
  setRailOpen: Dispatch<SetStateAction<boolean>>;
  setSearchOpen: Dispatch<SetStateAction<boolean>>;
  settings: RuntimeSettings;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  thumbnails: Record<string, string>;
  toggleWorktree: () => void;
  worktreeMode: boolean;
}) {
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const goalStatusLabels: Record<string, string> = {
    active: '进行中',
    paused: '已暂停',
    blocked: '受阻',
    usageLimited: '用量受限',
    budgetLimited: '预算受限',
    complete: '已完成',
  };
  const slashCommands = useMemo<
    {
      id: SlashCommandId;
      name: string;
      title: string;
      description: string;
      icon: ReactNode;
      enabled: boolean;
    }[]
  >(
    () => [
      {
        id: 'plan',
        name: 'plan',
        title: mode === 'plan' ? '关闭计划模式' : '计划模式',
        description: '先梳理方案与待办，确认后再修改',
        icon: <ListChecks size={13} />,
        enabled: true,
      },
      {
        id: 'goal',
        name: 'goal',
        title: goal ? '查看目标' : '设置目标',
        description: '让 Codex 持续朝目标推进，空闲时继续',
        icon: <Target size={13} />,
        enabled: true,
      },
      {
        id: 'new',
        name: 'new',
        title: '新建会话',
        description: '在同一工作区开始空白会话',
        icon: <Plus size={13} />,
        enabled: true,
      },
      {
        id: 'chat',
        name: 'chat',
        title: '无项目会话',
        description: '不在任何项目中开始工作',
        icon: <Compass size={13} />,
        enabled: true,
      },
      {
        id: 'project',
        name: 'project',
        title: '选择项目',
        description: '为之后的新会话选择项目',
        icon: <FolderOpen size={13} />,
        enabled: true,
      },
      {
        id: 'plan-skill',
        name: 'plan-skill',
        title: 'plan 技能',
        description: '使用计划技能梳理方案',
        icon: <ListChecks size={13} />,
        enabled: true,
      },
      {
        id: 'model',
        name: 'model',
        title: '模型',
        description: '切换模型',
        icon: <Cpu size={13} />,
        enabled: true,
      },
      {
        id: 'reasoning',
        name: 'reasoning',
        title: '推理强度',
        description: '调整思考强度',
        icon: <Gauge size={13} />,
        enabled: true,
      },
      {
        id: 'compact',
        name: 'compact',
        title: '压缩上下文',
        description: running ? '任务运行中不可压缩' : '压缩当前会话上下文',
        icon: <Minimize2 size={13} />,
        enabled: hasThread && !running,
      },
      {
        id: 'worktree',
        name: 'worktree',
        title: worktreeMode ? '关闭 Worktree' : '启用 Worktree',
        description: '在独立工作区中运行任务',
        icon: <GitBranch size={13} />,
        enabled: true,
      },
      {
        id: 'fork',
        name: 'fork',
        title: '分支会话',
        description: '从当前会话创建分支',
        icon: <GitFork size={13} />,
        enabled: hasThread,
      },
      {
        id: 'archive',
        name: 'archive',
        title: '归档会话',
        description: '归档当前会话',
        icon: <Archive size={13} />,
        enabled: hasThread,
      },
      {
        id: 'rename',
        name: 'rename',
        title: '重命名会话',
        description: '修改当前会话标题',
        icon: <Pencil size={13} />,
        enabled: hasThread,
      },
      {
        id: 'pin',
        name: 'pin',
        title: '置顶会话',
        description: '把当前会话固定到置顶分区',
        icon: <Pin size={13} />,
        enabled: hasThread,
      },
      {
        id: 'delete',
        name: 'delete',
        title: '永久删除会话',
        description: '确认后永久删除当前会话',
        icon: <Trash2 size={13} />,
        enabled: hasThread,
      },
      {
        id: 'mcp',
        name: 'mcp',
        title: 'MCP 状态',
        description: '打开能力面板查看 MCP 服务器',
        icon: <Server size={13} />,
        enabled: true,
      },
      {
        id: 'init',
        name: 'init',
        title: '初始化 AGENTS.md',
        description: running ? '任务运行中不可初始化' : '检查项目并创建 AGENTS.md',
        icon: <FileText size={13} />,
        enabled: !running,
      },
      {
        id: 'status',
        name: 'status',
        title: '会话状态',
        description: '查看会话、模型与目标状态',
        icon: <Info size={13} />,
        enabled: true,
      },
    ],
    [goal, hasThread, mode, running, worktreeMode],
  );
  const slashQuery =
    !mention && /^\/[^\s]*$/.test(input) ? input.slice(1).toLowerCase() : null;
  const filteredSlashCommands = useMemo(() => {
    if (slashQuery === null) return [];
    return slashCommands.filter(
      (command) =>
        command.name.startsWith(slashQuery) ||
        command.title.toLowerCase().includes(slashQuery),
    );
  }, [slashCommands, slashQuery]);
  const slashOpen =
    slashQuery !== null && !slashDismissed && filteredSlashCommands.length > 0;
  const activeSlashIndex = Math.min(
    slashIndex,
    Math.max(0, filteredSlashCommands.length - 1),
  );

  useEffect(() => {
    setSlashIndex(0);
    setSlashDismissed(false);
  }, [slashQuery]);

  const executeSlashCommand = (
    command: (typeof slashCommands)[number],
    argument?: string,
  ) => {
    if (!command.enabled) return;
    setInput('');
    setSlashDismissed(false);
    setAttachMenuOpen(false);
    setModelMenuOpen(false);
    onSlashCommand(command.id, argument);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (slashOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSlashIndex((previous) => (previous + 1) % filteredSlashCommands.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSlashIndex(
          (previous) =>
            (previous - 1 + filteredSlashCommands.length) % filteredSlashCommands.length,
        );
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        executeSlashCommand(filteredSlashCommands[activeSlashIndex]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setSlashDismissed(true);
        return;
      }
    }
    if (!mention && event.key === 'Enter' && !event.shiftKey) {
      const match = /^\/([a-z-]+)(?:\s+([\s\S]*))?$/i.exec(input);
      const command = match
        ? slashCommands.find((entry) => entry.name === match[1].toLowerCase())
        : undefined;
      if (command) {
        event.preventDefault();
        executeSlashCommand(command, match?.[2]?.trim());
        return;
      }
    }
    onKeyDown(event);
  };

  return (
        <footer className="composer">
          {!autonomyHidden &&
          itemsCount > 0 &&
          (settings.approvalPolicy === 'never' || settings.sandbox === 'danger-full-access') ? (
            <div className="autonomy-banner">
              <div className="autonomy-main">
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
              </div>
              <div className="autonomy-actions">
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
                  aria-label="关闭提示"
                  onClick={() => setAutonomyHidden(true)}
                >
                  <X size={13} />
                </button>
              </div>
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
            {slashOpen ? (
              <div className="slash-menu" role="listbox" aria-label="输入框命令">
                <div className="slash-menu-title">命令</div>
                {filteredSlashCommands.map((command, index) => (
                  <button
                    key={command.id}
                    type="button"
                    role="option"
                    aria-selected={index === activeSlashIndex}
                    className={`slash-item ${index === activeSlashIndex ? 'active' : ''} ${command.enabled ? '' : 'disabled'}`}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      executeSlashCommand(command);
                    }}
                  >
                    <span className="slash-icon">{command.icon}</span>
                    <span className="slash-text">
                      <strong>{command.title}</strong>
                      <small>{command.description}</small>
                    </span>
                    <code>/{command.name}</code>
                  </button>
                ))}
                <div className="slash-hint">↑↓ 选择 · Enter 执行 · Esc 关闭</div>
              </div>
            ) : null}
            {goal ? (
              <button
                type="button"
                className="composer-goal"
                onClick={onOpenGoal}
                title={goal.objective}
              >
                <Target size={13} />
                <span className={`goal-status ${goal.status}`}>
                  {goalStatusLabels[goal.status] || goal.status}
                </span>
                <span className="goal-objective">{goal.objective}</span>
                {goal.tokenBudget ? (
                  <span className="goal-usage">
                    {goal.tokensUsed}/{goal.tokenBudget}
                  </span>
                ) : null}
              </button>
            ) : null}
            {ocrAttachments.length > 0 ? (
              <div className="attachment-row">
                {ocrAttachments.map((doc) => (
                  <span className="attachment-chip document" key={doc.path} title={doc.path}>
                    <FileText size={12} />
                    {doc.name}
                    <small>
                      {doc.pageCount} 页{doc.truncated ? ' · 已截断' : ''}
                    </small>
                    <button
                      onClick={() =>
                        setOcrAttachments((list) => list.filter((entry) => entry.path !== doc.path))
                      }
                    >
                      <X size={10} />
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
            {ocrBusy ? (
              <div className="ocr-status">
                <Loader2 size={12} className="spin" /> 正在识别文档…
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
                setSlashDismissed(false);
                refreshMention(value, event.target.selectionStart ?? value.length);
              }}
              onKeyDown={handleKeyDown}
              onBlur={() => setSlashDismissed(true)}
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
                    aria-haspopup="menu"
                    aria-expanded={attachMenuOpen}
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
                      <button
                        onClick={() => {
                          setAttachMenuOpen(false);
                          captureScreen();
                        }}
                      >
                        <Monitor size={13} /> 截取屏幕
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
                          onOpenGoal();
                        }}
                      >
                        <Target size={13} /> 目标
                        {goal ? <Check size={12} /> : null}
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
                    aria-haspopup="menu"
                    aria-expanded={modelMenuOpen}
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
  );
}
