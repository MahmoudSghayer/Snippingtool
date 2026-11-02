/*
 * vendor.ts — the userscript build's third-party code, built as its own
 * (minified, never obfuscated) chunk ahead of the main bundle, which takes
 * it from the `__novaVendor` global instead of bundling it
 * (`scripts/build.mjs`, `buildUserscript`).
 *
 * Why: the published userscript is obfuscated (scripts/obfuscate.mjs), and
 * the obfuscator's string hiding costs real time where strings are read in
 * loops. Zod runs its checks in exactly such loops — every message's schema
 * check, every auction parsed while sniping, the catalog's 20k players —
 * and a Chrome profile of the script showed close to half of a schema check
 * spent in the obfuscator's string decoder. Zod is public code: nothing of
 * the owner's is in it, so it ships as is. Only this project's own modules
 * (src/**, @sl/shared) are obfuscated.
 *
 * `z` here holds only the members this project's code uses (`z.string`,
 * `z.object`, ...), so the chunk is tree-shaken as the one bundle was: a
 * `z.<name>` the code uses but this does not export would be `undefined`
 * at runtime, so the build checks every `z.<name>` in the sources against
 * this list (scripts/userscript-vendor.mjs) and fails on a missing one.
 */
import {
  ZodError,
  ZodType,
  array,
  boolean,
  coerce,
  discriminatedUnion,
  enum as enum_,
  lazy,
  literal,
  null as null_,
  number,
  object,
  preprocess,
  record,
  string,
  union,
  unknown,
} from 'zod';

export const z = {
  ZodError,
  ZodType,
  array,
  boolean,
  coerce,
  discriminatedUnion,
  enum: enum_,
  lazy,
  literal,
  null: null_,
  number,
  object,
  preprocess,
  record,
  string,
  union,
  unknown,
};
