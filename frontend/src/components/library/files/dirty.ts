/** One flag, so the ways OUT of the Files tab can ask before discarding work.
 *
 *  The editor's own guard only ever ran when opening another file, which
 *  left every other exit silent: switching Library tabs, clicking the scrim,
 *  the × button, reloading the page. Those are all owned by LibraryPage and
 *  the browser, not by the editor, so the answer has to be reachable from
 *  outside the component tree.
 *
 *  Deliberately a module-level flag rather than context: the consumers are
 *  an event handler in a sibling component and a `beforeunload` listener,
 *  neither of which is inside a provider, and there is only ever one editor
 *  open at a time.
 */

let dirty = false;

export function setFilesDirty(next: boolean) {
  dirty = next;
}

export function filesDirty(): boolean {
  return dirty;
}

/** True to proceed. Asks only when there is something to lose. */
export function confirmDiscardFiles(): boolean {
  if (!dirty) return true;
  const ok = window.confirm('The open file has unsaved changes. Discard them?');
  if (ok) dirty = false;
  return ok;
}
