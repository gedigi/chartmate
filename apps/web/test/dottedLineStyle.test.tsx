import type { IndicatorState } from '@chartmate/shared';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { SelectedDrawing } from '../src/chart/ChartAdapter';
import { dashPattern, lineToOverlay, normalizeOverlayStyles, readLine } from '../src/chart/drawingStyles';
import { overlayStyles } from '../src/chart/theme';
import { ChartAppearanceDialog } from '../src/components/ChartAppearanceDialog';
import { DrawingStyleBar, type DrawingStyleControls } from '../src/components/DrawingStyleBar';
import { IndicatorSettings } from '../src/components/IndicatorSettings';

describe('dotted line style', () => {
  it('maps to KLineChart dashed with round caps and a dot pattern that scales with the width', () => {
    // 1px: square 1px dots every 3px (round-cap zero-length dashes would be half-alpha specks at width 1).
    expect(dashPattern('dotted', 1)).toEqual([1, 2]);
    expect(lineToOverlay({ color: '#ff0000', size: 1, style: 'dotted' })).toEqual({
      line: { color: '#ff0000', size: 1, style: 'dashed', dashedValue: [1, 2], lineCap: 'butt' },
    });
    expect(dashPattern('dotted', 3)).toEqual([0, 6]);
    expect(lineToOverlay({ color: '#ff0000', size: 2, style: 'dotted' })).toEqual({
      line: { color: '#ff0000', size: 2, style: 'dashed', dashedValue: [0, 4], lineCap: 'round' },
    });
    // Solid / dashed reset the cap explicitly (KLineChart merges overlay styles on override).
    expect(lineToOverlay({ color: '#ff0000', size: 2, style: 'dashed' })).toEqual({
      line: { color: '#ff0000', size: 2, style: 'dashed', dashedValue: [6, 4], lineCap: 'butt' },
    });
    expect(overlayStyles({ color: '#00ff00', size: 3, style: 'dotted' }).line).toMatchObject({ style: 'dashed', dashedValue: [0, 6], lineCap: 'round' });
  });

  it('reads back as dotted (round trip through the overlay styles)', () => {
    for (const size of [1, 2, 3, 4]) {
      for (const style of ['solid', 'dashed', 'dotted'] as const) {
        const l = { color: '#123456', size, style };
        expect(readLine(lineToOverlay(l)), `${style} ${size}`).toEqual(l);
        expect(normalizeOverlayStyles('segment', lineToOverlay(l))).toEqual({ line: l });
      }
    }
  });

  it('the drawing style bar offers Dotted', () => {
    let cb: ((s: SelectedDrawing | null) => void) | null = null;
    const c = { onSelectionChange: vi.fn((f: typeof cb) => { cb = f; return () => {}; }), setSelectedStyle: vi.fn(), setSelectedPrice: vi.fn(), setSelectedLabel: vi.fn(), setSelectedExtend: vi.fn(), setSelectedFill: vi.fn(), onPriceEditRequest: vi.fn(() => () => {}), drawingSwatches: vi.fn(() => []), resetSelectedColor: vi.fn(), arrangeSelected: vi.fn(), selectedOrder: vi.fn(() => null) };
    render(<DrawingStyleBar controls={c as unknown as DrawingStyleControls} />);
    act(() => cb?.({ id: 'a', kind: 'line', name: 'segment', style: { color: '#123456', size: 2, style: 'dotted' }, locked: false, ownLock: false }));
    const sel = screen.getByLabelText('Line style');
    expect(sel).toHaveValue('dotted');
    expect(within(sel).getAllByRole('option').map((o) => o.textContent)).toEqual(['Solid', 'Dashed', 'Dotted']);
    fireEvent.change(sel, { target: { value: 'dashed' } });
    expect(c.setSelectedStyle).toHaveBeenLastCalledWith({ style: 'dashed' });
    fireEvent.change(sel, { target: { value: 'dotted' } });
    expect(c.setSelectedStyle).toHaveBeenLastCalledWith({ style: 'dotted' });
  });

  it('indicator settings offer Dotted and save it', async () => {
    const RSI: IndicatorState = { name: 'RSI', pane: 'sub', calcParams: [6, 12, 24], visible: true };
    const onSave = vi.fn();
    render(<IndicatorSettings state={RSI} theme="light" onSave={onSave} onClose={() => {}} />);
    expect(within(screen.getByLabelText('RSI2 style')).getAllByRole('option').map((o) => o.textContent)).toContain('Dotted');
    await userEvent.selectOptions(screen.getByLabelText('RSI2 style'), 'dotted');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith({ ...RSI, lineStyles: ['solid', 'dotted', 'solid'] });
  });

  it('chart appearance offers a dotted default drawing style (edits the active theme\'s appearance)', async () => {
    for (const theme of ['dark', 'light'] as const) {
      const onChange = vi.fn();
      const { unmount } = render(
        <ChartAppearanceDialog appearance={{ upColor: '#00ff00' }} theme={theme} chartType="candle" onChange={onChange} onClose={() => {}} />,
      );
      const select = screen.getByLabelText('Drawing line style');
      expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Solid', 'Dashed', 'Dotted']);
      await userEvent.selectOptions(select, 'dotted');
      expect(onChange, theme).toHaveBeenLastCalledWith(expect.objectContaining({ upColor: '#00ff00', drawing: expect.objectContaining({ style: 'dotted' }) }));
      unmount();
    }
  });
});
