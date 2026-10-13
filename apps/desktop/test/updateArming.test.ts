import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installListenGuard, type ListenGuard } from '../src/lib/listenGuard.js';
import { ARM_WINDOW_MS, armOnUpdateDownloaded } from '../src/lib/updateArming.js';

let guard: ListenGuard | null = null;
afterEach(() => {
  guard?.uninstall();
  guard = null;
});

describe('armOnUpdateDownloaded', () => {
  it('arms only while the downloaded update is being handed over (one loopback listener), then disarms', async () => {
    guard = installListenGuard(net.Server.prototype, { audit: () => {} });
    let port = 0;
    const updater = {
      async updateDownloaded() {
        // What MacUpdater does: create a server and listen on 127.0.0.1:0 immediately.
        const s = createServer();
        await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
        port = (s.address() as net.AddressInfo).port;
        s.close();
        return [];
      },
    };
    expect(armOnUpdateDownloaded(updater, guard, { platform: 'darwin' })).toBe(true);
    // Before the download completes nothing may listen (e.g. during a slow download).
    expect(() => createServer().listen(0, '127.0.0.1')).toThrow(/disabled/);
    await updater.updateDownloaded();
    expect(port).toBeGreaterThan(0);
    // Afterwards: disarmed again.
    expect(() => createServer().listen(0, '127.0.0.1')).toThrow(/disabled/);
  });

  it('disarms when the hand-over fails', async () => {
    const g = { armForUpdateInstall: vi.fn(() => disarm), uninstall: () => {} };
    const disarm = vi.fn();
    const updater = { updateDownloaded: async () => { throw new Error('boom'); } };
    armOnUpdateDownloaded(updater, g, { platform: 'darwin' });
    await expect(updater.updateDownloaded()).rejects.toThrow('boom');
    expect(g.armForUpdateInstall).toHaveBeenCalledWith(ARM_WINDOW_MS);
    expect(disarm).toHaveBeenCalled();
  });

  it('does nothing off macOS, or when the updater lacks the hook (fails closed)', () => {
    const g = { armForUpdateInstall: vi.fn(), uninstall: () => {} };
    expect(armOnUpdateDownloaded({ updateDownloaded: async () => [] }, g, { platform: 'win32' })).toBe(false);
    const onUnsupported = vi.fn();
    expect(armOnUpdateDownloaded({}, g, { platform: 'darwin', onUnsupported })).toBe(false);
    expect(onUnsupported).toHaveBeenCalled();
    expect(g.armForUpdateInstall).not.toHaveBeenCalled();
  });

  it('electron-updater (pinned version) still opens the Squirrel proxy inside MacUpdater.updateDownloaded', () => {
    const require = createRequire(import.meta.url);
    const { MacUpdater } = require('electron-updater/out/MacUpdater') as { MacUpdater: { prototype: Record<string, unknown> } };
    const src = String(MacUpdater.prototype.updateDownloaded);
    expect(src).toMatch(/createServer/);
    expect(src).toMatch(/\.listen\(0, "127\.0\.0\.1"/);
  });
});
