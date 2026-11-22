let completionAudioContext: AudioContext | null = null;

export function playCompletionChime() {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    if (!completionAudioContext || completionAudioContext.state === 'closed') {
      completionAudioContext = new AudioCtx();
    }
    const ctx = completionAudioContext;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const start = ctx.currentTime + 0.02;
    [880, 1174.66].forEach((frequency, index) => {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      const at = start + index * 0.16;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.12, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start(at);
      oscillator.stop(at + 0.24);
    });
  } catch {
    /* audio unavailable */
  }
}
