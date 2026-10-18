/*
 * recent-searches.ts — where the Nova AI page's Recent searches log is kept
 * (`BotPageDeps['recentSearches']`, ui/bot-page.ts): with the signed-in
 * account, so every browser the trader signs in on shows the same list, and
 * a local copy in extension storage (Tampermonkey's in the userscript build,
 * which EA's page cannot read) for when the account cannot be reached.
 *
 * Load: the account's list whenever background can read it — it wins, and
 * replaces the local copy — otherwise (signed out, offline, background not
 * answering) the local copy. The first time a browser reaches an account
 * whose list is empty, it uploads the list it kept before sync existed,
 * once.
 *
 * Save: the local copy at once, the account a moment later: debounced, so a
 * burst of starts is one request, and fire-and-forget. Nothing here ever
 * holds the bot up; a failed upload only leaves the account's list older
 * until the next save.
 *
 * Chrome-free, so it is testable: content/index.ts hands in storage and its
 * `send` to background.
 */
import { recentSearchSchema, type RecentSearchDto, type RecentSearchesResponse } from '@sl/shared';

import type { RecentSearch } from '../ui/bot-page.js';

/** The local copy (`RecentSearch[]`). The key predates sync, so it is also
 * the list a browser kept before it. */
export const RECENT_SEARCHES_KEY = 'sl.bot.recentSearches.v1';
/** Set once this browser's pre-sync list has been offered to an account. */
export const RECENT_SEARCHES_MIGRATED_KEY = 'sl.bot.recentSearches.migrated.v1';
/** How long after the last save the account's copy is replaced. */
export const RECENT_SEARCHES_PUSH_DELAY_MS = 1_500;

export interface RecentSearchesSyncDeps {
  storage: {
    get: (key: string) => Promise<unknown>;
    set: (key: string, value: unknown) => Promise<void>;
  };
  /** content's `send` (content/background-request.ts): null for anything
   * but data. Background answers null itself while signed out or offline. */
  send: <T>(type: string, payload?: unknown) => Promise<T | null>;
  pushDelayMs?: number;
}

export interface RecentSearchesSync {
  load: () => Promise<unknown>;
  save: (list: RecentSearch[]) => Promise<void>;
}

/** What the account accepts of `list` (@sl/shared `recentSearchSchema`). An
 * entry it would refuse (a price past EA's cap, say) stays in the local
 * copy only, rather than costing the whole upload. */
export function forAccount(list: readonly unknown[]): RecentSearchDto[] {
  return list.flatMap((entry) => {
    const parsed = recentSearchSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

export function createRecentSearchesSync(deps: RecentSearchesSyncDeps): RecentSearchesSync {
  const delay = deps.pushDelayMs ?? RECENT_SEARCHES_PUSH_DELAY_MS;
  let pending: RecentSearchDto[] | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const readLocal = () => deps.storage.get(RECENT_SEARCHES_KEY).catch(() => undefined);
  const writeLocal = (list: unknown[]) => deps.storage.set(RECENT_SEARCHES_KEY, list).catch(() => undefined);
  /** Replaces the account's list; true once it is saved there. */
  const push = async (items: RecentSearchDto[]) => (await deps.send('recentSearches.set', { items }).catch(() => null)) != null;

  /** Sends the save still waiting, now. Never rejects. */
  async function flush(): Promise<void> {
    if (timer) clearTimeout(timer);
    timer = null;
    const items = pending;
    pending = null;
    if (items) await push(items);
  }

  return {
    async load() {
      // Otherwise the account would still hand back the list from before it.
      await flush();
      const local = await readLocal();
      const account = await deps.send<RecentSearchesResponse>('recentSearches.get').catch(() => null);
      if (!account) return local;

      let items = account.items;
      // An unreadable flag counts as set: never upload on a guess.
      if ((await deps.storage.get(RECENT_SEARCHES_MIGRATED_KEY).catch(() => true)) !== true) {
        const before = Array.isArray(local) ? forAccount(local) : [];
        if (items.length === 0 && before.length > 0) {
          if (!(await push(before))) return local; // tried again on the next load
          items = before;
        }
        await deps.storage.set(RECENT_SEARCHES_MIGRATED_KEY, true).catch(() => undefined);
      }
      await writeLocal(items);
      return items;
    },

    async save(list) {
      pending = forAccount(list);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void flush(), delay);
      await writeLocal(list);
    },
  };
}
