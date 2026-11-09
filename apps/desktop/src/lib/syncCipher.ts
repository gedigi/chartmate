/**
 * Encrypts the sync token at rest with the OS keychain (Electron safeStorage: Keychain on macOS, DPAPI on Windows),
 * so the database alone never holds a usable GitHub token. Fails closed: with no OS encryption available the token
 * is not stored at all (the sync service turns the error into a readable message).
 */

/** The part of Electron's `safeStorage` this needs. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface SyncCipher { encrypt(plain: string): string; decrypt(stored: string): string }

export function createSyncCipher(safeStorage: SafeStorageLike): SyncCipher {
  const ready = (): void => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption is not available');
  };
  return {
    encrypt: (plain) => {
      ready();
      return safeStorage.encryptString(plain).toString('base64');
    },
    decrypt: (stored) => {
      ready();
      return safeStorage.decryptString(Buffer.from(stored, 'base64'));
    },
  };
}
