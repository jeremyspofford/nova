// Zip archives in a catalog (FR-049): a plugin, skill or pet packed as a `.zip`. Entry names are
// checked like a `.novax` bundle's (no absolute paths, `..` or backslashes), sizes and the entry
// count are capped before anything is inflated, and files are written only inside the target
// folder. `.novax` bundles themselves are read and verified by the extension SDK (`verifyBundle`).
import { NovaError } from '@nova/shared';
import { isZip, readZip } from '../documents/zip.ts';
import { BUNDLE_LIMITS, extractBundle, safeBundlePath } from '../sdk/bundle.ts';

/** The files of a zip archive by safe relative path. Throws `validation` when it is unsafe. */
export function readArchive(bytes: Uint8Array): Map<string, Uint8Array> {
  if (!isZip(bytes)) throw new NovaError('validation', 'the item is not a valid zip archive');
  const files = new Map<string, Uint8Array>();
  for (const [name, data] of readZip(bytes, () => true, BUNDLE_LIMITS)) {
    const safe = safeBundlePath(name);
    if (files.has(safe)) throw new NovaError('validation', `the archive lists ${safe} twice`);
    files.set(safe, data);
  }
  return files;
}

/** Write archive files into `dir` (created 0700; nothing outside it, nothing overwritten). */
export function writeArchive(files: Map<string, Uint8Array>, dir: string): void {
  extractBundle(files, dir);
}
