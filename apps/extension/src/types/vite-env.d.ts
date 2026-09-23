/// <reference types="vite/client" />

/**
 * Build-time env surface. Values are substituted by `scripts/build.mjs`
 * (via Vite's `define`, per-target — see docs/06-extension.md, "Build
 * targets"), never read from a committed `.env` file (the repo's
 * `.gitignore` excludes `.env*`, and these values are not secrets — they are
 * build configuration, so they live in `scripts/build.mjs` where they are
 * versioned like any other source file).
 */
interface ImportMetaEnv {
  /** `'0'` for the `ledger` build, `'1'` for `ledger-auto`. Every use of this
   * flag is a plain string comparison (`=== '1'`) so it constant-folds
   * during minification; the *inclusion* guarantee for `engine/autobuyer.ts`
   * comes from `resolve.alias` in `scripts/build.mjs` (see
   * `src/engine/autobuyer-loader.ledger.ts` vs `.auto.ts`), not from this
   * flag alone — this flag additionally gates *invocation* at runtime. */
  readonly VITE_AUTOMATION: '0' | '1';
  readonly VITE_BUILD_TARGET: 'ledger' | 'ledger-auto' | 'userscript';
  readonly VITE_API_ORIGIN: string;
  /** Origin of the companion dashboard. `background/welcome.ts` opens
   * `<origin>/bot` on first install so a new user lands where saved
   * searches are created — the extension has nothing to search until
   * one exists. */
  readonly VITE_DASHBOARD_ORIGIN: string;
  /** Only meaningful for `ledger-auto` (self-hosted updates); empty string
   * for `ledger` (Chrome Web Store owns updates, no `update_url` emitted). */
  readonly VITE_UPDATE_URL: string;
  readonly VITE_EXTENSION_VERSION: string;
  /** Base64 Ed25519 public key used to verify the signed entitlement blob
   * (`lib/license.ts`). A build-time constant, not a secret — verifying a
   * signature only needs the public half. */
  readonly VITE_LICENSE_PUBLIC_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
