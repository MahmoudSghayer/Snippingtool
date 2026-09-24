// generate-manifest.mjs — builds the MV3 manifest object for one build
// target. Pure data, no I/O — `scripts/build.mjs` writes the result to
// `dist/<target>/manifest.json`. Kept separate from `build.mjs` so the
// manifest shape is easy to unit-test/read on its own (see
// docs/06-extension.md, "Build targets" for the field-by-field rationale).

// The EA web-app URL patterns live in ../ea-origins.mjs (shared with the
// background's kill-switch tab broadcast); re-exported here so existing
// importers of this module keep working.
import { EA_WEB_APP_MATCHES } from '../ea-origins.mjs';

export { EA_WEB_APP_MATCHES };

/**
 * @param {'ledger' | 'ledger-auto'} target
 * @param {{ version: string; apiOrigin: string; updateUrl: string }} env
 */
export function buildManifest(target, env) {
  const isAuto = target === 'ledger-auto';
  const hostPermissions = [...EA_WEB_APP_MATCHES, `${env.apiOrigin}/*`];

  /** @type {Record<string, unknown>} */
  const manifest = {
    manifest_version: 3,
    name: 'Nova Trade',
    version: env.version,
    description: isAuto
      ? 'Nova Trade for the EA FC web app: finds and buys underpriced players, with a safety governor checking every action.'
      : 'Nova Trade for the EA FC web app: ranks transfer market opportunities, rotates your filters and shows your risk budget.',
    permissions: ['storage', 'unlimitedStorage', 'alarms'],
    host_permissions: hostPermissions,
    background: {
      service_worker: 'background.js',
      type: 'module',
    },
    content_scripts: [
      {
        matches: EA_WEB_APP_MATCHES,
        js: ['adapter.js'],
        world: 'MAIN',
        run_at: 'document_start',
        all_frames: false,
      },
      {
        matches: EA_WEB_APP_MATCHES,
        js: ['content.js'],
        world: 'ISOLATED',
        run_at: 'document_idle',
        all_frames: false,
      },
    ],
    action: {
      default_popup: 'src/popup/index.html',
      default_title: 'Nova Trade',
    },
    options_ui: {
      page: 'src/options/index.html',
      open_in_tab: true,
    },
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    },
  };

  // The Chrome Web Store owns updates for the listable build; only the
  // self-hosted `ledger-auto` build declares `update_url` (docs/01-
  // architecture.md, §6 "Two extension build targets").
  if (isAuto && env.updateUrl) {
    manifest.update_url = env.updateUrl;
    manifest.version_name = `${env.version}-auto`;
  }

  return manifest;
}
