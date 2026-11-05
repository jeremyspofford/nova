// The workspace: the folder in Nova's home where work products land. The local workspace
// worker writes here; the verifier reads here on its own to check what the worker claimed.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { CoreError } from './errors.ts';
import { reportOf, type Brief, type Report } from './envelope.ts';
import type { Worker } from './workers.ts';

export const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// Written whole beside the file, then moved into place, so a crash never leaves half of it; the pid
// in the temporary name keeps two processes writing the same file apart.
export function writeAtomic(path: string, data: string | Buffer, mode = 0o600): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode });
  renameSync(tmp, path);
}
export const writeJson = (path: string, v: unknown, mode = 0o600): void => writeAtomic(path, `${JSON.stringify(v, null, 2)}\n`, mode);

export class Workspace {
  readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
  }

  // `notes/x.md` or `workspace:notes/x.md` → an absolute path that is inside the workspace,
  // checked on the real path too, so a symlink inside the workspace can't lead out of it.
  resolve(target: string): string {
    const rel = target.replace(/^workspace:/, '');
    const abs = resolve(this.root, rel);
    if (!rel || abs === this.root || !abs.startsWith(this.root + sep)) throw new CoreError('forbidden', `${target} is outside the workspace.`);
    let existing = abs;
    while (!existsSync(existing)) existing = dirname(existing);
    const real = realpathSync(existing);
    const root = realpathSync(this.root);
    if (real !== root && !real.startsWith(root + sep)) throw new CoreError('forbidden', `${target} leads outside the workspace.`);
    return abs;
  }

  target(abs: string): string {
    return `workspace:${relative(this.root, abs).split(sep).join('/')}`;
  }

  read(target: string): Buffer | null {
    const abs = this.resolve(target);
    return existsSync(abs) ? readFileSync(abs) : null;
  }
}

interface WriteInputs { action: 'write' | 'append'; path: string; content: string }

function inputsOf(brief: Brief): WriteInputs {
  const i = brief.inputs ?? {};
  if (!['write', 'append'].includes(i.action as string) || typeof i.path !== 'string' || typeof i.content !== 'string') {
    throw new CoreError('validation', 'The workspace worker needs inputs {action: "write" | "append", path, content}.');
  }
  return i as unknown as WriteInputs;
}

// A deterministic local worker: writes or appends one file in the workspace, then reads it back
// and reports what is there. No model, no network, so it serves local-only tasks offline.
// A brief is applied once per idempotency key, so a retry or a restart never appends twice; the
// journal of applied keys lives in `stateDir`, outside the workspace.
export function workspaceWorker(ws: Workspace, stateDir = join(ws.root, '..', 'workers', 'workspace')): Worker {
  const applied = (key: string) => join(stateDir, `${sha256(key)}.done`);
  return {
    id: 'workspace',
    name: 'Workspace files',
    about: 'Writes or appends a file in the workspace and reads it back.',
    egress: 'none',
    evidence: ['read_back'],
    health: () => (existsSync(ws.root) ? { ok: true } : { ok: false, detail: `The workspace folder ${ws.root} is missing.` }),
    async run(brief: Brief, signal: AbortSignal): Promise<Report> {
      const started = performance.now();
      let inputs: WriteInputs;
      let abs: string;
      try {
        inputs = inputsOf(brief);
        abs = ws.resolve(inputs.path);
      } catch (e) {
        return reportOf(brief.task_id, 'blocked', (e as Error).message, { blockers: [(e as Error).message], usage: { duration_ms: performance.now() - started } });
      }
      signal.throwIfAborted();
      const already = existsSync(applied(brief.idempotency_key));
      if (!already) {
        mkdirSync(dirname(abs), { recursive: true });
        if (inputs.action === 'append') appendFileSync(abs, inputs.content);
        else writeFileSync(abs, inputs.content);
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(applied(brief.idempotency_key), new Date().toISOString());
      }
      const back = readFileSync(abs);
      const target = ws.target(abs);
      const rel = target.slice('workspace:'.length);
      return reportOf(brief.task_id, 'done', already ? `${rel} was already done (${back.length} bytes); not repeated.` : `${inputs.action === 'append' ? 'Added to' : 'Wrote'} ${rel} (${back.length} bytes).`, {
        evidence: [{ kind: 'read_back', target, sha256: sha256(back), bytes: back.length }],
        artifacts: [{ kind: 'file', ref: target, sha256: sha256(back) }],
        usage: { duration_ms: performance.now() - started },
      });
    },
  };
}
