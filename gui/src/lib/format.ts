import type { RuntimeSettings } from '../types';

export function automationScheduleLabel(minutes: number): string {
  if (!minutes) return '手动';
  if (minutes === 15) return '每 15 分钟';
  if (minutes === 60) return '每小时';
  if (minutes === 360) return '每 6 小时';
  if (minutes === 1440) return '每天';
  return `每 ${minutes} 分钟`;
}

export function nextRunLabel(next?: number): string {
  if (!next) return '';
  const diff = next * 1000 - Date.now();
  if (diff <= 0) return '即将执行';
  if (diff < 3600_000) return `${Math.max(1, Math.round(diff / 60_000))} 分钟后`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时后`;
  return `${Math.round(diff / 86_400_000)} 天后`;
}

export function textOfContent(content: unknown): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (!part) return '';
        if (part.type === 'text') return part.text || '';
        if (typeof part.text === 'string') return part.text;
        return '';
      })
      .join('');
  }
  return '';
}

export function cleanSnippet(value: string | null | undefined): string {
  return (value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function splitReviewComments(markdown: string): string[] {
  if (!markdown) return [];
  return markdown
    .split(/\n(?=\s*(?:[-*•]|\d+[.)])\s+)/)
    .filter((block) => /^\s*(?:[-*•]|\d+[.)])\s+/.test(block) && block.trim().length > 0);
}

export function timeAgo(seconds?: number): string {
  if (!seconds) return '';
  const diff = Math.max(0, Math.floor(Date.now() / 1000 - seconds));
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

export function formatThreadTime(seconds?: number): string {
  if (!seconds) return '';
  const date = new Date(seconds * 1000);
  const now = new Date();
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  if (date.toDateString() === now.toDateString()) return time;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${time}`;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
}

export function formatTokens(value?: number | null): string {
  if (!value) return '0';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${value}`;
}

export function approvalLabel(policy: RuntimeSettings['approvalPolicy']): string {
  if (policy === 'never') return '自主执行';
  if (policy === 'untrusted') return '全部确认';
  return '按需确认';
}

export function sandboxLabel(sandbox: RuntimeSettings['sandbox']): string {
  if (sandbox === 'read-only') return '只读';
  if (sandbox === 'workspace-write') return '工作区可写';
  return '完全访问';
}

export function sandboxPolicyFor(
  sandbox: RuntimeSettings['sandbox'],
  networkAccess = false,
): Record<string, unknown> {
  if (sandbox === 'read-only') {
    return { type: 'readOnly', networkAccess: false };
  }
  if (sandbox === 'workspace-write') {
    return {
      type: 'workspaceWrite',
      writableRoots: [],
      networkAccess,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
  }
  return { type: 'dangerFullAccess' };
}

export function effortLabel(value: string): string {
  const labels: Record<string, string> = {
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '极高',
    ultra: '极强',
    max: '最大',
  };
  return labels[value] || value;
}

export function collaborationModeLabel(value: string | null | undefined): string {
  return value === 'plan' ? '计划' : '执行';
}
