// Proves, in real child processes (Node, and Electron-as-Node when its binary is available), that the main
// process's provider fetch ignores HTTPS_PROXY + NODE_USE_ENV_PROXY and NODE_EXTRA_CA_CERTS, while the built-in
// global fetch does honour them (baseline).
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const work = mkdtempSync(join(tmpdir(), 'chartmate-direct-'));
const probe = join(work, 'probe.cjs');

// The child script: fetch `url` with either the global fetch or the guarded+pinned fetch, print the outcome.
const PROBE_SRC = `
import { createDirectFetch } from ${JSON.stringify(fileURLToPath(new URL('../src/lib/directFetch.ts', import.meta.url)))};
import { createGuardedFetch } from ${JSON.stringify(fileURLToPath(new URL('../src/lib/netAllowlist.ts', import.meta.url)))};
const [mode, url] = process.argv.slice(2);
const host = new URL(url).hostname;
const f = mode === 'global' ? fetch
  : mode === 'direct' ? createDirectFetch()
  : createGuardedFetch(createDirectFetch(), [host]);
f(url, { signal: AbortSignal.timeout(5000) }).then(
  (r) => console.log('RESULT ok ' + r.status),
  (e) => console.log('RESULT err ' + (e.cause?.code ?? e.code ?? e.name)),
);
`;

function electronBinary(): string | null {
  try {
    const dir = join(fileURLToPath(new URL('../node_modules/electron', import.meta.url)));
    const pathTxt = join(dir, 'path.txt');
    if (!existsSync(pathTxt)) return null;
    const bin = join(dir, 'dist', readFileSync(pathTxt, 'utf8').trim());
    return existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

const runtimes: [string, string][] = [['node', process.execPath]];
const eb = electronBinary();
if (eb) runtimes.push(['electron', eb]);

function run(bin: string, env: Record<string, string>, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(bin, [probe, ...args], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...env } });
    let out = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { out += String(d); });
    const t = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.on('exit', () => {
      clearTimeout(t);
      resolve(/RESULT (.*)/.exec(out)?.[1] ?? `no result: ${out.slice(0, 300)}`);
    });
  });
}

let proxy: net.Server;
let proxyPort = 0;
const proxied: string[] = [];
let tlsServer: ReturnType<typeof createHttpsServer> | null = null;
let tlsPort = 0;
let certFile = '';

beforeAll(async () => {
  await build({ stdin: { contents: PROBE_SRC, resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', target: 'node22', outfile: probe, logLevel: 'error' });
  // A fake proxy that records CONNECT requests and refuses them.
  proxy = net.createServer((s) => {
    s.once('data', (d) => {
      proxied.push(String(d).split('\r\n')[0]!);
      s.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
    });
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()));
  proxyPort = (proxy.address() as net.AddressInfo).port;

  // A local HTTPS server with a self-signed certificate (for the CA pinning check), if openssl is available.
  try {
    const key = join(work, 'key.pem');
    certFile = join(work, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', certFile, '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
    tlsServer = createHttpsServer({ key: readFileSync(key), cert: readFileSync(certFile) }, (_req, res) => res.end('hi'));
    await new Promise<void>((r) => tlsServer!.listen(0, '127.0.0.1', () => r()));
    tlsPort = (tlsServer.address() as net.AddressInfo).port;
  } catch {
    tlsServer = null;
  }
}, 60_000);

afterAll(() => {
  proxy?.close();
  tlsServer?.close();
});

describe.each(runtimes)('provider fetch in a real %s child process', (_name, bin) => {
  const proxyEnv = () => ({ HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`, HTTP_PROXY: `http://127.0.0.1:${proxyPort}`, NODE_USE_ENV_PROXY: '1' });

  it('baseline: the global fetch is diverted to HTTPS_PROXY when NODE_USE_ENV_PROXY=1', async () => {
    proxied.length = 0;
    await run(bin, proxyEnv(), ['global', 'https://chartmate-test.invalid/x']);
    expect(proxied).toEqual(['CONNECT chartmate-test.invalid:443 HTTP/1.1']);
  }, 30_000);

  it('the guarded, pinned fetch connects directly (never touches the proxy)', async () => {
    proxied.length = 0;
    const r = await run(bin, proxyEnv(), ['guarded', 'https://chartmate-test.invalid/x']);
    expect(proxied).toEqual([]);
    expect(r).toMatch(/^err (ENOTFOUND|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|TimeoutError|ECONNREFUSED)/);
  }, 30_000);

  it('NODE_EXTRA_CA_CERTS: trusted by the global fetch, NOT by the pinned fetch', async (ctx) => {
    if (!tlsServer) ctx.skip();
    const url = `https://localhost:${tlsPort}/`;
    expect(await run(bin, { NODE_EXTRA_CA_CERTS: certFile }, ['global', url])).toBe('ok 200');
    expect(await run(bin, { NODE_EXTRA_CA_CERTS: certFile }, ['direct', url])).toMatch(/^err (SELF_SIGNED_CERT|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY)/);
  }, 30_000);
});
