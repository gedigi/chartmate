import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The published image name and the download URLs are pinned here: a move to another owner is a change to these
// constants plus a search and replace in the files this test reads.
const IMAGE = 'ghcr.io/gedigi/chartmate';
// The repository the image is built from, as `gh attestation verify --repo` takes it.
const REPO_SLUG = 'gedigi/chartmate';
// Until a release carries compose.yaml / env.example as assets (desktop.yml attaches them from the next release
// on), the README downloads them from main. CONTRIBUTING's release checklist tracks switching to RELEASE_DOWNLOAD.
const RAW_MAIN = 'https://raw.githubusercontent.com/gedigi/chartmate/main';
const RELEASE_DOWNLOAD = 'https://github.com/gedigi/chartmate/releases/latest/download';
// A reference to the image: optional tag, optional digest, nothing else.
const IMAGE_REF = /^ghcr\.io\/gedigi\/chartmate(?::[\w.-]+)?(?:@sha256:[0-9a-f]{64})?$/;

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), 'utf8');

describe('self-hosting docs use the published image', () => {
  it('compose.yaml defaults to the image and still allows an override', () => {
    expect(read('compose.yaml')).toContain(`image: \${CHARTMATE_IMAGE:-${IMAGE}:latest}`);
  });

  it('the README quick-try line runs the image', () => {
    const line = read('README.md')
      .split('\n')
      .find((l) => l.startsWith('docker run -d --name chartmate -p 127.0.0.1:8787:8787'));
    expect(line).toBe(`docker run -d --name chartmate -p 127.0.0.1:8787:8787 -v chartmate-data:/data ${IMAGE}:latest`);
  });

  it('the README downloads compose.yaml and the .env template from the latest release, never over an existing .env', () => {
    const readme = read('README.md');
    expect(readme).toContain(`curl -fsSLO ${RELEASE_DOWNLOAD}/compose.yaml\n`);
    expect(readme).toContain(`curl -fsSL -o .env.example ${RELEASE_DOWNLOAD}/env.example\n`);
    expect(readme).toContain('[ -e .env ] || install -m 600 .env.example .env');
    expect(readme).not.toMatch(/-o \.env(?:\s|$)/m);
    // Every download URL in the README is one of the two pinned locations.
    for (const url of readme.match(/https:\/\/(?:raw\.githubusercontent\.com|github\.com)\/\S*\/(?:compose\.yaml|\.?env\.example)/g) ?? []) {
      expect([RAW_MAIN, RELEASE_DOWNLOAD].some((base) => url.startsWith(`${base}/`)), url).toBe(true);
    }
  });

  it('the README verifies the attestation of a digest, not a tag', () => {
    const readme = read('README.md');
    expect(readme).toContain(`gh attestation verify oci://${IMAGE}@sha256:<digest> --repo ${REPO_SLUG}`);
    expect(readme).not.toMatch(/gh attestation verify oci:\/\/\S+:[\w.-]+ /);
  });

  it('.env.example documents the same default, commented out', () => {
    const env = read('.env.example');
    expect(env).toContain(`# CHARTMATE_IMAGE=${IMAGE}:latest`);
    expect(env).not.toMatch(/^CHARTMATE_IMAGE=/m);
  });

  it('no self-host doc keeps an <owner>/<repo> placeholder', () => {
    for (const f of ['README.md', 'compose.yaml', '.env.example']) expect(read(f)).not.toMatch(/<owner>/);
  });

  it('every ghcr.io reference in the README, compose.yaml and .env.example is this image', () => {
    for (const f of ['README.md', 'compose.yaml', '.env.example']) {
      // A documented digest placeholder (`@sha256:<digest>`) stands for a real one.
      const text = read(f).replaceAll('@sha256:<digest>', `@sha256:${'0'.repeat(64)}`);
      const refs = text.match(/ghcr\.io\/[\w./:@-]*[\w]/g) ?? [];
      expect(refs.length).toBeGreaterThan(0);
      for (const r of refs) expect(r, `${f}: ${r}`).toMatch(IMAGE_REF);
    }
    expect(IMAGE_REF.test(`${IMAGE}:1.0.0@sha256:${'a'.repeat(64)}`)).toBe(true);
    for (const bad of [`${IMAGE}x`, `${IMAGE}/other`, 'ghcr.io/someone/chartmate', `${IMAGE}@sha256:abc`]) {
      expect(IMAGE_REF.test(bad), bad).toBe(false);
    }
  });

  it('names the owner only in the image, the two download bases and the attestation --repo, in every doc', () => {
    const docs = ['README.md', 'CONTRIBUTING.md', 'AGENTS.md', 'SECURITY.md', 'CHANGELOG.md', 'compose.yaml', '.env.example',
      ...readdirSync(fileURLToPath(new URL('../../../docs', import.meta.url))).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`)];
    const owner = REPO_SLUG.split('/')[0]!;
    for (const f of docs) {
      const rest = read(f)
        .replaceAll(`--repo ${REPO_SLUG}`, '')
        .replaceAll(`--signer-workflow ${REPO_SLUG}/.github/workflows/`, '')
        .replaceAll(`${RAW_MAIN}/`, '')
        .replaceAll(`${RELEASE_DOWNLOAD}/`, '')
        .replace(/ghcr\.io\/[\w./:@<>-]*[\w>]/g, (ref) => (IMAGE_REF.test(ref.replace('@sha256:<digest>', `@sha256:${'0'.repeat(64)}`)) ? '' : ref));
      expect(rest.includes(owner), `${f} names ${owner} outside the pinned forms`).toBe(false);
    }
  });
});
