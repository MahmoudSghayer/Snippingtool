/*
 * panel.js — the readout.
 *
 * Lives in a shadow root so EA's stylesheet and ours can't reach each other.
 * Shows what has been recorded, and for the card you last searched: the real
 * BIN floor, the spread, how often that card actually sells, and the highest
 * price at which a snipe still clears your target profit.
 */
(() => {
  'use strict';

  const css = `
    :host { all: initial; }
    .panel {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
      width: 268px; font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
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
    .name { font-weight: 600; letter-spacing: .02em; flex: 1; }
    .chev { color: #7d8f89; font-size: 11px; }
    .body { padding: 10px 12px 12px; }
    .panel.collapsed .body { display: none; }
    .status { color: #8ea39c; margin-bottom: 10px; }
    .status.warn { color: #e0b568; }
    .row { display: flex; justify-content: space-between; gap: 10px; padding: 2px 0; }
    .row .k { color: #8ea39c; }
    .row .v { font-variant-numeric: tabular-nums; font-weight: 600; }
    .sec {
      margin-top: 10px; padding-top: 9px; border-top: 1px solid #243029;
    }
    .sec h4 {
      margin: 0 0 6px; font-size: 10px; letter-spacing: .1em; text-transform: uppercase;
      color: #6f827b; font-weight: 600;
    }
    .hint { color: #6f827b; font-style: italic; }
    .big { color: #e8c07a; }
  `;

  const coins = (n) => (n == null ? '—' : n.toLocaleString('en-US'));
  const pct = (n) => (n == null ? '—' : Math.round(n * 100) + '%');

  function Panel() {
    const host = document.createElement('div');
    host.id = 'ledger-root';
    const root = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = css;

    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `
      <div class="head">
        <span class="dot" id="dot"></span>
        <span class="name">Ledger</span>
        <span class="chev" id="chev">▾</span>
      </div>
      <div class="body">
        <div class="status" id="status">Waiting for a market search…</div>
        <div class="row"><span class="k">Auctions recorded</span><span class="v" id="total">—</span></div>
        <div class="row"><span class="k">Players seen today</span><span class="v" id="players">—</span></div>
        <div class="row"><span class="k">Searches this session</span><span class="v" id="searches">0</span></div>
        <div class="sec" id="card-sec">
          <h4 id="card-title">Last search</h4>
          <div class="hint" id="card-hint">Search the market and the numbers appear here.</div>
          <div id="card-stats" hidden>
            <div class="row"><span class="k">Listings on record</span><span class="v" id="listings">—</span></div>
            <div class="row"><span class="k">BIN floor</span><span class="v" id="floor">—</span></div>
            <div class="row"><span class="k">Median BIN</span><span class="v" id="median">—</span></div>
            <div class="row"><span class="k">Sells before expiry</span><span class="v" id="sellthrough">—</span></div>
            <div class="row"><span class="k">Snipe under (1k profit)</span><span class="v big" id="maxsnipe">—</span></div>
          </div>
        </div>
      </div>
    `;

    root.append(style, panel);
    (document.body || document.documentElement).appendChild(host);

    const $ = (id) => root.getElementById(id);

    panel.querySelector('.head').addEventListener('click', () => {
      panel.classList.toggle('collapsed');
      $('chev').textContent = panel.classList.contains('collapsed') ? '▸' : '▾';
    });

    return {
      setHealth(state, message) {
        const dot = $('dot');
        dot.className = 'dot' + (state === 'live' ? ' live' : state === 'warn' ? ' warn' : '');
        const status = $('status');
        status.textContent = message;
        status.className = 'status' + (state === 'warn' ? ' warn' : '');
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
        $('card-hint').hidden = true;
        $('card-stats').hidden = false;
        $('card-title').textContent = 'Last search · ' + (result.rating ? result.rating + ' rated' : 'card');
        $('listings').textContent = coins(summary.listings);
        $('floor').textContent = coins(summary.floor);
        $('median').textContent = coins(summary.median);
        $('sellthrough').textContent =
          summary.sellThrough == null
            ? 'not enough data'
            : pct(summary.sellThrough) + ' (' + summary.sample + ')';
        $('maxsnipe').textContent = coins(maxSnipe);
      }
    };
  }

  globalThis.LedgerPanel = Panel;
})();
