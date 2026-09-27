import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/api/client.js';
import { NotificationsBell } from '@/components/NotificationsBell.js';

const ITEMS = [
  {
    id: '00000000-0000-0000-0000-0000000000n1',
    type: 'subscription.activated',
    title: 'Your pass is active',
    body: 'Enjoy.',
    data: {},
    readAt: null,
    createdAt: '2026-09-26T12:00:00.000Z',
  },
  {
    id: '00000000-0000-0000-0000-0000000000n2',
    type: 'device.new',
    title: 'New device signed in',
    body: null,
    data: {},
    readAt: null,
    createdAt: '2026-09-25T12:00:00.000Z',
  },
  {
    id: '00000000-0000-0000-0000-0000000000n3',
    type: 'system',
    title: 'Old news',
    body: null,
    data: {},
    readAt: '2026-09-20T12:00:00.000Z',
    createdAt: '2026-09-20T12:00:00.000Z',
  },
];

function ok(data: unknown) {
  return Promise.resolve({ data, error: undefined, response: new Response(null, { status: 200 }) });
}

function mockApi(items = ITEMS) {
  const get = vi
    .spyOn(api, 'GET')
    .mockImplementation((() => ok({ items, nextCursor: null })) as never);
  const post = vi.spyOn(api, 'POST').mockImplementation((() => ok({ ok: true })) as never);
  return { get, post };
}

function renderBell() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <NotificationsBell />
    </QueryClientProvider>,
  );
  return { user: userEvent.setup() };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('NotificationsBell', () => {
  it('names the bell with the unread count', async () => {
    mockApi();
    renderBell();
    expect(
      await screen.findByRole('button', { name: 'Notifications, 2 unread' }),
    ).toBeInTheDocument();
  });

  it('is just "Notifications" with nothing unread', async () => {
    mockApi([ITEMS[2]!]);
    renderBell();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Notifications' })).toBeVisible(),
    );
  });

  it('opens from the keyboard, and every notification is a focusable menu item', async () => {
    mockApi();
    const { user } = renderBell();
    const bell = await screen.findByRole('button', { name: 'Notifications, 2 unread' });

    bell.focus();
    await user.keyboard('{Enter}');
    const menu = await screen.findByRole('menu');
    expect(menu).toBeInTheDocument();
    const items = screen.getAllByRole('menuitem');
    // Three notifications plus "Mark all as read".
    expect(items.map((i) => i.textContent)).toEqual([
      'Mark all as read',
      expect.stringContaining('Your pass is active'),
      expect.stringContaining('New device signed in'),
      expect.stringContaining('Old news'),
    ]);

    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(items[1]);
  });

  it('marks one notification read when it is chosen', async () => {
    const { post } = mockApi();
    const { user } = renderBell();
    await user.click(await screen.findByRole('button', { name: 'Notifications, 2 unread' }));
    await user.click(await screen.findByRole('menuitem', { name: /New device signed in/ }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/v1/notifications/{id}/read', {
        params: { path: { id: ITEMS[1]!.id } },
      }),
    );
  });

  it('does not re-mark a notification that is already read', async () => {
    const { post } = mockApi();
    const { user } = renderBell();
    await user.click(await screen.findByRole('button', { name: 'Notifications, 2 unread' }));
    await user.click(await screen.findByRole('menuitem', { name: /Old news/ }));
    expect(post).not.toHaveBeenCalled();
  });

  it('marks everything read at once', async () => {
    const { post } = mockApi();
    const { user } = renderBell();
    await user.click(await screen.findByRole('button', { name: 'Notifications, 2 unread' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Mark all as read' }));

    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/v1/notifications/read-all'));
  });
});
