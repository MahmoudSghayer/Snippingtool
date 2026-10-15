/*
 * setup.ts — the first module `main.ts` imports, so it is evaluated before
 * background/* or content/* run a single line: anything those modules do at
 * import time (the startup license bootstrap, for one) must already go
 * through the userscript's transport and find the adapter in place.
 */
import adapterSource from 'virtual:adapter-source';

import { HANDOFF_ATTRIBUTE, handOffNonceWithinBundle } from '../lib/act-auth.js';
import { setFetchImpl } from '../lib/http.js';

import { gmFetch } from './gm-fetch.js';

setFetchImpl(gmFetch);

// The act channel's nonce (lib/act-auth.ts), exactly as the extension's
// handoff.js does it: minted here, left on <html> for the adapter, with
// content's copy kept inside this bundle. The adapter below runs
// synchronously as it is inserted, at document-start, before any page
// script: it takes the attribute and removes it, so no page script ever
// sees the nonce, and every act request, result and catalog between the
// page and this script is signed under it, as in the extension.
//
// Tampermonkey does not guarantee this runs before every page script, and
// on Chrome it often does not. The handoff goes ahead anyway (content logs
// that it was late): refusing locked Nova AI on every such load, with no
// reload able to fix it (lib/act-auth.ts has why that is the right trade).
handOffNonceWithinBundle(document);

// `GM_addElement` injects past the page's CSP. The element can go as soon as
// the script inside it has run.
GM_addElement(document.documentElement, 'script', { textContent: adapterSource }).remove();
// The adapter has taken the nonce by now. Should it not have run (a page
// that refused the injection), the attribute must not wait on <html> for a
// page script to read: fail closed — no act call can be authenticated.
document.documentElement.removeAttribute(HANDOFF_ATTRIBUTE);
