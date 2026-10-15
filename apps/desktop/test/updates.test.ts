import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { menuTemplate } from '../src/lib/menu.js';
import { releaseNotesText, safeVersion } from '../src/lib/releaseNotes.js';
import { isAllowedReleasesUrl, releasesPageUrl } from '../src/lib/releasesPage.js';
import {
  configureUpdater, createUpdateController, HANDOVER_WATCHDOG_MS, INSTALL_WATCHDOG_MS, logLine, STARTUP_CHECK_DELAY_MS, UPDATE_CHECK_INTERVAL_MS, type MessageOptions, type UpdaterPort,
} from '../src/lib/updateController.js';
import { startUpdatesSafely, unsupportedUpdateMessage, updateMenuItems, type UpdateMenuState } from '../src/lib/updateMenu.js';
import { isUpdateRequestAllowed, UPDATE_HOSTS, UPDATE_PARTITION, updateAvailability } from '../src/lib/updatePolicy.js';

describe('releasesPageUrl / isAllowedReleasesUrl', () => {
  it('derives the releases page from an owner/name slug', () => {
    expect(releasesPageUrl('octo-org/chart.mate_2')).toBe('https://github.com/octo-org/chart.mate_2/releases');
  });
  it('rejects anything that is not a plain GitHub slug', () => {
    for (const r of [undefined, '', 'owner', 'owner/', '/repo', 'a/b/c', 'a/..', 'a/.', '-a/b', 'a b/c', 'a/b?x', 'a/b#x', 'a@x/b',
      'evil.com/x', `${'a'.repeat(40)}/b`, 'a/b\n', 42]) {
      expect(releasesPageUrl(r)).toBeNull();
    }
  });
  it('allows only the exact build-time URL, and only if that URL itself is a GitHub releases page', () => {
    const ok = 'https://github.com/o/r/releases';
    expect(isAllowedReleasesUrl(ok, ok)).toBe(true);
    for (const u of [
      'https://github.com/o/r/releases/', 'https://github.com/o/r/releases?x=1', 'https://github.com/o/r/releases#x',
      'http://github.com/o/r/releases', 'https://github.com.evil.com/o/r/releases', 'https://user:pw@github.com/o/r/releases',
      'https://github.com:444/o/r/releases', 'https://github.com/o/other/releases', 'file:///etc/passwd', 'javascript:alert(1)',
    ]) expect(isAllowedReleasesUrl(u, ok)).toBe(false);
    for (const expected of ['', 'https://evil.com/o/r/releases', 'https://github.com/o/r', 'https://github.com/o/r/releases?x']) {
      expect(isAllowedReleasesUrl(expected, expected)).toBe(false);
    }
  });
  it('the web build\'s source code link (apps/web/build/repository.cjs) follows the same slug rules', () => {
    const { repositoryUrl } = createRequire(import.meta.url)('../../web/build/repository.cjs') as { repositoryUrl: (r: unknown) => string | null };
    for (const r of ['octo-org/chart.mate_2', 'o/r', undefined, '', 'owner', 'a/b/c', 'a/..', '-a/b', 'a b/c', 'a/b?x', 'evil.com/x',
      `${'a'.repeat(40)}/b`, 'a/b\n', 42]) {
      const releases = releasesPageUrl(r);
      expect(repositoryUrl(r), String(r)).toBe(releases === null ? null : releases.replace(/\/releases$/, ''));
    }
  });
  it('bundle.mjs uses the same slug check (build/repository.cjs) for __RELEASES_URL__', () => {
    const bundle = readFileSync(new URL('../scripts/bundle.mjs', import.meta.url), 'utf8');
    expect(bundle).toMatch(/require\('\.\.\/build\/repository\.cjs'\)/);
    expect(bundle).toMatch(/__RELEASES_URL__: JSON\.stringify\(releasesPageUrl\(process\.env\.GITHUB_REPOSITORY\) \?\? ''\)/);
  });
});

describe('releaseNotesText (untrusted GitHub HTML → capped plain text)', () => {
  it('turns HTML into plain text, dropping script/style and every tag', () => {
    const html = '<h2>What&#39;s new</h2><p>Faster <b>charts</b> &amp; drawings</p><script>alert(1)</script>'
      + '<style>p{}</style><ul><li>One</li><li>Two &lt;3</li></ul><img src=x onerror=alert(1)>';
    const t = releaseNotesText(html);
    expect(t).toBe("What's new\nFaster charts & drawings\n• One\n• Two <3");
    expect(t).not.toMatch(/<\/?[a-z]|alert/i);
  });
  it('removes control and bidirectional override characters', () => {
    expect(releaseNotesText('a\u202Eb\u0007c\u2066d\u200Fe')).toBe('abcde');
  });
  it('removes every Unicode format (Cf), line separator (Zl) and paragraph separator (Zp) character', () => {
    expect(releaseNotesText('a\u00ADb\u061Cc\u2028d\u2029e\u{E0041}f\u180Eg\u2064h')).toBe('abcdefgh');
  });
  it('caps lines and length', () => {
    const many = Array.from({ length: 50 }, (_, i) => `<p>line ${i}</p>`).join('');
    const t = releaseNotesText(many)!;
    expect(t.split('\n').length).toBeLessThanOrEqual(13);
    expect(t.endsWith('…')).toBe(true);
    expect(releaseNotesText('x'.repeat(5000))!.length).toBeLessThanOrEqual(600);
  });
  it('handles electron-updater\'s array form and empty notes', () => {
    expect(releaseNotesText([{ version: '1.2.0', note: '<p>New</p>' }, { version: '1.1.0', note: null }])).toBe('1.2.0\nNew');
    expect(releaseNotesText(null)).toBeNull();
    expect(releaseNotesText('<p> </p>')).toBeNull();
    expect(releaseNotesText({ evil: true })).toBeNull();
  });
  it('safeVersion accepts semver only', () => {
    expect(safeVersion('1.2.3')).toBe('1.2.3');
    expect(safeVersion('1.2.3-beta.1')).toBe('1.2.3-beta.1');
    for (const v of ['1.2', '<b>1.2.3</b>', '1.2.3\nRestart', 1, null, `1.2.3-${'a'.repeat(80)}`]) expect(safeVersion(v)).toBeNull();
  });
});

describe('update policy', () => {
  const yml = 'owner: o\nrepo: r\nprovider: github\n';
  const base = { isPackaged: true, productAutoUpdate: true, isSigned: true, platform: 'darwin' as NodeJS.Platform, updateConfig: yml, env: {}, winPublisherDn: '' };
  it('updateAvailability explains why updates are off', () => {
    expect(updateAvailability(base)).toBe('enabled');
    expect(updateAvailability({ ...base, env: { CHARTMATE_DISABLE_UPDATES: '1' } })).toBe('disabled-by-env');
    expect(updateAvailability({ ...base, isSigned: false, env: { CHARTMATE_DISABLE_UPDATES: '1' } })).toBe('disabled-by-env');
    expect(updateAvailability({ ...base, isSigned: false })).toBe('unsigned');
    expect(updateAvailability({ ...base, isPackaged: false })).toBe('unavailable');
    expect(updateAvailability({ ...base, productAutoUpdate: false })).toBe('unavailable');
    expect(updateAvailability({ ...base, updateConfig: null })).toBe('unavailable');
    expect(updateAvailability({ ...base, platform: 'win32' })).toBe('unavailable');
    expect(updateAvailability({ ...base, platform: 'win32', updateConfig: `${yml}publisherName: Jane\n`, winPublisherDn: 'CN=Jane, O=Jane, C=PL' })).toBe('enabled');
    expect(updateAvailability({ ...base, platform: 'linux' })).toBe('unavailable');
  });
  it('the updater partition allows HTTPS to the GitHub hosts only, on the default port', () => {
    expect([...UPDATE_HOSTS].sort()).toEqual(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
    for (const u of ['https://github.com/o/r/releases/latest',
      'https://objects.githubusercontent.com/a', 'https://release-assets.githubusercontent.com/a']) {
      expect(isUpdateRequestAllowed(u)).toBe(true);
    }
    for (const u of ['https://api.github.com/x', 'http://github.com/o/r', 'https://github.com:8443/x', 'https://evil.com/x', 'https://github.com.evil.com/x',
      'https://user:pw@github.com/x', 'http://127.0.0.1:1234/x', 'file:///x', 'not a url']) {
      expect(isUpdateRequestAllowed(u)).toBe(false);
    }
  });
  it('electron-updater still downloads through the partition the filter is installed on', () => {
    // Pins the dependency's behavior: if electron-updater ever stops using this partition, the filter is moot.
    const require = createRequire(import.meta.url);
    const out = join(dirname(require.resolve('electron-updater/package.json')), 'out');
    expect(readFileSync(join(out, 'electronHttpExecutor.js'), 'utf8')).toContain(`NET_SESSION_NAME = "${UPDATE_PARTITION}"`);
    const updater = readFileSync(new URL('../src/updater.ts', import.meta.url), 'utf8');
    expect(updater).toMatch(/session\.fromPartition\(UPDATE_PARTITION, \{ cache: false \}\)/);
    // The filter is installed before the controller can trigger the first check.
    expect(updater.indexOf('onBeforeRequest')).toBeLessThan(updater.indexOf('controller.start()'));
    // Direct connections only, like provider traffic (no system or PAC proxy), set before the first check.
    expect(updater).toContain("await s.setProxy({ mode: 'direct' })");
    expect(updater.indexOf("setProxy({ mode: 'direct' })")).toBeLessThan(updater.indexOf('controller.start()'));
  });
  it('the public GitHub provider never calls api.github.com (so it is not allowlisted)', () => {
    const require = createRequire(import.meta.url);
    const src = readFileSync(join(dirname(require.resolve('electron-updater/package.json')), 'out', 'providers', 'GitHubProvider.js'), 'utf8');
    // The latest-release lookup uses baseUrl (github.com) when no custom host is set; the API base is only for others.
    expect(src).toContain('options.host == null || options.host === "github.com"\n            ? (0, util_1.newUrlFromBase)(`${this.basePath}/latest`, this.baseUrl)');
    expect(src.match(/baseApiUrl/g)).toHaveLength(2);
  });
});

describe('configureUpdater (signature checks and downgrades stay at safe defaults)', () => {
  it('sets download/install behavior and never allows a downgrade', () => {
    const u: Record<string, unknown> = { allowDowngrade: true };
    configureUpdater(u as never, '1.1.0');
    expect(u).toEqual({ autoDownload: true, autoInstallOnAppQuit: true, allowPrerelease: false, allowDowngrade: false, forceDevUpdateConfig: false });
    configureUpdater(u as never, '1.2.0-beta.1');
    expect(u.allowPrerelease).toBe(true);
    expect(u.allowDowngrade).toBe(false);
  });
  it('never sets channel (it would allow downgrades), a feed URL or differential download behavior', () => {
    const src = readFileSync(new URL('../src/lib/updateController.ts', import.meta.url), 'utf8')
      + readFileSync(new URL('../src/updater.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/\.channel\s*=|disableDifferentialDownload\s*=|setFeedURL/);
  });
  it('Windows: replaces electron-updater\'s verifier (which skips the check when PowerShell fails) with the fail-closed one', () => {
    const src = readFileSync(new URL('../src/updater.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/verifyUpdateCodeSignature = createWindowsSignatureVerifier\(/);
    expect(src).toContain('expectedDn: __WIN_PUBLISHER_DN__');
    expect(src.match(/verifyUpdateCodeSignature\s*=/g)).toHaveLength(1);
  });
  it('Windows: the verifier gets the version the release advertised (from update-available)', () => {
    const src = readFileSync(new URL('../src/updater.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/expectedVersion: \(\) => advertisedVersion/);
    expect(src).toMatch(/autoUpdater\.on\('update-available', \(info\) => \{\s*advertisedVersion = safeVersion\(info\.version\)/);
  });
  it('macOS: the restart prompt waits for Squirrel.Mac (native update-downloaded)', () => {
    const src = readFileSync(new URL('../src/updater.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/waitForInstallReady: process\.platform === 'darwin'/);
    expect(src).toMatch(/nativeAutoUpdater\.on\('update-downloaded'/);
  });
  it('macOS: checks the downloaded bundle version before the Squirrel.Mac hand-over', () => {
    const src = readFileSync(new URL('../src/updater.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/beforeHandOver: async \(args\) =>[\s\S]*checkDownloadedBundle\(/);
  });
});

describe('logLine', () => {
  it('keeps every log entry on one line (no forged lines from untrusted text)', () => {
    expect(logLine('a\r\nb\nc\rd')).toBe('a\\r\\nb\\nc\\rd');
    expect(logLine('x'.repeat(2000)).length).toBeLessThanOrEqual(500);
    expect(logLine(new Error('boom\nfake line'))).toBe('Error: boom\\nfake line');
    expect(logLine('a\u2028b\u2029c')).toBe('a\\u2028b\\u2029c');
  });
});

describe('startUpdatesSafely', () => {
  it('returns the controller when the updater starts (sync or async)', async () => {
    const c = { id: 1 };
    await expect(startUpdatesSafely(() => c, () => {})).resolves.toEqual({ controller: c, availability: 'enabled' });
    await expect(startUpdatesSafely(async () => c, () => {})).resolves.toEqual({ controller: c, availability: 'enabled' });
  });
  it('a failing updater start is logged and leaves the app running with updates unavailable', async () => {
    const errors: unknown[] = [];
    const r = await startUpdatesSafely(() => { throw new Error('cannot load updater.cjs'); }, (e) => errors.push(e));
    expect(r).toEqual({ controller: null, availability: 'unavailable' });
    await expect(startUpdatesSafely(async () => { throw new Error('setProxy failed'); }, (e) => errors.push(e)))
      .resolves.toEqual({ controller: null, availability: 'unavailable' });
    expect(errors).toHaveLength(2);
    await expect(startUpdatesSafely(() => null, () => {})).resolves.toEqual({ controller: null, availability: 'unavailable' });
  });
});

function labels(items: MenuItemConstructorOptions[]): string[] {
  return items.map((i) => i.label ?? i.role ?? i.type ?? '');
}

describe('update menu (macOS only: the Windows window has no visible menu bar)', () => {
  const handlers = { onCheck: vi.fn(), onToggleAutomatic: vi.fn() };
  it('enabled: check now + a checkbox for automatic checks (macOS title case)', () => {
    const items = updateMenuItems({ state: { kind: 'enabled', automatic: true }, ...handlers });
    expect(labels(items)).toEqual(['Check for Updates…', 'Check for Updates Automatically']);
    expect(items[1]).toMatchObject({ type: 'checkbox', checked: true });
    (items[1]!.click as (i: { checked: boolean }) => void)({ checked: false });
    expect(handlers.onToggleAutomatic).toHaveBeenCalledWith(false);
    (items[0]!.click as () => void)();
    expect(handlers.onCheck).toHaveBeenCalled();
  });
  it('disabled by CHARTMATE_DISABLE_UPDATES: disabled item with the reason', () => {
    const items = updateMenuItems({ state: { kind: 'disabled-by-env' }, ...handlers });
    expect(items.every((i) => i.enabled === false)).toBe(true);
    expect(labels(items).join(' ')).toContain('CHARTMATE_DISABLE_UPDATES');
  });
  it('unsigned / unavailable: the item stays clickable and explains', () => {
    for (const kind of ['unsigned', 'unavailable'] as const) {
      const items = updateMenuItems({ state: { kind }, ...handlers });
      expect(items).toHaveLength(1);
      expect(items[0]!.enabled).not.toBe(false);
    }
    const unsigned = unsupportedUpdateMessage('unsigned', { appName: 'Chartmate', hasReleasesPage: true });
    expect(unsigned.message).toMatch(/signed build/);
    expect(unsigned.buttons).toEqual(['Open Releases Page', 'Close']);
    expect(unsupportedUpdateMessage('unsigned', { appName: 'Chartmate', hasReleasesPage: false }).buttons).toEqual(['OK']);
    expect(unsupportedUpdateMessage('unavailable', { appName: 'Chartmate', hasReleasesPage: true }).message).toMatch(/not available/);
  });
  it('macOS: the update items sit right after About; Windows gets no update menu (it would be unreachable)', () => {
    const updates = { state: { kind: 'enabled', automatic: true } as UpdateMenuState, ...handlers };
    const mac = menuTemplate({ isMac: true, hardened: true, appName: 'Chartmate', updates });
    const appMenu = mac[0]!.submenu as MenuItemConstructorOptions[];
    expect(labels(appMenu).slice(0, 4)).toEqual(['about', 'Check for Updates…', 'Check for Updates Automatically', 'separator']);
    const win = menuTemplate({ isMac: false, hardened: true, appName: 'Chartmate', updates });
    const all = JSON.stringify(win);
    expect(all).not.toMatch(/update/i);
    expect(win.some((m) => m.role === 'help')).toBe(false);
  });
});

/** A fake electron-updater with the events the controller relies on. */
function fakeUpdater() {
  const listeners = new Map<string, ((...a: unknown[]) => void)[]>();
  const u = {
    checks: 0,
    installs: 0,
    result: Promise.resolve({}) as Promise<unknown>,
    on(ev: string, l: (...a: unknown[]) => void) {
      listeners.set(ev, [...(listeners.get(ev) ?? []), l]);
      return u;
    },
    emit(ev: string, ...a: unknown[]) {
      for (const l of listeners.get(ev) ?? []) l(...a);
    },
    /** When set, checkForUpdates behaves like electron-updater on failure: emits 'error', then rejects. */
    failWith: null as Error | null,
    /** Windows-style: quitAndInstall reports a failure synchronously through 'error'. */
    installFailsSync: false,
    checkForUpdates() {
      u.checks += 1;
      if (u.failWith) {
        u.emit('error', u.failWith);
        return Promise.reject(u.failWith);
      }
      return u.result;
    },
    quitAndInstall() {
      u.installs += 1;
      if (u.installFailsSync) u.emit('error', new Error('installer could not be started'));
    },
  };
  return u;
}

function harness(opts: { automatic?: boolean; answer?: number; waitForInstallReady?: boolean } = {}) {
  const updater = fakeUpdater();
  const shown: MessageOptions[] = [];
  const saved: boolean[] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const logs: string[] = [];
  const changes = vi.fn();
  const controller = createUpdateController({
    updater: updater as unknown as UpdaterPort,
    dialog: { show: async (o) => { shown.push(o); return opts.answer ?? 1; } },
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    timers: {
      setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
      clearTimeout: (h) => { (h as { cleared: boolean }).cleared = true; },
    },
    appName: 'Chartmate',
    isMac: true,
    currentVersion: '1.1.0',
    waitForInstallReady: opts.waitForInstallReady ?? false,
    automatic: opts.automatic ?? true,
    saveAutomatic: (on) => { saved.push(on); },
    onChange: changes,
  });
  const live = () => timers.filter((t) => !t.cleared);
  const fire = async (t = live().at(-1)!) => { t.cleared = true; t.fn(); await flush(); };
  return { updater, shown, saved, timers, live, fire, logs, controller, changes };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('update controller', () => {
  it('background: first check after a short delay, then every 6 hours; silent unless an update is ready', async () => {
    const h = harness();
    h.controller.start();
    expect(h.live()).toHaveLength(1);
    expect(h.live()[0]!.ms).toBe(STARTUP_CHECK_DELAY_MS);
    expect(STARTUP_CHECK_DELAY_MS).toBeLessThanOrEqual(60_000);
    await h.fire();
    expect(h.updater.checks).toBe(1);
    expect(h.live()[0]!.ms).toBe(UPDATE_CHECK_INTERVAL_MS);
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(6 * 60 * 60 * 1000);
    h.updater.emit('update-not-available', { version: '1.1.0' });
    h.updater.emit('error', new Error('offline'));
    await flush();
    expect(h.shown).toEqual([]);
    await h.fire();
    expect(h.updater.checks).toBe(2);
    h.updater.emit('update-available', { version: '1.2.0' });
    await flush();
    expect(h.shown).toEqual([]);
  });

  it('background checks off: no timers, but a manual check still works', async () => {
    const h = harness({ automatic: false });
    h.controller.start();
    expect(h.live()).toHaveLength(0);
    await h.controller.checkNow();
    expect(h.updater.checks).toBe(1);
  });

  it('manual: up to date', async () => {
    const h = harness();
    await h.controller.checkNow();
    h.updater.emit('update-not-available', { version: '1.1.0' });
    await flush();
    expect(h.shown).toHaveLength(1);
    expect(h.shown[0]).toMatchObject({ message: 'You’re up to date', detail: 'Chartmate 1.1.0 is the latest version.' });
  });

  it('manual: error dialog is concise; details go to the log only', async () => {
    const h = harness();
    await h.controller.checkNow();
    h.updater.emit('error', new Error('HttpError: 404 <html><script>x</script></html> https://github.com/...'));
    await flush();
    expect(h.shown).toHaveLength(1);
    expect(h.shown[0]!.type).toBe('error');
    expect(`${h.shown[0]!.message} ${h.shown[0]!.detail}`).not.toMatch(/404|html|script/);
    expect(h.logs.join('\n')).toMatch(/404/);
    // A rejected checkForUpdates promise is reported once (the error event), not twice.
    expect(h.shown).toHaveLength(1);
  });

  it('manual: available → "downloading" dialog, then the restart prompt with plain-text notes', async () => {
    const h = harness({ answer: 0 });
    await h.controller.checkNow();
    h.updater.emit('update-available', { version: '1.2.0', releaseNotes: '<p>New <b>things</b></p>' });
    await flush();
    expect(h.shown[0]).toMatchObject({ message: 'Chartmate 1.2.0 is available' });
    expect(h.shown[0]!.detail).toMatch(/downloading/i);
    h.updater.emit('update-downloaded', { version: '1.2.0', releaseNotes: '<p>New <b>things</b></p>' });
    await flush();
    const prompt = h.shown[1]!;
    expect(prompt.message).toBe('Chartmate 1.2.0 is ready to install');
    expect(prompt.detail).toContain('New things');
    expect(prompt.detail).not.toMatch(/<|>/);
    expect(prompt.buttons).toEqual(['Restart Now', 'Later']);
    expect(prompt.cancelId).toBe(1);
    expect(h.updater.installs).toBe(1);
  });

  it('"Later" keeps the update for install on quit; no further checks run (the macOS hand-over is single use)', async () => {
    const h = harness({ answer: 1 });
    h.controller.start();
    await h.fire();
    h.updater.emit('update-available', { version: '1.2.0' });
    h.updater.emit('update-downloaded', { version: '1.2.0' });
    await flush();
    expect(h.shown).toHaveLength(1);
    expect(h.updater.installs).toBe(0);
    await h.fire();
    await h.fire();
    expect(h.updater.checks).toBe(1);
    expect(h.shown).toHaveLength(1);
    // A manual check re-offers the restart instead of checking again.
    await h.controller.checkNow();
    await flush();
    expect(h.updater.checks).toBe(1);
    expect(h.shown).toHaveLength(2);
    expect(h.shown[1]!.message).toBe('Chartmate 1.2.0 is ready to install');
  });

  it('manual check while downloading says so instead of starting another check', async () => {
    const h = harness();
    await h.controller.checkNow();
    h.updater.emit('update-available', { version: '1.2.0' });
    await flush();
    await h.controller.checkNow();
    await flush();
    expect(h.updater.checks).toBe(1);
    expect(h.shown.at(-1)!.message).toBe('Chartmate 1.2.0 is downloading');
  });

  it('a failed install hand-over (error after download) allows a later retry', async () => {
    const h = harness();
    await h.controller.checkNow();
    h.updater.emit('update-available', { version: '1.2.0' });
    h.updater.emit('update-downloaded', { version: '1.2.0' });
    await flush();
    h.updater.emit('error', new Error('Squirrel failed'));
    await flush();
    expect(h.controller.phase).toBe('idle');
  });

  it('a check that yields no result (updater inactive) does not get stuck', async () => {
    const h = harness();
    h.updater.result = Promise.resolve(null);
    await h.controller.checkNow();
    await flush();
    expect(h.controller.phase).toBe('idle');
    expect(h.shown).toHaveLength(1);
    expect(h.shown[0]!.type).toBe('error');
  });

  it('untrusted versions never reach a dialog verbatim', async () => {
    const h = harness();
    await h.controller.checkNow();
    h.updater.emit('update-available', { version: '<b>9.9.9</b>\nClick here' });
    await flush();
    expect(h.shown[0]!.message).toBe('A new version of Chartmate is available');
  });

  it('toggling automatic checks persists the choice and starts or stops the schedule', async () => {
    const h = harness({ automatic: false });
    h.controller.start();
    h.controller.setAutomatic(true);
    expect(h.saved).toEqual([true]);
    expect(h.controller.automatic).toBe(true);
    expect(h.live()).toHaveLength(1);
    expect(h.changes).toHaveBeenCalled();
    h.controller.setAutomatic(false);
    expect(h.saved).toEqual([true, false]);
    expect(h.live()).toHaveLength(0);
  });

  it('electron-updater style failure (error event, then rejection) shows exactly one dialog', async () => {
    const h = harness();
    h.updater.failWith = new Error('net::ERR_INTERNET_DISCONNECTED');
    await h.controller.checkNow();
    await flush();
    await flush();
    expect(h.shown).toHaveLength(1);
    expect(h.shown[0]!.message).toBe('Couldn’t check for updates');
    expect(h.controller.phase).toBe('idle');
  });

  it('a failure while downloading says the download failed', async () => {
    const h = harness();
    await h.controller.checkNow();
    h.updater.emit('update-available', { version: '1.2.0' });
    await flush();
    h.updater.emit('error', new Error('sha512 checksum mismatch'));
    await flush();
    expect(h.shown.at(-1)).toMatchObject({ type: 'error', message: 'Couldn’t download the update' });
    expect(h.shown.at(-1)!.detail).not.toMatch(/sha512/);
  });

  it('macOS-style: an error after Restart Now (Squirrel hand-over failed) is reported, then a later check can retry', async () => {
    const h = harness({ answer: 0 });
    h.controller.start();
    await h.fire();
    h.updater.emit('update-available', { version: '1.2.0' });
    h.updater.emit('update-downloaded', { version: '1.2.0' });
    await flush();
    expect(h.updater.installs).toBe(1);
    expect(h.controller.phase).toBe('installing');
    h.updater.emit('error', new Error('Squirrel: code signature did not match'));
    await flush();
    expect(h.shown.at(-1)).toMatchObject({ type: 'error', message: 'Couldn’t install the update' });
    expect(h.shown.at(-1)!.detail).not.toMatch(/Squirrel|signature/);
    expect(h.controller.phase).toBe('idle');
    await h.controller.checkNow();
    expect(h.updater.checks).toBe(2);
  });

  it('Windows-style: quitAndInstall failing synchronously is reported once', async () => {
    const h = harness({ answer: 0 });
    h.updater.installFailsSync = true;
    await h.controller.checkNow();
    h.updater.emit('update-available', { version: '1.2.0' });
    h.updater.emit('update-downloaded', { version: '1.2.0' });
    await flush();
    await flush();
    const errors = h.shown.filter((m) => m.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe('Couldn’t install the update');
    expect(h.controller.phase).toBe('idle');
  });

  it('an error after a download the user has not acted on stays silent (logged; retried later)', async () => {
    const h = harness({ answer: 1 });
    h.controller.start();
    await h.fire();
    h.updater.emit('update-available', { version: '1.2.0' });
    h.updater.emit('update-downloaded', { version: '1.2.0' });
    await flush();
    h.updater.emit('error', new Error('Squirrel failed'));
    await flush();
    expect(h.shown.filter((m) => m.type === 'error')).toHaveLength(0);
    expect(h.controller.phase).toBe('idle');
  });

  it('stop() cancels the schedule (before quitting) and Restart Now stops it too', async () => {
    const h = harness();
    h.controller.start();
    expect(h.live()).toHaveLength(1);
    h.controller.stop();
    expect(h.live()).toHaveLength(0);
    const r = harness({ answer: 0 });
    r.controller.start();
    await r.fire();
    r.updater.emit('update-downloaded', { version: '1.2.0' });
    await flush();
    expect(r.updater.installs).toBe(1);
    expect(r.live().filter((t) => t.ms !== INSTALL_WATCHDOG_MS)).toHaveLength(0);
  });

  it('Windows dialogs use sentence case', async () => {
    const updater = fakeUpdater();
    const shown: MessageOptions[] = [];
    createUpdateController({
      updater: updater as unknown as UpdaterPort,
      dialog: { show: async (o) => { shown.push(o); return 1; } },
      log: { info() {}, warn() {}, error() {} },
      timers: { setTimeout: () => 0, clearTimeout() {} },
      appName: 'Chartmate', isMac: false, currentVersion: '1.1.0', automatic: false, saveAutomatic() {},
    });
    updater.emit('update-downloaded', { version: '1.2.0' });
    await flush();
    expect(shown[0]!.buttons).toEqual(['Restart now', 'Later']);
  });

  it('a hand-over failure while the restart prompt is open: Restart Now reports it once and does not install', async () => {
    const updater = fakeUpdater();
    const shown: MessageOptions[] = [];
    let answer: (n: number) => void = () => {};
    const c = createUpdateController({
      updater: updater as unknown as UpdaterPort,
      dialog: { show: (o) => { shown.push(o); return o.type === 'error' ? Promise.resolve(0) : new Promise<number>((r) => { answer = r; }); } },
      log: { info() {}, warn() {}, error() {} },
      timers: { setTimeout: () => 0, clearTimeout() {} },
      appName: 'Chartmate', isMac: true, currentVersion: '1.1.0', automatic: false, saveAutomatic() {},
    });
    await c.checkNow();
    updater.emit('update-available', { version: '1.2.0' });
    updater.emit('update-downloaded', { version: '1.2.0' });
    await flush();
    expect(shown.at(-1)!.message).toBe('Chartmate 1.2.0 is ready to install');
    updater.emit('error', new Error('Squirrel: app is read-only'));
    await flush();
    answer(0);
    await flush();
    await flush();
    expect(updater.installs).toBe(0);
    const errors = shown.filter((m) => m.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe('Couldn’t install the update');
  });

  it('a version whose install failed is not offered again in this session', async () => {
    const h = harness({ answer: 0 });
    h.updater.installFailsSync = true;
    h.controller.start();
    await h.fire();
    h.updater.emit('update-available', { version: '1.2.0' });
    h.updater.emit('update-downloaded', { version: '1.2.0' });
    await flush();
    await flush();
    const prompts = () => h.shown.filter((m) => m.message.endsWith('is ready to install'));
    expect(prompts()).toHaveLength(1);
    // The next background cycle downloads the same version again: no new prompt.
    await h.fire((h.live().filter((t) => t.ms === UPDATE_CHECK_INTERVAL_MS)).at(-1));
    h.updater.emit('update-available', { version: '1.2.0' });
    h.updater.emit('update-downloaded', { version: '1.2.0' });
    await flush();
    expect(prompts()).toHaveLength(1);
    expect(h.updater.installs).toBe(1);
    // A newer version is offered normally.
    await h.fire((h.live().filter((t) => t.ms === UPDATE_CHECK_INTERVAL_MS)).at(-1));
    h.updater.installFailsSync = false;
    h.updater.emit('update-available', { version: '1.3.0' });
    h.updater.emit('update-downloaded', { version: '1.3.0' });
    await flush();
    expect(prompts()).toHaveLength(2);
  });

  it('macOS: the prompt waits for Squirrel.Mac; a failed hand-over before that never shows a dead prompt', async () => {
    const h = harness({ answer: 1, waitForInstallReady: true });
    h.controller.start();
    await h.fire();
    h.updater.emit('update-available', { version: '1.2.0' });
    h.updater.emit('update-downloaded', { version: '1.2.0' });
    await flush();
    expect(h.shown).toHaveLength(0);
    h.updater.emit('error', new Error('Squirrel: could not write to /Applications'));
    await flush();
    expect(h.shown).toHaveLength(0); // background: logged only
    expect(h.controller.phase).toBe('idle');
    // Next cycle: Squirrel succeeds, so the prompt appears.
    await h.fire((h.live().filter((t) => t.ms === UPDATE_CHECK_INTERVAL_MS)).at(-1));
    h.updater.emit('update-available', { version: '1.2.0' });
    h.updater.emit('update-downloaded', { version: '1.2.0' });
    await flush();
    expect(h.shown).toHaveLength(0);
    h.updater.emit('install-ready');
    await flush();
    expect(h.shown.map((m) => m.message)).toEqual(['Chartmate 1.2.0 is ready to install']);
  });

  it('macOS: a hand-over failure after a manual check is reported', async () => {
    const h = harness({ waitForInstallReady: true });
    await h.controller.checkNow();
    h.updater.emit('update-available', { version: '1.2.0' });
    await flush();
    h.updater.emit('update-downloaded', { version: '1.2.0' });
    h.updater.emit('error', new Error('Squirrel failed'));
    await flush();
    expect(h.shown.at(-1)).toMatchObject({ type: 'error', message: 'Couldn’t install the update' });
  });

  it('macOS: a hand-over that never ends times out, marks the version failed and resumes the schedule', async () => {
    const h = harness({ answer: 0, waitForInstallReady: true });
    h.controller.start();
    await h.fire();
    h.updater.emit('update-available', { version: '1.2.0' });
    h.updater.emit('update-downloaded', { version: '1.2.0' });
    await flush();
    expect(HANDOVER_WATCHDOG_MS).toBe(10 * 60_000);
    const watchdog = h.live().find((t) => t.ms === HANDOVER_WATCHDOG_MS)!;
    expect(watchdog).toBeDefined();
    await h.fire(watchdog);
    expect(h.controller.phase).toBe('idle');
    expect(h.logs.join('\n')).toMatch(/hand-over .*timed out/);
    expect(h.shown).toEqual([]); // background: logged only
    // The schedule still runs, and the same version is not offered again in this session.
    const next = h.live().filter((t) => t.ms === UPDATE_CHECK_INTERVAL_MS).at(-1)!;
    expect(next).toBeDefined();
    await h.fire(next);
    expect(h.updater.checks).toBe(2);
    h.updater.emit('update-available', { version: '1.2.0' });
    h.updater.emit('update-downloaded', { version: '1.2.0' });
    await flush();
    // A late install-ready from the timed-out hand-over (or this one) is what clears the mark.
    h.updater.emit('install-ready');
    await flush();
    expect(h.shown.map((m) => m.message)).toEqual(['Chartmate 1.2.0 is ready to install']);
  });

  it('stop() (quitting) clears the schedule and both watchdogs', async () => {
    const h = harness({ answer: 0, waitForInstallReady: true });
    h.controller.start();
    h.updater.emit('update-available', { version: '1.2.0' });
    h.updater.emit('update-downloaded', { version: '1.2.0' });
    expect(h.live().some((t) => t.ms === HANDOVER_WATCHDOG_MS)).toBe(true);
    h.controller.stop();
    expect(h.live()).toEqual([]);

    const w = harness({ answer: 0 });
    w.updater.emit('update-available', { version: '1.2.0' });
    w.updater.emit('update-downloaded', { version: '1.2.0' });
    await flush();
    expect(w.live().some((t) => t.ms === INSTALL_WATCHDOG_MS)).toBe(true);
    w.controller.stop();
    expect(w.live()).toEqual([]);
  });

  it('macOS: the hand-over watchdog stops once Squirrel.Mac reports ready or fails', async () => {
    for (const end of ['install-ready', 'error'] as const) {
      const h = harness({ waitForInstallReady: true });
      h.updater.emit('update-available', { version: '1.2.0' });
      h.updater.emit('update-downloaded', { version: '1.2.0' });
      if (end === 'error') h.updater.emit('error', new Error('Squirrel failed'));
      else h.updater.emit('install-ready');
      await flush();
      expect(h.live().filter((t) => t.ms === HANDOVER_WATCHDOG_MS), end).toEqual([]);
    }
  });

  it('macOS: "Check for Updates…" while the update is being handed over says so, then reports how it ends', async () => {
    const h = harness({ waitForInstallReady: true });
    h.updater.emit('update-available', { version: '1.2.0' });
    h.updater.emit('update-downloaded', { version: '1.2.0' });
    await h.controller.checkNow();
    expect(h.updater.checks).toBe(0);
    expect(h.shown.at(-1)).toMatchObject({ type: 'info', message: 'Chartmate 1.2.0 is being prepared' });
    await h.fire(h.live().find((t) => t.ms === HANDOVER_WATCHDOG_MS)!);
    expect(h.shown.at(-1)).toMatchObject({ type: 'error', message: 'Couldn’t install the update' });
  });

  it('a download promise that rejects never surfaces as an unhandled rejection (errors arrive as events)', async () => {
    const h = harness();
    const downloadPromise = Promise.reject(new Error('download failed'));
    h.updater.result = Promise.resolve({ downloadPromise });
    await h.controller.checkNow();
    await flush();
    await flush();
  });

  it('watchdog: "installing" that never quits returns to idle after 60 s', async () => {
    const h = harness({ answer: 0 });
    await h.controller.checkNow();
    h.updater.emit('update-available', { version: '1.2.0' });
    h.updater.emit('update-downloaded', { version: '1.2.0' });
    await flush();
    expect(h.controller.phase).toBe('installing');
    const watchdog = h.live().find((t) => t.ms === INSTALL_WATCHDOG_MS)!;
    expect(INSTALL_WATCHDOG_MS).toBe(60_000);
    await h.fire(watchdog);
    expect(h.controller.phase).toBe('idle');
    expect(h.logs.join('\n')).toMatch(/did not quit/);
  });

  it('only one restart prompt at a time', async () => {
    const h = harness();
    let release: (n: number) => void = () => {};
    const shown: MessageOptions[] = [];
    const c = createUpdateController({
      updater: h.updater as unknown as UpdaterPort,
      dialog: { show: (o) => { shown.push(o); return new Promise<number>((r) => { release = r; }); } },
      log: { info() {}, warn() {}, error() {} },
      timers: { setTimeout: () => 0, clearTimeout() {} },
      appName: 'Chartmate', isMac: true, currentVersion: '1.1.0', automatic: false, saveAutomatic() {},
    });
    h.updater.emit('update-downloaded', { version: '1.2.0' });
    await c.checkNow();
    await c.checkNow();
    expect(shown).toHaveLength(1);
    release(1);
  });
});

describe('shell.openExternal', () => {
  it('is called in exactly one place, for the validated releases page', () => {
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
    expect(main.match(/openExternal\(/g)).toHaveLength(1);
    expect(main).toMatch(/const hasReleasesPage = isAllowedReleasesUrl\(url, url\);[\s\S]*if \(hasReleasesPage && response === 0\) \{\s*await shell\.openExternal\(url\)/);
    for (const f of ['../src/updater.ts', '../src/lib/updateController.ts', '../src/lib/updateMenu.ts', '../src/lib/menu.ts']) {
      expect(readFileSync(new URL(f, import.meta.url), 'utf8')).not.toMatch(/openExternal|executeJavaScript|webContents|ipcMain/);
    }
  });
});
