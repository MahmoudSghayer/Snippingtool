/**
 * `virtual:autobuyer-loader` is resolved by `resolve.alias` in
 * `scripts/build.mjs` (build) and `vitest.config.ts` (tests) to either
 * `engine/autobuyer-loader.ledger.ts` (stub, no reference to
 * `engine/autobuyer.ts`) or `.auto.ts` (real loader) — see
 * docs/06-extension.md, "Build targets", for why this indirection is what
 * guarantees `ledger`'s dist never contains the autobuyer module at all.
 */
declare module 'virtual:autobuyer-loader' {
  export function loadAutobuyer(): Promise<typeof import('../engine/autobuyer.js') | null>;
}
