// "Get the extension" card: lets a user with a pass download the Nova Trade
// extension zip built for this deployment, and explains how to load it
// unpacked in Chrome. Under it, the optional one-click alternative: the same
// build as a Tampermonkey userscript, installed from the user's signed link
// (`GET /api/v1/downloads/userscript/link`). Used in the "Get the extension"
// section of /account.
import { Button, Card, CardContent, CardHeader, CardTitle, CopyField, cn } from '@sl/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Download, ExternalLink, Puzzle } from 'lucide-react';
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

export const USERSCRIPT_LINK_QUERY_KEY = ['downloads', 'userscript', 'link'] as const;

/** The signed-in user's Tampermonkey install link. The API serves the script
 * behind it only while their pass is active. */
export function useUserscriptLink(enabled: boolean) {
  return useQuery({
    queryKey: USERSCRIPT_LINK_QUERY_KEY,
    enabled,
    queryFn: async (): Promise<string> => {
      const { data, error } = await api.GET('/api/v1/downloads/userscript/link');
      if (error) throw error;
      return data.installUrl;
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
      <ol
        aria-label="Install the zip in Chrome"
        className="flex list-decimal flex-col gap-2 pl-5 text-sm text-ink-2 marker:text-ink-2"
      >
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

const linkClass = 'text-gold underline underline-offset-2 hover:text-gold/80';

/** The secondary install path: Tampermonkey, one click, automatic updates. */
function TampermonkeyOption() {
  const link = useUserscriptLink(true);
  const installUrl = link.data;
  return (
    <section
      aria-labelledby="tampermonkey-title"
      className="flex flex-col gap-3 border-t border-(--sl-border) pt-4"
    >
      <h3 id="tampermonkey-title" className="text-sm font-semibold text-ink">
        Prefer one-click install? Use Tampermonkey
      </h3>
      <ol
        aria-label="Install with Tampermonkey"
        className="flex list-decimal flex-col gap-2 pl-5 text-sm text-ink-2 marker:text-ink-2"
      >
        <li>
          Install the{' '}
          <a
            href="https://www.tampermonkey.net/"
            target="_blank"
            rel="noopener noreferrer"
            className={linkClass}
          >
            Tampermonkey extension
          </a>
          .
        </li>
        <li className="flex flex-col items-start gap-1.5">
          <span>Click “Install Nova Trade script”, then confirm in Tampermonkey.</span>
          {installUrl ? (
            <a
              href={installUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-8 items-center gap-1.5 rounded-(--sl-radius-sm) border border-(--sl-border) px-3 text-sm font-medium text-ink hover:bg-(--sl-card-2)"
            >
              <ExternalLink className="size-4" aria-hidden="true" />
              Install Nova Trade script
            </a>
          ) : link.isError ? (
            <span className="text-xs text-ink-2">
              Couldn't load your install link: {apiErrorMessage(link.error)}
            </span>
          ) : (
            <Button variant="outline" size="sm" loading>
              Install Nova Trade script
            </Button>
          )}
        </li>
        <li>Open the EA FC web app.</li>
      </ol>
      <p className="text-xs text-ink-2">
        Tampermonkey updates the script automatically. It works in Chrome, Edge, Firefox and Opera.
        The link is yours alone: it stops working when your pass ends.
      </p>
    </section>
  );
}

export interface ExtensionDownloadCardProps {
  /** `compact` tucks the install steps away behind a disclosure. */
  variant?: 'full' | 'compact';
  /** Render nothing (instead of the "comes with a pass" card) when the user
   * isn't entitled. */
  hideWhenNotEntitled?: boolean;
  /** Leave out the card's own "Get the extension" title, for a page that
   * already heads the section with it. */
  headless?: boolean;
  className?: string;
}

export function ExtensionDownloadCard({
  variant = 'full',
  hideWhenNotEntitled = false,
  headless = false,
  className,
}: ExtensionDownloadCardProps) {
  const infoQuery = useExtensionDownloadInfo();
  const info = infoQuery.data;
  const download = useExtensionDownload(info?.version ?? null);

  if (!info) return null;
  if (!info.entitled && hideWhenNotEntitled) return null;

  return (
    <Card className={className}>
      {!headless && (
        <CardHeader>
          <CardTitle>Get the extension</CardTitle>
          <Puzzle className="size-4 text-ink-2" aria-hidden="true" />
        </CardHeader>
      )}
      <CardContent className={cn('flex flex-col gap-4', headless && 'pt-5')}>
        {!info.entitled ? (
          <p className="text-sm text-ink-2">
            The extension comes with a pass.{' '}
            <a
              href="/account#buy"
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
            <TampermonkeyOption />
          </>
        )}
      </CardContent>
    </Card>
  );
}
