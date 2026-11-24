export type RelayTarget = {
  id: string;
  name: string;
};

export function parseAgentMentionPrefix(
  text: string,
): { names: string[]; message: string } | null {
  const match = /^((?:@[^\s@]+\s+)+)([\s\S]+)$/.exec(text);
  if (!match) return null;
  const names = [...match[1].matchAll(/@([^\s@]+)/g)].map((entry) => entry[1]);
  const message = match[2].trim();
  if (!names.length || !message) return null;
  return { names, message };
}

export function uniqueRelayTargets(targets: RelayTarget[]): RelayTarget[] {
  return [
    ...new Map(targets.map((target) => [target.id, target])).values(),
  ];
}

export function buildRelayTurnText(targets: RelayTarget[], message: string): string {
  if (targets.length === 1) {
    return `请调用 send_message 工具，参数 target 使用「${targets[0].name}」，message 使用下面内容：\n---\n${message}\n---\n发送后用 wait_agent 等待该子代理回复，并把结果转述给我；不要自己直接完成这件事。`;
  }
  return `请分别调用 send_message 工具 ${targets.length} 次，每个目标一次，不要合并：\n${targets.map((target, index) => `${index + 1}. target: 「${target.name}」`).join('\n')}\n每次的 message 都使用同一条内容：\n---\n${message}\n---\n发送完全部目标后，用 wait_agent 等待回复并汇总转述给我；不要自己直接完成这件事。`;
}
