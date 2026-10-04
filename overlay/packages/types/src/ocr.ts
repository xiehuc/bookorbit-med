export type OcrBoundingBox = [number, number, number, number];

export interface OcrHit {
  page: number;
  blockId: number;
  text: string;
  bbox: OcrBoundingBox | null;
  fingerprint: string;
}

export interface OcrSearchHit extends OcrHit {
  fileId: number;
  bookId: number;
  title: string | null;
}

export interface OcrSearchResponse {
  items: OcrSearchHit[];
  hasMore: boolean;
}

export interface OcrManifest {
  fileId: number;
  bookId: number;
  fingerprint: string;
  pages: Array<{ page: number; source: string; width: number; height: number }>;
}
