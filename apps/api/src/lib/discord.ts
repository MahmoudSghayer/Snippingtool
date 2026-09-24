// Posting to a Discord channel webhook. Used for operator notifications
// (jobs/payments.notify.job.ts); Prometheus alerts go through Alertmanager's
// own Discord integration instead (infra/monitoring/alertmanager).

export interface DiscordEmbed {
  title: string;
  url?: string;
  description?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  timestamp?: string;
}

export interface DiscordMessage {
  content?: string;
  embeds?: DiscordEmbed[];
  /** Discord mentions are off: a customer-supplied note must never be able
   * to ping @everyone. */
  allowed_mentions?: { parse: string[] };
}

const TIMEOUT_MS = 10_000;

/** Discord caps an embed field value at 1024 characters. */
export function clip(value: string, max = 1024): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** Throws on anything but a 2xx, so a BullMQ job calling this is retried
 * (Discord answers 429 when rate limited). */
export async function postDiscordWebhook(
  url: string,
  message: DiscordMessage,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ allowed_mentions: { parse: [] }, ...message }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Discord webhook returned ${res.status}`);
  }
}
