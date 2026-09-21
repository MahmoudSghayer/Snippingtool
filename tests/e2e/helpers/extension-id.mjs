// Computes the extension ID Chrome assigns an *unpacked* extension loaded
// from a given directory when its manifest carries no "key" field (true for
// every build this repo produces — see apps/extension/scripts/build.mjs).
// Chrome's own algorithm (undocumented in the manifest reference, but
// stable and widely relied on by extension tooling): SHA-256 the
// extension's absolute install path, take the first 32 hex characters, and
// map each hex nibble 0-9a-f to a letter a-p (i.e. `char + 'a' - '0'` for
// digits, `char + 'a' - 'a' + 10` for a-f — equivalently: hex digit's
// integer value 0-15 -> 'a'..'p').
//
// Needed here because apps/api's CORS allowlist (plugins/cors.ts) only
// accepts a `chrome-extension://<id>` origin it's told about via
// `EXTENSION_IDS`, and playwright.config.ts's `webServer` env has to be set
// *before* Chromium ever loads the extension (so we can't just read the id
// off `context.serviceWorkers()` first) — since this suite always builds
// into the same fixed directory (build-extension.mjs's `EXTENSION_OUT_DIR`),
// the id is deterministic across runs and can be computed up front from
// that path alone.
import { createHash } from 'node:crypto';

export function computeUnpackedExtensionId(absolutePath) {
  const hex = createHash('sha256').update(absolutePath, 'utf8').digest('hex').slice(0, 32);
  let id = '';
  for (const ch of hex) {
    id += String.fromCharCode('a'.charCodeAt(0) + parseInt(ch, 16));
  }
  return id;
}
