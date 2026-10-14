import type { IndicatorState, Layout } from '@chartmate/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { IndicatorChips } from '../src/components/IndicatorChips';

const INDICATORS: IndicatorState[] = [
  { name: 'VOL', pane: 'sub', calcParams: [5, 10, 20], visible: true },
  { name: 'RSI', pane: 'sub', calcParams: [6, 12, 24], visible: true },
];
const BASE: Layout = { symbol: 'crypto:BTC', tf: '1D', session: 'rth', chartType: 'candle', indicators: INDICATORS };

let latest: Layout = BASE;
function Harness({ initial = BASE }: { initial?: Layout }) {
  const [layout, setLayoutState] = useState(initial);
  latest = layout;
  return <IndicatorChips layout={layout} setLayout={(fn) => setLayoutState(fn)} />;
}

describe('IndicatorChips', () => {
  it('renders one chip per indicator with its label(params)', () => {
    render(<Harness />);
    const list = screen.getByRole('list', { name: /active indicators/i });
    const chips = within(list).getAllByRole('listitem');
    expect(chips).toHaveLength(2);
    expect(chips[0]).toHaveTextContent('VOL(5, 10, 20)');
    expect(chips[1]).toHaveTextContent('RSI(6, 12, 24)');
  });

  it('renders nothing when there are no indicators', () => {
    render(<Harness initial={{ ...BASE, indicators: [] }} />);
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('eye toggles visibility', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Hide RSI(6, 12, 24)' }));
    expect(latest.indicators[1]!.visible).toBe(false);
    const show = screen.getByRole('button', { name: 'Show RSI(6, 12, 24)' });
    await userEvent.click(show);
    expect(latest.indicators[1]!.visible).toBe(true);
  });

  it('× removes that indicator only', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Remove VOL(5, 10, 20)' }));
    expect(latest.indicators).toEqual([INDICATORS[1]]);
  });

  it('settings show the active theme\'s default bar colors', async () => {
    render(<IndicatorChips layout={BASE} setLayout={() => {}} theme="light" />);
    await userEvent.click(screen.getByRole('button', { name: 'Settings for VOL(5, 10, 20)' }));
    expect(screen.getByLabelText('Up bar color')).toHaveValue('#0b9da0');
  });

  it('gear opens settings; save updates that indicator', async () => {
    render(<Harness />);
    const gear = screen.getByRole('button', { name: 'Settings for RSI(6, 12, 24)' });
    await userEvent.click(gear);
    const input = screen.getByLabelText('RSI1 period');
    await userEvent.clear(input);
    await userEvent.type(input, '14');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(latest.indicators[1]!.calcParams).toEqual([14, 12, 24]);
    expect(latest.indicators[0]).toEqual(INDICATORS[0]);
    expect(screen.getByRole('button', { name: 'Settings for RSI(14, 12, 24)' })).toHaveFocus();
  });
});
