// Placeholder values baked into the downloadable templates
// (`node scripts/build.mjs ledger-auto --template` and
// `userscript --template`). The API replaces each one with its own
// configuration, or the user's download token, before serving them
// (apps/api/src/lib/extension-download.ts). They're valid-looking values of
// the right shape, so the template still builds and its manifest still
// validates, and unique enough that replacing them can't touch anything
// else.
export const TEMPLATE_PLACEHOLDERS = Object.freeze({
  apiOrigin: 'https://nova-api-origin.placeholder.invalid',
  dashboardOrigin: 'https://nova-dashboard-origin.placeholder.invalid',
  licensePublicKey: 'NOVA_LICENSE_PUBLIC_KEY_PLACEHOLDER',
  userscriptToken: 'NOVA_USERSCRIPT_TOKEN_PLACEHOLDER',
});
