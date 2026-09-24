/*
 * setup.ts — the first module `main.ts` imports, so it is evaluated before
 * background/* or content/* run a single line: anything those modules do at
 * import time (the startup license bootstrap, for one) must already go
 * through the userscript's transport and find the adapter in place.
 */
import adapterSource from 'virtual:adapter-source';

import { setFetchImpl } from '../lib/http.js';

import { gmFetch } from './gm-fetch.js';

setFetchImpl(gmFetch);

// `GM_addElement` injects past the page's CSP. The element can go as soon as
// the script inside it has run.
GM_addElement(document.documentElement, 'script', { textContent: adapterSource }).remove();
