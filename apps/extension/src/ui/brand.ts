/*
 * brand.ts — the Nova Trade logo, inlined (no remote fetch on EA's page).
 * Same artwork as the website's `apps/dashboard/public/favicon.svg`, which
 * is the source the extension's toolbar icons are rendered from.
 */

/** Full-colour logo on its own tile: the launcher button, the Nova AI page header. */
export const NOVA_LOGO_SVG = `<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
  <defs><linearGradient id="nt-nova-g" x1="4" y1="4" x2="28" y2="28" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#b1ffff"/><stop offset=".17" stop-color="#f2fcfc"/><stop offset=".65" stop-color="#f1f0ff"/><stop offset="1" stop-color="#e2d6ff"/></linearGradient></defs>
  <rect width="32" height="32" rx="7" fill="#151d29"/>
  <path d="M16 5.5Q16.8 15.2 26.5 16Q16.8 16.8 16 26.5Q15.2 16.8 5.5 16Q15.2 15.2 16 5.5Z" transform="rotate(45 16 16)" fill="#9d8cff"/>
  <path d="M16 3.8Q17.4 14.6 28.2 16Q17.4 17.4 16 28.2Q14.6 17.4 3.8 16Q14.6 14.6 16 3.8Z" fill="url(#nt-nova-g)"/>
  <circle cx="16" cy="16" r="2.4" fill="#ffffff"/>
</svg>`;

/** One-colour mark (`currentColor`), for EA's navigation: it takes the
 * nav's own idle, hover and selected colours like EA's icons do. */
export const NOVA_MARK_SVG = `<svg viewBox="0 0 32 32" width="100%" height="100%" aria-hidden="true" focusable="false">
  <path d="M16 5.5Q16.8 15.2 26.5 16Q16.8 16.8 16 26.5Q15.2 16.8 5.5 16Q15.2 15.2 16 5.5Z" transform="rotate(45 16 16)" fill="currentColor" opacity=".55"/>
  <path d="M16 3.8Q17.4 14.6 28.2 16Q17.4 17.4 16 28.2Q14.6 17.4 3.8 16Q14.6 14.6 16 3.8Z" fill="currentColor"/>
</svg>`;
