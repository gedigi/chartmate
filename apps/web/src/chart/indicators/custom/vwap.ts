import { nyDayKey, utcDayKey, vwap } from '../calc';
import type { CustomIndicator, IndicatorExtendData } from '../types';

/**
 * Session VWAP on the price pane. The session resets on the New York calendar date for stocks/baskets and
 * on the UTC date for crypto; the chart adapter supplies the asset class via `extendData`.
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
      return vwap(dataList, ext?.assetClass === 'crypto' ? utcDayKey : nyDayKey);
    },
  },
  catalog: {
    name: 'VWAP', label: 'VWAP (session)', pane: 'main', defaultParams: [], paramLabels: [], lines: ['VWAP'],
  },
};

export default indicator;
