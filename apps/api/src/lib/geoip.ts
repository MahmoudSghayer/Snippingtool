// Pluggable IP geo/ASN enrichment. `ip_activity` (docs/09-security.md "IP
// monitoring") wants a country + ASN per request so impossible-travel /
// new-country detection has something to compare, but this repo does not
// ship or download a geo database (explicitly out of scope — "do not
// download databases"). The interface is the seam: a real deployment wires
// `GEOIP_PROVIDER=maxmind` (a local `.mmdb` file path via
// `GEOIP_MAXMIND_DB_PATH`) or `GEOIP_PROVIDER=ipinfo` (a token via
// `IPINFO_TOKEN`) and gets real enrichment; everything else (dev, test, and
// prod until one of those is configured) gets the no-op provider, which is
// always correct — "we don't know" is a valid, safe answer this whole
// feature is built to tolerate (see `recordSuspiciousIpIfAny`: a null
// country never raises a flag, it just skips the check).
//
// These three env vars are also declared in `config/env.ts`'s zod schema
// (validated + documented there, and `GEOIP_PROVIDER` fails fast at boot if
// set to anything other than `noop`/`maxmind`/`ipinfo`) — this file still
// reads `process.env` directly rather than `fastify.config` because
// `getGeoIpProvider()` is called from a default parameter value
// (`upsertIpActivity`'s `provider = getGeoIpProvider()`), outside any
// request/Fastify-instance context.

export interface GeoIpLookupResult {
  country: string | null;
  asn: number | null;
}

export interface GeoIpProvider {
  readonly name: string;
  lookup(ip: string): Promise<GeoIpLookupResult>;
}

const NULL_RESULT: GeoIpLookupResult = { country: null, asn: null };

/** Always returns "unknown". Correct default: no database is bundled, and a
 * monitoring feature that guesses wrong is worse than one that abstains. */
export class NoopGeoIpProvider implements GeoIpProvider {
  readonly name = 'noop';
  async lookup(_ip: string): Promise<GeoIpLookupResult> {
    return NULL_RESULT;
  }
}

/** Local MaxMind GeoLite2/GeoIP2 `.mmdb` file, read via the optional
 * `maxmind` npm package. Never fetches or downloads a database — the path
 * to an already-present file is supplied by the operator via
 * `GEOIP_MAXMIND_DB_PATH`. Falls back to "unknown" (never throws) if the
 * package isn't installed or the file can't be opened, so an operator who
 * sets the env var wrong degrades to no-op instead of crashing the API. */
export class MaxMindGeoIpProvider implements GeoIpProvider {
  readonly name = 'maxmind';
  private readerPromise: Promise<unknown> | undefined;

  constructor(private readonly dbPath: string) {}

  private async getReader(): Promise<unknown> {
    if (!this.readerPromise) {
      this.readerPromise = (async () => {
        // Optional peer dependency — dynamic import (via a non-literal
        // specifier, so this typechecks whether or not the package is
        // installed) so the rest of the API works unmodified without it.
        const moduleName = 'maxmind';
        const maxmind = (await import(moduleName).catch(() => undefined)) as { open: (path: string) => Promise<unknown> } | undefined;
        if (!maxmind) return undefined;
        return maxmind.open(this.dbPath).catch(() => undefined);
      })();
    }
    return this.readerPromise;
  }

  async lookup(ip: string): Promise<GeoIpLookupResult> {
    const reader = (await this.getReader()) as { get?: (ip: string) => unknown } | undefined;
    if (!reader?.get) return NULL_RESULT;
    try {
      const record = reader.get(ip) as
        | { country?: { iso_code?: string }; registered_country?: { iso_code?: string }; autonomous_system_number?: number }
        | null
        | undefined;
      const country = record?.country?.iso_code ?? record?.registered_country?.iso_code ?? null;
      const asn = record?.autonomous_system_number ?? null;
      return { country, asn };
    } catch {
      return NULL_RESULT;
    }
  }
}

/** ipinfo.io HTTP lookup (opt-in, `IPINFO_TOKEN`). A real network call, so
 * kept out of the hot path — only used when a real login's IP monitoring
 * wants live enrichment and the operator has explicitly opted in. Fails
 * open to "unknown" on any network/parse error. */
export class IpinfoGeoIpProvider implements GeoIpProvider {
  readonly name = 'ipinfo';
  constructor(private readonly token: string) {}

  async lookup(ip: string): Promise<GeoIpLookupResult> {
    try {
      const res = await fetch(`https://ipinfo.io/${encodeURIComponent(ip)}/json?token=${encodeURIComponent(this.token)}`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) return NULL_RESULT;
      const body = (await res.json()) as { country?: string; org?: string };
      const asnMatch = body.org?.match(/^AS(\d+)/);
      return { country: body.country ?? null, asn: asnMatch ? Number(asnMatch[1]) : null };
    } catch {
      return NULL_RESULT;
    }
  }
}

/** A fixed `ip -> { country, asn }` lookup table from a JSON env var
 * (`GEOIP_STATIC_MAP`, e.g. `{"203.0.113.5":"US","198.51.100.7":"DE"}` —
 * values may also be `{ "country": "US", "asn": 15169 }` objects). Not a
 * MaxMind/ipinfo replacement for production traffic, but a real, useful
 * provider in its own right for a short allowlist of known corporate VPN
 * exits/office IPs, and what this repo's own integration tests use to
 * exercise the new-country/impossible-travel logic deterministically
 * without a real geo database or network access — see
 * `modules/auth/__tests__/ip-monitoring.test.ts`. */
export class StaticGeoIpProvider implements GeoIpProvider {
  readonly name = 'static';
  constructor(private readonly map: Record<string, { country: string | null; asn: number | null }>) {}

  async lookup(ip: string): Promise<GeoIpLookupResult> {
    return this.map[ip] ?? NULL_RESULT;
  }
}

function parseStaticMap(raw: string): Record<string, { country: string | null; asn: number | null }> {
  const parsed = JSON.parse(raw) as Record<string, string | { country?: string; asn?: number }>;
  const out: Record<string, { country: string | null; asn: number | null }> = {};
  for (const [ip, value] of Object.entries(parsed)) {
    out[ip] = typeof value === 'string' ? { country: value, asn: null } : { country: value.country ?? null, asn: value.asn ?? null };
  }
  return out;
}

let cachedProvider: GeoIpProvider | undefined;

/** Selects the provider from env (`GEOIP_PROVIDER=maxmind|ipinfo|static`,
 * default none). Memoised like `config/env.ts`'s `loadEnv` — call
 * `resetGeoIpProviderCacheForTests()` between tests that change the env. */
export function getGeoIpProvider(): GeoIpProvider {
  if (cachedProvider) return cachedProvider;
  const kind = process.env.GEOIP_PROVIDER;
  if (kind === 'maxmind' && process.env.GEOIP_MAXMIND_DB_PATH) {
    cachedProvider = new MaxMindGeoIpProvider(process.env.GEOIP_MAXMIND_DB_PATH);
  } else if (kind === 'ipinfo' && process.env.IPINFO_TOKEN) {
    cachedProvider = new IpinfoGeoIpProvider(process.env.IPINFO_TOKEN);
  } else if (kind === 'static' && process.env.GEOIP_STATIC_MAP) {
    try {
      cachedProvider = new StaticGeoIpProvider(parseStaticMap(process.env.GEOIP_STATIC_MAP));
    } catch {
      cachedProvider = new NoopGeoIpProvider();
    }
  } else {
    cachedProvider = new NoopGeoIpProvider();
  }
  return cachedProvider;
}

export function resetGeoIpProviderCacheForTests(): void {
  cachedProvider = undefined;
}
