import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DiffViewer } from '../src/components/DiffViewer.js';

describe('DiffViewer', () => {
  it('shows only changed fields between before and after', () => {
    render(
      <DiffViewer
        before={{ status: 'active', name: 'Alice' }}
        after={{ status: 'suspended', name: 'Alice' }}
      />,
    );
    expect(screen.getByText('status')).toBeInTheDocument();
    expect(screen.queryByText('name')).not.toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByText('suspended')).toBeInTheDocument();
  });

  it('renders a Created panel when before is null', () => {
    render(<DiffViewer before={null} after={{ email: 'a@example.com' }} />);
    expect(screen.getByText('Created')).toBeInTheDocument();
  });
});
