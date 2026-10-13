/**
 * Friendly names of the exchange codes Yahoo reports (`SymbolInfo.exchange`). Unknown codes (and the fixture
 * provider's) have none: the UI then omits the exchange rather than show a raw code.
 */
const NAMES: Readonly<Record<string, string>> = {
  NMS: 'Nasdaq', NGM: 'Nasdaq', NCM: 'Nasdaq', NAS: 'Nasdaq', NIM: 'Nasdaq',
  NYQ: 'NYSE', NYS: 'NYSE', ASE: 'NYSE American', PCX: 'NYSE Arca', ARCX: 'NYSE Arca',
  BTS: 'Cboe', BATS: 'Cboe', CBO: 'Cboe', PNK: 'OTC', OQB: 'OTC', OQX: 'OTC', OEM: 'OTC',
};

export function exchangeName(code: string | undefined): string | null {
  return code ? NAMES[code.toUpperCase()] ?? null : null;
}
