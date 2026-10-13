import { describe, expect, it, vi } from 'vitest';
import { FORBIDDEN_SWITCHES, findForbiddenSwitches, sanitizeEnv, STRIPPED_ENV_VARS } from '../src/lib/startupGuards.js';

describe('findForbiddenSwitches', () => {
  const exe = '/Applications/Chartmate.app/Contents/MacOS/Chartmate';

  it('accepts a normal launch (incl. macOS -psn_ args and plain file arguments)', () => {
    expect(findForbiddenSwitches([exe])).toEqual([]);
    expect(findForbiddenSwitches([exe, '-psn_0_12345'])).toEqual([]);
    expect(findForbiddenSwitches([exe, '--some-harmless-flag', 'file.txt'])).toEqual([]);
  });

  it.each([
    '--remote-debugging-port=0', '--remote-debugging-port', '--remote-debugging-pipe', '--remote-debugging-address=0.0.0.0',
    '--remote-allow-origins=*', '--inspect', '--inspect=9229', '--inspect-brk=0', '--inspect-port=1', '--inspect-publish-uid=http',
    '--js-flags=--allow-natives-syntax', '--no-sandbox', '--disable-web-security', '--disable-site-isolation-trials',
    '--ignore-certificate-errors', '--ignore-certificate-errors-spki-list=abc', '--allow-insecure-localhost',
    '--proxy-server=http://evil:8080', '--proxy-pac-url=http://evil/p.pac', '--host-resolver-rules=MAP * 1.2.3.4',
    '--host-rules=MAP * evil', '--load-extension=/tmp/x', '--enable-blink-features=X',
    '--unsafely-treat-insecure-origin-as-secure=http://x', '--renderer-cmd-prefix=gdb', '--utility-cmd-prefix=x',
    '--gpu-launcher=x', '--browser-subprocess-path=/tmp/x', '--log-net-log=/tmp/n.json', '--user-data-dir=/tmp/u',
  ])('rejects %s', (arg) => {
    expect(findForbiddenSwitches([exe, arg])).not.toEqual([]);
  });

  it('is case-insensitive and accepts single-dash and (Windows) slash prefixes', () => {
    expect(findForbiddenSwitches([exe, '--Remote-Debugging-Port=0'])).toEqual(['remote-debugging-port']);
    expect(findForbiddenSwitches([exe, '-remote-debugging-port=0'])).toEqual(['remote-debugging-port']);
    expect(findForbiddenSwitches([exe, '/remote-debugging-port=0'], 'win32')).toEqual(['remote-debugging-port']);
    expect(findForbiddenSwitches([exe, '/remote-debugging-port=0'], 'darwin')).toEqual([]);
  });

  it('stops at "--" (everything after it is a plain argument, as Chromium does)', () => {
    expect(findForbiddenSwitches([exe, '--', '--no-sandbox'])).toEqual([]);
  });

  it('also reports switches Chromium already parsed (app.commandLine.hasSwitch)', () => {
    const has = vi.fn((s: string) => s === 'no-sandbox');
    expect(findForbiddenSwitches([exe], 'darwin', has)).toEqual(['no-sandbox']);
  });

  it('covers the reviewed list', () => {
    expect(FORBIDDEN_SWITCHES).toEqual(expect.arrayContaining([
      'remote-debugging-port', 'remote-debugging-pipe', 'remote-debugging-address', 'remote-allow-origins', 'inspect',
      'js-flags', 'no-sandbox', 'disable-web-security', 'disable-site-isolation-trials', 'ignore-certificate-errors',
      'ignore-certificate-errors-spki-list', 'allow-insecure-localhost', 'proxy-server', 'proxy-pac-url',
      'host-resolver-rules', 'host-rules', 'load-extension', 'enable-blink-features',
      'unsafely-treat-insecure-origin-as-secure', 'renderer-cmd-prefix', 'utility-cmd-prefix', 'gpu-launcher',
      'browser-subprocess-path', 'log-net-log', 'user-data-dir',
    ]));
  });
});

describe('sanitizeEnv', () => {
  it('removes proxy/CA-injection variables and leaves the rest', () => {
    const env: Record<string, string | undefined> = {
      NODE_USE_ENV_PROXY: '1', NODE_USE_SYSTEM_CA: '1', NODE_EXTRA_CA_CERTS: '/tmp/evil.pem', HOME: '/Users/x',
    };
    expect(sanitizeEnv(env).sort()).toEqual(['NODE_EXTRA_CA_CERTS', 'NODE_USE_ENV_PROXY', 'NODE_USE_SYSTEM_CA']);
    expect(env).toEqual({ HOME: '/Users/x' });
    expect(STRIPPED_ENV_VARS).toEqual(['NODE_USE_ENV_PROXY', 'NODE_USE_SYSTEM_CA', 'NODE_EXTRA_CA_CERTS']);
  });
});
