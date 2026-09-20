/*
 * panel.ts — the in-page readout. Ported from milestone 1's `src/ui/panel.js`
 * (now a module returning a `Panel` instance instead of a `globalThis`
 * factory — `content/index.ts` imports it directly and bundles it into the
 * single ISOLATED content script, so there is no longer a second
 * `<script>` tag or a `globalThis.LedgerPanel()` global). Lives in a shadow
 * root so EA's stylesheet and ours can't reach each other.
 *
 * Extends milestone 1's floor/median/sell-through/max-snipe card with (M2):
 * a tiny price-history sparkline, session P&L, a risk budget meter, and the
 * ranker's current top candidates.
 */
import type { PriceSummary } from '../model/prices.js';
import type { RiskSnapshot } from '../engine/governor.js';
import type { ScoredOpportunity } from '../engine/ranker.js';
import type { SessionPnl } from '../engine/assist.js';

const css = `
  :host { all: initial; }
  .panel {
    position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
    width: 288px; font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 12px; line-height: 1.45; color: #e9eeec;
    background: #121a17; border: 1px solid #2b3a34; border-radius: 10px;
    box-shadow: 0 12px 32px -12px rgba(0,0,0,.7);
    overflow: hidden;
  }
  .head {
    display: flex; align-items: center; gap: 8px;
    padding: 9px 12px; background: #182320; border-bottom: 1px solid #2b3a34;
    cursor: pointer; user-select: none;
  }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: #4a5c55; flex: none; }
  .dot.live { background: #55c08e; box-shadow: 0 0 0 3px rgba(85,192,142,.16); }
  .dot.warn { background: #d9a03c; box-shadow: 0 0 0 3px rgba(217,160,60,.16); }
  .dot.risk { background: #e08678; box-shadow: 0 0 0 3px rgba(224,134,120,.16); }
  .name { font-weight: 600; letter-spacing: .02em; flex: 1; }
  .chev { color: #7d8f89; font-size: 11px; }
  .body { padding: 10px 12px 12px; max-height: 70vh; overflow-y: auto; }
  .panel.collapsed .body { display: none; }
  .status { color: #8ea39c; margin-bottom: 10px; }
  .status.warn { color: #e0b568; }
  .row { display: flex; justify-content: space-between; gap: 10px; padding: 2px 0; }
  .row .k { color: #8ea39c; }
  .row .v { font-variant-numeric: tabular-nums; font-weight: 600; }
  .row .v.pos { color: #6fbf9b; }
  .row .v.neg { color: #e08678; }
  .sec { margin-top: 10px; padding-top: 9px; border-top: 1px solid #243029; }
  .sec h4 {
    margin: 0 0 6px; font-size: 10px; letter-spacing: .1em; text-transform: uppercase;
    color: #6f827b; font-weight: 600;
  }
  .hint { color: #6f827b; font-style: italic; }
  .big { color: #e8c07a; }
  .spark { display: flex; align-items: flex-end; gap: 1px; height: 24px; margin-top: 4px; }
  .spark i { flex: 1; background: #3a5348; border-radius: 1px; min-height: 2px; }
  .meter { height: 5px; border-radius: 3px; background: #223028; overflow: hidden; margin-top: 3px; }
  .meter i { display: block; height: 100%; background: #55c08e; }
  .meter.high i { background: #d9a03c; }
  .meter.over i { background: #e08678; }
  .ranklist { display: flex; flex-direction: column; gap: 4px; }
  .rankrow { display: flex; justify-content: space-between; font-size: 11px; }
  .rankrow .ev { font-variant-numeric: tabular-nums; }
`;

const coins = (n: number | null | undefined) => (n == null ? '—' : Math.round(n).toLocaleString('en-US'));
const pct = (n: number | null | undefined) => (n == null ? '—' : Math.round(n * 100) + '%');

export type HealthState = 'live' | 'warn' | 'risk';

export interface CardResult {
  resourceId: number;
  rating: number | null;
  summary: PriceSummary;
  maxSnipe: number | null;
}

export interface Panel {
  setHealth(state: HealthState, message: string): void;
  setTotals(totals: { auctions: number; playersLast24h: number }): void;
  setSearches(n: number): void;
  setCard(result: CardResult): void;
  setSparkline(prices: number[]): void;
  setSessionPnl(pnl: SessionPnl): void;
  setRiskSnapshot(snapshot: RiskSnapshot): void;
  setRanked(candidates: ScoredOpportunity[]): void;
  destroy(): void;
}

export function createPanel(doc: Document = document): Panel {
  const host = doc.createElement('div');
  host.id = 'ledger-root';
  const root = host.attachShadow({ mode: 'open' });

  const style = doc.createElement('style');
  style.textContent = css;

  const panel = doc.createElement('div');
  panel.className = 'panel';
  panel.innerHTML = `
    <div class="head">
      <span class="dot" id="dot"></span>
      <span class="name">Sniper's Ledger</span>
      <span class="chev" id="chev">▾</span>
    </div>
    <div class="body">
      <div class="status" id="status">Waiting for a market search…</div>
      <div class="row"><span class="k">Auctions recorded</span><span class="v" id="total">—</span></div>
      <div class="row"><span class="k">Players seen today</span><span class="v" id="players">—</span></div>
      <div class="row"><span class="k">Searches this session</span><span class="v" id="searches">0</span></div>

      <div class="sec" id="card-sec">
        <h4>Last search</h4>
        <div class="hint" id="card-hint">Search the market and the numbers appear here.</div>
        <div id="card-stats" hidden>
          <div class="row"><span class="k">Listings on record</span><span class="v" id="listings">—</span></div>
          <div class="row"><span class="k">BIN floor</span><span class="v" id="floor">—</span></div>
          <div class="row"><span class="k">Median BIN</span><span class="v" id="median">—</span></div>
          <div class="row"><span class="k">Sells before expiry</span><span class="v" id="sellthrough">—</span></div>
          <div class="row"><span class="k">Snipe under (target profit)</span><span class="v big" id="maxsnipe">—</span></div>
          <div class="spark" id="spark" hidden></div>
        </div>
      </div>

      <div class="sec" id="pnl-sec" hidden>
        <h4>Session P&amp;L</h4>
        <div class="row"><span class="k">Coins spent</span><span class="v" id="pnl-spent">—</span></div>
        <div class="row"><span class="k">Coins earned</span><span class="v" id="pnl-earned">—</span></div>
        <div class="row"><span class="k">Net profit</span><span class="v" id="pnl-net">—</span></div>
        <div class="row"><span class="k">Trades</span><span class="v" id="pnl-trades">—</span></div>
      </div>

      <div class="sec" id="risk-sec" hidden>
        <h4>Risk budget</h4>
        <div class="row"><span class="k">Actions this hour</span><span class="v" id="risk-actions">—</span></div>
        <div class="meter" id="risk-actions-meter"><i style="width:0%"></i></div>
        <div class="row"><span class="k">Buy / search ratio</span><span class="v" id="risk-ratio">—</span></div>
        <div class="meter" id="risk-ratio-meter"><i style="width:0%"></i></div>
        <div class="row"><span class="k">Coin flow / hour</span><span class="v" id="risk-flow">—</span></div>
        <div class="meter" id="risk-flow-meter"><i style="width:0%"></i></div>
      </div>

      <div class="sec" id="rank-sec" hidden>
        <h4>Ranker — top candidates</h4>
        <div class="ranklist" id="ranklist"></div>
      </div>
    </div>
  `;

  root.append(style, panel);
  (doc.body || doc.documentElement).appendChild(host);

  const $ = <T extends Element = Element>(id: string): T => root.getElementById(id) as unknown as T;

  panel.querySelector('.head')?.addEventListener('click', () => {
    panel.classList.toggle('collapsed');
    $('chev').textContent = panel.classList.contains('collapsed') ? '▸' : '▾';
  });

  function meterClass(ratio: number): string {
    if (ratio >= 1) return 'meter over';
    if (ratio >= 0.8) return 'meter high';
    return 'meter';
  }

  function setMeter(id: string, value: number, limit: number): void {
    const el = $(id);
    const ratio = limit > 0 ? Math.min(1.2, value / limit) : 0;
    el.className = meterClass(ratio);
    const bar = el.querySelector('i');
    if (bar) (bar as HTMLElement).style.width = `${Math.min(100, ratio * 100)}%`;
  }

  return {
    setHealth(state, message) {
      const dot = $('dot');
      dot.className = 'dot' + (state === 'live' ? ' live' : state === 'warn' ? ' warn' : state === 'risk' ? ' risk' : '');
      const status = $('status');
      status.textContent = message;
      status.className = 'status' + (state === 'warn' || state === 'risk' ? ' warn' : '');
    },

    setTotals({ auctions, playersLast24h }) {
      $('total').textContent = coins(auctions);
      $('players').textContent = coins(playersLast24h);
    },

    setSearches(n) {
      $('searches').textContent = String(n);
    },

    setCard(result) {
      const { summary, maxSnipe } = result;
      $('card-hint').setAttribute('hidden', '');
      $('card-stats').removeAttribute('hidden');
      const title = doc.querySelector<HTMLElement>('#ledger-root')
        ? (root.querySelector('#card-sec h4') as HTMLElement)
        : null;
      if (title) title.textContent = 'Last search · ' + (result.rating ? result.rating + ' rated' : 'card');
      $('listings').textContent = coins(summary.listings);
      $('floor').textContent = coins(summary.floor);
      $('median').textContent = coins(summary.median);
      $('sellthrough').textContent =
        summary.sellThrough == null ? 'not enough data' : pct(summary.sellThrough) + ' (' + summary.sample + ')';
      $('maxsnipe').textContent = coins(maxSnipe);
    },

    setSparkline(prices) {
      const el = $('spark');
      if (!prices || prices.length === 0) {
        el.setAttribute('hidden', '');
        return;
      }
      el.removeAttribute('hidden');
      const max = Math.max(...prices, 1);
      el.innerHTML = prices
        .slice(-40)
        .map((p) => `<i style="height:${Math.max(8, Math.round((p / max) * 100))}%" title="${coins(p)}"></i>`)
        .join('');
    },

    setSessionPnl(pnl) {
      $('pnl-sec').removeAttribute('hidden');
      $('pnl-spent').textContent = coins(pnl.coinsSpent);
      $('pnl-earned').textContent = coins(pnl.coinsEarned);
      const net = $('pnl-net');
      net.textContent = (pnl.netProfit >= 0 ? '+' : '') + coins(pnl.netProfit);
      net.className = 'v ' + (pnl.netProfit >= 0 ? 'pos' : 'neg');
      $('pnl-trades').textContent = String(pnl.trades);
    },

    setRiskSnapshot(snapshot) {
      $('risk-sec').removeAttribute('hidden');
      $('risk-actions').textContent = `${snapshot.actionsLastHour} / ${snapshot.actionsPerHourLimit}`;
      setMeter('risk-actions-meter', snapshot.actionsLastHour, snapshot.actionsPerHourLimit);
      $('risk-ratio').textContent = `${snapshot.buyToSearchRatio.toFixed(2)} / ${snapshot.buyToSearchRatioLimit.toFixed(2)}`;
      setMeter('risk-ratio-meter', snapshot.buyToSearchRatio, snapshot.buyToSearchRatioLimit);
      $('risk-flow').textContent = `${coins(snapshot.coinFlowLastHour)} / ${coins(snapshot.coinFlowLimit)}`;
      setMeter('risk-flow-meter', snapshot.coinFlowLastHour, snapshot.coinFlowLimit);
    },

    setRanked(candidates) {
      const sec = $('rank-sec');
      const list = $('ranklist');
      if (!candidates || candidates.length === 0) {
        sec.setAttribute('hidden', '');
        return;
      }
      sec.removeAttribute('hidden');
      list.innerHTML = candidates
        .slice(0, 5)
        .map(
          (c) =>
            `<div class="rankrow"><span>#${c.resourceId} @ ${coins(c.price)}</span><span class="ev">EV ${c.ev >= 0 ? '+' : ''}${coins(c.ev)}</span></div>`,
        )
        .join('');
    },

    destroy() {
      host.remove();
    },
  };
}
