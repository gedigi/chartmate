import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TimeframeBar, type TimeframeBarProps } from '../src/components/TimeframeBar';

function setup(over: Partial<TimeframeBarProps> = {}) {
  const props: TimeframeBarProps = {
    tf: '1D', onTf: vi.fn(), session: 'rth', onSession: vi.fn(), showSession: true,
    chartType: 'candle', onChartType: vi.fn(), ...over,
  };
  render(<TimeframeBar {...props} />);
  return props;
}

describe('TimeframeBar', () => {
  it('renders 10 timeframe buttons with aria-pressed on the active one', () => {
    setup();
    const group = screen.getByRole('group', { name: 'Timeframe' });
    const buttons = group.querySelectorAll('button');
    expect(buttons).toHaveLength(10);
    expect(screen.getByRole('button', { name: '1D' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '4h' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('clicking 4h calls onTf("4h")', async () => {
    const p = setup();
    await userEvent.click(screen.getByRole('button', { name: '4h' }));
    expect(p.onTf).toHaveBeenCalledWith('4h');
  });

  it('shows the RTH/ETH toggle only when showSession is true', async () => {
    const p = setup();
    expect(screen.getByRole('button', { name: 'RTH' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'ETH' }));
    expect(p.onSession).toHaveBeenCalledWith('eth');
  });

  it('hides the session toggle when showSession is false', () => {
    setup({ showSession: false });
    expect(screen.queryByRole('button', { name: 'RTH' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ETH' })).not.toBeInTheDocument();
  });

  it('chart type select calls onChartType', async () => {
    const p = setup();
    const select = screen.getByRole('combobox', { name: 'Chart type' });
    expect(select).toHaveValue('candle');
    await userEvent.selectOptions(select, 'Line');
    expect(p.onChartType).toHaveBeenCalledWith('line');
  });
});
