// Types for ./obfuscate.mjs (imported by tests).
export declare const ADAPTER_SOURCE_SENTINEL: string;
export declare function obfuscateUserscriptCode(code: string, keepVerbatim?: string[]): string;
export declare function obfuscateAdapterSource(code: string): string;
export declare function injectAdapterSource(mainCode: string, adapterSource: string): string;
