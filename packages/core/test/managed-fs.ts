// A stand-in for the file system the managed policy checks read (tests cannot create root-owned
// files): entries with an owner and a mode, folders implied by the files below them (root, 0755)
// unless set, and whole-path symlinks.
import type { ManagedFileInfo, ManagedFs } from '../src/managed/index.ts';

interface FakeEntry {
  uid: number;
  mode: number;
  content?: Buffer;
  dir?: boolean;
  link?: string;
}

function enoent(path: string): NodeJS.ErrnoException {
  const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  return err;
}

export class FakeFs implements ManagedFs {
  readonly entries = new Map<string, FakeEntry>();
  /** Paths whose stat fails with this code (EACCES and the like). */
  readonly failing = new Map<string, string>();

  file(path: string, content: string | object, uid = 0, mode = 0o644): this {
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    this.entries.set(path, { uid, mode, content: Buffer.from(text) });
    return this;
  }

  dir(path: string, uid = 0, mode = 0o755): this {
    this.entries.set(path, { uid, mode, dir: true });
    return this;
  }

  link(path: string, target: string): this {
    this.entries.set(path, { uid: 0, mode: 0o777, link: target });
    return this;
  }

  #resolve(path: string): string {
    let p = path;
    for (let i = 0; i < 10; i++) {
      const e = this.entries.get(p);
      if (!e?.link) return p;
      p = e.link;
    }
    return p;
  }

  stat(path: string): Promise<ManagedFileInfo> {
    const fail = this.failing.get(path);
    if (fail) {
      const err = new Error(fail) as NodeJS.ErrnoException;
      err.code = fail;
      return Promise.reject(err);
    }
    const p = this.#resolve(path);
    const e = this.entries.get(p);
    const implied =
      !e && (p === '/' || [...this.entries.keys()].some((k) => k.startsWith(`${p}/`)));
    if (!e && !implied) return Promise.reject(enoent(path));
    const entry = e ?? { uid: 0, mode: 0o755, dir: true };
    return Promise.resolve({
      uid: entry.uid,
      mode: entry.mode,
      isFile: () => !entry.dir,
      isDirectory: () => entry.dir === true,
    });
  }

  realpath(path: string): Promise<string> {
    if (this.failing.get(`realpath:${path}`)) return Promise.reject(enoent(path));
    return Promise.resolve(this.#resolve(path));
  }

  readFile(path: string): Promise<Buffer> {
    if (this.failing.get(`read:${path}`)) return Promise.reject(enoent(path));
    const e = this.entries.get(this.#resolve(path));
    if (!e?.content) return Promise.reject(enoent(path));
    return Promise.resolve(e.content);
  }
}
