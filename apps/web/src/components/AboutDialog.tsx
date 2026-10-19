import { useEffect, useState, type JSX } from 'react';
import { api } from '../api/client';
import { APP_VERSION, SOURCE_REF, SOURCE_URL } from '../buildInfo';
import { isDesktopApp } from '../desktopShell';
import { Modal } from './Modal';
import './AboutDialog.css';

export interface AboutDialogProps {
  onClose: () => void;
  /** Defaults: this build's version and source repository (src/buildInfo.ts), and where the page runs. */
  version?: string;
  sourceUrl?: string | null;
  /** The git ref of this build's source (default: src/buildInfo.ts): its release tag or its commit. */
  sourceRef?: string | null;
  /** The desktop app: it opens no links, so addresses are selectable text; its server is the app itself. */
  desktop?: boolean;
  /** A production build (default); a development build links the repository root. */
  release?: boolean;
  /** macOS: the desktop app's updates are in its native Chartmate menu (default: from the user agent). */
  mac?: boolean;
}

/** The license text, for a build that does not know its repository. */
export const GNU_AGPL_URL = 'https://www.gnu.org/licenses/agpl-3.0.html';
/** A release tag (`v1.2.3`, `v1.3.0-beta.1`) or a full commit id. */
const VALID_REF = /^(?:v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?|[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Where the source code and the license of this build are: at its ref (`<repo>/tree/<ref>`: the release tag for a
 * build of that tag, else the commit it was built from) for a production build, else the repository root; without a
 * repository, no source link and the license text at gnu.org.
 */
export function sourceLinks(sourceUrl: string | null, ref: string | null, release: boolean): { source: string | null; license: string } {
  if (sourceUrl === null) return { source: null, license: GNU_AGPL_URL };
  if (release && ref !== null && VALID_REF.test(ref) && !ref.includes('..')) {
    return { source: `${sourceUrl}/tree/${ref}`, license: `${sourceUrl}/blob/${ref}/LICENSE` };
  }
  return { source: sourceUrl, license: `${sourceUrl}/blob/HEAD/LICENSE` };
}

/** `https://github.com/o/r` → `github.com/o/r`. */
const shortUrl = (url: string) => url.replace(/^https:\/\//, '');

/**
 * About Chartmate: the version (and, self-hosted, the server's when it differs) and where to get the source code
 * and the license, the offer AGPL-3.0 section 13 asks of software used over a network.
 */
export function AboutDialog({
  onClose, version = APP_VERSION, sourceUrl = SOURCE_URL, sourceRef = SOURCE_REF, desktop = isDesktopApp(),
  release = !import.meta.env.DEV, mac = /Mac/.test(navigator.userAgent),
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

  const links = sourceLinks(sourceUrl, sourceRef, release);
  const external = { target: '_blank', rel: 'noopener noreferrer' } as const;
  let source: JSX.Element;
  if (links.source === null) {
    source = desktop
      ? <span>See LICENSE, next to the app</span>
      : (
        <span className="about-source">
          <span>Ask whoever runs this server for it.</span>
          <span className="about-hint">Operators: see LICENSE and the project page.</span>
        </span>
      );
  } else if (desktop) {
    source = (
      <span className="about-source">
        <span className="about-url">{links.source}</span>
        <span className="about-hint">Copy it into your browser.</span>
      </span>
    );
  } else source = <a href={links.source} {...external}>{shortUrl(sourceUrl!)}</a>;
  const license = desktop
    ? <span>AGPL-3.0 (LICENSE, next to the app)</span>
    : <a href={links.license} {...external}>AGPL-3.0</a>;

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
        {/* Where, not a button: the page has no way to start an update (the update UX stays in the main process). */}
        {desktop && mac && (
          <div>
            <dt>Updates</dt>
            <dd>Chartmate menu → Check for Updates…</dd>
          </div>
        )}
        {serverVersion !== null && serverVersion !== version && (
          <div>
            <dt>Server version</dt>
            <dd className="num">{serverVersion}</dd>
          </div>
        )}
      </dl>
    </Modal>
  );
}
