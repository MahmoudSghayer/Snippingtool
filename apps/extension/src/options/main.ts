/*
 * options/main.ts — the options page's entry: mounts `app.ts` into the
 * page's `#app`. The userscript build mounts the same module into its own
 * shadow root instead (`src/userscript/launcher.ts`).
 */
import { mountOptions } from './app.js';

mountOptions(document.getElementById('app') as HTMLDivElement);
