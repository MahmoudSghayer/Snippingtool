/*
 * confirm-overlay.ts — the assist buy's confirm step (P0 Task 13): the buy
 * chord shows this, naming the card (name and rating when the listing's
 * item data had them, else its id), the price and the expected profit; a
 * second press of the chord or a click on Confirm buys, Escape or Cancel
 * does not (engine/assist.ts owns that logic; this file only shows it).
 *
 * Moving the selection (Alt+Up/Down) shows a short, non-modal line naming
 * the newly selected listing, so the chord has visible feedback.
 *
 * Same rules as the panel and the Sniping Bot page: a closed shadow root,
 * so page scripts cannot read or reach into it, and every handler ignores
 * script-made events (`onTrusted`), so a page script can never click
 * Confirm. DOM construction with `textContent` only: the name comes from
 * EA's item data, untrusted as far as this file is concerned.
 */
import tokensCss from '../styles/tokens.css?raw';

import { onTrusted } from './trusted-events.js';

const tokens = tokensCss.replace(/:root/g, ':host');

const css = `
  ${tokens}
  :host { all: initial; }
  .box {
    position: fixed; left: 50%; top: 18%; transform: translateX(-50%); z-index: 2147483001;
    width: 300px; padding: 14px 16px; font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
    color: var(--sl-fg); background: var(--sl-surface-2); border: 1px solid var(--sl-border);
    border-radius: var(--sl-radius-md); box-shadow: 0 16px 40px -12px rgba(0,0,0,.75);
  }
  .box[hidden] { display: none; }
  h3 { margin: 0 0 8px; font-size: 14px; }
  .row { display: flex; justify-content: space-between; gap: 10px; padding: 2px 0; }
  .k { color: var(--sl-fg-muted); }
  .v { font-variant-numeric: tabular-nums; font-weight: 600; }
  .v.pos { color: var(--sl-positive); }
  .v.neg { color: var(--sl-negative); }
  .hint { margin: 8px 0 10px; color: var(--sl-fg-muted); font-size: 12px; }
  .actions { display: flex; gap: 8px; }
  button { flex: 1; padding: 7px 10px; border: 0; border-radius: var(--sl-radius-sm, 6px); font: inherit; font-weight: 600; cursor: pointer; }
  button[data-action="confirm"] { background: var(--sl-positive); color: #0b1410; }
  button[data-action="cancel"] { background: var(--sl-card-2); color: var(--sl-fg); }
  button:focus-visible { outline: 2px solid var(--sl-fg); outline-offset: 2px; }
  .sel {
    position: fixed; left: 50%; top: 12%; transform: translateX(-50%); z-index: 2147483001;
    max-width: 360px; padding: 7px 12px; font: 12px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
    color: var(--sl-fg); background: var(--sl-card); border: 1px solid var(--sl-border); border-radius: var(--sl-radius-sm, 6px);
    pointer-events: none;
  }
  .sel[hidden] { display: none; }
`;

export interface ConfirmDetails {
  /** "Name 86", or "#resourceId" when the item data carried no name. */
  title: string;
  price: number;
  /** After EA's 5% tax, at the recorded median; null when unknown. */
  expectedProfit: number | null;
  /** The buy chord as the key caps read (`Alt+B`). */
  confirmKey: string;
}

export interface SelectionDetails extends ConfirmDetails {
  /** "2/5": where the selection is in the current search's ranked list. */
  position: string;
}

/** How long the selection line stays up after the last move. */
const SELECTION_HINT_MS = 3_000;

export interface ConfirmOverlay {
  show(details: ConfirmDetails, handlers: { onConfirm: () => void; onCancel: () => void }): void;
  /** The short "Selected 2/5: …" line after Alt+Up/Down. */
  showSelection(details: SelectionDetails): void;
  hide(): void;
  isOpen(): boolean;
}

const coins = (n: number) => Math.round(n).toLocaleString('en-US');

export function createConfirmOverlay(doc: Document = document): ConfirmOverlay {
  const host = doc.createElement('div');
  host.id = 'ledger-confirm';
  const root = host.attachShadow({ mode: 'closed' });
  const style = doc.createElement('style');
  style.textContent = css;

  const box = doc.createElement('div');
  box.className = 'box';
  box.hidden = true;
  box.setAttribute('role', 'alertdialog');
  box.setAttribute('aria-label', 'Confirm buy');

  const title = doc.createElement('h3');
  const row = (label: string) => {
    const r = doc.createElement('div');
    r.className = 'row';
    const k = doc.createElement('span');
    k.className = 'k';
    k.textContent = label;
    const v = doc.createElement('span');
    v.className = 'v';
    r.append(k, v);
    return { r, v };
  };
  const price = row('Price');
  const profit = row('Expected profit (after tax)');
  const hint = doc.createElement('p');
  hint.className = 'hint';
  const actions = doc.createElement('div');
  actions.className = 'actions';
  const confirm = doc.createElement('button');
  confirm.type = 'button';
  confirm.dataset.action = 'confirm';
  confirm.textContent = 'Confirm buy';
  const cancel = doc.createElement('button');
  cancel.type = 'button';
  cancel.dataset.action = 'cancel';
  cancel.textContent = 'Cancel';
  actions.append(confirm, cancel);
  box.append(title, price.r, profit.r, hint, actions);
  const sel = doc.createElement('div');
  sel.className = 'sel';
  sel.hidden = true;
  sel.setAttribute('role', 'status');
  let selTimer: ReturnType<typeof setTimeout> | null = null;
  root.append(style, box, sel);
  (doc.body || doc.documentElement).appendChild(host);

  let handlers: { onConfirm: () => void; onCancel: () => void } | null = null;
  onTrusted(confirm, 'click', () => handlers?.onConfirm());
  onTrusted(cancel, 'click', () => handlers?.onCancel());

  return {
    show(details, next) {
      handlers = next;
      title.textContent = `Buy ${details.title}?`;
      price.v.textContent = coins(details.price);
      const p = details.expectedProfit;
      profit.v.textContent = p == null ? 'unknown' : `${p >= 0 ? '+' : ''}${coins(p)}`;
      profit.v.className = 'v' + (p == null ? '' : p >= 0 ? ' pos' : ' neg');
      hint.textContent = `Press ${details.confirmKey} again or click Confirm. Esc cancels.`;
      box.hidden = false;
    },
    showSelection(details) {
      const p = details.expectedProfit;
      const profitText = p == null ? '' : ` (${p >= 0 ? '+' : ''}${coins(p)})`;
      sel.textContent = `Selected ${details.position}: ${details.title} @ ${coins(details.price)}${profitText} · ${details.confirmKey} to buy`;
      sel.hidden = false;
      if (selTimer) clearTimeout(selTimer);
      selTimer = setTimeout(() => {
        sel.hidden = true;
      }, SELECTION_HINT_MS);
    },
    hide() {
      handlers = null;
      box.hidden = true;
    },
    isOpen() {
      return !box.hidden;
    },
  };
}
