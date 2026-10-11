import type { JSX } from 'react';

export function StaleBadge({ stale }: { stale: boolean }): JSX.Element | null {
  if (!stale) return null;
  return <span className="stale-badge" role="status">Data delayed — source unavailable</span>;
}
