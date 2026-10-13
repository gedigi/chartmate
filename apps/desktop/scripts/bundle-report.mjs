// Prints the largest packages in the last bundle (from .bundle-meta/main.json written by bundle.mjs).
import { readFileSync } from 'node:fs';

const meta = JSON.parse(readFileSync(new URL('../.bundle-meta/main.json', import.meta.url), 'utf8'));
const agg = {};
for (const out of Object.values(meta.outputs)) {
  for (const [k, v] of Object.entries(out.inputs ?? {})) {
    const m = k.match(/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/);
    const key = m ? m[1] : k.split('/').slice(0, 4).join('/');
    agg[key] = (agg[key] ?? 0) + v.bytesInOutput;
  }
}
for (const [k, v] of Object.entries(agg).sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`${(v / 1024).toFixed(0).padStart(6)} KiB  ${k}`);
