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
    return `请使用 collaboration.send_message 工具，把下面这条消息发送给子代理「${targets[0].name}」（threadId: ${targets[0].id}）：\n---\n${message}\n---\n发送后等待该子代理的回复，并把结果转述给我；不要自己直接完成这件事。`;
  }
  return `请使用 collaboration.send_message 工具，把下面同一条消息分别发送给这些子代理：\n${targets.map((target) => `- 「${target.name}」（threadId: ${target.id}）`).join('\n')}\n消息内容：\n---\n${message}\n---\n每个目标单独调用一次；发送完全部目标后等待回复并汇总转述给我；不要自己直接完成这件事。`;
}
