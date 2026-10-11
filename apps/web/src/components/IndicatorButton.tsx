import type { Layout } from '@altv/shared';
import type { JSX } from 'react';

export interface IndicatorButtonProps {
  layout: Layout;
  setLayout: (fn: (l: Layout) => Layout) => void;
}

/** TopBar "Indicators" button (opens the indicator picker). STUB — implemented by Task 11. */
export function IndicatorButton(_props: IndicatorButtonProps): JSX.Element {
  return <button type="button" disabled>Indicators</button>;
}
