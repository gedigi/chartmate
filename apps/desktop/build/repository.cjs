// The GitHub releases page of the repository the app was built from. Used at bundle time (scripts/bundle.mjs bakes it
// into the app as __RELEASES_URL__) and at run time (src/lib/releasesPage.ts re-validates it before opening it).
// The repository is never hardcoded: it comes from GITHUB_REPOSITORY (owner/name), set by GitHub Actions.

/** GitHub owner (user or organization) and repository name rules, kept strict: anything else is refused. */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * `https://github.com/<owner>/<name>/releases` for an `owner/name` slug, or null when the slug is missing or not a
 * plain GitHub slug.
 * @param {unknown} repository
 * @returns {string | null}
 */
function releasesPageUrl(repository) {
  if (typeof repository !== 'string') return null;
  const parts = repository.split('/');
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!OWNER.test(owner) || !REPO.test(repo) || repo === '.' || repo === '..') return null;
  return `https://github.com/${owner}/${repo}/releases`;
}

module.exports = { releasesPageUrl };
