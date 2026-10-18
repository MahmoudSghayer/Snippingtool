import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DateRangePicker, defaultDateRange } from '../src/components/DateRangePicker.js';

const selected = (name: string) =>
  screen.getByRole('button', { name }).className.includes('bg-(--sl-accent)');

describe('DateRangePicker', () => {
  it('starts on the preset its value is', () => {
    render(<DateRangePicker value={defaultDateRange('7d')} onChange={() => {}} />);
    expect(selected('7d')).toBe(true);
    expect(selected('30d')).toBe(false);
  });

  it('offers only the presets asked for', () => {
    render(
      <DateRangePicker
        value={defaultDateRange('7d')}
        presets={['7d', '30d']}
        onChange={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: '30d' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '90d' })).not.toBeInTheDocument();
  });

  it('shows no preset as selected with activePreset null, and reports a pick', () => {
    const onChange = vi.fn();
    render(
      <DateRangePicker value={defaultDateRange('7d')} activePreset={null} onChange={onChange} />,
    );
    expect(['7d', '30d', '90d', 'Custom'].some(selected)).toBe(false);

    screen.getByRole('button', { name: '30d' }).click();
    expect(onChange).toHaveBeenCalledWith(defaultDateRange('30d'), '30d');
  });
});
