import { useEffect, useState, type JSX } from 'react';
import { api } from '../api/client';
import { APP_VERSION, SOURCE_URL } from '../buildInfo';
import { isDesktopApp } from '../desktopShell';
import { Modal } from './Modal';
import './AboutDialog.css';

export interface AboutDialogProps {
  onClose: () => void;
  /** Defaults: this build's version and source repository (src/buildInfo.ts), and where the page runs. */
  version?: string;
  sourceUrl?: string | null;
  /** The desktop app: it opens no links, so addresses are selectable text; its server is the app itself. */
  desktop?: boolean;
}

/** `https://github.com/o/r` → `github.com/o/r`. */
const shortUrl = (url: string) => url.replace(/^https:\/\//, '');

/**
 * About Chartmate: the version (and, self-hosted, the server's) and where to get the source code and the license,
 * the offer AGPL-3.0 section 13 asks of software used over a network.
 */
export function AboutDialog({
  onClose, version = APP_VERSION, sourceUrl = SOURCE_URL, desktop = isDesktopApp(),
}: AboutDialogProps): JSX.Element {
  const [serverVersion, setServerVersion] = useState<string | null>(null);

  useEffect(() => {
    if (desktop) return;
    let live = true;
    api.about().then(
      (r) => { if (live && typeof r?.version === 'string') setServerVersion(r.version); },
      () => { /* an older server, or offline: no server row */ },
    );
    return () => { live = false; };
  }, [desktop]);

  const external = { target: '_blank', rel: 'noopener noreferrer' } as const;
  let source: JSX.Element;
  if (sourceUrl === null) source = <span>See LICENSE</span>;
  else if (desktop) {
    source = (
      <span className="about-source">
        <span className="about-url">{sourceUrl}</span>
        <span className="about-hint">Copy it into your browser.</span>
      </span>
    );
  } else source = <a href={sourceUrl} {...external}>{shortUrl(sourceUrl)}</a>;
  const license = sourceUrl !== null && !desktop
    ? <a href={`${sourceUrl}/blob/HEAD/LICENSE`} {...external}>AGPL-3.0</a>
    : <span>AGPL-3.0 (LICENSE)</span>;

  return (
    <Modal title="About Chartmate" onClose={onClose} className="about-dialog">
      <div className="about-identity">
        <img src="/favicon.svg" alt="" width={40} height={40} />
        <div>
          <p className="about-name">Chartmate</p>
          <p className="about-version num">Version {version}</p>
        </div>
      </div>
      <p className="about-text">
        Chartmate is free software under the GNU Affero General Public License, version 3. You can get its source
        code, study it, change it and share it under the same license.
      </p>
      <dl className="about-facts">
        <div>
          <dt>Source code</dt>
          <dd>{source}</dd>
        </div>
        <div>
          <dt>License</dt>
          <dd>{license}</dd>
        </div>
        {serverVersion !== null && (
          <div>
            <dt>Server version</dt>
            <dd className="num">{serverVersion}</dd>
          </div>
        )}
      </dl>
    </Modal>
  );
}
