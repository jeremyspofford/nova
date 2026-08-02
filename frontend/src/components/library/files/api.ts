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
  /** documents only */
  count?: number; id?: string; mime?: string; present?: boolean;
  text_source?: string;
};

export type FileRead = {
  kind: 'text' | 'binary' | 'document';
  name: string; bytes: number; text: string;
  mtime?: number; editable: boolean; reason?: string;
  indexed?: boolean | null;
  mime?: string; text_source?: string; text_error?: string; id?: string;
};

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
      if (typeof body?.detail === 'string' && body.detail.trim()) detail = body.detail;
    } catch { /* not JSON — keep the status line */ }
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

/** The bytes, fetched WITH the token and handed to the browser as a blob.
 *
 *  `/api/v1/files/raw` sits behind the same bearer-token middleware as every
 *  other route, and an `<a href>` cannot carry an Authorization header — so
 *  the obvious plain link 401s for anyone the backend does not already trust
 *  by socket, which is every path except a browser on this host.
 *  `downloadAttachment` in src/api.ts documents the same trap. */
export async function openRaw(root: string, path: string): Promise<void> {
  const token = getAuthToken();
  const r = await fetch(`${API_URL}/api/v1/files/raw?${q({ root, path })}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (r.status === 401) window.dispatchEvent(new Event('nova:unauthorized'));
  if (!r.ok) throw new Error(`Could not fetch that file (${r.status}).`);
  const url = URL.createObjectURL(await r.blob());
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export const writeFile = (root: string, path: string, content: string) =>
  call<{ ok: true; bytes: number; mtime: number }>('/api/v1/files/content', {
    method: 'PUT', body: JSON.stringify({ root, path, content }),
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
