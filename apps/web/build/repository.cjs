// The GitHub repository a build comes from, as an https URL. The repository is never hardcoded: it comes from
// GITHUB_REPOSITORY (owner/name), which GitHub Actions sets (the Docker image takes it as a build argument). Used at
// build time by vite.config.ts (the About dialog's source code link, __CHARTMATE_SOURCE_URL__) and by the desktop
// app's build/repository.cjs (its releases page).

/** GitHub owner (user or organization) and repository name rules, kept strict: anything else is refused. */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * `https://github.com/<owner>/<name>` for an `owner/name` slug, or null when the slug is missing or not a plain
 * GitHub slug.
 * @param {unknown} repository
 * @returns {string | null}
 */
function repositoryUrl(repository) {
  if (typeof repository !== 'string') return null;
  const parts = repository.split('/');
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!OWNER.test(owner) || !REPO.test(repo) || repo === '.' || repo === '..') return null;
  return `https://github.com/${owner}/${repo}`;
}

module.exports = { repositoryUrl };
