import { describe, expect, it } from 'vitest';
import { migrateAppearance } from '../src/types.js';

describe('migrateAppearance', () => {
  const flat = { upColor: '#ffffff', downColor: '#e63b7a', drawing: { color: '#ffffff', size: 1, style: 'solid' as const } };

  it('moves a legacy flat appearance to the dark theme (it was chosen in dark mode)', () => {
    expect(migrateAppearance(flat)).toEqual({ dark: flat });
    expect(migrateAppearance({ lineWidth: 3 })).toEqual({ dark: { lineWidth: 3 } });
  });

  it('keeps the per-theme shape as is', () => {
    const themed = { dark: flat, light: { upColor: '#000000' } };
    expect(migrateAppearance(themed)).toEqual(themed);
    expect(migrateAppearance({ light: { lineWidth: 2 } })).toEqual({ light: { lineWidth: 2 } });
    expect(migrateAppearance({})).toEqual({});
  });

  it('passes undefined / non-objects through as undefined', () => {
    expect(migrateAppearance(undefined)).toBeUndefined();
    expect(migrateAppearance(null)).toBeUndefined();
    expect(migrateAppearance('x')).toBeUndefined();
  });
});
