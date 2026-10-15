// The git ref the About dialog links the source code at, derived at build time from the variables GitHub Actions
// sets (the Docker image takes them as build arguments). Used by vite.config.ts (__CHARTMATE_SOURCE_REF__).

const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
/** A full commit id (SHA-1, or SHA-256 for repositories that use it). */
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * `v<version>` when the build is from exactly that tag (GITHUB_REF_TYPE `tag`, GITHUB_REF_NAME `v<version>`); else
 * the commit (GITHUB_SHA, a full lowercase hex id) it is built from; else null (the dialog links the repository).
 * A commit after a release but before the next version bump is not that release, so it never gets the tag.
 * @param {Record<string, string | undefined>} env
 * @param {string} version the product version (the web package's)
 * @returns {string | null}
 */
function sourceRef(env, version) {
  const tag = `v${version}`;
  if (RELEASE_VERSION.test(version) && env.GITHUB_REF_TYPE === 'tag' && env.GITHUB_REF_NAME === tag) return tag;
  const sha = env.GITHUB_SHA;
  if (typeof sha === 'string' && COMMIT.test(sha)) return sha;
  return null;
}

module.exports = { sourceRef };
