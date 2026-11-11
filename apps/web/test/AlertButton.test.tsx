import type { DrawingAlert } from '@chartmate/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import { AlertButton } from '../src/components/AlertButton';
import { resetAlertsSupported } from '../src/state/alerts';

const base: DrawingAlert = { id: 'a1', on: true, tf: '1h', session: 'rth', cross: ['up', 'down'], extend: true };

/** The button over a stand-in adapter that keeps the alert like the real one ('new' → the defaults). */
function Harness({ name, initial, onSet }: { name: string; initial: DrawingAlert | null; onSet?: (a: DrawingAlert | 'new' | null) => void }) {
  const [alert, setAlert] = useState<DrawingAlert | null>(initial);
  const controls = {
    setSelectedAlert: (next: DrawingAlert | 'new' | null) => {
      onSet?.(next);
      setAlert(next === 'new' ? { ...base, id: 'new1' } : next);
      return true;
    },
  };
  return <AlertButton controls={controls} name={name} alert={alert} />;
}

beforeEach(() => resetAlertsSupported());
afterEach(() => vi.restoreAllMocks());

describe('AlertButton', () => {
  it('hidden where alerts are not checked (the web server) and on text', async () => {
    vi.spyOn(api.alerts, 'get').mockResolvedValue({ supported: false, alerts: {} });
    const { container } = render(<Harness name="segment" initial={null} />);
    await waitFor(() => expect(api.alerts.get).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    resetAlertsSupported();
    vi.mocked(api.alerts.get).mockResolvedValue({ supported: true, alerts: {} });
    const t = render(<Harness name="simpleAnnotation" initial={null} />);
    await waitFor(() => expect(api.alerts.get).toHaveBeenCalledTimes(2));
    expect(t.container).toBeEmptyDOMElement();
  });

  it('turning it on creates the alert; the line options edit it; the status says what it watches', async () => {
    vi.spyOn(api.alerts, 'get').mockResolvedValue({ supported: true, alerts: {} });
    const onSet = vi.fn();
    render(<Harness name="segment" initial={null} onSet={onSet} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Alert' }));
    const on = screen.getByRole('checkbox', { name: 'Notify me' });
    expect(on).not.toBeChecked();
    await userEvent.click(on);
    expect(onSet).toHaveBeenLastCalledWith('new');
    expect(screen.getByRole('checkbox', { name: 'Crosses up' })).toBeChecked();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Crosses down' }));
    expect(onSet).toHaveBeenLastCalledWith({ ...base, id: 'new1', cross: ['up'] });
    expect(screen.getByRole('checkbox', { name: 'Keep watching past its end' })).toBeChecked();
    expect(screen.getByRole('status')).toHaveTextContent('Watching on the 1h chart.');
    expect(screen.getByRole('button', { name: 'Alert' })).toHaveAttribute('data-armed', 'true');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Notify me' }));
    expect(onSet).toHaveBeenLastCalledWith(expect.objectContaining({ on: false }));
    expect(screen.getByRole('checkbox', { name: 'Crosses up' })).toBeDisabled();
  });

  it('each kind of drawing gets its own choices', async () => {
    vi.spyOn(api.alerts, 'get').mockResolvedValue({ supported: true, alerts: {} });
    const open = async (name: string, alert: DrawingAlert) => {
      const t = render(<Harness name={name} initial={alert} />);
      await userEvent.click(await screen.findByRole('button', { name: 'Alert' }));
      return t;
    };
    let t = await open('parallelChannel', { ...base, cross: undefined, zone: ['exitUp', 'exitDown'] });
    expect(screen.getAllByRole('checkbox').map((c) => c.closest('label')!.textContent)).toEqual(['Notify me', 'Breaks above', 'Breaks below', 'Re-enters', 'Keep watching past its end']);
    t.unmount();
    t = await open('rectangle', { ...base, cross: undefined, zone: ['enter'] });
    expect(screen.getByRole('checkbox', { name: 'Enters' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Leaves above' })).not.toBeChecked();
    t.unmount();
    t = await open('fibonacciLine', { ...base, cross: undefined, extend: undefined, levels: [0.618] });
    expect(screen.getByRole('checkbox', { name: '61.8%' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '50%' })).not.toBeChecked();
    expect(screen.queryByRole('checkbox', { name: 'Keep watching past its end' })).not.toBeInTheDocument();
    t.unmount();
    t = await open('longPosition', { ...base, cross: undefined, extend: undefined, position: ['entry', 'target', 'stop'] });
    expect(screen.getAllByRole('checkbox').slice(1).map((c) => c.closest('label')!.textContent)).toEqual(['Entry reached', 'Target hit', 'Stop hit']);
    t.unmount();
    await open('verticalStraightLine', { ...base, cross: undefined, extend: undefined });
    expect(screen.getByText('Notifies when this time arrives.')).toBeInTheDocument();
  });

  it('a fired alert says what happened and can be re-armed; Escape closes the panel', async () => {
    const get = vi.spyOn(api.alerts, 'get')
      .mockResolvedValueOnce({ supported: true, alerts: {} })
      .mockResolvedValueOnce({ supported: true, alerts: { a1: { status: 'fired', at: Date.UTC(2026, 10, 10, 14, 30), message: 'crossed below the trend line' } } })
      .mockResolvedValue({ supported: true, alerts: {} });
    const rearm = vi.spyOn(api.alerts, 'rearm').mockResolvedValue(undefined);
    render(<Harness name="segment" initial={base} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Alert' }));
    expect(await screen.findByText(/Triggered .*: crossed below the trend line\./)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Re-arm' }));
    expect(rearm).toHaveBeenCalledWith('a1');
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Watching on the 1h chart.'));
    expect(get).toHaveBeenCalledTimes(3);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Alert' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Alert' })).toHaveFocus();
  });
});
