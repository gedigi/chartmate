import { nyDayKey, utcDayKey, vwap } from '../calc';
import type { CustomIndicator, IndicatorExtendData } from '../types';

/**
 * Session VWAP on the price pane. On intraday charts the session resets on the New York calendar date for
 * stocks/baskets and on the UTC date for crypto; on 1D and longer timeframes (where every bar is its own
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
    calc: (dataList, ind) => {
      const ext = ind.extendData as IndicatorExtendData | undefined;
      if (ext?.intraday === false) return vwap(dataList, () => 0);
      return vwap(dataList, ext?.assetClass === 'crypto' ? utcDayKey : nyDayKey);
    },
  },
  catalog: {
    name: 'VWAP', label: 'VWAP (session, intraday)', pane: 'main', defaultParams: [], paramLabels: [], lines: ['VWAP'],
    description: 'Resets each session on intraday charts; on 1D and longer timeframes it spans the whole loaded series.',
  },
};

export default indicator;
