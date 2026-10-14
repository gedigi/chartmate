// Types of new-indicator.mjs (imported by its test in apps/web/test/scaffold/).
export interface IndicatorSpec {
  /** File base name: `custom/<id>.ts`, `test/indicators/<id>.test.ts`. */
  id: string;
  /** KLineChart template name and `catalog.name`. */
  templateName: string;
  /** Picker label. */
  label: string;
  /** Name of the exported calculation function. */
  calcName: string;
  pane: 'sub' | 'main';
}

export const INDICATORS_DIR: string;
export const CUSTOM_DIR: string;
export const TEST_DIR: string;
export function indicatorSpec(name: string, pane?: string): IndicatorSpec;
export function takenNames(root: string): Set<string>;
export function indicatorSource(spec: IndicatorSpec): string;
export function testSource(spec: IndicatorSpec): string;
export function parseArgs(argv: string[]): { name: string; pane: string };
export function createIndicator(name: string, options: { root: string; pane?: string }): string[];
