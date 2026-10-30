// userscript-vendor.mjs — keeps src/userscript/vendor.ts honest: every
// `z.<name>` the sources use at runtime must be a member of the `z` object
// it exports, or the published userscript would read `undefined` where the
// one-bundle build had the real thing. Pure functions, used by build.mjs
// and tested on their own.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/** `z.<name>` members that are types only: erased at build time. */
export const ZOD_TYPE_ONLY = new Set(['infer', 'input', 'output', 'ZodTypeAny', 'ZodRawShape', 'ZodObject', 'ZodSchema']);

/** The runtime `z.<name>` members used in `source`. */
export function usedZodMembers(source) {
  const out = new Set();
  for (const m of source.matchAll(/\bz\.([A-Za-z_$][\w$]*)/g)) if (!ZOD_TYPE_ONLY.has(m[1])) out.add(m[1]);
  return out;
}

/** The keys of `export const z = { ... }` in the vendor module's source. */
export function vendorZodMembers(vendorSource) {
  const body = /export const z = \{([\s\S]*?)\};/.exec(vendorSource)?.[1] ?? '';
  const out = new Set();
  for (const line of body.split(',')) {
    const key = line.trim().split(':')[0]?.trim();
    if (key) out.add(key);
  }
  return out;
}

function tsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** The `z.<name>` members used under `sourceDirs` that `vendorPath` lacks. */
export function missingZodMembers(sourceDirs, vendorPath) {
  const have = vendorZodMembers(readFileSync(vendorPath, 'utf8'));
  const missing = new Set();
  for (const dir of sourceDirs) {
    for (const file of tsFiles(dir)) {
      if (path.resolve(file) === path.resolve(vendorPath)) continue;
      for (const name of usedZodMembers(readFileSync(file, 'utf8'))) if (!have.has(name)) missing.add(name);
    }
  }
  return [...missing].sort();
}
