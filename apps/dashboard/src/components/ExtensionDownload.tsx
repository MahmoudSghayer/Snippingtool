// "Get the extension" card: lets a user with a pass download the Nova Trade
// extension zip built for this deployment, and explains how to load it
// unpacked in Chrome. Used at the top of /subscriptions (full) and on the
// /dashboard home (compact).
import { Button, Card, CardContent, CardHeader, CardTitle, CopyField } from '@sl/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Download, Puzzle } from 'lucide-react';
import { toast } from 'sonner';

import { api, apiErrorMessage } from '@/api/client.js';

export interface ExtensionDownloadInfo {
  available: boolean;
  entitled: boolean;
  version: string | null;
  sizeBytes: number | null;
}

export const EXTENSION_INFO_QUERY_KEY = ['downloads', 'extension', 'info'] as const;

export function useExtensionDownloadInfo() {
  return useQuery({
    queryKey: EXTENSION_INFO_QUERY_KEY,
    queryFn: async (): Promise<ExtensionDownloadInfo> => {
      const { data, error } = await api.GET('/api/v1/downloads/extension/info');
      if (error) throw error;
      return data;
    },
  });
}

/** `12.3 MB`, with one decimal below 10 MB so small builds don't read "0 MB". */
export function formatSizeMb(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** Pulls the filename out of a Content-Disposition header, preferring the
 * RFC 5987 `filename*=` form. Returns null when there isn't a usable one. */
export function filenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  const extended = /filename\*\s*=\s*(?:UTF-8'[^']*')?([^;]+)/i.exec(header);
  if (extended?.[1]) {
    try {
      return decodeURIComponent(extended[1].trim().replace(/^"|"$/g, ''));
    } catch {
      // fall through to the plain form
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(header);
  const name = (plain?.[2] ?? plain?.[1])?.trim();
  return name ? name : null;
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Give the browser a moment to start the download before revoking.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function useExtensionDownload(version: string | null) {
  return useMutation({
    mutationFn: async () => {
      const { data, error, response } = await api.GET('/api/v1/downloads/extension', {
        parseAs: 'blob',
      });
      if (error !== undefined || !data) throw error ?? new Error('Empty download');
      const filename =
        filenameFromContentDisposition(response.headers.get('content-disposition')) ??
        `nova-trade-extension-${version ?? 'latest'}.zip`;
      saveBlob(data, filename);
    },
    onError: (error) =>
      toast.error("Couldn't download the extension", { description: apiErrorMessage(error) }),
  });
}

function InstallSteps() {
  return (
    <div className="flex flex-col gap-3">
      <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm text-ink-2 marker:text-ink-2">
        <li>Unzip the file.</li>
        <li>
          <span>Open this address in Chrome (copy it into the address bar):</span>
          <CopyField value="chrome://extensions" className="mt-1.5 max-w-xs" />
        </li>
        <li>Turn on Developer mode (top right).</li>
        <li>
          Click “Load unpacked” and choose the{' '}
          <code className="font-mono text-xs text-ink">nova-trade-extension</code> folder.
        </li>
        <li>Pin Nova Trade, sign in, and open the EA FC web app.</li>
      </ol>
      <p className="text-xs text-ink-2">
        When a new version comes out, download it again, then remove the old one on
        chrome://extensions and load the new folder. Your settings stay in your account.
      </p>
    </div>
  );
}

export interface ExtensionDownloadCardProps {
  /** `compact` is the /dashboard home version: install steps tucked away. */
  variant?: 'full' | 'compact';
  /** Render nothing (instead of the "comes with a pass" card) when the user
   * isn't entitled. */
  hideWhenNotEntitled?: boolean;
  className?: string;
}

export function ExtensionDownloadCard({
  variant = 'full',
  hideWhenNotEntitled = false,
  className,
}: ExtensionDownloadCardProps) {
  const infoQuery = useExtensionDownloadInfo();
  const info = infoQuery.data;
  const download = useExtensionDownload(info?.version ?? null);

  if (!info) return null;
  if (!info.entitled && hideWhenNotEntitled) return null;

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Get the extension</CardTitle>
        <Puzzle className="size-4 text-ink-2" aria-hidden="true" />
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!info.entitled ? (
          <p className="text-sm text-ink-2">
            The extension comes with a pass.{' '}
            <a
              href="/subscriptions#pricing"
              className="text-gold underline underline-offset-2 hover:text-gold/80"
            >
              See plans and pay
            </a>
          </p>
        ) : !info.available ? (
          <p className="text-sm text-ink-2">The download isn't available on this server yet.</p>
        ) : (
          <>
            <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-3">
              <Button
                loading={download.isPending}
                leftIcon={<Download className="size-4" aria-hidden="true" />}
                onClick={() => download.mutate()}
              >
                Download Nova Trade{info.version ? ` v${info.version}` : ''}
              </Button>
              {info.sizeBytes !== null && (
                <span className="text-xs text-ink-2">{formatSizeMb(info.sizeBytes)} zip</span>
              )}
            </div>
            {variant === 'full' ? (
              <InstallSteps />
            ) : (
              <details className="text-sm">
                <summary className="cursor-pointer text-xs text-gold underline underline-offset-2 hover:text-gold/80">
                  How to install
                </summary>
                <div className="mt-3">
                  <InstallSteps />
                </div>
              </details>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
