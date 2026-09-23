// userscript-header.mjs — the `==UserScript==` metadata block for the
// userscript build, the Tampermonkey counterpart of generate-manifest.mjs.
// Pure data, no I/O; `scripts/build.mjs` writes it on top of the bundle and
// alone into the `.meta.js` Tampermonkey polls for updates.

import { EA_WEB_APP_MATCHES } from '../ea-origins.mjs';

// Every GM_* function src/userscript/ calls (see src/userscript/gm.d.ts).
// Tampermonkey leaves anything not granted here undefined.
const GRANTS = [
  'GM_xmlhttpRequest',
  'GM_getValue',
  'GM_setValue',
  'GM_deleteValue',
  'GM_addElement',
  'GM_openInTab',
  'GM_registerMenuCommand',
];

/**
 * @param {{ version: string; apiOrigin: string; downloadUrl: string }} env
 */
export function buildUserscriptHeader(env) {
  const apiHost = new URL(env.apiOrigin).hostname;

  /** @type {[string, string][]} */
  const fields = [
    ['name', "Sniper's Ledger"],
    ['namespace', 'https://snipersledger.app/'],
    ['version', env.version],
    [
      'description',
      "Records what the FC transfer market actually does, ranks opportunities, and runs a governed autobuyer. The Tampermonkey build of the Sniper's Ledger extension.",
    ],
    ...EA_WEB_APP_MATCHES.map((m) => /** @type {[string, string]} */ (['match', m])),
    // The adapter must patch XHR/fetch before EA's own code makes its first
    // market call; content/index.ts waits for the DOM on its own.
    ['run-at', 'document-start'],
    ['noframes', ''],
    // The only host the script talks to besides the page it runs on.
    ['connect', apiHost],
    ...GRANTS.map((g) => /** @type {[string, string]} */ (['grant', g])),
  ];

  if (env.downloadUrl) {
    fields.push(['updateURL', env.downloadUrl.replace(/\.user\.js$/, '.meta.js')]);
    fields.push(['downloadURL', env.downloadUrl]);
  }

  const width = Math.max(...fields.map(([k]) => k.length)) + 2;
  const lines = fields.map(([k, v]) => `// @${k.padEnd(width)}${v}`.trimEnd());
  return ['// ==UserScript==', ...lines, '// ==/UserScript=='].join('\n');
}
