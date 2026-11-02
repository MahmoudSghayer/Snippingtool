// userscript-prelude.mjs — the first statement of the userscript's body,
// written by scripts/build.mjs right after the `==UserScript==` header and
// ahead of every bundle (pure data, like userscript-header.mjs).
//
// Tampermonkey runs a userscript inside `with (sandbox)`, so every use of a
// global name (`Promise`, `Object`, ...) is a property lookup through that
// sandbox proxy — a measurable share of code that uses them in loops, such
// as every schema check (a Chrome profile put it at about a sixth of a
// catalog check). Bound once here, at the top of the script's own function
// scope, they are plain locals for everything below. Written as plain text
// after obfuscation, so neither the bundler nor the obfuscator can rename
// or strip it; and never inside the MAIN-world adapter, which runs in EA's
// page, not the sandbox.
export const USERSCRIPT_PRELUDE =
  'const { Promise, Object, Array, Map, Set, JSON, Math, Number, String, Symbol, Reflect, Error } = globalThis;';
