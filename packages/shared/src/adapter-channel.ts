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
