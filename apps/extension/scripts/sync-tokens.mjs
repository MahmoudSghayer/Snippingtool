#!/usr/bin/env node
// sync-tokens.mjs — refreshes `src/styles/tokens.css` from the design
// system's source of truth, `packages/ui/src/tokens.css` (PHASE 10:
// "shared tokens ... a script `pnpm --filter @sl/extension tokens:sync`
// that copies the file is welcome"). The extension has no runtime
// dependency on `@sl/ui` (a React component library) and ships as a plain
// MV3 build, so the tokens are vendored as a plain copy rather than
// imported at build time — this script is how that copy gets refreshed by
// hand whenever the design system's palette changes, instead of by editing
// `src/styles/tokens.css` directly and risking it drifting from the source.
//
// Copies the `:root { ... }` / `@media (prefers-reduced-motion...)` /
// `body { ... }` blocks verbatim, but drops the chart-series ramp
// (`--sl-chart-1..6`) — nothing in the extension renders a chart, so that
// block would be dead weight in every popup/options/panel load. Everything
// else must stay byte-for-byte identical to the source file's `:root`
// block (docs/10-design-system.md §15, "Extension surfaces").
//
// Usage: pnpm --filter @sl/extension tokens:sync
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dirname, '..');
const sourcePath = path.resolve(root, '../../packages/ui/src/tokens.css');
const targetPath = path.resolve(root, 'src/styles/tokens.css');

const source = readFileSync(sourcePath, 'utf8');

// Drop the chart-series ramp block (the comment + its six `--sl-chart-N`
// declarations) — bounded by the "/* Chart series" comment and the next
// blank-line-preceded declaration ("/* Radii */"), so this stays correct
// even if the ramp's own comment text changes, as long as the two section
// headers either side of it don't move. The trailing `\n\n` (not `\n`)
// collapses the blank line the removed block leaves behind, so the output
// doesn't accumulate an extra blank line each time this script runs.
const withoutChartRamp = source.replace(/\n\s*\/\* Chart series[\s\S]*?(?=\n\s*\/\* Radii \*\/)/, '\n\n');

const header = `/**
 * The Sniper's Ledger — design tokens, synced from \`packages/ui/src/tokens.css\`
 * by \`pnpm --filter @sl/extension tokens:sync\` (${new Date().toISOString().slice(0, 10)}).
 * DO NOT hand-edit the \`:root\` block below — run the sync script again
 * after changing the source file instead, so this copy never drifts from
 * the dashboard's palette (docs/10-design-system.md §1 "Color carries
 * meaning, consistently").
 *
 * This IS a copy, not an import — the extension has no dependency on
 * \`@sl/ui\` (a React component library) and ships as a plain MV3 build.
 * The chart-series ramp (\`--sl-chart-1..6\`) is intentionally dropped —
 * nothing in the extension renders a chart.
 *
 * Consumed two ways:
 *  - \`popup/index.html\` and \`options/index.html\` \`<link>\` this file
 *    directly — both run in the extension's own \`chrome-extension://\`
 *    origin, an ordinary document \`<head>\`, no different from any other
 *    page.
 *  - \`ui/panel.ts\` imports this file's text at build time (\`?raw\`) and
 *    swaps \`:root\` for \`:host\`, because it renders inside a shadow root
 *    injected into EA's page — custom properties are inherited properties,
 *    but nothing on EA's own page defines \`--sl-*\`, so the shadow tree
 *    needs its own top-level declaration rather than relying on
 *    inheritance from a \`:root\` it isn't part of.
 */

`;

const body = withoutChartRamp
  .replace(/^\/\*\*[\s\S]*?\*\/\s*\n+/, '')
  // Belt-and-braces: collapse any run of 2+ blank lines the ramp removal
  // leaves behind into exactly one, regardless of exactly how many
  // newlines bordered the removed block in the source file.
  .replace(/\n{3,}/g, '\n\n');

writeFileSync(targetPath, header + body);
console.warn(`[tokens:sync] wrote ${path.relative(root, targetPath)} from ${path.relative(root, sourcePath)}`);
