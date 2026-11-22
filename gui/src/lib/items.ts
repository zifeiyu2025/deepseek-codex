import type { Item } from '../types';

export function itemOutput(item: Item): string {
  const raw = item.aggregatedOutput ?? item.output ?? item.result ?? '';
  if (typeof raw === 'string') return raw;
  if (raw == null) return '';
  try {
    return JSON.stringify(raw, null, 2);
  } catch {
    return String(raw);
  }
}

export function upsertItem(list: Item[], item: Item): Item[] {
  const index = list.findIndex((entry) => entry.id === item.id);
  if (index < 0) return [...list, item];
  const next = [...list];
  next[index] = { ...next[index], ...item, streaming: false };
  return next;
}

export function appendTextDelta(list: Item[], itemId: string, delta: string): Item[] {
  const index = list.findIndex((entry) => entry.id === itemId);
  if (index < 0) {
    return [...list, { id: itemId, type: 'agentMessage', text: delta, streaming: true }];
  }
  const next = [...list];
  const existing = next[index];
  next[index] = { ...existing, text: (existing.text || '') + delta, streaming: true };
  return next;
}

export function appendReasoningDelta(list: Item[], itemId: string, delta: string): Item[] {
  const index = list.findIndex((entry) => entry.id === itemId);
  if (index < 0) {
    return [
      ...list,
      { id: itemId, type: 'reasoning', summary: [], content: [delta], streaming: true },
    ];
  }
  const next = [...list];
  const existing = next[index];
  const content = [...(existing.content || [])];
  if (content.length === 0) content.push('');
  content[content.length - 1] += delta;
  next[index] = { ...existing, content, streaming: true };
  return next;
}

export function appendOutputDelta(list: Item[], itemId: string, delta: string): Item[] {
  const index = list.findIndex((entry) => entry.id === itemId);
  if (index < 0) return list;
  const next = [...list];
  const existing = next[index];
  next[index] = {
    ...existing,
    aggregatedOutput: (existing.aggregatedOutput || '') + delta,
  };
  return next;
}

const ACTIVITY_TYPES = new Set([
  'reasoning',
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'webSearch',
  'imageGeneration',
]);

export function isActivityItem(item: Item): boolean {
  return ACTIVITY_TYPES.has(item.type);
}

export function activitySummary(list: Item[]): string {
  const steps = list.filter((item) => item.type !== 'reasoning').length;
  if (steps === 0) return '思考过程';
  const commands = list.filter((item) => item.type === 'commandExecution').length;
  const changes = list.filter((item) => item.type === 'fileChange').length;
  const tools = list.filter(
    (item) => item.type === 'mcpToolCall' || item.type === 'dynamicToolCall',
  ).length;
  const web = list.filter((item) => item.type === 'webSearch').length;
  const others = steps - commands - changes - tools - web;
  const parts: string[] = [];
  if (commands) parts.push(`运行了 ${commands} 条命令`);
  if (changes) parts.push(`编辑了 ${changes} 个文件`);
  if (tools) parts.push(`调用了 ${tools} 个工具`);
  if (web) parts.push('搜索了网页');
  if (others > 0) parts.push(`${others} 个步骤`);
  return parts.join(' · ');
}
