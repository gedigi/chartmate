import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArrangeMenu } from '../src/components/ArrangeMenu';

function controls(order: { atFront: boolean; atBack: boolean } | null = { atFront: false, atBack: false }) {
  return { arrangeSelected: vi.fn((_how: string) => true), selectedOrder: vi.fn(() => order) };
}

afterEach(() => vi.restoreAllMocks());

describe('ArrangeMenu', () => {
  it('opens a menu of the four actions with their shortcuts; picking one arranges the drawing and closes it', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    const c = controls();
    render(<ArrangeMenu controls={c} locked={false} />);
    const button = screen.getByRole('button', { name: 'Arrange' });
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
    await userEvent.click(button);
    const menu = screen.getByRole('menu', { name: 'Arrange' });
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent))
      .toEqual(['Bring to front⇧⌘]', 'Bring forward⌘]', 'Send backward⌘[', 'Send to back⇧⌘[']);
    await userEvent.click(within(menu).getByRole('menuitem', { name: /Send to back/ }));
    expect(c.arrangeSelected).toHaveBeenCalledWith('back');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  it('shows Ctrl shortcuts off Apple platforms', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32');
    render(<ArrangeMenu controls={controls()} locked={false} />);
    await userEvent.click(screen.getByRole('button', { name: 'Arrange' }));
    expect(screen.getByRole('menuitem', { name: /Bring to front/ })).toHaveTextContent('Ctrl+Shift+]');
    expect(screen.getByRole('menuitem', { name: /Send backward/ })).toHaveTextContent('Ctrl+[');
  });

  it('disables what would change nothing: at the front, Bring to front / forward', async () => {
    const c = controls({ atFront: true, atBack: false });
    render(<ArrangeMenu controls={c} locked={false} />);
    await userEvent.click(screen.getByRole('button', { name: 'Arrange' }));
    expect(screen.getByRole('menuitem', { name: /Bring to front/ })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: /Bring forward/ })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: /Send backward/ })).toBeEnabled();
    // The focus starts on the first action that does something.
    expect(screen.getByRole('menuitem', { name: /Send backward/ })).toHaveFocus();
  });

  it('is disabled on a locked drawing, and when the drawing is the only one', () => {
    const { unmount } = render(<ArrangeMenu controls={controls()} locked />);
    expect(screen.getByRole('button', { name: 'Arrange' })).toBeDisabled();
    unmount();
    render(<ArrangeMenu controls={controls({ atFront: true, atBack: true })} locked={false} />);
    expect(screen.getByRole('button', { name: 'Arrange' })).toBeDisabled();
  });

  it('keyboard: ArrowDown opens, arrows skip disabled items, Enter picks, Escape closes back to the button', async () => {
    const c = controls({ atFront: false, atBack: true });
    render(<ArrangeMenu controls={c} locked={false} />);
    const button = screen.getByRole('button', { name: 'Arrange' });
    button.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: /Bring to front/ })).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}'); // Send backward / to back are disabled: wraps to the top
    expect(screen.getByRole('menuitem', { name: /Bring to front/ })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(button).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(c.arrangeSelected).toHaveBeenCalledWith('forward');
  });

  it('closes on a click outside', async () => {
    render(<><ArrangeMenu controls={controls()} locked={false} /><button type="button">elsewhere</button></>);
    await userEvent.click(screen.getByRole('button', { name: 'Arrange' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'elsewhere' }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
