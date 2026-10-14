import { describe, it, expect } from 'vitest';
import { createDb } from '../../src/db/connect.js';

describe('createDb', () => {
  it('rejects sqlite: with an empty path instead of opening an anonymous temp database', () => {
    expect(() => createDb('sqlite:')).toThrow(/empty.*path/i);
    expect(() => createDb('sqlite: ')).toThrow(/empty.*path/i);
  });
});
