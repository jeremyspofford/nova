// File kinds for the browser, editor and preview (FR-039): which files open as text, and how a
// preview draws a file. Decided by MIME type first, then by extension.
import { normalizeLanguage } from '@nova/ui';

export function baseName(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.at(-1) ?? path;
}

export function extensionOf(path: string): string {
  const m = /\.([A-Za-z0-9+_-]+)$/.exec(baseName(path));
  return m?.[1]?.toLowerCase() ?? '';
}

const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'log',
  'ini',
  'cfg',
  'conf',
  'env',
  'gitignore',
  'dockerfile',
  'makefile',
  'lock',
]);

const TEXT_MIMES = [
  /^text\//,
  /\+json$/,
  /\+xml$/,
  /^application\/(json|xml|javascript|ecmascript|typescript|x-sh|x-yaml|yaml|toml|sql|x-httpd-php)$/,
];

export function isTextFile(mime: string | null, path: string): boolean {
  if (mime?.startsWith('image/')) return false;
  if (mime && TEXT_MIMES.some((r) => r.test(mime))) return true;
  const ext = extensionOf(path);
  return TEXT_EXTENSIONS.has(ext) || normalizeLanguage(ext) !== null;
}

export type PreviewKind = 'markdown' | 'image' | 'pdf' | 'code' | 'text' | 'binary';

export function previewKind(mime: string | null, path: string): PreviewKind {
  const ext = extensionOf(path);
  if (mime === 'text/markdown' || ext === 'md' || ext === 'markdown') return 'markdown';
  if (mime?.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext))
    return 'image';
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (normalizeLanguage(ext)) return 'code';
  if (isTextFile(mime, path)) return 'text';
  return 'binary';
}

/** Text opens in the editor; everything else in the preview. */
export function opensIn(mime: string | null, path: string): 'editor' | 'preview' {
  return isTextFile(mime, path) && previewKind(mime, path) !== 'image' ? 'editor' : 'preview';
}

/** True when the editor's Preview button has something richer than the text to show. */
export function hasRichPreview(mime: string | null, path: string): boolean {
  const k = previewKind(mime, path);
  return k === 'markdown' || k === 'code';
}

export function lineCount(text: string): number {
  let n = 1;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n++;
  return n;
}
