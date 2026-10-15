/*
 * ea-wallet.ts — the trader's coin and FC Points balance, read from EA's
 * own top bar, for the Nova AI page's header (`ui/bot-page.ts`): the page
 * sits over EA's screen, and the balance is the one number a trader wants
 * to keep in sight while the bot buys.
 *
 * ASSUMED SHAPE, like `ui/ea-nav.ts`: the top bar shows the balances in
 * `.view-navbar-currency-coins` and `.view-navbar-currency-points`, as plain
 * numbers with thousands separators. `COINS_SELECTORS` / `POINTS_SELECTORS`
 * are the lines to update when EA renames them. Text that is not a plain
 * number reads as unknown (null), never as a wrong balance.
 */

const COINS_SELECTORS = ['.view-navbar-currency-coins', '[class*="currency-coins"]'];
const POINTS_SELECTORS = ['.view-navbar-currency-points', '[class*="currency-points"]'];

export interface Wallet {
  coins: number | null;
  points: number | null;
}

/** "1,234,567" (or "1.234.567", "1 234 567") as a number; null for
 * anything else, such as an empty field or an abbreviated "1.2M". */
export function parseBalance(text: string | null | undefined): number | null {
  const t = (text ?? '').trim();
  if (!/^\d[\d\s.,'\u00a0\u202f]*$/.test(t)) return null;
  const digits = t.replace(/\D/g, '');
  return digits.length <= 12 ? Number(digits) : null;
}

function read(doc: Document, selectors: string[]): number | null {
  for (const sel of selectors) {
    const value = parseBalance(doc.querySelector(sel)?.textContent);
    if (value != null) return value;
  }
  return null;
}

export function readWallet(doc: Document = document): Wallet {
  return { coins: read(doc, COINS_SELECTORS), points: read(doc, POINTS_SELECTORS) };
}
