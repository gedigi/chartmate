import type { RemoteFile } from '../../src/sync/github.js';
import type { RemoteStore } from '../../src/sync/service.js';

/** A sync file with GitHub's rules: a write must name the sha it replaces. */
export class FakeRepo {
  file: RemoteFile | null = null;
  private n = 0;
  writes = 0;
  /** Runs before the next write lands (to simulate another device writing in between). */
  beforeWrite: (() => void) | null = null;
  store(): RemoteStore {
    return {
      read: async () => (this.file ? { ...this.file } : null),
      write: async (text, sha) => {
        const hook = this.beforeWrite;
        this.beforeWrite = null;
        hook?.();
        if ((this.file?.sha ?? null) !== sha) return 'conflict';
        this.writes++;
        this.file = { text, sha: `s${++this.n}` };
        return { sha: this.file.sha };
      },
    };
  }
  docs(): Record<string, { t: number; v?: unknown; deleted?: true }> {
    return this.file ? (JSON.parse(this.file.text) as { docs: Record<string, { t: number }> }).docs : {};
  }
}

