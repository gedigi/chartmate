// Deletes the e2e SQLite database (and its -wal/-shm/-journal files) so every `pnpm e2e` run starts empty.
// Usage: node e2e/reset-db.mjs <dir> <file>   (defaults: test-results, e2e.db)
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'test-results';
const file = process.argv[3] ?? 'e2e.db';
mkdirSync(dir, { recursive: true });
for (const f of readdirSync(dir)) {
  if (f === file || f.startsWith(`${file}-`)) rmSync(join(dir, f), { force: true });
}
