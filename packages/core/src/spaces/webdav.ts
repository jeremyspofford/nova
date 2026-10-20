// A WebDAV hosting target for sites (FR-037, M8): a built version is uploaded into a collection on
// a static web host that speaks WebDAV (RFC 4918), with nothing but `fetch`. The files go into a
// temporary collection first and one MOVE (Overwrite: T) swaps it in, so visitors never see half a
// site; the folder carries Nova's `.nova-site` marker, and a folder without this site's marker is
// never replaced or removed. Redirects are never followed (a credential must not go elsewhere).
import { randomUUID } from 'node:crypto';
import { NovaError, type HostingProblem } from '@nova/shared';
import type { HostedFile, HostingTarget } from './hosting.ts';
import { SITE_MARKER } from './marker.ts';

export interface WebDavTargetOptions {
  /** The collection site folders go into; must end in `/`. */
  url: string;
  /** The `Authorization` header to send, or null for none (read from the vault per operation). */
  authorization: () => Promise<string | null>;
  /** The HTTP client: the egress-checked fetch (hosting.ts `egressFetch`). */
  fetch: typeof fetch;
  /** Per request; default 30 s. */
  timeoutMs?: number;
}

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  txt: 'text/plain; charset=utf-8',
  xml: 'application/xml',
  ico: 'image/x-icon',
};

export function contentTypeOf(path: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? '';
  return TYPES[ext] ?? 'application/octet-stream';
}

/** A failure of the remote target: 409 `conflict` with a HostingProblem reason (like a BMC's). */
export function targetError(
  reason: HostingProblem,
  message: string,
  extra: Record<string, unknown> = {},
): NovaError {
  return new NovaError('conflict', message, {
    details: { reason, ...extra },
    retryable: reason === 'target_unreachable' || reason === 'target_timeout',
  });
}

function folderInUse(): NovaError {
  return new NovaError(
    'conflict',
    'that folder on the hosting target holds something Nova did not publish there',
    { details: { reason: 'folder_in_use' } },
  );
}

/** Each segment encoded; `..`, empty and absolute paths never reach the target. */
function encodePath(path: string): string {
  const parts = path.split('/');
  if (parts.some((p, i) => p === '..' || p === '.' || (p === '' && i < parts.length - 1)))
    throw new NovaError('validation', `not a file path: ${path}`);
  return parts.map(encodeURIComponent).join('/');
}

async function drain(res: Response): Promise<void> {
  await res.arrayBuffer().catch(() => undefined);
}

export class WebDavTarget implements HostingTarget {
  readonly kind = 'webdav' as const;
  readonly #base: string;
  readonly #o: WebDavTargetOptions;
  readonly #timeout: number;

  constructor(opts: WebDavTargetOptions) {
    if (!opts.url.endsWith('/')) throw new NovaError('validation', 'the collection must end in /');
    this.#base = opts.url;
    this.#o = opts;
    this.#timeout = opts.timeoutMs ?? 30_000;
  }

  location(folder: string): Promise<string> {
    return Promise.resolve(this.#location(folder));
  }

  #location(folder: string): string {
    return `${this.#base}${encodePath(folder)}/`;
  }

  /** Whether the collection answers: a PROPFIND (Depth 0) on it. */
  async check(): Promise<void> {
    const res = await this.#req('PROPFIND', this.#base, { headers: { Depth: '0' } });
    await drain(res);
    if (res.status === 207 || res.ok) return;
    if (res.status === 404)
      throw targetError('target_not_found', `no collection at ${this.#base}`, {
        status: res.status,
      });
    throw this.#refused(res.status);
  }

  async claim(siteId: string, folder: string): Promise<boolean> {
    const marker = await this.#req('GET', this.#url(`${folder}/${SITE_MARKER}`));
    if (marker.ok) {
      if ((await marker.text()).trim() === siteId) return true;
      throw folderInUse();
    }
    await drain(marker);
    if (marker.status !== 404) throw this.#refused(marker.status);
    // No marker: the name must be free. Asked without the slash, so a file of that name counts too.
    const found = await this.#req('PROPFIND', this.#url(folder), { headers: { Depth: '0' } });
    await drain(found);
    if (found.status === 404) return false;
    if (found.status === 207 || found.ok) throw folderInUse();
    throw this.#refused(found.status);
  }

  async put(siteId: string, folder: string, files: readonly HostedFile[]): Promise<string> {
    await this.claim(siteId, folder);
    const tmp = `.${folder}.tmp-${randomUUID()}`;
    try {
      await this.#mkcol(`${tmp}/`);
      const dirs = new Set<string>();
      for (const f of files) {
        const parts = f.path.split('/').slice(0, -1);
        for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
      }
      for (const d of [...dirs].sort((a, b) => a.split('/').length - b.split('/').length))
        await this.#mkcol(`${tmp}/${d}/`);
      for (const f of files) await this.#put(`${tmp}/${f.path}`, f.bytes, contentTypeOf(f.path));
      await this.#put(
        `${tmp}/${SITE_MARKER}`,
        new TextEncoder().encode(`${siteId}\n`),
        'text/plain; charset=utf-8',
      );
      // One swap: the server deletes this site's old folder and moves the new one in its place.
      const res = await this.#req('MOVE', this.#url(`${tmp}/`), {
        headers: { Destination: this.#url(`${folder}/`), Overwrite: 'T' },
      });
      await drain(res);
      if (!res.ok) throw this.#refused(res.status);
    } catch (err) {
      await this.#req('DELETE', this.#url(`${tmp}/`))
        .then(drain)
        .catch(() => undefined);
      throw err;
    }
    return this.#location(folder);
  }

  async remove(siteId: string, folder: string): Promise<void> {
    const marker = await this.#req('GET', this.#url(`${folder}/${SITE_MARKER}`));
    if (!marker.ok) {
      await drain(marker);
      if (marker.status === 404) return;
      throw this.#refused(marker.status);
    }
    // Someone else's folder by now: leave it alone.
    if ((await marker.text()).trim() !== siteId) return;
    const res = await this.#req('DELETE', this.#url(`${folder}/`));
    await drain(res);
    if (!res.ok && res.status !== 404) throw this.#refused(res.status);
  }

  // ---- internals ---------------------------------------------------------------------------------

  #url(path: string): string {
    return `${this.#base}${encodePath(path)}`;
  }

  async #mkcol(path: string): Promise<void> {
    const res = await this.#req('MKCOL', this.#url(path));
    await drain(res);
    if (res.status === 409)
      throw targetError('target_not_found', `no collection at ${this.#base}`, { status: 409 });
    if (!res.ok) throw this.#refused(res.status);
  }

  async #put(path: string, bytes: Uint8Array, type: string): Promise<void> {
    const res = await this.#req('PUT', this.#url(path), {
      body: bytes,
      headers: { 'Content-Type': type },
    });
    await drain(res);
    if (!res.ok) throw this.#refused(res.status);
  }

  #refused(status: number): NovaError {
    if (status === 401 || status === 403)
      return targetError('target_auth_failed', 'the hosting target refused the credentials', {
        status,
      });
    return targetError('target_refused', `the hosting target answered ${status}`, { status });
  }

  async #req(
    method: string,
    url: string,
    init: { headers?: Record<string, string>; body?: Uint8Array } = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    const auth = await this.#o.authorization();
    if (auth) headers.set('Authorization', auth);
    let res: Response;
    try {
      res = await this.#o.fetch(url, {
        method,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.#timeout),
        ...(init.body ? { body: new Uint8Array(init.body) } : {}),
      });
    } catch (err) {
      if (err instanceof NovaError) throw err;
      const name = err instanceof Error ? err.name : '';
      if (name === 'TimeoutError' || name === 'AbortError')
        throw targetError('target_timeout', `the hosting target did not answer in time`);
      throw targetError('target_unreachable', `the hosting target could not be reached`);
    }
    if (res.status >= 300 && res.status < 400) {
      await drain(res);
      throw targetError('target_redirected', 'the hosting target answered with a redirect', {
        status: res.status,
      });
    }
    if (res.status === 401 || res.status === 403) {
      await drain(res);
      throw this.#refused(res.status);
    }
    return res;
  }
}
