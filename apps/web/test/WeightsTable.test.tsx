import type { SymbolInfo } from '@chartmate/shared';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import { normalizePercents, newRow, validateRows, WeightsTable, type WeightRow } from '../src/components/WeightsTable';

vi.mock('../src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/client')>();
  return { ...actual, api: { ...actual.api, search: vi.fn() } };
});

afterEach(() => vi.clearAllMocks());

function Harness({ initial }: { initial: WeightRow[] }) {
  const [rows, setRows] = useState(initial);
  return <WeightsTable rows={rows} onChange={setRows} />;
}

const weightInputs = () => screen.getAllByRole('spinbutton', { name: /Weight for/ });

describe('WeightsTable', () => {
  it('shows the live total and normalizes 33.3/33.3/33.3 to exactly 100', async () => {
    render(<Harness initial={[newRow('stock:AAPL', '33.3'), newRow('stock:MSFT', '33.3'), newRow('crypto:BTC', '33.3')]} />);
    expect(screen.getByTestId('weights-total')).toHaveTextContent('99.90%');
    expect(screen.getByRole('alert')).toHaveTextContent('Total must be 100% (currently 99.90%)');

    await userEvent.click(screen.getByRole('button', { name: 'Normalize to 100%' }));
    const values = weightInputs().map((i) => Number((i as HTMLInputElement).value));
    expect(values).toEqual([33.34, 33.33, 33.33]);
    expect(Math.round(values.reduce((a, b) => a + b, 0) * 100)).toBe(10000);
    expect(screen.getByTestId('weights-total')).toHaveTextContent('100.00%');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('normalize leaves empty/zero/negative rows untouched and hints to remove or fill them', async () => {
    render(<Harness initial={[newRow('stock:AAPL', '1000000'), newRow('stock:MSFT', '1'), newRow('crypto:BTC', ''), newRow('crypto:ETH', '-5'), newRow('stock:SPY', '0')]} />);
    expect(screen.getByText(/remove them or fill in a weight/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Normalize to 100%' }));
    expect(weightInputs().map((i) => (i as HTMLInputElement).value)).toEqual(['99.99', '0.01', '', '-5', '0']);
    expect(screen.getByTestId('weights-total')).toHaveTextContent('95.00%');
  });

  it('shows no unsized-row hint when every weight is positive', () => {
    render(<Harness initial={[newRow('stock:AAPL', '60'), newRow('crypto:BTC', '30')]} />);
    expect(screen.queryByText(/remove them or fill in a weight/)).not.toBeInTheDocument();
  });

  it('accepts decimals and a total within ±0.01', () => {
    render(<Harness initial={[newRow('stock:AAPL', '33.33'), newRow('stock:MSFT', '33.33'), newRow('crypto:BTC', '33.33')]} />);
    expect(screen.getByTestId('weights-total')).toHaveTextContent('99.99%');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.change(weightInputs()[2]!, { target: { value: '33.32' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Total must be 100%');
  });

  it('flags duplicate symbols', () => {
    render(<Harness initial={[newRow('stock:AAPL', '50'), newRow('stock:AAPL', '50')]} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Duplicate symbol: AAPL');
  });

  it('flags an empty table', () => {
    render(<Harness initial={[]} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Add at least one constituent');
  });

  it('caps a version at 50 constituents: "Add constituent" disabled with a hint', async () => {
    const rows49 = Array.from({ length: 49 }, (_, i) => newRow(`stock:S${i}`, '1'));
    render(<Harness initial={rows49} />);
    const add = screen.getByRole('button', { name: 'Add constituent' });
    expect(add).toBeEnabled();
    expect(screen.queryByTestId('constituent-limit')).not.toBeInTheDocument();
    await userEvent.click(add);
    expect(screen.getAllByTestId('weight-row')).toHaveLength(50);
    expect(add).toBeDisabled();
    expect(screen.getByTestId('constituent-limit')).toHaveTextContent('at most 50 constituents');
  });

  it('flags more than 50 rows', () => {
    render(<Harness initial={Array.from({ length: 51 }, (_, i) => newRow(`stock:S${i}`, '1'))} />);
    expect(screen.getByRole('alert')).toHaveTextContent('At most 50 constituents per version');
  });

  it('removes a row', async () => {
    render(<Harness initial={[newRow('stock:AAPL', '60'), newRow('crypto:BTC', '40')]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Remove AAPL' }));
    expect(screen.queryByText('AAPL')).not.toBeInTheDocument();
    expect(screen.getByText('BTC')).toBeInTheDocument();
    expect(screen.getByTestId('weights-total')).toHaveTextContent('40.00%');
  });

  it('adds a row and picks a symbol; search results exclude baskets', async () => {
    const results: SymbolInfo[] = [
      { id: 'stock:AAPL', assetClass: 'stock', ticker: 'AAPL', name: 'Apple', pricePrecision: 2 },
      { id: 'basket:abc', assetClass: 'basket', ticker: 'My basket', name: 'My basket', pricePrecision: 2 },
    ];
    vi.mocked(api.search).mockResolvedValue(results);
    render(<Harness initial={[]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Add constituent' }));
    const row = screen.getAllByTestId('weight-row')[0]!;
    await userEvent.type(within(row).getByRole('combobox'), 'a');
    const options = await screen.findAllByRole('option');
    expect(options).toHaveLength(1);
    await userEvent.click(options[0]!);
    expect(within(row).getByText('AAPL')).toBeInTheDocument();
  });
});

describe('weights helpers', () => {
  it('normalizePercents puts the rounding remainder on the largest weight', () => {
    expect(normalizePercents([1, 1, 1])).toEqual([33.34, 33.33, 33.33]);
    expect(normalizePercents([1, 2, 1])).toEqual([25, 50, 25]);
    expect(normalizePercents([0.7, 0.3])).toEqual([70, 30]);
    expect(normalizePercents([1, 1, 2, 2, 2, 2])).toEqual([10, 10, 20, 20, 20, 20]);
    const r = normalizePercents([1, 2, 3, 7]);
    expect(Math.round(r.reduce((a, b) => a + b, 0) * 100)).toBe(10000);
    expect(r[3]).toBe(53.85);
  });

  it('normalizePercents gives every positive weight at least 0.01 and still totals exactly 100', () => {
    expect(normalizePercents([1e6, 1])).toEqual([99.99, 0.01]);
    const r = normalizePercents([1e9, 1, 1, 1]);
    expect(r).toEqual([99.97, 0.01, 0.01, 0.01]);
    expect(Math.round(r.reduce((a, b) => a + b, 0) * 100)).toBe(10000);
    expect(() => normalizePercents([1, 0])).toThrow();
    expect(() => normalizePercents([])).toThrow();
  });

  it('validateRows returns percents keyed by symbol when valid', () => {
    const v = validateRows([newRow('stock:AAPL', '60'), newRow('crypto:BTC', '40')]);
    expect(v.errors).toEqual([]);
    expect(v.percents).toEqual({ 'stock:AAPL': 60, 'crypto:BTC': 40 });
    expect(validateRows([newRow(null, '100')]).errors).toContain('Choose a symbol for every row');
    expect(validateRows([newRow('stock:AAPL', '0')]).errors).toContain('Every weight must be a positive number');
    expect(validateRows([newRow('stock:AAPL', '')]).percents).toBeNull();
  });
});
