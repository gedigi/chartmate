/**
 * Inert stand-in for `klinecharts` in jsdom (no canvas). Registered globally in test/setup.ts;
 * tests that inspect chart calls install their own vi.mock('klinecharts').
 */
let seq = 0;

function makeChart() {
  return {
    setStyles() {}, setSymbol() {}, setPeriod() {}, setDataLoader() {}, setTimezone() {}, resize() {},
    getDataList: () => [],
    getIndicators: () => [],
    getOverlays: () => [],
    createIndicator: () => `stub_ind_${++seq}`,
    overrideIndicator: () => true,
    removeIndicator: () => true,
    createOverlay: () => `stub_ov_${++seq}`,
    overrideOverlay: () => true,
    removeOverlay: () => true,
  };
}

export const init = () => makeChart();
export const dispose = () => {};
export const registerIndicator = () => {};
export const registerOverlay = () => {};
export const getSupportedIndicators = () => [];
export const getSupportedOverlays = () => [];
