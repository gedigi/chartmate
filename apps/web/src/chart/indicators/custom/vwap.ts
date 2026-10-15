import { nyDayKey, utcDayKey, vwap } from '../calc';
import type { CustomIndicator, IndicatorExtendData } from '../types';

/**
 * Session VWAP on the price pane. On intraday charts the session resets on the New York calendar date for
 * stocks and stock-only baskets and on the UTC date for crypto and baskets holding crypto (`utcDays`); on 1D and longer timeframes (where every bar is its own
 * session) it is anchored to the first loaded bar instead. The chart adapter supplies asset class and
 * timeframe via `extendData`.
 */
const indicator: CustomIndicator = {
  template: {
    name: 'VWAP',
    shortName: 'VWAP',
    series: 'price',
    calcParams: [],
    figures: [{ key: 'vwap', title: 'VWAP: ', type: 'line' }],
    styles: { lines: [{ style: 'solid', smooth: false, size: 1, dashedValue: [2, 2] }] }, // color: palette slot 5 (blue), set by the chart adapter per theme
    calc: (dataList, ind) => {
      const ext = ind.extendData as IndicatorExtendData | undefined;
      if (ext?.intraday === false) return vwap(dataList, () => 0);
      return vwap(dataList, ext?.assetClass === 'crypto' || ext?.utcDays === true ? utcDayKey : nyDayKey);
    },
  },
  catalog: {
    name: 'VWAP', label: 'VWAP (session, intraday)', pane: 'main', defaultParams: [], paramLabels: [], lines: ['VWAP'],
    lineSlots: [5], // blue: no other price-pane overlay uses it (MA slots 0-3, EMA 0-2, BOLL 0-2, BBI 0)
    description: 'Resets each session on intraday charts; on 1D and longer timeframes it spans the whole loaded series.',
  },
};

export default indicator;
