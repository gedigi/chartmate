import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RangeBar } from '../src/components/RangeBar';

describe('RangeBar', () => {
  it('renders the eight presets in a "Date range" group, in sentence case', () => {
    render(<RangeBar value={null} onSelect={vi.fn()} />);
    const group = screen.getByRole('group', { name: 'Date range' });
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['1D', '5D', '1M', '3M', '6M', 'YTD', '1Y', 'All']);
    for (const b of within(group).getAllByRole('button')) expect(b).toHaveAttribute('aria-pressed', 'false');
  });

  it('marks the selected preset with aria-pressed and names each in its tooltip', () => {
    render(<RangeBar value="1Y" onSelect={vi.fn()} />);
    const group = screen.getByRole('group', { name: 'Date range' });
    expect(within(group).getByRole('button', { name: '1Y' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(group).getByRole('button', { name: '1Y' })).toHaveAttribute('title', 'Show 1 year');
    expect(within(group).getByRole('button', { name: 'YTD' })).toHaveAttribute('title', 'Show year to date');
    expect(within(group).getByRole('button', { name: '1D' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('clicking a preset selects it (again too: the range is shown anew)', async () => {
    const onSelect = vi.fn();
    render(<RangeBar value="5D" onSelect={onSelect} />);
    const group = screen.getByRole('group', { name: 'Date range' });
    await userEvent.click(within(group).getByRole('button', { name: 'All' }));
    await userEvent.click(within(group).getByRole('button', { name: '5D' }));
    expect(onSelect.mock.calls).toEqual([['All'], ['5D']]);
  });

  it('disabled: no button acts', async () => {
    const onSelect = vi.fn();
    render(<RangeBar value={null} onSelect={onSelect} disabled />);
    const group = screen.getByRole('group', { name: 'Date range' });
    for (const b of within(group).getAllByRole('button')) expect(b).toBeDisabled();
    await userEvent.click(within(group).getByRole('button', { name: '1M' }));
    expect(onSelect).not.toHaveBeenCalled();
  });
});
