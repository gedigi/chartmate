import { createServer, Server } from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installListenGuard, type ListenGuard } from '../src/lib/listenGuard.js';

let guard: ListenGuard | null = null;
afterEach(() => {
  guard?.uninstall();
  guard = null;
});

const listen = (s: net.Server, ...args: unknown[]) => new Promise<number>((resolve, reject) => {
  s.once('error', reject);
  (s.listen as (...a: unknown[]) => void)(...args, () => resolve((s.address() as net.AddressInfo).port));
});

describe('listen guard', () => {
  it('refuses every listener by default (TCP, any host, IPC paths)', () => {
    const audit = vi.fn();
    guard = installListenGuard(net.Server.prototype, { audit });
    expect(() => createServer().listen(0, '127.0.0.1')).toThrow(/disabled/);
    expect(() => net.createServer().listen(0)).toThrow(/disabled/);
    expect(() => net.createServer().listen({ port: 0, host: '0.0.0.0' })).toThrow(/disabled/);
    expect(() => net.createServer().listen('/tmp/x.sock')).toThrow(/disabled/);
    expect(audit).toHaveBeenCalledWith(expect.stringMatching(/refused/));
  });

  it('allows exactly one loopback listener on an ephemeral port while an update install is armed', async () => {
    const audit = vi.fn();
    guard = installListenGuard(net.Server.prototype, { audit });
    const disarm = guard.armForUpdateInstall();
    const s = createServer();
    const port = await listen(s, 0, '127.0.0.1');
    expect(port).toBeGreaterThan(0);
    expect(audit).toHaveBeenCalledWith(expect.stringMatching(/allowed loopback listener .*127\.0\.0\.1:\d+/));
    // Single use: a second listener is refused even while still armed.
    expect(() => createServer().listen(0, '127.0.0.1')).toThrow(/disabled/);
    await new Promise((r) => s.close(r));
    disarm();
  });

  it('never allows a non-loopback host, a fixed port or an IPC path, even when armed', () => {
    guard = installListenGuard(net.Server.prototype, { audit: () => {} });
    guard.armForUpdateInstall();
    expect(() => createServer().listen(0, '0.0.0.0')).toThrow(/disabled/);
    expect(() => createServer().listen(0)).toThrow(/disabled/); // no host = all interfaces
    expect(() => createServer().listen(8787, '127.0.0.1')).toThrow(/disabled/);
    expect(() => createServer().listen('/tmp/y.sock')).toThrow(/disabled/);
  });

  it('accepts the options form and ::1', async () => {
    guard = installListenGuard(net.Server.prototype, { audit: () => {} });
    guard.armForUpdateInstall();
    const s = createServer();
    await listen(s, { port: 0, host: '::1' }).catch(() => 0); // ::1 may be unavailable on CI hosts
    s.close();
  });

  it('expires and can be disarmed', () => {
    let now = 0;
    guard = installListenGuard(net.Server.prototype, { audit: () => {}, now: () => now, armMs: 1000 });
    guard.armForUpdateInstall();
    now = 2000;
    expect(() => createServer().listen(0, '127.0.0.1')).toThrow(/disabled/);
    const disarm = guard.armForUpdateInstall();
    disarm();
    expect(() => createServer().listen(0, '127.0.0.1')).toThrow(/disabled/);
  });

  it('uninstall restores the original listen', async () => {
    guard = installListenGuard(net.Server.prototype, { audit: () => {} });
    guard.uninstall();
    guard = null;
    const s: Server = createServer();
    await listen(s, 0, '127.0.0.1');
    s.close();
  });
});
