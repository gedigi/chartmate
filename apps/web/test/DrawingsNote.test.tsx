import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DrawingsNote } from '../src/components/DrawingsSave';
import { drawingsStore } from '../src/state/drawingsStore';

const d = [{ name: 'segment', points: [{ timestamp: 1, value: 2 }], lock: false }];

function seed(entries: Array<[`stock:${string}`, 'retrying' | 'stalled' | 'failed']>) {
  act(() => {
    for (const [sym, state] of entries) {
      drawingsStore.setValue(sym, d);
      drawingsStore.setStatus(sym, { state, detail: `${state} error`, retry: vi.fn() });
    }
  });
}

beforeEach(() => drawingsStore.reset());
afterEach(() => vi.restoreAllMocks());

describe('DrawingsNote (one note for every symbol waiting to be saved)', () => {
  it('mixed: any permanent failure turns the note red, with Retry (for the stalled ones) and a quiet Discard', () => {
    seed([['stock:AAPL', 'failed'], ['stock:MSFT', 'stalled']]);
    render(<DrawingsNote />);
    const note = screen.getByRole('alert');
    expect(note).toHaveClass('is-error');
    expect(note.querySelector('.save-note-long')).toHaveTextContent('Drawings not saved for AAPL and MSFT.');
    expect(note.querySelector('.save-note-short')).toHaveTextContent('Drawings not saved (2).');
    expect(note).toHaveAttribute('title', 'AAPL: failed error\nMSFT: stalled error');
    const retry = drawingsStore.getSnapshot().statuses.get('stock:MSFT')!.retry;
    fireEvent.click(screen.getByRole('button', { name: 'Retry saving the drawings' }));
    expect(retry).toHaveBeenCalled();
    // One failed symbol: discarded without asking.
    fireEvent.click(screen.getByRole('button', { name: 'Discard the drawings that could not be saved' }));
    expect(drawingsStore.getSnapshot().values.has('stock:AAPL')).toBe(false);
    expect(drawingsStore.getSnapshot().values.has('stock:MSFT')).toBe(true);
  });

  it('Discard covering more than one symbol asks first', () => {
    seed([['stock:AAPL', 'failed'], ['stock:MSFT', 'failed'], ['stock:SPY', 'failed']]);
    render(<DrawingsNote />);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const discard = screen.getByRole('button', { name: 'Discard the drawings that could not be saved' });
    fireEvent.click(discard);
    expect(confirm).toHaveBeenCalledWith('Discard the unsaved drawings of AAPL, MSFT and 1 more? They cannot be saved.');
    expect(drawingsStore.getSnapshot().values.size).toBe(3);
    fireEvent.click(discard);
    expect(drawingsStore.getSnapshot().values.size).toBe(0);
  });
});
