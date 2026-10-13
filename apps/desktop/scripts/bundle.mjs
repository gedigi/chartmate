// Bundles the Electron main process (desktop shell + the whole altv server) into one minified CommonJS file and
// copies the built web UI next to it:
//   dist/main.cjs, dist/web/**, dist/icon.png   (+ dist/*.LEGAL.txt with third-party license comments)
//   dist/updater.cjs — ONLY when the build is code-signed for the target platform (build/signing.cjs); unsigned
//   builds do not contain the auto-updater at all (and main.cjs has the updater code path compiled out).
//
// Usage: node scripts/bundle.mjs [--dev] [--platform=darwin|win32] [--out=<dir>] [--test-inspectable]
//   --dev               unminified, with source maps
//   --platform          target platform for the signing decision (default: the host platform)
//   --test-inspectable  TEST-ONLY variant used by smoke/prepare-inspectable.mjs: the command-line switch guard is
//                       compiled out so a test harness can attach. Never packaged by electron-builder.
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { signingFor } = require('../build/signing.cjs');

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const dev = process.argv.includes('--dev');
const testInspectable = process.argv.includes('--test-inspectable');
const platform = arg('platform') ?? process.platform;
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const out = arg('out') ? resolve(arg('out')) : here('../dist');
const webDist = here('../../web/dist');

if (!existsSync(`${webDist}/index.html`)) {
  console.error('apps/web/dist is missing: run `pnpm --filter @altv/web build` first');
  process.exit(1);
}

const { signed, method } = signingFor(process.env, platform);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const common = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  minify: !dev,
  treeShaking: true,
  sourcemap: dev ? 'linked' : false,
  legalComments: dev ? 'inline' : 'external',
  // electron is provided by the runtime; node:sqlite and other builtins are external automatically.
  external: ['electron', './updater.cjs'],
  alias: { '@altv/shared': here('../../../packages/shared/src/index.ts') },
  define: {
    __WEB_ROOT_REL__: JSON.stringify('web'),
    __BUILD_SIGNED__: JSON.stringify(signed),
    __TEST_INSPECTABLE__: JSON.stringify(testInspectable),
    'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production'),
  },
  logLevel: 'warning',
  metafile: true,
};

const main = await build({ ...common, entryPoints: { main: here('../src/main.ts') }, outExtension: { '.js': '.cjs' }, outdir: out });
const updater = signed
  ? await build({ ...common, entryPoints: { updater: here('../src/updater.ts') }, outExtension: { '.js': '.cjs' }, outdir: out })
  : null;

// Guard: the desktop build must never contain the native SQLite module or the Postgres driver, and an unsigned
// build must not reference the updater at all.
const inputs = Object.keys(main.metafile.inputs);
const forbidden = inputs.filter((p) => /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(better-sqlite3|pg|pg-pool|pg-protocol|electron-updater)\//.test(p));
if (forbidden.length > 0) {
  console.error(`forbidden modules in the desktop bundle:\n  ${forbidden.join('\n  ')}`);
  process.exit(1);
}

if (!testInspectable) {
  mkdirSync(here('../.bundle-meta'), { recursive: true });
  writeFileSync(here('../.bundle-meta/main.json'), JSON.stringify(main.metafile));
}

// Runtime window/dock icon (Windows/Linux BrowserWindow icon, macOS dock icon in development).
cpSync(here('../../../assets/brand/png/icon-512.png'), `${out}/icon.png`);
cpSync(webDist, `${out}/web`, { recursive: true, filter: (src) => !src.endsWith('.map') });
// The desktop's own static error page (shown after repeated renderer crashes); no inline script or style.
for (const f of ['crashed.html', 'crashed.css']) cpSync(here(`../src/static/${f}`), `${out}/web/${f}`);
const size = (m) => (m ? Object.values(m.metafile.outputs).reduce((s, o) => s + o.bytes, 0) : 0);
console.log(`bundled main ${(size(main) / 1024).toFixed(0)} KiB, updater ${updater ? `${(size(updater) / 1024).toFixed(0)} KiB` : 'not included'} ` +
  `(${dev ? 'dev' : 'prod'}, platform=${platform}, signing=${method}${testInspectable ? ', TEST-INSPECTABLE' : ''})`);
