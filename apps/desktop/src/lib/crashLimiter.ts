export type CrashAction = 'reload' | 'error-page' | 'give-up';

/**
 * What to do after a renderer crash, so a crash can never turn into a reload loop:
 * - up to `maxReloads` automatic reloads per sliding `windowMs`;
 * - then the static error page, at most `maxErrorPages` times per window (the page itself could crash);
 * - beyond that, give up (the caller shows a native dialog and closes the window).
 */
export function createCrashPolicy(opts: { maxReloads?: number; maxErrorPages?: number; windowMs?: number; now?: () => number } = {}): { onCrash(): CrashAction } {
  const maxReloads = opts.maxReloads ?? 3;
  const maxErrorPages = opts.maxErrorPages ?? 1;
  const windowMs = opts.windowMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const reloads: number[] = [];
  const errorPages: number[] = [];
  const prune = (list: number[], t: number) => {
    while (list.length > 0 && t - list[0]! >= windowMs) list.shift();
  };
  return {
    onCrash() {
      const t = now();
      prune(reloads, t);
      prune(errorPages, t);
      if (reloads.length < maxReloads) {
        reloads.push(t);
        return 'reload';
      }
      if (errorPages.length < maxErrorPages) {
        errorPages.push(t);
        return 'error-page';
      }
      return 'give-up';
    },
  };
}
