import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Sparkline } from '../src/components/Sparkline';

describe('Sparkline', () => {
  it('renders a polyline with one point per value, 80x24', () => {
    const { container } = render(<Sparkline values={[1, 2, 3, 2, 5]} />);
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveAttribute('width', '80');
    expect(svg).toHaveAttribute('height', '24');
    const pts = container.querySelector('polyline')!.getAttribute('points')!.trim().split(/\s+/);
    expect(pts).toHaveLength(5);
  });
  it('colors up when last >= first, down otherwise', () => {
    const up = render(<Sparkline values={[1, 3]} />).container.querySelector('polyline')!;
    expect(up.getAttribute('class')).toContain('up');
    const down = render(<Sparkline values={[3, 1]} />).container.querySelector('polyline')!;
    expect(down.getAttribute('class')).toContain('down');
  });
  it('renders nothing for fewer than 2 points', () => {
    expect(render(<Sparkline values={[1]} />).container.querySelector('svg')).toBeNull();
    expect(render(<Sparkline values={[]} />).container.querySelector('svg')).toBeNull();
  });
  it('handles flat series', () => {
    const { container } = render(<Sparkline values={[2, 2, 2]} />);
    expect(container.querySelector('polyline')!.getAttribute('points')).not.toContain('NaN');
  });
});
