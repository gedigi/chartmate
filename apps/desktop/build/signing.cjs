// Single source of truth for "is this build signed?", per target platform. Used by the electron-builder config
// (what to sign with) and by the bundler (whether the auto-updater is compiled in at all).

/** @param {NodeJS.ProcessEnv} env */
const hasAll = (env, ...keys) => keys.every((k) => typeof env[k] === 'string' && env[k].trim() !== '');
/** @param {NodeJS.ProcessEnv} env */
const hasAny = (env, ...keys) => keys.some((k) => hasAll(env, k));

const AZURE_KEYS = ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'AZURE_TRUSTED_SIGNING_ENDPOINT',
  'AZURE_TRUSTED_SIGNING_ACCOUNT', 'AZURE_TRUSTED_SIGNING_PROFILE', 'AZURE_PUBLISHER_NAME'];

/** Certum's RFC 3161 timestamp server (Certum's signtool guide for Code Signing in the cloud). */
const CERTUM_TIMESTAMP_URL = 'http://time.certum.pl';

/**
 * Certum (SimplySign) cloud certificate. The key never leaves Certum's HSM; one of three backends reaches it:
 * - `ci-login`: CI logs SimplySign Desktop in with CHARTMATE_CERTUM_USERNAME + CHARTMATE_CERTUM_OTP_URI
 *   (scripts/certum/login.ps1), which then exports CHARTMATE_WIN_CERT_SHA1 for the `signtool` backend.
 * - `signtool`: Windows, SimplySign Desktop already logged in; signtool selects the certificate by thumbprint.
 * - `pkcs11`: macOS/Linux, osslsigncode + the PKCS#11 module of SimplySign Desktop (or any SimplySign module).
 * CHARTMATE_WIN_PUBLISHER_NAME (the certificate subject CN) is required: electron-updater pins it.
 */
const CERTUM_CI_KEYS = ['CHARTMATE_CERTUM_USERNAME', 'CHARTMATE_CERTUM_OTP_URI'];
const CERTUM_KEYS = [...CERTUM_CI_KEYS, 'CHARTMATE_WIN_CERT_SHA1', 'CHARTMATE_WIN_PKCS11_MODULE'];
const CERTUM_METHOD = 'Certum (SimplySign)';

/**
 * Which Certum backend the environment configures, or null when none. Throws on a half-configured setup, so a
 * release is never silently built unsigned (or signed without the publisher name the updater needs).
 * @param {NodeJS.ProcessEnv} env
 * @returns {null | 'ci-login' | 'signtool' | 'pkcs11'}
 */
function certumBackend(env) {
  if (!hasAny(env, ...CERTUM_KEYS)) return null;
  if (hasAny(env, ...CERTUM_CI_KEYS) && !hasAll(env, ...CERTUM_CI_KEYS)) {
    throw new Error(`Certum signing: set both ${CERTUM_CI_KEYS.join(' and ')} (or neither)`);
  }
  if (!hasAll(env, 'CHARTMATE_WIN_PUBLISHER_NAME')) {
    throw new Error('Certum signing needs CHARTMATE_WIN_PUBLISHER_NAME (the certificate subject CN, pinned for updates)');
  }
  if (hasAll(env, 'CHARTMATE_WIN_PKCS11_MODULE')) return 'pkcs11';
  if (hasAll(env, ...CERTUM_CI_KEYS)) return 'ci-login';
  return 'signtool';
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {'darwin' | 'win32' | string} platform target platform of the build
 * @returns {{ signed: boolean, notarize: boolean, azure: boolean, certum: null | 'ci-login' | 'signtool' | 'pkcs11', method: string }}
 */
function signingFor(env, platform) {
  if (platform === 'darwin') {
    const signed = hasAll(env, 'CSC_LINK') || hasAll(env, 'CSC_NAME');
    const notarize = signed && hasAll(env, 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID');
    return { signed, notarize, azure: false, certum: null, method: signed ? (notarize ? 'Developer ID + notarized' : 'Developer ID') : 'unsigned' };
  }
  if (platform === 'win32') {
    const azure = hasAll(env, ...AZURE_KEYS);
    const certum = azure ? null : certumBackend(env);
    const cert = !azure && !certum && hasAll(env, 'WIN_CSC_LINK');
    const method = azure ? 'Azure Trusted Signing' : certum ? CERTUM_METHOD : cert ? 'Authenticode certificate' : 'unsigned';
    return { signed: azure || certum !== null || cert, notarize: false, azure, certum, method };
  }
  return { signed: false, notarize: false, azure: false, certum: null, method: 'unsigned' };
}

module.exports = { signingFor, certumBackend, AZURE_KEYS, CERTUM_KEYS, CERTUM_METHOD, CERTUM_TIMESTAMP_URL };
