import type { IndicatorState } from '@altv/shared';
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
    expect(dashPattern('dotted', 1)).toEqual([0, 2]);
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
    for (const style of ['solid', 'dashed', 'dotted'] as const) {
      const l = { color: '#123456', size: 3, style };
      expect(readLine(lineToOverlay(l))).toEqual(l);
      expect(normalizeOverlayStyles('segment', lineToOverlay(l))).toEqual({ line: l });
    }
  });

  it('the drawing style bar offers Dotted', () => {
    let cb: ((s: SelectedDrawing | null) => void) | null = null;
    const c = { onSelectionChange: vi.fn((f: typeof cb) => { cb = f; return () => {}; }), setSelectedStyle: vi.fn(), setSelectedPrice: vi.fn(), setSelectedLabel: vi.fn(), onPriceEditRequest: vi.fn(() => () => {}) };
    render(<DrawingStyleBar controls={c as unknown as DrawingStyleControls} />);
    act(() => cb?.({ id: 'a', kind: 'line', style: { color: '#123456', size: 2, style: 'dotted' }, locked: false }));
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
    render(<IndicatorSettings state={RSI} onSave={onSave} onClose={() => {}} />);
    expect(within(screen.getByLabelText('RSI2 style')).getAllByRole('option').map((o) => o.textContent)).toContain('Dotted');
    await userEvent.selectOptions(screen.getByLabelText('RSI2 style'), 'dotted');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith({ ...RSI, lineStyles: ['solid', 'dotted', 'solid'] });
  });

  it('chart appearance offers a dotted default drawing style', async () => {
    const onChange = vi.fn();
    render(<ChartAppearanceDialog appearance={undefined} theme="dark" chartType="candle" onChange={onChange} onClose={() => {}} />);
    await userEvent.selectOptions(screen.getByLabelText('Drawing line style'), 'dotted');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ drawing: expect.objectContaining({ style: 'dotted' }) }));
  });
});
