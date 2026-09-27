/*
 * storage-keys.ts — `storage.local` keys that more than one context reads:
 * background writes them (lib/settings.ts, background/settings.ts), and an
 * open EA tab watches them through `storage.onChanged`
 * (content/live-settings.ts) so a change applies without a reload. Only
 * the names live here: content still never imports `lib/storage.ts`.
 */

/** The user's settings document, as the server last returned it. */
export const SETTINGS_CACHE_KEY = 'sl.settings.cache.v1';
/** The saved filters (`SavedFilter[]`). */
export const FILTERS_KEY = 'sl.filters.v1';
