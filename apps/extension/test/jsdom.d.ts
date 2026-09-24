// jsdom ships no types and `@types/jsdom` is not a dependency; this covers
// the little test/unit/ledger-build-adapter.test.ts uses to load a built
// adapter.js into a fresh page of its own.
declare module 'jsdom' {
  export class JSDOM {
    constructor(html?: string, options?: { url?: string; runScripts?: 'dangerously' | 'outside-only' });
    readonly window: Window & typeof globalThis;
  }
}
