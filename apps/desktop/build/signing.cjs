// Single source of truth for "is this build signed?", per target platform. Used by the electron-builder config
// (what to sign with) and by the bundler (whether the auto-updater is compiled in at all).

/** @param {NodeJS.ProcessEnv} env */
const hasAll = (env, ...keys) => keys.every((k) => typeof env[k] === 'string' && env[k].trim() !== '');

const AZURE_KEYS = ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'AZURE_TRUSTED_SIGNING_ENDPOINT',
  'AZURE_TRUSTED_SIGNING_ACCOUNT', 'AZURE_TRUSTED_SIGNING_PROFILE', 'AZURE_PUBLISHER_NAME'];

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {'darwin' | 'win32' | string} platform target platform of the build
 * @returns {{ signed: boolean, notarize: boolean, azure: boolean, method: string }}
 */
function signingFor(env, platform) {
  if (platform === 'darwin') {
    const signed = hasAll(env, 'CSC_LINK') || hasAll(env, 'CSC_NAME');
    const notarize = signed && hasAll(env, 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID');
    return { signed, notarize, azure: false, method: signed ? (notarize ? 'Developer ID + notarized' : 'Developer ID') : 'unsigned' };
  }
  if (platform === 'win32') {
    const azure = hasAll(env, ...AZURE_KEYS);
    const cert = hasAll(env, 'WIN_CSC_LINK');
    return { signed: azure || cert, notarize: false, azure, method: azure ? 'Azure Trusted Signing' : cert ? 'Authenticode certificate' : 'unsigned' };
  }
  return { signed: false, notarize: false, azure: false, method: 'unsigned' };
}

module.exports = { signingFor, AZURE_KEYS };
