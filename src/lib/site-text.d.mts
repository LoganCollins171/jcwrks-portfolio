export interface SiteTextField {
  page: string; key: string; label: string; kind: "line" | "paragraphs"; max: number;
  maxParagraphs?: number; default: string; help?: string; path?: string; also?: string[];
}
export declare const PAGES: Array<{ id: string; label: string; path: string }>;
export declare const FIELDS: SiteTextField[];
export declare const FIELD_BY_KEY: Map<string, SiteTextField>;
export declare function fieldPaths(field: SiteTextField): string[];
export declare function cleanText(value: unknown, field: SiteTextField): string | null;
export declare function charCount(s: string): number;
export declare function problemWith(cleaned: string, field: SiteTextField): string | null;
export declare function effectiveText(data: unknown, key: string): string;
