import type { ChartAppearance, Layout } from '@altv/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DOWN, THEME_TOKENS, UP } from '../src/chart/theme';
import { ChartAppearanceDialog } from '../src/components/ChartAppearanceDialog';
import { TopBar } from '../src/components/TopBar';

function Harness({ initial, onChange }: { initial?: ChartAppearance; onChange: (a: ChartAppearance | undefined) => void }) {
  const [a, setA] = useState<ChartAppearance | undefined>(initial);
  return (
    <ChartAppearanceDialog appearance={a} theme="dark" chartType="candle"
      onChange={(n) => { setA(n); onChange(n); }} onClose={() => {}} />
  );
}

describe('ChartAppearanceDialog', () => {
  it('shows theme defaults when unset, with candle preview swatches', () => {
    render(<Harness onChange={() => {}} />);
    expect(screen.getByRole('dialog', { name: 'Chart appearance' })).toBeInTheDocument();
    expect(screen.getByLabelText('Up colour')).toHaveValue(UP);
    expect(screen.getByLabelText('Down colour')).toHaveValue(DOWN);
    expect(screen.getByLabelText('Body style')).toHaveValue('solid');
    expect(screen.getByLabelText('Line colour')).toHaveValue(THEME_TOKENS.dark.accent);
    expect(screen.getByLabelText('Line width')).toHaveValue('2');
    expect(screen.getByLabelText('Drawing colour')).toHaveValue(THEME_TOKENS.dark.accent);
    expect(screen.getByLabelText('Drawing width')).toHaveValue('1');
    expect(screen.getByLabelText('Drawing line style')).toHaveValue('solid');
    expect(screen.getByTestId('candle-preview-up')).toHaveAttribute('fill', UP);
    expect(screen.getByTestId('candle-preview-down')).toHaveAttribute('fill', DOWN);
  });

  it('applies each change live (only the changed field is stored) and Reset restores the defaults', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.input(screen.getByLabelText('Up colour'), { target: { value: '#00ff00' } });
    expect(onChange).toHaveBeenLastCalledWith({ upColor: '#00ff00' });
    expect(screen.getByTestId('candle-preview-up')).toHaveAttribute('fill', '#00ff00');
    await userEvent.selectOptions(screen.getByLabelText('Body style'), 'hollow_up');
    expect(onChange).toHaveBeenLastCalledWith({ upColor: '#00ff00', candleBody: 'hollow_up' });
    expect(screen.getByTestId('candle-preview-up')).toHaveAttribute('fill', 'none');
    await userEvent.selectOptions(screen.getByLabelText('Line width'), '4');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ lineWidth: 4 }));
    await userEvent.selectOptions(screen.getByLabelText('Drawing line style'), 'dashed');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      drawing: { color: THEME_TOKENS.dark.accent, size: 1, style: 'dashed' },
    }));
    await userEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
    expect(onChange).toHaveBeenLastCalledWith(undefined);
    expect(screen.getByLabelText('Up colour')).toHaveValue(UP);
  });
});

describe('TopBar chart appearance button', () => {
  const layout: Layout = { symbol: 'stock:AAPL', tf: '1D', session: 'rth', chartType: 'candle', indicators: [] };
  const props = {
    view: 'chart' as const, onView: () => {}, layout, symbolInfo: null, showSession: false, onSelectSymbol: () => {},
    theme: 'dark' as const, onToggleTheme: () => {}, sidebarOpen: true, onToggleSidebar: () => {},
  };

  it('opens the dialog and writes changes / reset into the layout', async () => {
    let current: Layout = layout;
    const setLayout = vi.fn((fn: (l: Layout) => Layout) => { current = fn(current); });
    render(<TopBar {...props} setLayout={setLayout} />);
    await userEvent.click(screen.getByRole('button', { name: 'Chart appearance' }));
    fireEvent.input(screen.getByLabelText('Down colour'), { target: { value: '#ff00ff' } });
    expect(current.appearance).toEqual({ downColor: '#ff00ff' });
    await userEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
    expect(current).not.toHaveProperty('appearance');
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('is disabled with the other controls', () => {
    render(<TopBar {...props} setLayout={() => {}} controlsDisabled />);
    expect(screen.getByRole('button', { name: 'Chart appearance' })).toBeDisabled();
  });
});
