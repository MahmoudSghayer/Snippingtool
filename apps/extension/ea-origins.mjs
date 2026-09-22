// ea-origins.mjs — the one list of EA web-app URL patterns the extension is
// scoped to. Consumed by scripts/generate-manifest.mjs (content_scripts
// `matches` + host_permissions) and by src/background/kill-switch.ts
// (`tabs.query({ url })` when pushing a server kill-switch change into
// already-open EA tabs), so the two can never drift apart. Plain ESM JS
// (not TS) because the manifest generator runs under bare node at build
// time; ea-origins.d.mts types it for the TypeScript side.
//
// The UTAS market path has outlived many bundle rewrites; the EA web app
// itself lives at these two origins (with/without a locale segment) — see
// src/main/adapter.ts for the matching passive-observation regex.
export const EA_WEB_APP_MATCHES = [
  'https://www.ea.com/*/ultimate-team/web-app/*',
  'https://www.ea.com/ultimate-team/web-app/*',
];
