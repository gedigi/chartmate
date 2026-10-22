// Bundles the Electron main process (desktop shell + the whole Chartmate server) into one minified CommonJS file and
// copies the built web UI next to it:
//   dist/main.cjs, dist/web/**, dist/icon.png   (+ dist/*.LEGAL.txt with third-party license comments)
//   __RELEASES_URL__ — the GitHub releases page of GITHUB_REPOSITORY (owner/name), validated by build/repository.cjs.
//   dist/updater.cjs — ONLY when the build is code-signed for the target platform (build/signing.cjs); unsigned
//   builds do not contain the auto-updater at all (and main.cjs has the updater code path compiled out).
//
// Usage: node scripts/bundle.mjs [--dev] [--platform=darwin|win32] [--out=<dir>] [--web-dist=<dir>] [--test-inspectable]
//   --dev               development bundle: unminified, source maps, and __DEV_BUNDLE__ = true, the only bundle that
//                       runs unhardened when started unpackaged (src/lib/buildMode.ts). Never for release builds.
//   --platform          target platform for the signing decision (default: the host platform)
//   --web-dist          the web build to copy in (default: apps/web/dist); smoke/prepare-inspectable.mjs passes the
//                       one inside the packaged app, so its TEST-ONLY copy carries exactly the shipped web UI
//   --test-inspectable  TEST-ONLY variant used by smoke/prepare-inspectable.mjs: the command-line switch guard is
//                       compiled out so a test harness can attach. Never packaged by electron-builder.
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { signingFor } = require('../build/signing.cjs');
const { releasesPageUrl } = require('../build/repository.cjs');

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const dev = process.argv.includes('--dev');
const testInspectable = process.argv.includes('--test-inspectable');
const platform = arg('platform') ?? process.platform;
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const out = arg('out') ? resolve(arg('out')) : here('../dist');
const webDist = arg('web-dist') ? resolve(arg('web-dist')) : here('../../web/dist');

/**
 * Canonical form of `p` for containment checks: symlinks resolved (on the deepest existing ancestor, since `p` may
 * not exist yet) and case-folded where the file system is normally case-insensitive (macOS, Windows).
 */
function canonical(p) {
  let head = resolve(p);
  const tail = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) break;
    tail.unshift(basename(head));
    head = parent;
  }
  const full = join(realpathSync(head), ...tail);
  return process.platform === 'darwin' || process.platform === 'win32' ? full.toLowerCase() : full;
}

// The test-only variant must never land in dist/ (which electron-builder packages).
const distCanon = canonical(here('../dist'));
const outCanon = canonical(out);
if (testInspectable && dev) {
  console.error('--test-inspectable cannot be combined with --dev (the TEST-ONLY copy must stay a hardened production bundle)');
  process.exit(2);
}
if (testInspectable && (!arg('out') || outCanon === distCanon || outCanon.startsWith(distCanon + sep))) {
  console.error('--test-inspectable requires --out=<dir> outside apps/desktop/dist (it must never be packaged)');
  process.exit(2);
}

if (!existsSync(`${webDist}/index.html`)) {
  console.error(arg('web-dist') ? `${webDist} has no index.html` : 'apps/web/dist is missing: run `pnpm --filter @chartmate/web build` first');
  process.exit(1);
}

const { signed, method } = signingFor(process.env, platform);
if (signed && platform === 'win32' && !String(process.env.CHARTMATE_WIN_PUBLISHER_DN ?? '').trim()) {
  console.warn('CHARTMATE_WIN_PUBLISHER_DN is not set: this signed Windows build will not update itself (docs/desktop.md)');
}

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
  alias: { '@chartmate/shared': here('../../../packages/shared/src/index.ts') },
  define: {
    __WEB_ROOT_REL__: JSON.stringify('web'),
    __BUILD_SIGNED__: JSON.stringify(signed),
    // The releases page offered by "Check for updates" in builds that cannot update themselves ('' = none).
    __RELEASES_URL__: JSON.stringify(releasesPageUrl(process.env.GITHUB_REPOSITORY) ?? ''),
    // Windows: the publisher DN (at least CN, O, C) the update installer's signature must match; '' = no Windows
    // updates (src/lib/winSignature.ts, updatePolicy.ts).
    __WIN_PUBLISHER_DN__: JSON.stringify(String(process.env.CHARTMATE_WIN_PUBLISHER_DN ?? '').trim()),
    __TEST_INSPECTABLE__: JSON.stringify(testInspectable),
    // Only the --dev bundle may run unhardened, and only unpackaged (src/lib/buildMode.ts).
    __DEV_BUNDLE__: JSON.stringify(dev),
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

// What kind of bundle this is: build/after-pack.cjs refuses to package anything but "prod".
const kind = testInspectable ? 'test-inspectable' : dev ? 'dev' : 'prod';
writeFileSync(`${out}/bundle-kind.json`, JSON.stringify({ kind }));

// Runtime window/dock icon (Windows/Linux BrowserWindow icon, macOS dock icon in development).
cpSync(here('../../../assets/brand/png/icon-512.png'), `${out}/icon.png`);
cpSync(webDist, `${out}/web`, { recursive: true, filter: (src) => !src.endsWith('.map') });
// The desktop's own static error page (shown after repeated renderer crashes); no inline script or style.
for (const f of ['crashed.html', 'crashed.css']) cpSync(here(`../src/static/${f}`), `${out}/web/${f}`);
const size = (m) => (m ? Object.values(m.metafile.outputs).reduce((s, o) => s + o.bytes, 0) : 0);
console.log(`bundled main ${(size(main) / 1024).toFixed(0)} KiB, updater ${updater ? `${(size(updater) / 1024).toFixed(0)} KiB` : 'not included'} ` +
  `(${dev ? 'dev' : 'prod'}, platform=${platform}, signing=${method}${testInspectable ? ', TEST-INSPECTABLE' : ''})`);
