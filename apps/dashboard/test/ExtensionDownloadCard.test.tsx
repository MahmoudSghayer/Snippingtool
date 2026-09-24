import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/api/client.js';
import {
  ExtensionDownloadCard,
  filenameFromContentDisposition,
  formatSizeMb,
  type ExtensionDownloadInfo,
} from '@/components/ExtensionDownload.js';

const toastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { error: toastError, success: vi.fn() } }));

const ENTITLED: ExtensionDownloadInfo = {
  available: true,
  entitled: true,
  version: '2.4.1',
  sizeBytes: 3.5 * 1024 * 1024,
};

type Props = Parameters<typeof ExtensionDownloadCard>[0];

/** Mocks `api.GET`: the info endpoint answers with `info`; the zip endpoint
 * answers with `download` (or a 403 by default). */
function mockApi(
  info: ExtensionDownloadInfo,
  download?: () => Promise<unknown>,
): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(api, 'GET').mockImplementation(((path: string) => {
    if (path === '/api/v1/downloads/extension/info') {
      return Promise.resolve({
        data: info,
        error: undefined,
        response: new Response(null, { status: 200 }),
      });
    }
    if (path === '/api/v1/downloads/extension' && download) return download();
    return Promise.resolve({
      data: undefined,
      error: { code: 'FORBIDDEN', message: 'Your pass does not include the extension.' },
      response: new Response(null, { status: 403 }),
    });
  }) as never);
}

function renderCard(props: Props = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <ExtensionDownloadCard {...props} />
    </QueryClientProvider>,
  );
  return { ...result, user: userEvent.setup() };
}

let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;

beforeEach(() => {
  createObjectURL = vi.fn(() => 'blob:mock-url');
  revokeObjectURL = vi.fn();
  Object.assign(URL, { createObjectURL, revokeObjectURL });
});

afterEach(() => {
  vi.restoreAllMocks();
  toastError.mockReset();
});

describe('helpers', () => {
  it('formats sizes in MB', () => {
    expect(formatSizeMb(3.5 * 1024 * 1024)).toBe('3.5 MB');
    expect(formatSizeMb(12.4 * 1024 * 1024)).toBe('12 MB');
  });

  it('reads the filename from Content-Disposition', () => {
    expect(filenameFromContentDisposition('attachment; filename="nova.zip"')).toBe('nova.zip');
    expect(filenameFromContentDisposition('attachment; filename=nova.zip')).toBe('nova.zip');
    expect(
      filenameFromContentDisposition(
        `attachment; filename="x.zip"; filename*=UTF-8''nova%20trade.zip`,
      ),
    ).toBe('nova trade.zip');
    expect(filenameFromContentDisposition('attachment')).toBeNull();
    expect(filenameFromContentDisposition(null)).toBeNull();
  });
});

describe('ExtensionDownloadCard', () => {
  it('shows the download button, size and install steps when entitled', async () => {
    mockApi(ENTITLED);
    renderCard();

    expect(
      await screen.findByRole('button', { name: /Download Nova Trade v2\.4\.1/ }),
    ).toBeInTheDocument();
    expect(screen.getByText('3.5 MB zip')).toBeInTheDocument();
    const steps = screen.getAllByRole('listitem');
    expect(steps).toHaveLength(5);
    expect(steps[0]).toHaveTextContent('Unzip the file.');
    expect(steps[1]).toHaveTextContent('chrome://extensions');
    expect(steps[3]).toHaveTextContent('nova-trade-extension');
    expect(screen.getByText(/When a new version comes out, download it again/)).toBeInTheDocument();
  });

  it('points users without the autobuyer to the plans', async () => {
    mockApi({ available: true, entitled: false, version: '2.4.1', sizeBytes: 1000 });
    renderCard();

    expect(await screen.findByText(/The extension comes with a pass\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See plans and pay' })).toHaveAttribute(
      'href',
      '/subscriptions#pricing',
    );
    expect(screen.queryByRole('button', { name: /Download/ })).not.toBeInTheDocument();
  });

  it('renders nothing for users who are not entitled when asked to hide', async () => {
    const get = mockApi({ available: true, entitled: false, version: null, sizeBytes: null });
    const { container } = renderCard({ variant: 'compact', hideWhenNotEntitled: true });

    await waitFor(() => expect(get).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container).toBeEmptyDOMElement();
  });

  it('says so when the server has no build', async () => {
    mockApi({ available: false, entitled: true, version: null, sizeBytes: null });
    renderCard();

    expect(
      await screen.findByText("The download isn't available on this server yet."),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Download/ })).not.toBeInTheDocument();
  });

  it('downloads the zip as a blob and saves it under the server filename', async () => {
    const blob = new Blob(['zip'], { type: 'application/zip' });
    const get = mockApi(ENTITLED, () =>
      Promise.resolve({
        data: blob,
        error: undefined,
        response: new Response(null, {
          status: 200,
          headers: { 'content-disposition': 'attachment; filename="nova-trade-2.4.1.zip"' },
        }),
      }),
    );
    const clicked: { href: string; download: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push({ href: this.href, download: this.download });
    });
    const { user } = renderCard();

    await user.click(await screen.findByRole('button', { name: /Download Nova Trade/ }));

    await waitFor(() => expect(clicked).toHaveLength(1));
    expect(get).toHaveBeenCalledWith('/api/v1/downloads/extension', { parseAs: 'blob' });
    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(clicked[0]).toEqual({ href: 'blob:mock-url', download: 'nova-trade-2.4.1.zip' });
    expect(toastError).not.toHaveBeenCalled();
  });

  it('falls back to a versioned filename without Content-Disposition', async () => {
    mockApi(ENTITLED, () =>
      Promise.resolve({
        data: new Blob(['zip']),
        error: undefined,
        response: new Response(null, { status: 200 }),
      }),
    );
    const downloads: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloads.push(this.download);
    });
    const { user } = renderCard();

    await user.click(await screen.findByRole('button', { name: /Download Nova Trade/ }));

    await waitFor(() => expect(downloads).toEqual(['nova-trade-extension-2.4.1.zip']));
  });

  it('shows an error toast when the download is refused', async () => {
    mockApi(ENTITLED);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click');
    const { user } = renderCard();

    await user.click(await screen.findByRole('button', { name: /Download Nova Trade/ }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Couldn't download the extension", {
        description: 'Your pass does not include the extension.',
      }),
    );
    expect(click).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Download Nova Trade/ })).not.toHaveAttribute(
      'aria-busy',
    );
  });
});
