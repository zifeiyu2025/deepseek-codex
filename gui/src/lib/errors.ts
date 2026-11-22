export function friendlyClientError(error: unknown): string {
  const raw = (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']+':\s*(Error:\s*)?/,
    '',
  );
  if (/already has an active writer/i.test(raw)) {
    return '该会话正被另一个 Codex 客户端（如官方桌面端）占用。请在对方关闭该会话或退出后重试，或切换到其他会话。';
  }
  return raw;
}
