/**
 * Email normalisation for **abuse-detection matching**, not for storage or
 * login. `users.email` is `citext` (case-insensitive equality only) — that
 * is the identity used for login/uniqueness and is left completely alone
 * here. This module exists for one purpose: computing a second, more
 * aggressive normal form so trial-abuse detection
 * (`docs/05-subscriptions.md`, "Trial protection") can recognise
 * `p.layer+altaccount@gmail.com` and `player@googlemail.com` as the same
 * inbox they actually are, even though they are two distinct, valid,
 * `citext`-distinct rows in `users`.
 *
 * Two normalisations are applied, in order:
 *  1. **Domain lowercasing** — always, every provider. Email domains are
 *     case-insensitive per the DNS, so `Player@GMAIL.com` and
 *     `player@gmail.com` must compare equal for abuse purposes regardless
 *     of provider.
 *  2. **Gmail dot/plus stripping** — only for `gmail.com` and its alias
 *     domain `googlemail.com` (both canonicalised to `gmail.com`), because
 *     Gmail is documented and guaranteed by Google to ignore dots in the
 *     local part and to treat anything from a `+` onward as a discardable
 *     subaddress tag. This is a real, provider-guaranteed equivalence, not
 *     a heuristic — applying it to arbitrary other providers would produce
 *     false positives (many mail servers treat `+`/`.` as significant), so
 *     it is deliberately scoped to Gmail's two domains only.
 *
 * The local part is also lower-cased for the returned value, since it is
 * used only as an abuse-matching key (hashed/compared, never displayed or
 * used to actually address mail) — two logins that differ only in local-part
 * casing are treated as the same signup attempt for trial-protection
 * purposes, which is the conservative (harder-to-abuse) choice.
 */

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);
const GMAIL_CANONICAL_DOMAIN = 'gmail.com';

/**
 * Normalises an email address for abuse-detection comparison/hashing.
 * Never throws: malformed input (no `@`, empty string) is returned
 * lower-cased and trimmed as a best-effort fallback, since this function's
 * job is to produce a stable matching key, not to validate the address
 * (validation is `emailSchema` in `schemas/auth.ts`).
 */
export function normaliseEmailForAbuseCheck(email: string): string {
  const trimmed = email.trim().toLowerCase();
  const atIndex = trimmed.lastIndexOf('@');
  if (atIndex <= 0 || atIndex === trimmed.length - 1) {
    // No (or a malformed) `@` — nothing more we can safely normalise.
    return trimmed;
  }

  const localPart = trimmed.slice(0, atIndex);
  const domain = trimmed.slice(atIndex + 1);

  if (!GMAIL_DOMAINS.has(domain)) {
    return `${localPart}@${domain}`;
  }

  const withoutTag = localPart.split('+')[0] ?? localPart;
  const withoutDots = withoutTag.replace(/\./g, '');

  return `${withoutDots}@${GMAIL_CANONICAL_DOMAIN}`;
}
