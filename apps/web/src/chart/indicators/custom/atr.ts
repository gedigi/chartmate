import { atr } from '../calc';
import type { CustomIndicator } from '../types';

/** Average True Range (Wilder) in its own pane. */
const indicator: CustomIndicator = {
  template: {
    name: 'ATR',
    shortName: 'ATR',
    calcParams: [14],
    figures: [{ key: 'atr', title: 'ATR: ', type: 'line' }],
    calc: (dataList, ind) => atr(dataList, ind.calcParams[0] ?? 14),
  },
  catalog: {
    name: 'ATR', label: 'Average True Range', pane: 'sub', defaultParams: [14], paramLabels: ['Period'], lines: ['ATR'],
  },
};

export default indicator;
