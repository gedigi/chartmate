import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createAlertNotifier, type NotificationApi, type NotificationLike } from '../src/lib/alertNotifier.js';

function fakeApi(supported = true) {
  const shown: Array<{ options: { title: string; body: string; silent: boolean }; click: () => void }> = [];
  class Fake implements NotificationLike {
    private readonly handlers: Record<string, () => void> = {};
    constructor(readonly options: { title: string; body: string; silent: boolean }) {}
    on(event: 'click' | 'close', listener: () => void) { this.handlers[event] = listener; return this; }
    show() { shown.push({ options: this.options, click: () => this.handlers.click?.() }); }
    static isSupported() { return supported; }
  }
  return { api: Fake as unknown as NotificationApi, shown };
}

describe('alert notifier', () => {
  it('shows the alert as a native notification (plain text, clipped); a click focuses the window', () => {
    const { api, shown } = fakeApi();
    let focused = 0;
    const notify = createAlertNotifier({ Notification: api, focus: () => { focused++; } });
    notify({ title: 'BTC crossed below the trend line', body: `Price 99.0 · ${'x'.repeat(400)}` });
    expect(shown).toHaveLength(1);
    expect(shown[0]!.options.title).toBe('BTC crossed below the trend line');
    expect(shown[0]!.options.body.length).toBe(240);
    expect(shown[0]!.options.silent).toBe(false);
    shown[0]!.click();
    expect(focused).toBe(1);
  });

  it('does nothing where notifications are not supported, and never throws', () => {
    const { api, shown } = fakeApi(false);
    createAlertNotifier({ Notification: api, focus: () => {} })({ title: 't', body: 'b' });
    expect(shown).toEqual([]);
    const errors: unknown[] = [];
    const broken = { isSupported: () => true } as unknown as NotificationApi; // not constructible
    expect(() => createAlertNotifier({ Notification: broken, focus: () => {}, onError: (e) => errors.push(e) })({ title: 't', body: 'b' })).not.toThrow();
    expect(errors).toHaveLength(1);
  });

  it('main.ts hands the server this notifier (no IPC) and sets the Windows app id notifications need', () => {
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
    expect(main).toMatch(/alertNotify: createAlertNotifier\(\{\n\s+Notification,/);
    expect(main).toMatch(/if \(process\.platform === 'win32'\) app\.setAppUserModelId\(product\.appId\);/);
    expect(main).not.toMatch(/ipcMain/);
  });
});
