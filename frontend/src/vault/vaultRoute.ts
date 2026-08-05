/** The Vault's URL shape, in one place.
 *
 *  `/vault` · `/vault/:root` · `/vault/:root/<path...>`, plus `?tag=` and
 *  `?graph=1`. The open note has a URL because that is what makes a wikilink
 *  click a `navigate()` and the browser's back button the history a vault
 *  needs — Obsidian's back button, for free.
 *
 *  Search text is deliberately NOT in the URL: it is transient, and a URL that
 *  changes on every keystroke poisons the back stack it exists to serve.
 */

export interface NoteRef { root: string; path: string }

/** Same shape as `Tree.nodeKey`, so a ref and a tree row compare directly. */
export const refKey = (r: NoteRef) => `${r.root} ${r.path}`;

export interface VaultQuery {
  tag?: string | null;
  graph?: boolean;
}

/** Encode per SEGMENT. `encodeURIComponent` on the whole path would eat the
 *  separators; leaving it raw breaks on a Workspace file with a space or a `#`
 *  in its name. Memory filenames are slugs, but Workspace takes anything. */
const encPath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

export function vaultUrl(ref?: NoteRef | null, q?: VaultQuery): string {
  let url = '/vault';
  if (ref?.root) {
    url += `/${encodeURIComponent(ref.root)}`;
    if (ref.path) url += `/${encPath(ref.path)}`;
  }
  const params = new URLSearchParams();
  if (q?.tag) params.set('tag', q.tag);
  if (q?.graph) params.set('graph', '1');
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}
