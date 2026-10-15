import type { Layout } from '@chartmate/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';
import { AboutDialog } from '../src/components/AboutDialog';
import { TopBar } from '../src/components/TopBar';

afterEach(() => vi.restoreAllMocks());

const REPO = 'https://github.com/octo-org/chartmate';

describe('AboutDialog (AGPL-3.0 section 13 source offer)', () => {
  it('shows the version and links to the source code and the license (new tab, no referrer)', async () => {
    vi.spyOn(api, 'about').mockResolvedValue({ version: '1.0.0' });
    render(<AboutDialog version="1.0.0" sourceUrl={REPO} desktop={false} onClose={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: 'About Chartmate' });
    expect(dialog).toHaveTextContent('Version 1.0.0');
    expect(dialog).toHaveTextContent('GNU Affero General Public License');
    const source = screen.getByRole('link', { name: 'github.com/octo-org/chartmate' });
    expect(source).toHaveAttribute('href', REPO);
    expect(source).toHaveAttribute('target', '_blank');
    expect(source).toHaveAttribute('rel', 'noopener noreferrer');
    const license = screen.getByRole('link', { name: 'AGPL-3.0' });
    expect(license).toHaveAttribute('href', `${REPO}/blob/HEAD/LICENSE`);
    expect(license).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('self-hosted: also shows the server version', async () => {
    vi.spyOn(api, 'about').mockResolvedValue({ version: '1.0.1' });
    render(<AboutDialog version="1.0.0" sourceUrl={REPO} desktop={false} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('Server version')).toBeInTheDocument());
    expect(screen.getByText('Server version').nextElementSibling).toHaveTextContent('1.0.1');
  });

  it('a server that does not say (or fails) shows no server version row', async () => {
    const about = vi.spyOn(api, 'about').mockRejectedValue(new Error('404'));
    render(<AboutDialog version="1.0.0" sourceUrl={REPO} desktop={false} onClose={() => {}} />);
    await waitFor(() => expect(about).toHaveBeenCalled());
    expect(screen.queryByText('Server version')).not.toBeInTheDocument();
  });

  it('built without a repository: no links, "See LICENSE"', () => {
    vi.spyOn(api, 'about').mockResolvedValue({ version: null });
    render(<AboutDialog version="1.0.0" sourceUrl={null} desktop={false} onClose={() => {}} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('Source code').nextElementSibling).toHaveTextContent('See LICENSE');
  });

  it('desktop: the source address is selectable text (the app opens no links), and there is no separate server', () => {
    const about = vi.spyOn(api, 'about');
    render(<AboutDialog version="1.0.0" sourceUrl={REPO} desktop onClose={() => {}} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    const url = screen.getByText(REPO);
    expect(url).toHaveClass('about-url');
    expect(screen.getByText('Copy it into your browser.')).toBeInTheDocument();
    expect(screen.queryByText('Server version')).not.toBeInTheDocument();
    expect(about).not.toHaveBeenCalled();
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
