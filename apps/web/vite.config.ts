import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { repositoryUrl } = require('./build/repository.cjs') as typeof import('./build/repository.d.cts');
const { sourceRef } = require('./build/sourceRef.cjs') as typeof import('./build/sourceRef.d.cts');
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@chartmate/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)) },
  },
  define: {
    // The About dialog (src/buildInfo.ts): this build's version and, from GITHUB_REPOSITORY, its source repository
    // ('' = built without it; the dialog then points to the LICENSE shipped with the app), and from GITHUB_REF_TYPE,
    // GITHUB_REF_NAME and GITHUB_SHA the ref of its source ('v<version>' only for a build of that tag, else the
    // commit; '' = unknown, the dialog then links the repository).
    __CHARTMATE_VERSION__: JSON.stringify(version),
    __CHARTMATE_SOURCE_URL__: JSON.stringify(repositoryUrl(process.env.GITHUB_REPOSITORY) ?? ''),
    __CHARTMATE_SOURCE_REF__: JSON.stringify(sourceRef(process.env, version) ?? ''),
  },
  server: {
    proxy: { '/api': { target: 'http://localhost:8787', changeOrigin: true } },
  },
});
