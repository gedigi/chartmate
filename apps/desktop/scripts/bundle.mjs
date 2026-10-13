// Bundles the Electron main process (desktop shell + the whole altv server) into one minified CommonJS file,
// plus the lazily-loaded auto-updater, and copies the built web UI next to it:
//   dist/main.cjs, dist/updater.cjs, dist/web/**   (+ dist/*.LEGAL.txt with third-party license comments)
// Usage: node scripts/bundle.mjs [--dev]   (--dev: unminified with source maps)
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dev = process.argv.includes('--dev');
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const out = here('../dist');
const webDist = here('../../web/dist');

if (!existsSync(`${webDist}/index.html`)) {
  console.error('apps/web/dist is missing: run `pnpm --filter @altv/web build` first');
  process.exit(1);
}

const has = (k) => typeof process.env[k] === 'string' && process.env[k].trim() !== '';
const signed = has('CSC_LINK') || has('CSC_NAME') || has('WIN_CSC_LINK') || has('AZURE_CLIENT_SECRET');

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
    'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production'),
  },
  logLevel: 'warning',
  metafile: true,
};

const main = await build({ ...common, entryPoints: { main: here('../src/main.ts') }, outExtension: { '.js': '.cjs' }, outdir: out });
const updater = await build({ ...common, entryPoints: { updater: here('../src/updater.ts') }, outExtension: { '.js': '.cjs' }, outdir: out });

// Guard: the desktop build must never contain the native SQLite module or the Postgres driver.
const inputs = Object.keys(main.metafile.inputs);
const forbidden = inputs.filter((p) => /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(better-sqlite3|pg|pg-pool|pg-protocol)\//.test(p));
if (forbidden.length > 0) {
  console.error(`forbidden modules in the desktop bundle:\n  ${forbidden.join('\n  ')}`);
  process.exit(1);
}

mkdirSync(here('../.bundle-meta'), { recursive: true });
writeFileSync(here('../.bundle-meta/main.json'), JSON.stringify(main.metafile));
writeFileSync(here('../.bundle-meta/updater.json'), JSON.stringify(updater.metafile));

// Runtime window/dock icon (Windows/Linux BrowserWindow icon, macOS dock icon in development).
cpSync(here('../../../assets/brand/png/icon-512.png'), `${out}/icon.png`);
cpSync(webDist, `${out}/web`, { recursive: true, filter: (src) => !src.endsWith('.map') });
const size = (m) => Object.values(m.metafile.outputs).reduce((s, o) => s + o.bytes, 0);
console.log(`bundled main ${(size(main) / 1024).toFixed(0)} KiB, updater ${(size(updater) / 1024).toFixed(0)} KiB (${dev ? 'dev' : 'prod'}, signed=${signed})`);
