import type {
  Dispatch,
  KeyboardEvent as ReactKeyboardEvent,
  RefObject,
  SetStateAction,
} from 'react';
import {
  AlertTriangle,
  ArrowUp,
  Boxes,
  Check,
  ChevronDown,
  ChevronRight,
  Compass,
  FileText,
  FolderOpen,
  GitBranch,
  Image as ImageIcon,
  ListChecks,
  PanelRight,
  Paperclip,
  Plus,
  ShieldCheck,
  X,
} from 'lucide-react';
import type { MentionState, ModelInfo, RuntimeSettings } from '../types';
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
  dragging,
  effortOptions,
  input,
  insertMention,
  itemsCount,
  mention,
  mode,
  model,
  modelListOpen,
  modelMenuOpen,
  models,
  onKeyDown,
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
  dragging: boolean;
  effortOptions: string[];
  input: string;
  insertMention: (item: { path: string; fileName?: string }) => void;
  itemsCount: number;
  mention: MentionState | null;
  mode: 'default' | 'plan';
  model: string;
  modelListOpen: boolean;
  modelMenuOpen: boolean;
  models: ModelInfo[];
  onKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
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
  setRailOpen: Dispatch<SetStateAction<boolean>>;
  setSearchOpen: Dispatch<SetStateAction<boolean>>;
  settings: RuntimeSettings;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  thumbnails: Record<string, string>;
  toggleWorktree: () => void;
  worktreeMode: boolean;
}) {
  return (
        <footer className="composer">
          {!autonomyHidden &&
          itemsCount > 0 &&
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
