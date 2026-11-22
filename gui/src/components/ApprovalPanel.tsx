import { Check, ShieldAlert, X } from 'lucide-react';
import type { ApprovalRequest } from '../types';

export function ApprovalPanel({
  approval,
  onDecide,
}: {
  approval: ApprovalRequest;
  onDecide: (decision: string) => void;
}) {
  const title =
    approval.kind === 'command'
      ? '命令执行需要确认'
      : approval.kind === 'file'
        ? '文件修改需要确认'
        : '需要额外权限';
  return (
    <div className="approval">
      <div className="approval-head">
        <ShieldAlert size={16} />
        <span>{title}</span>
      </div>
      {approval.command ? <pre>{approval.command}</pre> : null}
      {approval.kind === 'permissions' && approval.permissions ? (
        <pre>{JSON.stringify(approval.permissions, null, 2)}</pre>
      ) : null}
      {approval.cwd ? <div className="approval-meta">目录 · {approval.cwd}</div> : null}
      {approval.grantRoot ? <div className="approval-meta">范围 · {approval.grantRoot}</div> : null}
      {approval.reason ? <div className="approval-meta">原因 · {approval.reason}</div> : null}
      <div className="approval-actions">
        <button className="decline" onClick={() => onDecide('decline')}>
          <X size={14} /> 拒绝
        </button>
        <button onClick={() => onDecide('acceptForSession')}>本会话允许</button>
        <button className="accept" onClick={() => onDecide('accept')}>
          <Check size={14} /> {approval.kind === 'permissions' ? '本次允许' : '允许'}
        </button>
      </div>
    </div>
  );
}
