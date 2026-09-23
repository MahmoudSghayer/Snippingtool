/*
 * gm.d.ts — the slice of the Tampermonkey API the userscript build uses.
 * Every name here must also appear as an `@grant` in the header
 * `scripts/userscript-header.mjs` writes, or Tampermonkey leaves it
 * undefined at runtime.
 */
interface GmXhrResponse {
  status: number;
  statusText: string;
  responseHeaders: string;
  responseText: string;
  finalUrl: string;
}

interface GmXhrDetails {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  data?: string;
  timeout?: number;
  anonymous?: boolean;
  onload?: (res: GmXhrResponse) => void;
  onerror?: (res: GmXhrResponse) => void;
  ontimeout?: () => void;
  onabort?: () => void;
}

declare function GM_xmlhttpRequest(details: GmXhrDetails): { abort: () => void };
declare function GM_getValue<T>(key: string, fallback?: T): T;
declare function GM_setValue(key: string, value: unknown): void;
declare function GM_deleteValue(key: string): void;
declare function GM_addElement(tag: string, attributes: Record<string, string>): HTMLElement;
declare function GM_addElement(
  parent: Node,
  tag: string,
  attributes: Record<string, string>,
): HTMLElement;
declare function GM_openInTab(url: string, options?: { active?: boolean }): void;
declare function GM_registerMenuCommand(caption: string, onClick: () => void): unknown;
