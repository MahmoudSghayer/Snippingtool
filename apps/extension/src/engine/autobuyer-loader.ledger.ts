/*
 * autobuyer-loader.ledger.ts — the `ledger` build's loader. Deliberately
 * contains no reference whatsoever to `./autobuyer.ts` — this is the
 * build-time exclusion guarantee (docs/06-extension.md, "Build targets"):
 * `scripts/build.mjs` aliases `virtual:autobuyer-loader` to *this* file for
 * the `ledger` target, so `engine/autobuyer.ts` is never resolved, parsed or
 * included in that build's module graph at all, regardless of what any
 * runtime flag says. `pnpm --filter @sl/extension build:ledger && grep -r
 * autobuyer dist/ledger` is the check this exists to pass.
 */
export async function loadAutobuyer(): Promise<null> {
  return null;
}

/** Same guarantee for the Sniping Bot loop: no reference to it here. */
export async function loadSniper(): Promise<null> {
  return null;
}
