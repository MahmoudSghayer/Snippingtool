/*
 * brand.ts — the Nova Trade logo, inlined (no remote fetch on EA's page).
 * Same artwork as the website's header (`apps/dashboard/index.html`,
 * `<a class="brand">`).
 */

/** Full-colour logo on its own tile: the launcher button, the bot page header. */
export const NOVA_LOGO_SVG = `<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
  <rect width="32" height="32" rx="7" fill="#151d1a"/>
  <circle cx="16" cy="16" r="9.5" fill="none" stroke="#ddb35c" stroke-width="2"/>
  <path d="M16 3.5v5M16 23.5v5M3.5 16h5M23.5 16h5" stroke="#ddb35c" stroke-width="2" stroke-linecap="round"/>
  <circle cx="16" cy="16" r="2.75" fill="#6fbf9b"/>
</svg>`;

/** One-colour mark (`currentColor`), for EA's navigation: it takes the
 * nav's own idle, hover and selected colours like EA's icons do. */
export const NOVA_MARK_SVG = `<svg viewBox="0 0 32 32" width="100%" height="100%" aria-hidden="true" focusable="false">
  <circle cx="16" cy="16" r="9.5" fill="none" stroke="currentColor" stroke-width="2.4"/>
  <path d="M16 3.5v5M16 23.5v5M3.5 16h5M23.5 16h5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
  <circle cx="16" cy="16" r="3" fill="currentColor"/>
</svg>`;
