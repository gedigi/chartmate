import { readFileSync } from 'node:fs';

/** A semantic version, with an optional pre-release suffix (`1.0.0`, `1.1.0-beta.1`). */
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const readPackageJson = (): string => readFileSync(new URL('../package.json', import.meta.url), 'utf8');

/**
 * The server's version: its package.json `version` (kept equal to the product version; a test pins it), read next
 * to `src/` or `dist/` (in the Docker image, /app/package.json). Null when it cannot be read or is not a version.
 */
export function serverVersion(read: () => string = readPackageJson): string | null {
  try {
    const v = (JSON.parse(read()) as { version?: unknown }).version;
    return typeof v === 'string' && VERSION_RE.test(v) ? v : null;
  } catch {
    return null;
  }
}
