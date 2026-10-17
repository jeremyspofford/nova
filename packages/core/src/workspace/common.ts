// Helpers shared by the workspace services (FR-035, FR-039, FR-041): content types by extension,
// text detection, file hashes, the folders a walk skips and a small `.gitignore` reader.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { extname } from 'node:path';
import { globToRegExp } from '../tools/fs.ts';

const MIME: Record<string, string> = {
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.jsx': 'text/javascript',
  '.ts': 'text/x-typescript',
  '.tsx': 'text/x-typescript',
  '.py': 'text/x-python',
  '.rb': 'text/x-ruby',
  '.rs': 'text/x-rust',
  '.go': 'text/x-go',
  '.java': 'text/x-java',
  '.kt': 'text/x-kotlin',
  '.c': 'text/x-c',
  '.h': 'text/x-c',
  '.cpp': 'text/x-c++',
  '.hpp': 'text/x-c++',
  '.cs': 'text/x-csharp',
  '.swift': 'text/x-swift',
  '.php': 'text/x-php',
  '.sh': 'text/x-shellscript',
  '.sql': 'application/sql',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.toml': 'application/toml',
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
};

/** File types the folder indexer never opens: their content is not text (FR-035). */
export const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.bmp',
  '.ico',
  '.tif',
  '.tiff',
  '.psd',
  '.pdf',
  '.zip',
  '.gz',
  '.tgz',
  '.bz2',
  '.xz',
  '.7z',
  '.rar',
  '.tar',
  '.jar',
  '.war',
  '.class',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.o',
  '.a',
  '.lib',
  '.bin',
  '.dat',
  '.db',
  '.sqlite',
  '.sqlite3',
  '.pyc',
  '.pyo',
  '.wasm',
  '.mp3',
  '.wav',
  '.flac',
  '.ogg',
  '.m4a',
  '.mp4',
  '.m4v',
  '.mov',
  '.avi',
  '.mkv',
  '.webm',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.iso',
  '.dmg',
  '.docx',
  '.xlsx',
  '.pptx',
]);

/**
 * Folders a project-folder walk never enters: version control, dependencies, caches and build
 * output. `.git` is also a protected path (docs/12 §7.2).
 */
export const IGNORED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'bower_components',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.gradle',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'dist',
  'build',
  'target',
  'coverage',
]);

/** The content type for a file name; unknown text is `text/plain`. */
export function mimeOf(name: string, isText = false): string {
  const known = MIME[extname(name).toLowerCase()];
  if (known) return known;
  return isText ? 'text/plain' : 'application/octet-stream';
}

/** UTF-8 text without NUL bytes, or null for binary content. */
export function decodeText(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8192).includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Hash a file as a stream, so large files do not need to fit in memory. */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => h.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

interface IgnoreRule {
  re: RegExp;
  dirOnly: boolean;
  anchored: boolean;
}

/**
 * The patterns of a folder's top-level `.gitignore`: `name`, `*.log`, `dir/`, `/anchored`,
 * `a/**`. Negations (`!pattern`) and nested `.gitignore` files are not supported; a negated
 * line is skipped, so at worst a file the user wanted indexed is left out.
 */
export class IgnoreRules {
  readonly #rules: IgnoreRule[];

  constructor(text: string) {
    this.#rules = [];
    for (const raw of text.split(/\r?\n/)) {
      let line = raw.replace(/\s+$/, '');
      if (!line || line.startsWith('#') || line.startsWith('!')) continue;
      const dirOnly = line.endsWith('/');
      if (dirOnly) line = line.replace(/\/+$/, '');
      const anchored = line.includes('/');
      line = line.replace(/^\/+/, '');
      if (!line) continue;
      this.#rules.push({ re: globToRegExp(line), dirOnly, anchored });
    }
  }

  get size(): number {
    return this.#rules.length;
  }

  /** Whether `rel` (relative to the folder, `/`-separated) is ignored. */
  ignores(rel: string, isDir: boolean): boolean {
    const name = rel.slice(rel.lastIndexOf('/') + 1);
    for (const r of this.#rules) {
      if (r.dirOnly && !isDir) continue;
      if (r.re.test(r.anchored ? rel : name)) return true;
    }
    return false;
  }
}
