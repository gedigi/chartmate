import { registerIndicator } from 'klinecharts';
import { CUSTOM_INDICATORS } from './extensions';

let registered = false;

/**
 * Registers every custom indicator template with KLineChart (idempotent): VWAP and ATR plus any other
 * module in ./custom/ — see extensions.ts and the README's "Custom indicators" section.
 */
export function registerCustomIndicators(): void {
  if (registered) return;
  registered = true;
  for (const c of CUSTOM_INDICATORS) registerIndicator(c.template);
}
