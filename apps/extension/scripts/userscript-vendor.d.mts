export declare const ZOD_TYPE_ONLY: Set<string>;
export declare function usedZodMembers(source: string): Set<string>;
export declare function vendorZodMembers(vendorSource: string): Set<string>;
export declare function missingZodMembers(sourceDirs: string[], vendorPath: string): string[];
