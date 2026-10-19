import type { Layout } from '@chartmate/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import { AboutDialog, sourceLinks } from '../src/components/AboutDialog';
import { TopBar } from '../src/components/TopBar';

afterEach(() => vi.restoreAllMocks());

const REPO = 'https://github.com/octo-org/chartmate';
const GNU_AGPL = 'https://www.gnu.org/licenses/agpl-3.0.html';

describe('sourceLinks', () => {
  const SHA = '0123456789abcdef0123456789abcdef01234567';

  it('a build of a release tag links the source and the license at that tag', () => {
    expect(sourceLinks(REPO, 'v1.2.3', true)).toEqual({
      source: `${REPO}/tree/v1.2.3`, license: `${REPO}/blob/v1.2.3/LICENSE`,
    });
    expect(sourceLinks(REPO, 'v1.3.0-beta.1', true).source).toBe(`${REPO}/tree/v1.3.0-beta.1`);
  });

  it('a build of any other commit links that commit, not the previous release', () => {
    expect(sourceLinks(REPO, SHA, true)).toEqual({ source: `${REPO}/tree/${SHA}`, license: `${REPO}/blob/${SHA}/LICENSE` });
  });

  it('a development build, one without a ref, or an invalid ref links the repository root', () => {
    const root = { source: REPO, license: `${REPO}/blob/HEAD/LICENSE` };
    expect(sourceLinks(REPO, 'v1.2.3', false)).toEqual(root);
    expect(sourceLinks(REPO, null, true)).toEqual(root);
    for (const ref of ['main', 'vlocal build', '../x', `${SHA}/../x`, SHA.slice(0, 12), 'v1.2.3/../../x']) {
      expect(sourceLinks(REPO, ref, true), ref).toEqual(root);
    }
  });

  it('without a repository: no source link, the license at gnu.org', () => {
    expect(sourceLinks(null, 'v1.2.3', true)).toEqual({ source: null, license: GNU_AGPL });
  });
});

describe('AboutDialog (AGPL-3.0 section 13 source offer)', () => {
  it('shows the version and links to the source of this version and the license (new tab, no referrer)', async () => {
    vi.spyOn(api, 'about').mockResolvedValue({ version: '1.0.0' });
    render(<AboutDialog version="1.0.0" sourceUrl={REPO} sourceRef="v1.0.0" desktop={false} release onClose={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: 'About Chartmate' });
    expect(dialog).toHaveTextContent('Version 1.0.0');
    expect(dialog).toHaveTextContent('GNU Affero General Public License');
    const source = screen.getByRole('link', { name: 'github.com/octo-org/chartmate' });
    expect(source).toHaveAttribute('href', `${REPO}/tree/v1.0.0`);
    expect(source).toHaveAttribute('target', '_blank');
    expect(source).toHaveAttribute('rel', 'noopener noreferrer');
    const license = screen.getByRole('link', { name: 'AGPL-3.0' });
    expect(license).toHaveAttribute('href', `${REPO}/blob/v1.0.0/LICENSE`);
    expect(license).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('a build of a commit after the release links that commit, not the release tag', () => {
    vi.spyOn(api, 'about').mockResolvedValue({ version: '1.0.0' });
    const sha = 'fedcba9876543210fedcba9876543210fedcba98';
    render(<AboutDialog version="1.0.0" sourceUrl={REPO} sourceRef={sha} desktop={false} release onClose={() => {}} />);
    expect(screen.getByRole('link', { name: 'github.com/octo-org/chartmate' })).toHaveAttribute('href', `${REPO}/tree/${sha}`);
    expect(screen.getByRole('link', { name: 'AGPL-3.0' })).toHaveAttribute('href', `${REPO}/blob/${sha}/LICENSE`);
  });

  it('self-hosted: shows the server version only when it differs from the web app\'s', async () => {
    const about = vi.spyOn(api, 'about').mockResolvedValue({ version: '1.0.1' });
    const { unmount } = render(<AboutDialog version="1.0.0" sourceUrl={REPO} desktop={false} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('Server version')).toBeInTheDocument());
    expect(screen.getByText('Server version').nextElementSibling).toHaveTextContent('1.0.1');
    unmount();
    about.mockResolvedValue({ version: '1.0.0' });
    render(<AboutDialog version="1.0.0" sourceUrl={REPO} desktop={false} onClose={() => {}} />);
    await waitFor(() => expect(about).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(screen.queryByText('Server version')).not.toBeInTheDocument();
  });

  it('a server that does not say (or fails) shows no server version row', async () => {
    const about = vi.spyOn(api, 'about').mockRejectedValue(new Error('404'));
    render(<AboutDialog version="1.0.0" sourceUrl={REPO} desktop={false} onClose={() => {}} />);
    await waitFor(() => expect(about).toHaveBeenCalled());
    expect(screen.queryByText('Server version')).not.toBeInTheDocument();
  });

  it('built without a repository: asks the server\'s operator for the source; the license links to gnu.org', () => {
    vi.spyOn(api, 'about').mockResolvedValue({ version: null });
    render(<AboutDialog version="1.0.0" sourceUrl={null} desktop={false} onClose={() => {}} />);
    expect(screen.getByText('Ask whoever runs this server for it.')).toBeInTheDocument();
    expect(screen.getByText('Operators: see LICENSE and the project page.')).toHaveClass('about-hint');
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'AGPL-3.0' })).toHaveAttribute('href', GNU_AGPL);
  });

  it('desktop: the address of this version\'s source is selectable text (the app opens no links), no server row', () => {
    const about = vi.spyOn(api, 'about');
    render(<AboutDialog version="1.0.0" sourceUrl={REPO} sourceRef="v1.0.0" desktop release onClose={() => {}} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    const url = screen.getByText(`${REPO}/tree/v1.0.0`);
    expect(url).toHaveClass('about-url');
    expect(screen.getByText('Copy it into your browser.')).toBeInTheDocument();
    expect(screen.getByText('License').nextElementSibling).toHaveTextContent('AGPL-3.0 (LICENSE, next to the app)');
    expect(screen.queryByText('Server version')).not.toBeInTheDocument();
    expect(about).not.toHaveBeenCalled();
  });

  it('desktop on macOS: says where updates are (the Chartmate menu); no button, the page cannot start an update', () => {
    render(<AboutDialog version="1.0.0" sourceUrl={REPO} sourceRef="v1.0.0" desktop mac release onClose={() => {}} />);
    expect(screen.getByText('Updates').nextElementSibling).toHaveTextContent('Chartmate menu → Check for Updates…');
    expect(screen.queryByRole('button', { name: /update/i })).not.toBeInTheDocument();
  });

  it('no updates row on Windows (no menu bar) or self-hosted', () => {
    const { unmount } = render(<AboutDialog version="1.0.0" sourceUrl={REPO} desktop mac={false} onClose={() => {}} />);
    expect(screen.queryByText('Updates')).not.toBeInTheDocument();
    unmount();
    vi.spyOn(api, 'about').mockResolvedValue({ version: '1.0.0' });
    render(<AboutDialog version="1.0.0" sourceUrl={REPO} desktop={false} mac onClose={() => {}} />);
    expect(screen.queryByText('Updates')).not.toBeInTheDocument();
  });

  it('desktop built without a repository: points to the LICENSE that ships with the app', () => {
    render(<AboutDialog version="1.0.0" sourceUrl={null} desktop onClose={() => {}} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('Source code').nextElementSibling).toHaveTextContent('See LICENSE, next to the app');
  });

  it('closes with the close button and Escape', async () => {
    vi.spyOn(api, 'about').mockResolvedValue({ version: '1.0.0' });
    const onClose = vi.fn();
    render(<AboutDialog version="1.0.0" sourceUrl={REPO} desktop={false} onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('TopBar brand', () => {
  const layout: Layout = { symbol: 'stock:AAPL', tf: '1D', session: 'rth', chartType: 'candle', indicators: [] };
  const props = {
    layout, setLayout: () => {}, symbolInfo: null, showSession: false, onSelectSymbol: () => {}, onView: () => {},
    theme: 'dark' as const, onToggleTheme: () => {}, sidebarOpen: true, onToggleSidebar: () => {},
  };

  it.each(['chart', 'baskets'] as const)('opens About Chartmate from the %s view, and focus returns to it', async (view) => {
    vi.spyOn(api, 'about').mockResolvedValue({ version: '1.0.0' });
    render(<TopBar {...props} view={view} />);
    const brand = screen.getByRole('button', { name: 'About Chartmate' });
    await userEvent.click(brand);
    expect(screen.getByRole('dialog', { name: 'About Chartmate' })).toHaveTextContent(/Version \d+\.\d+\.\d+/);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(brand).toHaveFocus();
  });
});
