export declare const GALLERY_SLUGS: string[];
export declare const GALLERY_TITLES: Record<string, string>;
export declare const IMAGE_EXT: RegExp;
export declare const GALLERIES_PREFIX: string;
export declare const GALLERY_DATA_PREFIX: string;
export declare const STATS_PATH: string;
export declare function isContentPath(path: string): boolean;
export declare function srcKey(src: string): string;
export declare function naturalCompare(a: string, b: string): number;
export declare function mergeGallery(
  listed: Array<{ src: string; alt?: string }> | undefined,
  fileSrcs: string[]
): { images: Array<{ src: string; alt: string }>; missing: string[]; extras: string[] };
export declare function movedCount(beforeSrcs: string[], afterSrcs: string[]): number;
