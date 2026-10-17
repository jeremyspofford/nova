// What the document readers return (FR-219): text and tables in a structure the model and the
// artifact preview both use. Everything here came from a file, so it is untrusted content.
import type { DocumentFormat } from './content.ts';

export type ExtractedBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'table'; rows: string[][] };

export interface ExtractedSlide {
  /** 1-based, in presentation order. */
  index: number;
  title: string | null;
  /** Other text on the slide, one entry per paragraph; `level` is the bullet depth. */
  paragraphs: { text: string; level: number }[];
  notes: string | null;
}

export interface ExtractedSheet {
  name: string;
  /** Cell text by row; dates as ISO text, booleans as TRUE/FALSE. */
  rows: string[][];
  /** Rows or columns were left out (limits). */
  truncated: boolean;
}

export interface ExtractedPage {
  /** 1-based. */
  index: number;
  text: string;
}

export interface ExtractedDocument {
  format: DocumentFormat;
  title: string | null;
  blocks?: ExtractedBlock[];
  slides?: ExtractedSlide[];
  sheets?: ExtractedSheet[];
  pages?: ExtractedPage[];
  /** False when the file opened but its text could not be read (a scanned PDF). */
  readable: boolean;
  /** Why some or all text is missing, in plain words; null when nothing is. */
  note: string | null;
  /** Content was left out to keep the result within its limits. */
  truncated: boolean;
}
