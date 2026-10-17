import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { drawingSwatches } from '../src/chart/drawingColors';
import { PaletteColorPicker } from '../src/components/PaletteColorPicker';

const rect = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 100, width: 100, height: bottom - top, x: 0, y: top, toJSON: () => ({}) });

/** Lays out a picker button at `buttonTop` inside a scrolling box spanning 0–400 px; the popover is 150 px tall. */
function layout(buttonTop: number) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('scroller')) return rect(0, 400) as DOMRect;
    if (this.classList.contains('color-picker-popover')) return rect(0, 150) as DOMRect;
    if (this.classList.contains('color-picker')) return rect(buttonTop, buttonTop + 26) as DOMRect;
    return rect(0, 0) as DOMRect;
  });
  render(
    <div className="scroller" style={{ overflowY: 'auto' }}>
      <PaletteColorPicker label="Up bar color" value="up" swatches={drawingSwatches('dark')} onPick={() => {}} onReset={() => {}} />
    </div>,
  );
}
const popover = () => document.querySelector('.color-picker-popover')!;

afterEach(() => vi.restoreAllMocks());

describe('PaletteColorPicker placement', () => {
  it('opens below when it fits inside its scrolling container', async () => {
    layout(40);
    await userEvent.click(screen.getByRole('button', { name: 'Up bar color' }));
    expect(popover()).not.toHaveClass('above');
  });

  it('opens upward when it would be cut off below (the last rows of a scrolling dialog)', async () => {
    layout(330);
    await userEvent.click(screen.getByRole('button', { name: 'Up bar color' }));
    expect(popover()).toHaveClass('above');
  });
});
