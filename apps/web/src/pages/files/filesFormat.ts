/**
 * Pure presentation logic for the Files page, kept apart from the
 * component for the same reason activityFormat.ts is: each property this
 * page has to get right — a real size on a small file, a stated (never
 * guessed) reason a file's contents are not shown — is one function a
 * test can pin down without rendering anything.
 */

/** Most files Nova writes are a few hundred bytes to a few KB, so bytes
 * gets no decimal at all — "0 B" / "7 B" reads better than "0.0 B" for the
 * common case, and nothing here rounds a real size down to a fake zero. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

/**
 * The message shown in place of a file's contents when core's
 * GET /file (services/core/app/workspace_api.py) answered with `text:
 * null` — binary or over the 256 KB preview cap. The real byte count is
 * always named (never dropped in favour of a vague "large file"), and the
 * two reasons are mutually exclusive by construction on the wire, so this
 * never has to choose between them.
 */
export function notShownMessage(detail: {
  size: number
  binary: boolean
  too_large: boolean
}): string {
  const reason = detail.too_large ? 'too large to preview' : 'binary'
  return `${detail.size} bytes, not shown (${reason}) — download to view`
}
