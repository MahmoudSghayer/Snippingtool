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

/**
 * How the adapter files an EA HTTP error it saw on a market, trade-pile or
 * buy response (apps/extension `main/adapter.ts`, the `ea_error` message),
 * so each engine can react the right way: `session_ended` (401: log in to
 * the web app again), `verification` (458: EA's captcha), `rate_limited`
 * (429, 512, 521: slow down), `server_error` (any other 5xx), `rejected`
 * (any other 4xx — 403, 461, 478 and the like: someone else's buy landed
 * first, not enough coins...), `other` (an empty answer, or a status
 * outside 4xx/5xx). Zod-free, like the channel name, for the MAIN world.
 */
export const EA_ERROR_CATEGORIES = [
  'session_ended',
  'verification',
  'rate_limited',
  'server_error',
  'rejected',
  'other',
] as const;
export type EaErrorCategory = (typeof EA_ERROR_CATEGORIES)[number];

/** What an EA error's request was for: a market search, the trade pile (or
 * a relist or item move), a buy, or anything else. */
export const EA_ERROR_ENDPOINTS = ['market', 'pile', 'bid', 'other'] as const;
export type EaErrorEndpoint = (typeof EA_ERROR_ENDPOINTS)[number];

/** The category of an EA HTTP error status (`EA_ERROR_CATEGORIES`). EA's own
 * codes, as traders report them: 401 an expired session, 458 a verification
 * (captcha), 429 / 512 / 521 too many requests — 512 and 521 sit in the 5xx
 * range but are rate limits, not outages. */
export function eaErrorCategory(status: number): EaErrorCategory {
  if (status === 401) return 'session_ended';
  if (status === 458) return 'verification';
  if (status === 429 || status === 512 || status === 521) return 'rate_limited';
  if (status >= 500 && status <= 599) return 'server_error';
  if (status >= 400 && status <= 499) return 'rejected';
  return 'other';
}
