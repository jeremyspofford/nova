/** Unsaved-work state for the file surfaces, so the ways OUT can ask first.
 *
 *  The editor's own guard only ever ran when opening another file, which left
 *  every other exit silent: switching Library tabs, clicking the scrim, the ×
 *  button, reloading the page. Those are owned by LibraryPage, the Vault and
 *  the browser, not by the editor, so the answer has to be reachable from
 *  outside the component tree — hence a module, not context.
 *
 *  Keyed by owner rather than one boolean. `<Routes>` renders at most one of
 *  Library and the Vault, so a single flag would still *work* — but it would
 *  be lying about which surface it means, and FilesTab clears it
 *  UNCONDITIONALLY on unmount. With two owners that clear erases the other
 *  surface's state and `beforeunload` silently stops firing. A count per owner
 *  cannot do that.
 *
 *  A count, not a boolean, because the Vault holds a draft per note: you can
 *  navigate away from a dirty note, dirty another, and still owe two saves.
 *
 *  The `beforeunload` listener lives HERE. It used to live in FilesTab, which
 *  meant a second editing surface had to remember to grow one — a rule nobody
 *  can see from the outside is a rule that gets skipped.
 */

export type DirtyOwner = 'files' | 'vault';

const counts = new Map<DirtyOwner, number>();

let listening = false;

function warn(e: BeforeUnloadEvent) {
  e.preventDefault();
  e.returnValue = '';
}

/** Install/remove the listener from the live total, so no caller has to
 *  remember to. The browser only warns while a surface actually owes a save. */
function sync() {
  const want = anyDirty();
  if (want === listening) return;
  if (want) window.addEventListener('beforeunload', warn);
  else window.removeEventListener('beforeunload', warn);
  listening = want;
}

/** How many files this surface is holding unsaved. Call with 0 on unmount. */
export function setDirtyCount(owner: DirtyOwner, n: number): void {
  if (n > 0) counts.set(owner, n);
  else counts.delete(owner);
  sync();
}

export function dirtyCount(owner?: DirtyOwner): number {
  if (owner) return counts.get(owner) ?? 0;
  let total = 0;
  for (const n of counts.values()) total += n;
  return total;
}

export function anyDirty(): boolean {
  return dirtyCount() > 0;
}

/** True to proceed. Asks only when there is something to lose, and says how
 *  much — "2 notes have unsaved changes" is a different decision from one.
 *  Omit `owner` to ask about everything. */
export function confirmDiscard(owner?: DirtyOwner): boolean {
  const n = dirtyCount(owner);
  if (!n) return true;
  const what = n === 1 ? 'The open file has' : `${n} files have`;
  const ok = window.confirm(`${what} unsaved changes. Discard them?`);
  if (ok) {
    if (owner) setDirtyCount(owner, 0);
    else { counts.clear(); sync(); }
  }
  return ok;
}
