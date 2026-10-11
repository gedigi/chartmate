// Deletes the e2e SQLite database (and its -wal/-shm/-journal files) so every `pnpm e2e` run starts empty.
// Usage: node e2e/reset-db.mjs <dir>   (default dir: test-results)
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'test-results';
mkdirSync(dir, { recursive: true });
for (const f of readdirSync(dir)) {
  if (f.startsWith('e2e.db')) rmSync(join(dir, f), { force: true });
}
