import type { Layout } from '@altv/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { IndicatorButton } from '../src/components/IndicatorButton';
import { IndicatorPicker } from '../src/components/IndicatorPicker';

describe('IndicatorPicker', () => {
  it('is a modal dialog with Overlays and Oscillators groups and focuses the search box', () => {
    render(<IndicatorPicker onAdd={() => {}} onClose={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: /indicators/i });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByRole('heading', { name: 'Overlays' })).toBeInTheDocument();
    expect(within(dialog).getByRole('heading', { name: 'Oscillators' })).toBeInTheDocument();
    expect(screen.getByRole('searchbox')).toHaveFocus();
    expect(within(dialog).getByRole('button', { name: /Moving Average \(SMA\)/ })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /VWAP \(session\)/ })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /Average True Range/ })).toBeInTheDocument();
  });

  it('filtering "rsi" shows RSI only; clicking adds it with default params', async () => {
    const onAdd = vi.fn();
    render(<IndicatorPicker onAdd={onAdd} onClose={() => {}} />);
    await userEvent.type(screen.getByRole('searchbox'), 'rsi');
    const items = within(screen.getByRole('dialog')).getAllByRole('listitem');
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent('RSI');
    expect(screen.queryByRole('heading', { name: 'Overlays' })).not.toBeInTheDocument();
    await userEvent.click(within(items[0]!).getByRole('button'));
    expect(onAdd).toHaveBeenCalledWith({ name: 'RSI', pane: 'sub', calcParams: [6, 12, 24], visible: true });
  });

  it('shows an empty state when nothing matches', async () => {
    render(<IndicatorPicker onAdd={() => {}} onClose={() => {}} />);
    await userEvent.type(screen.getByRole('searchbox'), 'zzzz');
    expect(screen.getByText(/no indicators match/i)).toBeInTheDocument();
  });

  it('Escape closes', async () => {
    const onClose = vi.fn();
    render(<IndicatorPicker onAdd={() => {}} onClose={onClose} />);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('traps Tab focus inside the dialog', async () => {
    render(<><button type="button">outside</button><IndicatorPicker onAdd={() => {}} onClose={() => {}} /></>);
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

function Harness({ onLayout }: { onLayout: (l: Layout) => void }) {
  const [layout, setLayoutState] = useState(BASE);
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
});
