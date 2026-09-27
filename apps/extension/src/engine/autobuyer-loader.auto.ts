/*
 * autobuyer-loader.auto.ts — the `ledger-auto` build's loader. Statically
 * imports `./autobuyer.ts` (a static, not dynamic, import — see
 * docs/06-extension.md, "Build targets" for why: content scripts build as a
 * single IIFE with no code-splitting, so a "lazy" dynamic import would just
 * get inlined anyway; the real exclusion mechanism is
 * `scripts/build.mjs`'s `virtual:autobuyer-loader` alias picking this file
 * only for `ledger-auto`). `content/index.ts` still gates *invocation*
 * behind `import.meta.env.VITE_AUTOMATION === '1'` as defence in depth.
 */
import * as autobuyer from './autobuyer.js';
import * as sniper from './sniper.js';

export async function loadAutobuyer(): Promise<typeof autobuyer> {
  return autobuyer;
}

/** The Sniping Bot loop (`./sniper.ts`) is automation too, so it ships only
 * where the autobuyer does, through the same alias. */
export async function loadSniper(): Promise<typeof sniper> {
  return sniper;
}
