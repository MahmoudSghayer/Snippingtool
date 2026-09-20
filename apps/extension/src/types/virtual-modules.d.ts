/**
 * `virtual:autobuyer-loader` is resolved by `resolve.alias` in
 * `scripts/build.mjs` (build) and `vitest.config.ts` (tests) to either
 * `engine/autobuyer-loader.ledger.ts` (stub, no reference to
 * `engine/autobuyer.ts`) or `.auto.ts` (real loader) — see
 * docs/06-extension.md, "Build targets", for why this indirection is what
 * guarantees `ledger`'s dist never contains the autobuyer module at all.
 */
declare module 'virtual:autobuyer-loader' {
  // An ambient module declaration can't hoist a named type import above itself.
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  export function loadAutobuyer(): Promise<typeof import('../engine/autobuyer.js') | null>;
}
