/**
 * The background message types only automation builds handle (the Sniping
 * Bot page and its catalog). Kept out of `ext-messages.ts`'s
 * `backgroundMessageTypeSchema` on purpose: that module's top-level schemas
 * end up in every extension bundle, and the listable `ledger` build must
 * carry no trace of the bot (its build check greps `dist/ledger` for these
 * names). apps/extension `background/index.ts` registers the handlers for
 * these only when `VITE_AUTOMATION === '1'`, and builds its envelope from
 * its handler table (`backgroundMessageEnvelopeSchemaFor`).
 */
export const AUTOMATION_BACKGROUND_MESSAGE_TYPES = [
  /** The Sniping Bot page's settings (`BotSettings`, `storage.local`). Local
   * only: nothing about how a user paces their bot goes to the server. */
  'bot.settingsGet',
  'bot.settingsSet',
  /** The bot's active time today, for its hours-per-day limit
   * (`BotDailyUsage`, `storage.local`). Local only. */
  'bot.usageGet',
  'bot.usageSet',
  /** The bot's hourly budgets: its governor's state and its own search and
   * buy windows (`BotBudgetState`, `storage.local`), so Stop/Start and a
   * page reload never refill them. Local only. */
  'bot.budgetGet',
  'bot.budgetSet',
  /** Player names for resource ids, for the bot log and search results.
   * Background resolves them from `/api/v1/market/cards/:id` and caches
   * them in `storage.local`. */
  'cards.names',
  /** EA's own player list and club/league/nation names, captured from the
   * web app's search data (`apps/extension` `model/catalog.ts`) and kept in
   * `storage.local` for the Snipe Targets form. */
  'catalog.get',
  'catalog.save',
] as const;
export type AutomationBackgroundMessageType = (typeof AUTOMATION_BACKGROUND_MESSAGE_TYPES)[number];
