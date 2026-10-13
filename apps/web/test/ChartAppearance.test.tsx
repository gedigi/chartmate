import type { ChartAppearance, Layout } from '@altv/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { THEME_TOKENS } from '../src/chart/theme';

const UP = THEME_TOKENS.dark.up;
const DOWN = THEME_TOKENS.dark.down;
import { ChartAppearanceDialog } from '../src/components/ChartAppearanceDialog';
import { TopBar } from '../src/components/TopBar';

function Harness({ initial, onChange, theme = 'dark' }: {
  initial?: ChartAppearance; onChange: (a: ChartAppearance | undefined) => void; theme?: 'dark' | 'light';
}) {
  const [a, setA] = useState<ChartAppearance | undefined>(initial);
  return (
    <ChartAppearanceDialog appearance={a} theme={theme} chartType="candle"
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

  it('names the theme being edited', () => {
    const { unmount } = render(<Harness onChange={() => {}} />);
    expect(screen.getByText('Dark theme')).toBeInTheDocument();
    unmount();
    render(<Harness onChange={() => {}} theme="light" />);
    expect(screen.getByText('Light theme')).toBeInTheDocument();
    expect(screen.getByLabelText('Line colour')).toHaveValue(THEME_TOKENS.light.accent);
  });

  it('warns inline about colours that barely show on the theme background', () => {
    const { unmount } = render(<Harness onChange={() => {}} theme="light" />);
    expect(screen.queryByText(/Low contrast/)).not.toBeInTheDocument(); // defaults are fine
    fireEvent.input(screen.getByLabelText('Up colour'), { target: { value: '#ffffff' } });
    expect(screen.getByText('Low contrast on the light background')).toBeInTheDocument();
    expect(screen.getByLabelText('Up colour')).toHaveAccessibleDescription('Low contrast on the light background');
    fireEvent.input(screen.getByLabelText('Drawing colour'), { target: { value: '#fafafa' } });
    expect(screen.getAllByText('Low contrast on the light background')).toHaveLength(2);
    fireEvent.input(screen.getByLabelText('Up colour'), { target: { value: '#00aa00' } });
    expect(screen.getAllByText('Low contrast on the light background')).toHaveLength(1);
    unmount();
    // The reported colours are fine on the dark background; near-black ones are not.
    render(<Harness onChange={() => {}} initial={{ upColor: '#ffffff', downColor: '#e63b7a', drawing: { color: '#ffffff', size: 1, style: 'solid' } }} />);
    expect(screen.queryByText(/Low contrast/)).not.toBeInTheDocument();
    fireEvent.input(screen.getByLabelText('Line colour'), { target: { value: '#1a1e2a' } });
    expect(screen.getByText('Low contrast on the dark background')).toBeInTheDocument();
  });
});

describe('TopBar chart appearance button', () => {
  const layout: Layout = { symbol: 'stock:AAPL', tf: '1D', session: 'rth', chartType: 'candle', indicators: [] };
  const props = {
    view: 'chart' as const, onView: () => {}, layout, symbolInfo: null, showSession: false, onSelectSymbol: () => {},
    theme: 'dark' as const, onToggleTheme: () => {}, sidebarOpen: true, onToggleSidebar: () => {},
  };

  it('in light mode edits and resets only the light theme settings', async () => {
    let current: Layout = { ...layout, appearance: { dark: { upColor: '#ffffff' } } };
    const setLayout = vi.fn((fn: (l: Layout) => Layout) => { current = fn(current); });
    const { rerender } = render(<TopBar {...props} layout={current} theme="light" setLayout={setLayout} />);
    await userEvent.click(screen.getByRole('button', { name: 'Chart appearance' }));
    expect(screen.getByText('Light theme')).toBeInTheDocument();
    expect(screen.getByLabelText('Up colour')).toHaveValue('#00a870'); // light default; the dark theme's white is not used here
    fireEvent.input(screen.getByLabelText('Down colour'), { target: { value: '#ff00ff' } });
    expect(current.appearance).toEqual({ dark: { upColor: '#ffffff' }, light: { downColor: '#ff00ff' } });
    rerender(<TopBar {...props} layout={current} theme="light" setLayout={setLayout} />);
    await userEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
    expect(current.appearance).toEqual({ dark: { upColor: '#ffffff' } });
    // Toggling the theme while open switches the dialog to the other theme's settings.
    rerender(<TopBar {...props} layout={current} theme="dark" setLayout={setLayout} />);
    expect(screen.getByText('Dark theme')).toBeInTheDocument();
    expect(screen.getByLabelText('Up colour')).toHaveValue('#ffffff');
  });

  it('opens the dialog and writes changes / reset into the active theme of the layout', async () => {
    let current: Layout = layout;
    const setLayout = vi.fn((fn: (l: Layout) => Layout) => { current = fn(current); });
    render(<TopBar {...props} setLayout={setLayout} />);
    await userEvent.click(screen.getByRole('button', { name: 'Chart appearance' }));
    fireEvent.input(screen.getByLabelText('Down colour'), { target: { value: '#ff00ff' } });
    expect(current.appearance).toEqual({ dark: { downColor: '#ff00ff' } });
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
