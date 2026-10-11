import { MAX_INDICATORS, type IndicatorState, type Layout } from '@altv/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { IndicatorButton } from '../src/components/IndicatorButton';
import { IndicatorPicker } from '../src/components/IndicatorPicker';

describe('IndicatorPicker', () => {
  it('is a modal dialog with Overlays and Oscillators groups and focuses the search box', () => {
    render(<IndicatorPicker count={0} onAdd={() => {}} onClose={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: /indicators/i });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByRole('heading', { name: 'Overlays' })).toBeInTheDocument();
    expect(within(dialog).getByRole('heading', { name: 'Oscillators' })).toBeInTheDocument();
    expect(screen.getByRole('searchbox')).toHaveFocus();
    expect(within(dialog).getByRole('button', { name: /Moving Average \(SMA\)/ })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /VWAP \(session, intraday\)/ })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /Average True Range/ })).toBeInTheDocument();
  });

  it('filtering "rsi" shows RSI only; clicking adds it with default params', async () => {
    const onAdd = vi.fn();
    render(<IndicatorPicker count={0} onAdd={onAdd} onClose={() => {}} />);
    await userEvent.type(screen.getByRole('searchbox'), 'rsi');
    const items = within(screen.getByRole('dialog')).getAllByRole('listitem');
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent('RSI');
    expect(screen.queryByRole('heading', { name: 'Overlays' })).not.toBeInTheDocument();
    await userEvent.click(within(items[0]!).getByRole('button'));
    expect(onAdd).toHaveBeenCalledWith({ name: 'RSI', pane: 'sub', calcParams: [6, 12, 24], visible: true });
  });

  it('shows an empty state when nothing matches', async () => {
    render(<IndicatorPicker count={0} onAdd={() => {}} onClose={() => {}} />);
    await userEvent.type(screen.getByRole('searchbox'), 'zzzz');
    expect(screen.getByText(/no indicators match/i)).toBeInTheDocument();
  });

  it(`at ${MAX_INDICATORS} indicators the options are disabled and a message explains why`, async () => {
    const onAdd = vi.fn();
    render(<IndicatorPicker count={MAX_INDICATORS} onAdd={onAdd} onClose={() => {}} />);
    expect(screen.getByRole('alert')).toHaveTextContent(`at most ${MAX_INDICATORS} indicators`);
    const options = within(screen.getByRole('dialog')).getAllByRole('listitem').map((li) => within(li).getByRole('button'));
    expect(options.length).toBeGreaterThan(0);
    for (const o of options) expect(o).toBeDisabled();
    await userEvent.click(options[0]!);
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('below the limit there is no message', () => {
    render(<IndicatorPicker count={MAX_INDICATORS - 1} onAdd={() => {}} onClose={() => {}} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('Escape closes', async () => {
    const onClose = vi.fn();
    render(<IndicatorPicker count={0} onAdd={() => {}} onClose={onClose} />);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('traps Tab focus inside the dialog', async () => {
    render(<><button type="button">outside</button><IndicatorPicker count={0} onAdd={() => {}} onClose={() => {}} /></>);
    const dialog = screen.getByRole('dialog');
    for (let i = 0; i < 40; i++) {
      await userEvent.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    await userEvent.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});

const BASE: Layout = { symbol: 'crypto:BTC', tf: '1D', session: 'rth', chartType: 'candle', indicators: [] };

function Harness({ onLayout, initial = BASE }: { onLayout: (l: Layout) => void; initial?: Layout }) {
  const [layout, setLayoutState] = useState(initial);
  const setLayout = (fn: (l: Layout) => Layout) => setLayoutState((l) => { const n = fn(l); onLayout(n); return n; });
  return <IndicatorButton layout={layout} setLayout={setLayout} />;
}

describe('IndicatorButton', () => {
  it('opens the picker, appends picked indicators (duplicates allowed) and returns focus on close', async () => {
    const onLayout = vi.fn();
    render(<Harness onLayout={onLayout} />);
    const button = screen.getByRole('button', { name: 'Indicators' });
    expect(button).toBeEnabled();
    await userEvent.click(button);
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /Moving Average \(SMA\)/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: /Moving Average \(SMA\)/ }));
    expect(onLayout).toHaveBeenLastCalledWith(expect.objectContaining({
      indicators: [
        { name: 'MA', pane: 'main', calcParams: [5, 10, 30, 60], visible: true },
        { name: 'MA', pane: 'main', calcParams: [5, 10, 30, 60], visible: true },
      ],
    }));
    await userEvent.click(within(dialog).getByRole('button', { name: /close/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  it('never grows the layout beyond MAX_INDICATORS (picker reaching the limit mid-session)', async () => {
    const onLayout = vi.fn();
    const ind: IndicatorState = { name: 'MA', pane: 'main', calcParams: [5], visible: true };
    render(<Harness onLayout={onLayout} initial={{ ...BASE, indicators: Array.from({ length: MAX_INDICATORS - 1 }, () => ind) }} />);
    await userEvent.click(screen.getByRole('button', { name: 'Indicators' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Exponential MA/ }));
    expect(onLayout).toHaveBeenLastCalledWith(expect.objectContaining({ indicators: expect.any(Array) }));
    expect((onLayout.mock.lastCall![0] as Layout).indicators).toHaveLength(MAX_INDICATORS);
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: /Exponential MA/ })).toBeDisabled();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('onAdd is guarded against a layout that is already full (stale layout prop)', async () => {
    const ind: IndicatorState = { name: 'MA', pane: 'main', calcParams: [5], visible: true };
    const full: Layout = { ...BASE, indicators: Array.from({ length: MAX_INDICATORS }, () => ind) };
    const setLayout = vi.fn();
    render(<IndicatorButton layout={BASE} setLayout={setLayout} />);
    await userEvent.click(screen.getByRole('button', { name: 'Indicators' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Exponential MA/ }));
    const update = setLayout.mock.calls[0]![0] as (l: Layout) => Layout;
    expect(update(full)).toBe(full);
    expect(update(BASE).indicators).toHaveLength(1);
  });
});
