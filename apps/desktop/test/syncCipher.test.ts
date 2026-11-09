import { describe, expect, it } from 'vitest';
import { createSyncCipher, type SafeStorageLike } from '../src/lib/syncCipher.js';

const fake = (available: boolean): SafeStorageLike => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from(`k:${s}`, 'utf8'),
  decryptString: (b) => b.toString('utf8').replace(/^k:/, ''),
});

describe('sync token cipher', () => {
  it('round-trips through the OS encryption, stored as base64 (never the plain token)', () => {
    const c = createSyncCipher(fake(true));
    const stored = c.encrypt('github_pat_secret');
    expect(stored).not.toContain('github_pat_secret');
    expect(c.decrypt(stored)).toBe('github_pat_secret');
  });
  it('fails closed without OS encryption: nothing is stored or read in plain text', () => {
    const c = createSyncCipher(fake(false));
    expect(() => c.encrypt('t')).toThrow(/not available/);
    expect(() => c.decrypt('dA==')).toThrow(/not available/);
  });
});
