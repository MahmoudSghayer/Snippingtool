/*
 * handoff.ts — the first thing the extension runs on an EA page: an
 * ISOLATED-world content script at `document_start`, listed in the manifest
 * ahead of the MAIN-world adapter.js. It mints this page load's act-channel
 * nonce and hands it to the adapter before any page script exists
 * (lib/act-auth.ts has the whole scheme). Deliberately tiny and separate
 * from content.js, which runs at `document_idle` — far too late to hand
 * anything to the adapter unseen.
 */
import { handOffNonce } from '../lib/act-auth.js';

handOffNonce();
