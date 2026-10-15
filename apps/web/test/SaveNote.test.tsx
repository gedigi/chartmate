import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SaveNote } from '../src/components/SaveNote';

describe('SaveNote (one treatment for every save that has not reached the server)', () => {
  it('retrying: "<Thing> not saved. Retrying…", calm warn tone, a status, the raw error in the title', () => {
    render(<SaveNote thing="Layout" state="retrying" detail="down" retryLabel="Retry saving the layout" onRetry={() => {}} />);
    const note = screen.getByRole('status');
    expect(note).toHaveTextContent('Layout not saved. Retrying…');
    expect(note).toHaveAttribute('title', 'down');
    expect(note).toHaveClass('save-note', 'is-warn');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('stalled: "<Thing> not saved." with a Retry button, same tone', () => {
    const onRetry = vi.fn();
    render(<SaveNote thing="Watchlist" state="stalled" detail="offline" retryLabel="Retry saving the watchlist" onRetry={onRetry} />);
    const note = screen.getByRole('status');
    expect(note).toHaveTextContent('Watchlist not saved.');
    expect(note).toHaveClass('is-warn');
    fireEvent.click(screen.getByRole('button', { name: 'Retry saving the watchlist' }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('failed (permanent): an alert in the error color with the reason, no Retry', () => {
    render(<SaveNote thing="Watchlist" state="failed" detail="Too many symbols" retryLabel="Retry saving the watchlist" onRetry={() => {}} />);
    const note = screen.getByRole('alert');
    expect(note).toHaveTextContent('Watchlist not saved: Too many symbols');
    expect(note).toHaveClass('is-error');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
