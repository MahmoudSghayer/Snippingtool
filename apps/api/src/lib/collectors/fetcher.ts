// The one HTTP path every collector goes through.
//
// Centralised so politeness is structural rather than per-adapter discipline
// (docs/14-ml-suggestions.md §4e). Everything here is about taking less from
// a source than it would tolerate:
//
//   - one in-flight request per host, with a minimum interval between them
//   - robots.txt consulted before every fetch, cached per host
//   - conditional requests (ETag / If-Modified-Since); a 304 costs nothing
//   - content hashing, so an unchanged page costs no parse and no DB write
//   - exponential backoff honouring Retry-After on 429/503
//   - an identifiable User-Agent with a contact URL
//
// Deliberately absent: any attempt to look like a browser. A source that
// challenges us is telling us something, and the documented answer is to back
// off and seek permitted access, not to escalate — an evasion arms race is
// unbounded maintenance that fails silently and takes the feature down with
// it. `FetchOutcome.blocked` exists so that decision surfaces as data.

import { createHash } from 'node:crypto';

import {
  isAllowed,
  parseRobots,
  pathAndQueryOf,
  ROBOTS_ALLOW_ALL,
  type RobotsTxt,
} from './robots.js';

export const DEFAULT_USER_AGENT =
  'SnipersLedger/0.1 (+https://snipersledger.app/bot; market data collector)';

export type FetchOutcome =
  /** Fetched and the body changed since `knownHash` (or none was given). */
  | { kind: 'fetched'; status: number; body: string; contentType: string | null; hash: string }
  /** Server said 304, or the hash matched what we already had. */
  | { kind: 'unchanged'; status: number; hash: string }
  /** robots.txt disallows this path for our agent. Never retried. */
  | { kind: 'disallowed'; reason: string }
  /** 401/403/451, or a challenge page. Not a transient error — escalating is
   * out of scope by design, so this is terminal for the run. */
  | { kind: 'blocked'; status: number; reason: string }
  /** Transient: network error, 5xx, or 429 that outlived our retries. */
  | { kind: 'error'; status: number | null; reason: string };

export interface FetcherOptions {
  userAgent?: string;
  /** Minimum gap between requests to the same host. */
  minIntervalMs?: number;
  /** Attempts per URL, including the first. */
  maxAttempts?: number;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Cap on a single response body, to avoid a surprise multi-hundred-MB
   * download wedging the worker. */
  maxBytes?: number;
  /** Injected in tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected in tests so backoff does not actually sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
  log?: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };
}

interface HostState {
  /** Resolves when the host is free; serialises requests per host. */
  chain: Promise<void>;
  lastRequestAt: number;
  robots: RobotsTxt | null;
  robotsFetchedAt: number;
}

const ROBOTS_TTL_MS = 60 * 60 * 1000; // re-read robots.txt hourly

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class PoliteFetcher {
  private readonly hosts = new Map<string, HostState>();
  private readonly userAgent: string;
  private readonly minIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly doFetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: FetcherOptions['log'];

  constructor(options: FetcherOptions = {}) {
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.minIntervalMs = options.minIntervalMs ?? 2000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
    this.doFetch = options.fetchImpl ?? fetch;
    this.sleep = options.sleepImpl ?? defaultSleep;
    this.log = options.log;
  }

  private stateFor(host: string): HostState {
    let state = this.hosts.get(host);
    if (!state) {
      state = { chain: Promise.resolve(), lastRequestAt: 0, robots: null, robotsFetchedAt: 0 };
      this.hosts.set(host, state);
    }
    return state;
  }

  /** Serialises work per host and enforces the minimum gap. Every outbound
   * request — robots.txt included — goes through here, so a burst of URLs on
   * one host is paced even when the caller asks for them all at once. */
  private schedule<T>(host: string, work: () => Promise<T>): Promise<T> {
    const state = this.stateFor(host);
    const run = state.chain.then(async () => {
      const wait = state.lastRequestAt + this.minIntervalMs - Date.now();
      if (wait > 0) await this.sleep(wait);
      state.lastRequestAt = Date.now();
      return work();
    });
    // Keep the chain alive even if this request rejects, or one failure
    // would wedge the host forever.
    state.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async rawFetch(url: string, headers: Record<string, string>): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.doFetch(url, {
        headers: { 'user-agent': this.userAgent, accept: '*/*', ...headers },
        redirect: 'follow',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Fetches and caches robots.txt for a host. A fetch failure caches
   * allow-all for the TTL rather than retrying per URL — the page fetch
   * itself still reports any block. */
  async robotsFor(origin: string): Promise<RobotsTxt> {
    const host = new URL(origin).host;
    const state = this.stateFor(host);
    if (state.robots && Date.now() - state.robotsFetchedAt < ROBOTS_TTL_MS) return state.robots;

    const robotsUrl = new URL('/robots.txt', origin).toString();
    let robots = ROBOTS_ALLOW_ALL;
    try {
      const res = await this.schedule(host, () => this.rawFetch(robotsUrl, {}));
      if (res.ok) {
        robots = parseRobots(await res.text(), this.userAgent);
      } else {
        this.log?.warn({ robotsUrl, status: res.status }, 'robots.txt unavailable; assuming allow');
      }
    } catch (err) {
      this.log?.warn({ robotsUrl, err: String(err) }, 'robots.txt fetch failed; assuming allow');
    }

    state.robots = robots;
    state.robotsFetchedAt = Date.now();
    return robots;
  }

  /**
   * Fetch one URL politely.
   *
   * `knownHash` / `etag` / `lastModified` come from the last stored
   * `raw_documents` row for this URL, which is what makes a re-poll of an
   * unchanged page nearly free for both sides.
   */
  async fetch(
    url: string,
    opts: { knownHash?: string; etag?: string; lastModified?: string } = {},
  ): Promise<FetchOutcome> {
    const parsed = new URL(url);
    const host = parsed.host;

    const robots = await this.robotsFor(parsed.origin);
    if (!isAllowed(robots, pathAndQueryOf(url))) {
      return {
        kind: 'disallowed',
        reason: `robots.txt disallows this path for '${robots.matchedAgent ?? '*'}'`,
      };
    }

    const headers: Record<string, string> = {};
    if (opts.etag) headers['if-none-match'] = opts.etag;
    if (opts.lastModified) headers['if-modified-since'] = opts.lastModified;

    let lastError = 'unknown';
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      let res: Response;
      try {
        res = await this.schedule(host, () => this.rawFetch(url, headers));
      } catch (err) {
        lastError = String(err);
        if (attempt === this.maxAttempts) return { kind: 'error', status: null, reason: lastError };
        await this.sleep(this.backoffMs(attempt));
        continue;
      }

      if (res.status === 304) {
        return { kind: 'unchanged', status: 304, hash: opts.knownHash ?? '' };
      }

      // Terminal refusals. Retrying these is both useless and rude.
      if (res.status === 401 || res.status === 403 || res.status === 451) {
        return {
          kind: 'blocked',
          status: res.status,
          reason: `refused with ${res.status}; source is declining automated access`,
        };
      }

      if (res.status === 429 || res.status >= 500) {
        lastError = `upstream returned ${res.status}`;
        if (attempt === this.maxAttempts) {
          return { kind: 'error', status: res.status, reason: lastError };
        }
        await this.sleep(this.retryAfterMs(res) ?? this.backoffMs(attempt));
        continue;
      }

      if (!res.ok) {
        return { kind: 'error', status: res.status, reason: `unexpected status ${res.status}` };
      }

      const body = await this.readCapped(res);
      if (body === null) {
        return {
          kind: 'error',
          status: res.status,
          reason: `body exceeded ${this.maxBytes} bytes`,
        };
      }

      const hash = sha256(body);
      if (opts.knownHash && hash === opts.knownHash) {
        return { kind: 'unchanged', status: res.status, hash };
      }

      // A challenge page is a 200 that is not the content we asked for.
      // Classifying it as `blocked` rather than parsing it is what stops a
      // challenge HTML body being stored as if it were data.
      const challenge = detectChallenge(body);
      if (challenge) {
        return { kind: 'blocked', status: res.status, reason: challenge };
      }

      return {
        kind: 'fetched',
        status: res.status,
        body,
        contentType: res.headers.get('content-type'),
        hash,
      };
    }

    return { kind: 'error', status: null, reason: lastError };
  }

  private backoffMs(attempt: number): number {
    const base = Math.min(30_000, 1000 * 2 ** (attempt - 1));
    return base + Math.floor(Math.random() * 250); // jitter, so retries don't sync up
  }

  private retryAfterMs(res: Response): number | null {
    const header = res.headers.get('retry-after');
    if (!header) return null;
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.min(60_000, Math.max(0, seconds) * 1000);
    const date = Date.parse(header);
    return Number.isNaN(date) ? null : Math.min(60_000, Math.max(0, date - Date.now()));
  }

  /** Reads a body, giving up past `maxBytes` rather than buffering whatever
   * arrives. Returns null if the cap was exceeded. */
  private async readCapped(res: Response): Promise<string | null> {
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > this.maxBytes) return null;
    const text = await res.text();
    return Buffer.byteLength(text, 'utf8') > this.maxBytes ? null : text;
  }
}

/** Recognises the common "prove you're a browser" interstitials, which are
 * served with a 200 and would otherwise be stored and parsed as content. */
export function detectChallenge(body: string): string | null {
  const head = body.slice(0, 4096).toLowerCase();
  if (head.includes('just a moment')) return 'challenge page (Cloudflare interstitial)';
  if (head.includes('attention required') && head.includes('cloudflare')) {
    return 'challenge page (Cloudflare block)';
  }
  if (head.includes('enable javascript and cookies to continue')) {
    return 'challenge page (JavaScript gate)';
  }
  if (head.includes('captcha-delivery.com') || head.includes('px-captcha')) {
    return 'challenge page (CAPTCHA)';
  }
  return null;
}
