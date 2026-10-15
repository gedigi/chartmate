import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without types
import { changelogSection } from '../scripts/changelog-section.mjs';

const sample = [
  '# Changelog',
  '',
  'Intro text.',
  '',
  '## [1.1.0-beta.1] - 2026-11-02',
  '',
  '### Fixed',
  '',
  '- Something.',
  '',
  '## [1.0.0] - 2026-10-14',
  '',
  'The first stable release.',
  '',
  '### Charts',
  '',
  '- Candles.',
  '',
  '## [0.1.2] - 2026-10-01',
  '',
  '- Older.',
  '',
  '[1.0.0]: ../../releases/tag/v1.0.0',
  '',
].join('\n');

describe('changelogSection', () => {
  it('returns the body of the version\'s section, without its heading or the next section', () => {
    expect(changelogSection(sample, '1.0.0')).toBe('The first stable release.\n\n### Charts\n\n- Candles.');
  });

  it('matches pre-release versions exactly (no prefix matches)', () => {
    expect(changelogSection(sample, '1.1.0-beta.1')).toBe('### Fixed\n\n- Something.');
    expect(changelogSection(sample, '1.1.0')).toBeNull();
    expect(changelogSection(sample, '1.0')).toBeNull();
  });

  it('drops link reference definitions at the end of the last section', () => {
    expect(changelogSection(sample, '0.1.2')).toBe('- Older.');
  });

  it('accepts a heading without brackets or date, and a v prefix in the version asked for', () => {
    expect(changelogSection('## 2.0.0\n\n- New.\n', 'v2.0.0')).toBe('- New.');
  });

  it('returns null for a missing version or an empty section', () => {
    expect(changelogSection(sample, '9.9.9')).toBeNull();
    expect(changelogSection('## [3.0.0]\n\n## [2.0.0]\n- x\n', '3.0.0')).toBeNull();
  });
});

describe('CHANGELOG.md', () => {
  const text = readFileSync(new URL('../../../CHANGELOG.md', import.meta.url), 'utf8');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

  it('has an entry for the desktop app\'s version (the release notes include it)', () => {
    expect(changelogSection(text, pkg.version)).toMatch(/\S/);
  });

  it('names no other charting product', () => {
    expect(text).not.toMatch(/tradingview|thinkorswim|metatrader|tradestation|ninjatrader/i);
  });
});

describe('one product version', () => {
  const version = (rel: string) =>
    (JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8')) as { version: string }).version;

  it('the web UI and the server report the desktop app\'s version (their About dialog shows it)', () => {
    const product = version('../package.json');
    expect(version('../../web/package.json')).toBe(product);
    expect(version('../../server/package.json')).toBe(product);
  });
});
