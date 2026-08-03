/** Client for the Files tab.
 *
 *  Its own module rather than lines in `src/api.ts` on purpose: that file is
 *  the busiest shared surface in the frontend, and a feature that can keep
 *  its calls to itself should. Auth is the one thing it borrows — importing
 *  `getAuthToken` rather than re-reading localStorage means the token still
 *  has exactly one owner.
 */

import { getAuthToken } from '../../../api';

const API_URL = import.meta.env.VITE_API_URL || '';

export type Root = {
  key: string; label: string; note: string;
  writable: boolean; can_mkdir: boolean; exists: boolean;
};

export type Entry = {
  name: string; path: string; dir: boolean; bytes: number; mtime: number;
  /** memory only — false when the file sits where iter_files cannot see it */
  indexed?: boolean;
};

export type FileRead = {
  kind: 'text' | 'binary';
  name: string; bytes: number; text: string;
  mtime?: number; editable: boolean; reason?: string;
  indexed?: boolean | null;
  /** memory only — how many [[links]] elsewhere point at this note's title */
  inbound_links?: number;
  /** memory only — links in THIS body that resolve to nothing */
  dangling?: string[];
};

/** What the save was told about the links it would break. */
export type LinkPlan = {
  code: 'title_change_breaks_links';
  message: string;
  old_title: string; new_title: string;
  notes: number; occurrences: number;
  referrers: { doc_id: string; count: number }[];
  options: ('retarget' | 'unlink')[];
  plan: string;
};

export type LinkReceipt = {
  action: 'retarget' | 'unlink';
  from: string; to: string | null;
  notes: number; occurrences: number;
  docs: string[]; failed: string[];
};

/** A refusal that carries structure, not just a sentence.
 *
 *  The generic path keeps only a string `detail`, so a dict body degraded to
 *  "409 Conflict" and every count, referrer and fingerprint died in the
 *  client. The message is still a full sentence, so anything that only reads
 *  `.message` stays correct. */
export class FilesRefusal extends Error {
  constructor(message: string, readonly detail: LinkPlan) {
    super(message);
    this.name = 'FilesRefusal';
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getAuthToken();
  const r = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers as Record<string, string> ?? {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (r.status === 401) window.dispatchEvent(new Event('nova:unauthorized'));
  if (!r.ok) {
    // The backend answers refusals in sentences — surfacing the status line
    // instead would replace "Memory is two levels deep by design" with
    // "Forbidden", which tells the operator nothing about what to do next.
    let detail = `${r.status} ${r.statusText}`;
    try {
      const body = await r.json();
      const d = body?.detail;
      if (typeof d === 'string' && d.trim()) detail = d;
      // A structured refusal keeps its structure. `message` is still a full
      // sentence, so a caller that only reads .message loses nothing.
      else if (d && typeof d === 'object' && d.code) {
        throw new FilesRefusal(d.message ?? detail, d as LinkPlan);
      }
    } catch (e) {
      if (e instanceof FilesRefusal) throw e;
      /* not JSON — keep the status line */
    }
    throw new Error(detail);
  }
  return r.json() as Promise<T>;
}

const q = (o: Record<string, string | boolean>) =>
  Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');

export const listRoots = () =>
  call<{ roots: Root[] }>('/api/v1/files/roots').then(r => r.roots);

export const listDir = (root: string, path: string) =>
  call<{ entries: Entry[] }>(`/api/v1/files/list?${q({ root, path })}`).then(r => r.entries);

export const readFile = (root: string, path: string) =>
  call<FileRead>(`/api/v1/files/read?${q({ root, path })}`);

/** The bytes, fetched WITH the token and DOWNLOADED — never rendered.
 *
 *  `/api/v1/files/raw` sits behind the same bearer-token middleware as every
 *  other route, and an `<a href>` cannot carry an Authorization header — so
 *  the obvious plain link 401s for anyone the backend does not already trust
 *  by socket. `downloadAttachment` in src/api.ts documents the same trap.
 *
 *  It downloads rather than opens, and rebuilds the blob with an inert type,
 *  because a blob URL inherits THIS page's origin: an .html dropped in
 *  Workspace, opened in a tab, would run its script against the origin
 *  holding `nova.token` in localStorage. The server pins
 *  application/octet-stream too — this is the second of the two, since the
 *  blob path never sees Content-Disposition. */
export async function openRaw(root: string, path: string): Promise<void> {
  const token = getAuthToken();
  const r = await fetch(`${API_URL}/api/v1/files/raw?${q({ root, path })}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (r.status === 401) window.dispatchEvent(new Event('nova:unauthorized'));
  if (!r.ok) throw new Error(`Could not fetch that file (${r.status}).`);
  const blob = new Blob([await r.blob()], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = path.split('/').pop() || 'download';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export const writeFile = (
  root: string, path: string, content: string,
  opts?: { links: 'retarget' | 'unlink'; confirm_plan: string },
) =>
  call<{ ok: true; bytes: number; mtime: number; links?: LinkReceipt }>(
    '/api/v1/files/content', {
      method: 'PUT', body: JSON.stringify({ root, path, content, ...opts }),
    });

export const newFile = (root: string, path: string) =>
  call<{ ok: true; path: string }>('/api/v1/files/new-file', {
    method: 'POST', body: JSON.stringify({ root, path }),
  });

export const newFolder = (root: string, path: string) =>
  call<{ ok: true; path: string }>('/api/v1/files/new-folder', {
    method: 'POST', body: JSON.stringify({ root, path }),
  });

export const renameEntry = (root: string, path: string, to: string) =>
  call<{ ok: true; path: string }>('/api/v1/files/rename', {
    method: 'POST', body: JSON.stringify({ root, path, to }),
  });

export const deleteEntry = (root: string, path: string, recursive = false) =>
  call<{ ok: true }>(`/api/v1/files/item?${q({ root, path, recursive })}`, {
    method: 'DELETE',
  });
