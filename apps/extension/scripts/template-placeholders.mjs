// Placeholder values baked into the downloadable extension template
// (`node scripts/build.mjs ledger-auto --template`). The API replaces each one
// with its own configuration before serving the zip
// (apps/api/src/lib/extension-download.ts). They're valid-looking values of
// the right shape, so the template still builds and its manifest still
// validates, and unique enough that replacing them can't touch anything
// else.
export const TEMPLATE_PLACEHOLDERS = Object.freeze({
  apiOrigin: 'https://nova-api-origin.placeholder.invalid',
  dashboardOrigin: 'https://nova-dashboard-origin.placeholder.invalid',
  licensePublicKey: 'NOVA_LICENSE_PUBLIC_KEY_PLACEHOLDER',
});
