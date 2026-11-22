import { useState } from 'react';
import type { ReviewTarget } from '../types';
import { Modal } from './Modal';

export function ReviewDialog({
  cwd,
  busy,
  onStart,
  onClose,
}: {
  cwd: string;
  busy: boolean;
  onStart: (target: ReviewTarget) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<ReviewTarget['type']>('uncommittedChanges');
  const [branch, setBranch] = useState('main');
  const [sha, setSha] = useState('');
  const [instructions, setInstructions] = useState('');
  const options: { value: ReviewTarget['type']; title: string; description: string }[] = [
    {
      value: 'uncommittedChanges',
      title: '未提交变更',
      description: '审查工作区的已暂存、未暂存与未跟踪文件',
    },
    { value: 'baseBranch', title: '相对分支', description: '审查当前分支相对某个基线的差异' },
    { value: 'commit', title: '指定提交', description: '审查单个提交引入的变更' },
    { value: 'custom', title: '自定义指令', description: '让审查者按你的要求检查代码' },
  ];
  const target: ReviewTarget | null = (() => {
    if (mode === 'uncommittedChanges') return { type: 'uncommittedChanges' };
    if (mode === 'baseBranch') {
      return branch.trim() ? { type: 'baseBranch', branch: branch.trim() } : null;
    }
    if (mode === 'commit') return sha.trim() ? { type: 'commit', sha: sha.trim() } : null;
    return instructions.trim() ? { type: 'custom', instructions: instructions.trim() } : null;
  })();
  return (
    <Modal onClose={onClose} labelledBy="review-dialog-title">
      <div className="key-card review-card">
        <div className="key-kicker">CODE REVIEW</div>
        <h2 id="review-dialog-title">开始审查</h2>
        <p>引擎将在当前会话中执行审查 · {cwd || '未选择目录'}</p>
        <div className="setting-group">
          {options.map((option) => (
            <button
              key={option.value}
              className={`setting-option ${mode === option.value ? 'selected' : ''}`}
              onClick={() => setMode(option.value)}
            >
              <strong>{option.title}</strong>
              <span>{option.description}</span>
            </button>
          ))}
        </div>
        {mode === 'baseBranch' ? (
          <input
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
            placeholder="基线分支，如 main"
          />
        ) : null}
        {mode === 'commit' ? (
          <input
            value={sha}
            onChange={(event) => setSha(event.target.value)}
            placeholder="提交 SHA"
          />
        ) : null}
        {mode === 'custom' ? (
          <textarea
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            placeholder="例如：重点检查错误处理与并发安全"
            rows={3}
          />
        ) : null}
        <div className="key-actions">
          <button onClick={onClose}>取消</button>
          <button
            className="primary"
            disabled={!target || busy}
            onClick={() => target && onStart(target)}
          >
            {busy ? '启动中…' : '开始审查'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
