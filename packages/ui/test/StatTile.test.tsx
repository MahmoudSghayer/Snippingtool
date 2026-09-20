import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { StatTile } from '../src/components/StatTile.js';

describe('StatTile', () => {
  it('renders a positive delta with an up arrow and green tone', () => {
    render(<StatTile label="Net profit" value="1,240,000" delta={0.124} deltaLabel="vs prior 7d" />);
    expect(screen.getByText('Net profit')).toBeInTheDocument();
    expect(screen.getByText('1,240,000')).toBeInTheDocument();
    expect(screen.getByText('+12.4%')).toBeInTheDocument();
    expect(screen.getByText('vs prior 7d')).toBeInTheDocument();
  });

  it('inverts delta tone for metrics where a rise is bad', () => {
    render(<StatTile label="Error rate" value="2.1%" delta={0.5} invertDeltaTone />);
    const delta = screen.getByText('+50%');
    expect(delta.className).toContain('sl-negative');
  });
});
