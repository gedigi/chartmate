import { describe, expect, it, vi } from 'vitest';
import {
  FORBIDDEN_ENV_VARS, FORBIDDEN_SWITCHES, findForbiddenEnv, findForbiddenSwitches, runStartupGuards, type StartupGuardDeps,
} from '../src/lib/startupGuards.js';

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
    // second review round
    '--ssl-key-log-file=/tmp/keys', '--enable-features=X', '--disable-features=TrustedDOMTypes', '--disable-gpu-sandbox',
    '--allow-file-access-from-files', '--allow-running-insecure-content', '--disable-blink-features=X',
    '--force-fieldtrials=X/Y', '--single-process', '--no-zygote', '--disable-setuid-sandbox', '--ssl-version-max=tls1',
    '--proxy-bypass-list=*', '--remote-debugging-targets=x', '--enable-automation', '--disk-cache-dir=/tmp/c',
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

describe('findForbiddenEnv', () => {
  it('reports proxy/CA/key-log variables that are set (non-empty)', () => {
    expect(FORBIDDEN_ENV_VARS).toEqual(['NODE_USE_ENV_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSLKEYLOGFILE']);
    expect(findForbiddenEnv({ HOME: '/x', HTTPS_PROXY: 'http://p' })).toEqual([]);
    expect(findForbiddenEnv({ NODE_USE_ENV_PROXY: '1', SSLKEYLOGFILE: '/tmp/k', NODE_EXTRA_CA_CERTS: ' ' }))
      .toEqual(['NODE_USE_ENV_PROXY', 'SSLKEYLOGFILE']);
    expect(findForbiddenEnv({ NODE_USE_SYSTEM_CA: '1', NODE_EXTRA_CA_CERTS: '/tmp/ca.pem' })).toEqual(['NODE_EXTRA_CA_CERTS']);
  });
});

describe('runStartupGuards', () => {
  const deps = (over: Partial<StartupGuardDeps> = {}) => {
    const calls = { errors: [] as [string, string][], stderr: [] as string[], exit: [] as number[] };
    const d: StartupGuardDeps = {
      hardened: true, checkSwitches: true, argv: ['/app'], env: {}, platform: 'darwin', productName: 'Chartmate',
      showError: (t, c) => { calls.errors.push([t, c]); },
      writeStderr: (l) => { calls.stderr.push(l); },
      exit: ((code: number) => { calls.exit.push(code); throw new Error(`exit ${code}`); }) as (code: number) => never,
      ...over,
    };
    return { d, calls };
  };

  it('does nothing for a clean hardened start or for any unhardened (dev bundle, unpackaged) start', () => {
    const a = deps();
    runStartupGuards(a.d);
    expect(a.calls.exit).toEqual([]);
    const b = deps({ hardened: false, env: { NODE_USE_ENV_PROXY: '1' }, argv: ['/app', '--no-sandbox'] });
    runStartupGuards(b.d);
    expect(b.calls.exit).toEqual([]);
  });

  it('shows an error box naming the variable, writes stderr, exits 1', () => {
    const { d, calls } = deps({ env: { NODE_USE_ENV_PROXY: '1' } });
    expect(() => runStartupGuards(d)).toThrow('exit 1');
    expect(calls.exit).toEqual([1]);
    expect(calls.stderr[0]).toMatch(/forbidden environment variable\(s\): NODE_USE_ENV_PROXY/);
    expect(calls.errors).toHaveLength(1);
    expect(calls.errors[0]![0]).toBe('Chartmate cannot start');
    expect(calls.errors[0]![1]).toContain('NODE_USE_ENV_PROXY');
  });

  it('shows an error box naming the switch, writes stderr, exits 1', () => {
    const { d, calls } = deps({ argv: ['/app', '--remote-debugging-port=0'] });
    expect(() => runStartupGuards(d)).toThrow('exit 1');
    expect(calls.errors[0]![1]).toContain('--remote-debugging-port');
    expect(calls.stderr[0]).toMatch(/forbidden command-line switch\(es\): --remote-debugging-port/);
  });

  it('the TEST-ONLY copy skips the switch check but still checks the environment', () => {
    const a = deps({ checkSwitches: false, argv: ['/app', '--remote-debugging-port=0'] });
    runStartupGuards(a.d);
    expect(a.calls.exit).toEqual([]);
    const b = deps({ checkSwitches: false, env: { SSLKEYLOGFILE: '/tmp/k' } });
    expect(() => runStartupGuards(b.d)).toThrow('exit 1');
  });
});
