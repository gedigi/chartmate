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

  it('failed (permanent): an alert in the error color, a short fixed sentence (the reason in the title), no Retry', () => {
    render(<SaveNote thing="Watchlist" state="failed" detail="Too many symbols" retryLabel="Retry saving the watchlist" onRetry={() => {}} />);
    const note = screen.getByRole('alert');
    expect(note).toHaveTextContent(/^Watchlist not saved\.$/);
    expect(note).toHaveAttribute('title', 'Too many symbols');
    expect(note).toHaveClass('is-error');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('a custom message and a Discard action (explicitly drops what could not be saved)', () => {
    const onDiscard = vi.fn();
    render(<SaveNote thing="Drawings" message="Drawings not saved for AAPL and MSFT" state="failed" detail="AAPL: too large"
      retryLabel="Retry" onRetry={() => {}} discardLabel="Discard unsaved drawings" onDiscard={onDiscard} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Drawings not saved for AAPL and MSFT.');
    const discard = screen.getByRole('button', { name: 'Discard unsaved drawings' });
    expect(discard).toHaveClass('save-note-discard'); // a quieter text button, not styled like Retry
    expect(discard).not.toHaveClass('save-note-retry');
    fireEvent.click(discard);
    expect(onDiscard).toHaveBeenCalled();
  });

  it('a short form for narrow rows: both texts render, CSS shows one (container query)', () => {
    render(<SaveNote thing="Drawings" message="Drawings not saved for AAPL, MSFT and 3 more" shortMessage="Drawings not saved (5)"
      state="retrying" detail="x" retryLabel="Retry" onRetry={() => {}} />);
    expect(document.querySelector('.save-note-long')).toHaveTextContent('Drawings not saved for AAPL, MSFT and 3 more. Retrying…');
    expect(document.querySelector('.save-note-short')).toHaveTextContent('Drawings not saved (5). Retrying…');
    expect(document.querySelector('.save-note-short')).toHaveAttribute('aria-hidden', 'true');
  });
});
