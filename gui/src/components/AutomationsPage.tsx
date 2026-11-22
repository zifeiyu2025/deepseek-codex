import { useState } from 'react';
import { CalendarClock, Search } from 'lucide-react';
import type { Automation, ProjectInfo } from '../types';
import { automationScheduleLabel, nextRunLabel, timeAgo } from '../lib/format';

type AutomationFormState = {
  name: string;
  prompt: string;
  intervalMinutes: number;
  projectId: string;
};

export function AutomationsPage({
  automations,
  form,
  editingId,
  projects,
  onForm,
  onEditing,
  onSave,
  onRun,
  onToggle,
  onRemove,
  onClose,
}: {
  automations: Automation[];
  form: AutomationFormState;
  editingId: string | null;
  projects: ProjectInfo[];
  onForm: (form: AutomationFormState) => void;
  onEditing: (id: string | null) => void;
  onSave: () => void;
  onRun: (automation: Automation, manual: boolean) => void;
  onToggle: (automation: Automation) => void;
  onRemove: (automation: Automation) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const filter = query.trim().toLowerCase();
  const filtered = automations.filter((automation) =>
    `${automation.name} ${automation.prompt}`.toLowerCase().includes(filter),
  );
  const emptyForm: AutomationFormState = {
    name: '',
    prompt: '',
    intervalMinutes: 0,
    projectId: '',
  };
  const startCreate = () => {
    onEditing(null);
    onForm(emptyForm);
    setEditorOpen(true);
  };
  const startEdit = (automation: Automation) => {
    onEditing(automation.id);
    onForm({
      name: automation.name,
      prompt: automation.prompt,
      intervalMinutes: automation.intervalMinutes,
      projectId: automation.projectId || '',
    });
    setEditorOpen(true);
  };
  const cancelEdit = () => {
    onEditing(null);
    onForm(emptyForm);
    setEditorOpen(false);
  };

  if (editorOpen) {
    return (
      <div className="page-view">
        <div className="page-head">
          <div>
            <h1>{editingId ? '编辑定时任务' : '新建定时任务'}</h1>
            <p>保存后将在此设备上按计划执行；应用关闭时不会运行。</p>
          </div>
          <div className="page-head-actions">
            <button className="page-ghost" onClick={cancelEdit}>
              取消
            </button>
            <button
              className="page-primary"
              disabled={!form.name.trim() || !form.prompt.trim()}
              onClick={() => {
                onSave();
                setEditorOpen(false);
              }}
            >
              保存
            </button>
          </div>
        </div>
        <div className="automation-editor">
          <input
            id="automation-name"
            value={form.name}
            onChange={(event) => onForm({ ...form, name: event.target.value })}
            placeholder="名称，如：每日仓库体检"
          />
          <textarea
            value={form.prompt}
            onChange={(event) => onForm({ ...form, prompt: event.target.value })}
            placeholder="任务内容，例如：检查未提交变更并输出风险清单"
            rows={3}
          />
          <div className="automation-form-row">
            <select
              value={form.intervalMinutes}
              onChange={(event) =>
                onForm({ ...form, intervalMinutes: Number(event.target.value) })
              }
            >
              <option value={0}>仅手动运行</option>
              <option value={15}>每 15 分钟</option>
              <option value={60}>每小时</option>
              <option value={360}>每 6 小时</option>
              <option value={1440}>每天</option>
            </select>
            <select
              value={form.projectId}
              onChange={(event) => onForm({ ...form, projectId: event.target.value })}
            >
              <option value="">当前目录</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page-view">
      <div className="page-head">
        <div>
          <h1>定时任务</h1>
          <p>
            按计划在本地运行固定任务。应用关闭后不会执行；运行使用 DeepSeek
            与完全自主执行策略，请只在你信任的项目中启用。
          </p>
        </div>
        <div className="page-head-actions">
          <button className="page-ghost" onClick={onClose}>
            返回应用
          </button>
          <button className="page-primary" onClick={startCreate}>
            创建
          </button>
        </div>
      </div>
      <div className="page-toolbar">
        <label className="page-search">
          <Search size={13} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索定时任务…"
          />
        </label>
      </div>
      <div className="automation-list">
        {filtered.length === 0 ? (
          filter ? (
            <div className="page-empty">没有匹配的定时任务</div>
          ) : (
            <div className="page-empty schedule-empty">
              <div className="empty-illustration">
                <CalendarClock size={30} />
              </div>
              <strong>还没有定时任务</strong>
              <span>创建后会在本地按计划运行；应用关闭时不会执行。</span>
              <button className="page-primary" onClick={startCreate}>
                创建第一个任务
              </button>
            </div>
          )
        ) : (
          filtered.map((automation) => (
            <div className="automation-row" key={automation.id}>
              <div className="automation-row-main">
                <strong>{automation.name}</strong>
                <span>
                  {automationScheduleLabel(automation.intervalMinutes)} ·{' '}
                  {automation.lastStatus === 'running'
                    ? '运行中'
                    : automation.lastStatus === 'ok'
                      ? '上次成功'
                      : automation.lastStatus === 'error'
                        ? '上次失败'
                        : '未运行'}
                  {automation.lastRunAt ? ` · ${timeAgo(automation.lastRunAt)}` : ''}
                  {automation.enabled && automation.nextRunAt
                    ? ` · 下次 ${nextRunLabel(automation.nextRunAt)}`
                    : ''}
                </span>
                <small>{automation.prompt}</small>
                {automation.runs?.length ? (
                  <small>
                    最近 {automation.runs.length} 次：
                    {automation.runs.filter((run) => run.status === 'ok').length} 成功 ·{' '}
                    {automation.runs.filter((run) => run.status === 'error').length} 失败
                  </small>
                ) : null}
                {automation.lastError ? (
                  <small className="automation-error">{automation.lastError}</small>
                ) : null}
              </div>
              <div className="automation-row-actions">
                <button
                  className="cap-btn"
                  disabled={automation.lastStatus === 'running'}
                  onClick={() => onRun(automation, true)}
                >
                  运行
                </button>
                <button
                  className="cap-btn"
                  disabled={!automation.intervalMinutes}
                  onClick={() => onToggle(automation)}
                >
                  {automation.enabled ? '暂停' : '启用'}
                </button>
                <button className="cap-btn" onClick={() => startEdit(automation)}>
                  编辑
                </button>
                <button className="cap-btn danger" onClick={() => onRemove(automation)}>
                  删除
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
