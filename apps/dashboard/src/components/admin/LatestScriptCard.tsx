// Admin "Latest extension" card on /admin: installs or downloads the newest
// published Tampermonkey build. The files are the ones publish-userscript.yml
// uploads to dashboard.{$DOMAIN}/userscript/ on every push to main, reached
// here same-origin through vercel.json's /userscript rewrite, so this is
// always the latest version and needs no pass or per-user link.
import { Button, Card, CardContent, CardHeader, CardTitle } from '@sl/ui';
import { useQuery } from '@tanstack/react-query';
import { Download, ExternalLink, Puzzle } from 'lucide-react';

const USER_JS = '/userscript/nova-trade.user.js';
const META_JS = '/userscript/nova-trade.meta.js';

/** `@version` of the published build, or null if it can't be read. */
function useLatestScriptVersion() {
  return useQuery({
    queryKey: ['userscript', 'latest-version'],
    queryFn: async (): Promise<string | null> => {
      const res = await fetch(META_JS, { cache: 'no-store' });
      if (!res.ok) return null;
      const match = /@version\s+(\S+)/.exec(await res.text());
      return match?.[1] ?? null;
    },
    staleTime: 60_000,
  });
}

export function LatestScriptCard() {
  const version = useLatestScriptVersion().data;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Latest extension{version ? ` (v${version})` : ''}</CardTitle>
        <Puzzle className="size-4 text-ink-2" aria-hidden="true" />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={USER_JS}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-9 items-center gap-1.5 rounded-(--sl-radius-sm) border border-(--sl-border) px-3 text-sm font-medium text-ink hover:bg-(--sl-card-2)"
          >
            <ExternalLink className="size-4" aria-hidden="true" />
            Install in Tampermonkey
          </a>
          <Button
            variant="outline"
            leftIcon={<Download className="size-4" aria-hidden="true" />}
            onClick={() => {
              const link = document.createElement('a');
              link.href = USER_JS;
              link.download = 'nova-trade.user.js';
              document.body.appendChild(link);
              link.click();
              link.remove();
            }}
          >
            Download file
          </Button>
        </div>
        <p className="text-xs text-ink-2">
          The newest published build, updated on every release. With Tampermonkey installed,
          “Install” opens its install page; installed copies update themselves.
        </p>
      </CardContent>
    </Card>
  );
}
