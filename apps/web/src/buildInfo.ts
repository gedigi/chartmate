/** Set by vite.config.ts at build time. */
declare const __CHARTMATE_VERSION__: string;
declare const __CHARTMATE_SOURCE_URL__: string;

/** This build's version (the web package's, kept equal to the product version). */
export const APP_VERSION: string = __CHARTMATE_VERSION__;

/**
 * `https://github.com/<owner>/<name>`: the repository this build comes from (GITHUB_REPOSITORY at build time,
 * validated by build/repository.cjs), or null for a build made without it.
 */
export const SOURCE_URL: string | null = __CHARTMATE_SOURCE_URL__ || null;
