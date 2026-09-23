/*
 * popup/main.ts — the extension popup's entry: mounts `app.ts` into the
 * page's `#app`. The userscript build mounts the same module into its own
 * shadow root instead (`src/userscript/launcher.ts`).
 */
import { mountPopup } from './app.js';

mountPopup(document.getElementById('app') as HTMLDivElement);
