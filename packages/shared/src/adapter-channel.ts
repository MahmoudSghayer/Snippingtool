/**
 * The MAIN-world adapter <-> ISOLATED-world content script channel name,
 * split into its own zod-free module so `apps/extension`'s `main/adapter.ts`
 * and `content/adapter-client.ts` — both injected into every matching page
 * load, MAIN-world code especially wanting to stay as small as possible —
 * can import just this constant without pulling `zod` and every schema in
 * `ext-messages.ts` along with it (a bare `import { ADAPTER_CHANNEL } from
 * '@sl/shared'` would otherwise execute that whole barrel's module graph).
 * `ext-messages.ts` re-exports this so `@sl/shared`'s public surface is
 * unchanged for every other consumer.
 */
export const ADAPTER_CHANNEL = 'ledger:v2';

/**
 * The EA hosts the Sniping Bot's catalog may load data files and images
 * from (apps/extension `main/catalog-builder.ts`): `https:` on the default
 * port, on `ea.com`, `ea2.com` or `easports.com` or one of their
 * subdomains. The web app and its content (`fut_resourceRoot`, today
 * `https://www.ea.com/`) and its market API (`utas.*.ea.com`) are all under
 * these. Zod-free, like the channel name above, so the MAIN-world adapter
 * can use it; `adapterCatalogSchema` applies the same rule to every image
 * URL in a catalog.
 */
export const EA_ASSET_DOMAINS = ['ea.com', 'ea2.com', 'easports.com'] as const;

/** Whether `url` is an absolute `https:` URL on an EA host (see
 * `EA_ASSET_DOMAINS`). A `{id}` placeholder in the path is allowed (the
 * catalog's portrait template). Anything unparsable is not. */
export function isEaAssetUrl(url: unknown): boolean {
  if (typeof url !== 'string' || url.length > 2_000) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' || parsed.port !== '' || parsed.username || parsed.password)
    return false;
  const host = parsed.hostname.toLowerCase();
  return EA_ASSET_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}
