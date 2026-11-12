import type { DrawingAlert } from '@chartmate/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type AlertEntry } from '../src/api/client';
import { alertSummary, AlertsDialog } from '../src/components/AlertsDialog';
import { changeAlert, registerAlertEditor } from '../src/state/alerts';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const base: DrawingAlert = { id: 'a1', on: true, tf: '1h', session: 'rth', cross: ['up', 'down'] };
const entry = (patch: Partial<AlertEntry>): AlertEntry => ({
  id: 'a1', symbol: 'crypto:BTC', ticker: 'BTC', name: 'segment', alert: base, status: 'armed', at: null, message: null, ...patch,
});

describe('alertSummary', () => {
  it('says what each kind of alert watches, with its timeframe', () => {
    expect(alertSummary('segment', base)).toBe('Crosses up or down · 1h');
    expect(alertSummary('segment', { ...base, cross: ['down'] })).toBe('Crosses down · 1h');
    expect(alertSummary('parallelChannel', { ...base, cross: undefined, zone: ['exitUp', 'exitDown'] })).toBe('Breaks above or breaks below · 1h');
    expect(alertSummary('rectangle', { ...base, cross: undefined, zone: ['enter', 'exitDown'] })).toBe('Enters or leaves below · 1h');
    expect(alertSummary('fibonacciLine', { ...base, cross: undefined, levels: [0.5, 0.618] })).toBe('Crosses 61.8% or 50% · 1h');
    expect(alertSummary('longPosition', { ...base, cross: undefined, position: ['entry', 'target', 'stop'] })).toBe('Entry, target or stop · 1h');
    expect(alertSummary('verticalStraightLine', { ...base, cross: undefined })).toBe('Its time arrives · 1h');
    expect(alertSummary('segment', { ...base, cross: [] })).toBe('Nothing chosen · 1h');
  });
});

describe('AlertsDialog', () => {
  it('lists every alert: symbol, drawing, what it watches and how it stands', async () => {
    vi.spyOn(api.alerts, 'get').mockResolvedValue({
      supported: true, alerts: {},
      list: [
        entry({ status: 'fired', at: Date.UTC(2026, 10, 12, 14, 30), message: 'crossed below the trend line' }),
        entry({ id: 'a2', symbol: 'stock:AAPL', ticker: 'AAPL', name: 'longPosition', alert: { ...base, id: 'a2', cross: undefined, position: ['target', 'stop'] }, status: 'open', at: 1 }),
        entry({ id: 'a3', ticker: 'ETH', name: 'horizontalStraightLine', alert: { ...base, id: 'a3', on: false } }),
      ],
    });
    render(<AlertsDialog onClose={() => {}} onShow={() => {}} />);
    const rows = await screen.findAllByRole('listitem');
    expect(rows.map((r) => within(r).getByText(/^(BTC|AAPL|ETH)$/).textContent)).toEqual(['BTC', 'AAPL', 'ETH']);
    expect(rows[0]).toHaveTextContent('Trend line');
    expect(rows[0]).toHaveTextContent(/Triggered .*: crossed below the trend line/);
    expect(within(rows[0]!).getByRole('button', { name: 'Re-arm' })).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent('Target or stop · 1h');
    expect(rows[1]).toHaveTextContent('Entry reached');
    expect(rows[2]).toHaveTextContent('Off');
    expect(within(rows[2]!).getByRole('switch')).not.toBeChecked();
  });

  it('switches, re-arms, removes and shows; the change goes through the chart when it shows the drawing', async () => {
    vi.spyOn(api.alerts, 'get').mockResolvedValue({ supported: true, alerts: {}, list: [entry({ status: 'fired', at: 1, message: 'm' }), entry({ id: 'a2', symbol: 'stock:AAPL', ticker: 'AAPL' })] });
    const setOn = vi.spyOn(api.alerts, 'setOn').mockResolvedValue(undefined);
    const remove = vi.spyOn(api.alerts, 'remove').mockResolvedValue(undefined);
    const rearm = vi.spyOn(api.alerts, 'rearm').mockResolvedValue(undefined);
    const onChart = vi.fn((id: string) => id === 'a1'); // the chart shows a1's drawing only
    const off = registerAlertEditor(onChart);
    const onShow = vi.fn();
    render(<AlertsDialog onClose={() => {}} onShow={onShow} />);
    await userEvent.click(await screen.findByRole('switch', { name: 'BTC Trend line alert' }));
    expect(onChart).toHaveBeenCalledWith('a1', { on: false });
    expect(setOn).not.toHaveBeenCalled(); // handled by the chart
    expect(screen.getByRole('switch', { name: 'BTC Trend line alert' })).not.toBeChecked(); // at once
    await userEvent.click(screen.getByRole('switch', { name: 'AAPL Trend line alert' }));
    expect(setOn).toHaveBeenCalledWith('a2', false); // not on the chart: the server
    await userEvent.click(screen.getByRole('button', { name: 'Remove AAPL Trend line alert' }));
    expect(remove).toHaveBeenCalledWith('a2');
    await waitFor(() => expect(screen.queryByText('AAPL')).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Show BTC Trend line on the chart' }));
    expect(onShow).toHaveBeenCalledWith('crypto:BTC');
    off();
    void rearm;
  });

  it('re-arms a triggered alert; an empty list says how to add one', async () => {
    const get = vi.spyOn(api.alerts, 'get').mockResolvedValueOnce({ supported: true, alerts: {}, list: [entry({ status: 'fired', at: 1, message: 'm' })] });
    const rearm = vi.spyOn(api.alerts, 'rearm').mockResolvedValue(undefined);
    const t = render(<AlertsDialog onClose={() => {}} onShow={() => {}} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Re-arm' }));
    expect(rearm).toHaveBeenCalledWith('a1');
    expect(screen.getByRole('listitem')).toHaveTextContent('Watching');
    t.unmount();
    get.mockResolvedValue({ supported: true, alerts: {}, list: [] });
    render(<AlertsDialog onClose={() => {}} onShow={() => {}} />);
    expect(await screen.findByText(/No alerts yet/)).toBeInTheDocument();
  });
});

describe('changeAlert', () => {
  it('goes to the server when no chart shows the drawing', async () => {
    const remove = vi.spyOn(api.alerts, 'remove').mockResolvedValue(undefined);
    await changeAlert('zz', null);
    expect(remove).toHaveBeenCalledWith('zz');
  });
});
