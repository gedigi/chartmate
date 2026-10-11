const WINDOW_MS = 15 * 60_000;
const PER_IP = 10;
const GLOBAL = 100;
const MAX_TRACKED_IPS = 10_000;

/** In-memory failed-login limiter: ≤ 10 failures per IP and ≤ 100 overall per sliding 15 min. */
export class LoginLimiter {
  private readonly byIp = new Map<string, number[]>();
  private global: number[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  /** True if another attempt from `ip` must be refused. */
  blocked(ip: string): boolean {
    const t = this.now();
    this.global = this.recent(this.global, t);
    const mine = this.recent(this.byIp.get(ip) ?? [], t);
    if (mine.length === 0) this.byIp.delete(ip);
    else this.byIp.set(ip, mine);
    return mine.length >= PER_IP || this.global.length >= GLOBAL;
  }

  recordFailure(ip: string): void {
    const t = this.now();
    this.global.push(t);
    const mine = this.recent(this.byIp.get(ip) ?? [], t);
    mine.push(t);
    this.byIp.set(ip, mine);
    if (this.byIp.size > MAX_TRACKED_IPS) this.prune(t);
  }

  reset(ip: string): void {
    this.byIp.delete(ip);
  }

  private recent(list: number[], t: number): number[] {
    return list.filter((x) => t - x < WINDOW_MS);
  }

  private prune(t: number): void {
    for (const [ip, list] of this.byIp) {
      const r = this.recent(list, t);
      if (r.length === 0) this.byIp.delete(ip);
      else this.byIp.set(ip, r);
    }
  }
}
