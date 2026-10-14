import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The published image name is pinned here: a move to another owner is a one-line change below plus a
// search and replace in the files this test reads.
const IMAGE = 'ghcr.io/gedigi/chartmate';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), 'utf8');

describe('self-hosting docs use the published image', () => {
  it('compose.yaml defaults to the image and still allows an override', () => {
    expect(read('compose.yaml')).toContain(`image: \${CHARTMATE_IMAGE:-${IMAGE}:latest}`);
  });

  it('the README quick-try line runs the image', () => {
    const line = read('README.md')
      .split('\n')
      .find((l) => l.startsWith('docker run -d --name chartmate -p 127.0.0.1:8787:8787'));
    expect(line).toBe(`docker run -d --name chartmate -p 127.0.0.1:8787:8787 -v chartmate-data:/data ${IMAGE}`);
  });

  it('.env.example documents the same default, commented out', () => {
    const env = read('.env.example');
    expect(env).toContain(`# CHARTMATE_IMAGE=${IMAGE}:latest`);
    expect(env).not.toMatch(/^CHARTMATE_IMAGE=/m);
  });

  it('no self-host doc keeps an <owner>/<repo> placeholder', () => {
    for (const f of ['README.md', 'compose.yaml', '.env.example']) expect(read(f)).not.toMatch(/<owner>/);
  });

  it('every ghcr.io reference in the README and compose.yaml is this image', () => {
    for (const f of ['README.md', 'compose.yaml']) {
      const refs = read(f).match(/ghcr\.io\/[\w./-]+/g) ?? [];
      expect(refs.length).toBeGreaterThan(0);
      for (const r of refs) expect(r.startsWith(IMAGE)).toBe(true);
    }
  });
});
