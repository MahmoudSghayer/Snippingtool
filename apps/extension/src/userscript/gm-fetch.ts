/*
 * gm-fetch.ts — a `fetch`-shaped wrapper over `GM_xmlhttpRequest`, installed
 * as `lib/http.ts`'s transport by the userscript entry. The userscript runs
 * on ea.com, so a plain `fetch` to the API would be cross-origin (and would
 * send EA's cookies along); `GM_xmlhttpRequest` is exempt from CORS for any
 * host listed in the header's `@connect`, and `anonymous: true` keeps
 * cookies out of it entirely — auth is the bearer token, nothing else.
 */

const TIMEOUT_MS = 30_000;

function parseHeaders(raw: string): Headers {
  const headers = new Headers();
  for (const line of raw.trim().split(/[\r\n]+/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    try {
      headers.append(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
    } catch {
      // A header name the Fetch spec rejects — nothing downstream reads it.
    }
  }
  return headers;
}

export function gmFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, key) => {
    headers[key] = value;
  });
  const body = init.body;
  if (body != null && typeof body !== 'string') {
    return Promise.reject(new TypeError('gmFetch only sends string bodies'));
  }

  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: init.method ?? 'GET',
      url: input,
      headers,
      data: body ?? undefined,
      timeout: TIMEOUT_MS,
      anonymous: true,
      onload: (res) => {
        // Tampermonkey reports some blocked requests (e.g. a host missing
        // from `@connect`) as a "load" with status 0.
        if (res.status < 200 || res.status > 599) {
          reject(new TypeError(`network error (status ${res.status}): ${input}`));
          return;
        }
        // `Response` refuses a body on these statuses.
        const resBody =
          res.status === 204 || res.status === 205 || res.status === 304 ? null : res.responseText;
        resolve(
          new Response(resBody, {
            status: res.status,
            statusText: res.statusText,
            headers: parseHeaders(res.responseHeaders),
          }),
        );
      },
      // Same failure type a real `fetch` rejects with, so `retryFetch`'s
      // network-error backoff treats both transports alike.
      onerror: () => reject(new TypeError(`network error: ${input}`)),
      ontimeout: () => reject(new TypeError(`timed out: ${input}`)),
      onabort: () => reject(new TypeError(`aborted: ${input}`)),
    });
  });
}
