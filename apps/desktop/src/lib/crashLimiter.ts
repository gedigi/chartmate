/** Sliding-window limit for automatic renderer reloads after crashes (avoids a crash → reload → crash loop). */
export function createCrashLimiter(opts: { max?: number; windowMs?: number; now?: () => number } = {}): { shouldReload(): boolean } {
  const max = opts.max ?? 3;
  const windowMs = opts.windowMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const times: number[] = [];
  return {
    shouldReload() {
      const t = now();
      while (times.length > 0 && t - times[0]! >= windowMs) times.shift();
      if (times.length >= max) return false;
      times.push(t);
      return true;
    },
  };
}
