import { act, fireEvent, render, screen } from '@testing-library/react';
import type { JSX } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scrollFade, useScrollEdges } from '../src/state/useScrollEdges';

function Row(): JSX.Element {
  const [ref, edges] = useScrollEdges();
  return <div ref={ref} data-testid="row" data-fade={scrollFade(edges)} />;
}

/** jsdom lays nothing out: the row's scroll metrics are set by hand. */
function metrics(el: HTMLElement, m: { scrollWidth: number; clientWidth: number; scrollLeft: number }) {
  Object.defineProperty(el, 'scrollWidth', { configurable: true, value: m.scrollWidth });
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: m.clientWidth });
  el.scrollLeft = m.scrollLeft;
}

let resize: (() => void) | null = null;
afterEach(() => {
  vi.unstubAllGlobals();
  resize = null;
});

describe('useScrollEdges', () => {
  it('reports which edges hide content, following scrolls and resizes', () => {
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: () => void) { resize = cb; }
      observe() {}
      disconnect() {}
    });
    render(<Row />);
    const row = screen.getByTestId('row');
    expect(row.dataset.fade).toBe('none');
    metrics(row, { scrollWidth: 500, clientWidth: 300, scrollLeft: 0 });
    act(() => resize!());
    expect(row.dataset.fade).toBe('end');
    metrics(row, { scrollWidth: 500, clientWidth: 300, scrollLeft: 100 });
    fireEvent.scroll(row);
    expect(row.dataset.fade).toBe('both');
    metrics(row, { scrollWidth: 500, clientWidth: 300, scrollLeft: 200 });
    fireEvent.scroll(row);
    expect(row.dataset.fade).toBe('start');
    metrics(row, { scrollWidth: 300, clientWidth: 400, scrollLeft: 0 });
    act(() => resize!());
    expect(row.dataset.fade).toBe('none');
  });

  it('scrollFade names the edges', () => {
    expect(scrollFade({ start: false, end: false })).toBe('none');
    expect(scrollFade({ start: true, end: false })).toBe('start');
    expect(scrollFade({ start: false, end: true })).toBe('end');
    expect(scrollFade({ start: true, end: true })).toBe('both');
  });
});
