// Auto-verify (FR-068, docs/10 §7 and §14). After a turn of a Code session edits files, the
// project's checks run in the session's sandbox (network off): the commands set in
// `code.autoVerify` for the project, else the detected build and test commands. The result
// (pass or fail per check, with a redacted and capped log) is stored, shown in the session view
// and announced; when checks fail, their logs go back to the agent as a turn so it fixes them,
// at most `feedbackTurns` times in a row before the user's next turn. That turn carries no
// authority: the logs are tool output (FR-189). A run can also be started from the session view.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NovaError, uuidv7, type VerifyCheckView, type VerifyRunView } from '@nova/shared';
import { defaultRedactor } from '@nova/security';
import type { NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import type { SettingReader } from '../approvals/gate.ts';
import { capHeadTail } from '../tools/text.ts';
import type { SandboxClient } from '../tools/types.ts';
import type { CodeService, CodeSessionInfo, CodeTurnEndHook } from './service.ts';
import { detectTestCommand } from './tools.ts';

/** Characters of each check's log kept (head and tail). */
const LOG_CHARS = 8_000;

interface VerifyRow {
  id: string;
  sessionId: string;
  trigger: 'auto' | 'manual';
  status: VerifyRunView['status'];
  checksJson: string;
  createdAt: string;
  completedAt: string | null;
}

const VERIFY_COLUMNS = `id, session_id AS sessionId, trigger, status, checks_json AS checksJson,
  created_at AS createdAt, completed_at AS completedAt`;

export interface VerifyCommand {
  name: string;
  command: string;
}

/** The checks a folder's project offers: a build or typecheck script, then its test suite. */
export async function detectVerifyCommands(folder: string): Promise<VerifyCommand[]> {
  const out: VerifyCommand[] = [];
  try {
    const pkg = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8')) as {
      scripts?: Record<string, unknown>;
    };
    for (const name of ['typecheck', 'build'] as const) {
      if (typeof pkg.scripts?.[name] === 'string') {
        out.push({ name, command: `npm run ${name}` });
        break;
      }
    }
  } catch {
    // No package.json.
  }
  const test = await detectTestCommand(folder);
  if (test) {
    if (test.runner === 'go') out.unshift({ name: 'build', command: 'go build ./...' });
    if (test.runner === 'cargo') out.unshift({ name: 'build', command: 'cargo build' });
    out.push({ name: 'test', command: test.cmd });
  }
  return out;
}

export interface AutoVerifierOptions {
  db: NovaDatabase;
  code: CodeService;
  setting: SettingReader;
  now?: () => Date;
  log?: Logger;
}

export class AutoVerifier {
  readonly #o: AutoVerifierOptions;
  readonly #now: () => Date;
  readonly #log: Logger;
  readonly #running = new Map<string, Promise<VerifyRunView>>();
  /** Feedback turns sent in a row per session, and the ids of those turns. */
  readonly #streak = new Map<string, number>();
  readonly #feedbackTurns = new Set<string>();

  constructor(opts: AutoVerifierOptions) {
    this.#o = opts;
    this.#now = opts.now ?? (() => new Date());
    this.#log = opts.log ?? new Logger({ module: 'core.code.verify', sinks: [] });
  }

  /** The turn-end hook: verify in the background after a turn that edited files. */
  readonly onTurnEnd: CodeTurnEndHook = async (s, turn) => {
    // A turn the user (or anything but a feedback turn) started resets the streak.
    if (!this.#feedbackTurns.delete(turn.turnId)) this.#streak.delete(s.id);
    if (!turn.edited || !s.active || turn.outcome.status === 'interrupted') return;
    const cfg = await this.#o.setting('code.autoVerify', s.projectId);
    if (!cfg.enabled || this.#running.has(s.id)) return;
    const { done } = this.#start(s, 'auto', turn.turnId);
    void done.catch((err: unknown) =>
      this.#log.warn('auto-verify failed', { err, sessionId: s.id }),
    );
  };

  /** Run the checks now (the session view's Verify); `conflict` while a run is going. */
  async run(
    accountId: string,
    sessionId: string,
  ): Promise<{ view: VerifyRunView; done: Promise<VerifyRunView> }> {
    const s = this.#o.code.info(accountId, sessionId);
    if (this.#running.has(s.id))
      throw new NovaError('conflict', 'the checks are already running', {
        details: { reason: 'verify_running' },
      });
    const { id, inserted, done } = this.#start(s, 'manual', null);
    await inserted;
    return { view: this.get(accountId, sessionId, id), done };
  }

  list(accountId: string, sessionId: string, limit = 20): VerifyRunView[] {
    const s = this.#o.code.info(accountId, sessionId);
    const rows = this.#o.db.raw
      .prepare(
        `SELECT ${VERIFY_COLUMNS} FROM code_verify_run WHERE session_id = ?
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(s.id, limit) as unknown as VerifyRow[];
    return rows.map(viewOf);
  }

  get(accountId: string, sessionId: string, id: string): VerifyRunView {
    const s = this.#o.code.info(accountId, sessionId);
    const r = this.#o.db.raw
      .prepare(`SELECT ${VERIFY_COLUMNS} FROM code_verify_run WHERE id = ? AND session_id = ?`)
      .get(id, s.id) as VerifyRow | undefined;
    if (!r) throw new NovaError('not_found', 'verify run not found');
    return viewOf(r);
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.#running.values()]);
  }

  /** Reserve the session's slot at once (one run at a time), then insert and run. */
  #start(s: CodeSessionInfo, trigger: 'auto' | 'manual', turnId: string | null) {
    const id = uuidv7();
    const now = this.#iso();
    const inserted = this.#o.db.transaction(() => {
      this.#o.db.raw
        .prepare(
          `INSERT INTO code_verify_run (id, session_id, trigger, turn_id, status, checks_json,
             created_at) VALUES (?, ?, ?, ?, 'running', '[]', ?)`,
        )
        .run(id, s.id, trigger, turnId, now);
    });
    const done = inserted
      .then(() => this.#execute(s, id, trigger))
      .finally(() => this.#running.delete(s.id));
    this.#running.set(s.id, done);
    return { id, inserted, done };
  }

  async #execute(
    s: CodeSessionInfo,
    id: string,
    trigger: 'auto' | 'manual',
  ): Promise<VerifyRunView> {
    await this.#o.code.announce(s, 'code.verify.started', {
      sessionId: s.id,
      verifyId: id,
      trigger,
    });
    const cfg = await this.#o.setting('code.autoVerify', s.projectId);
    const commands: VerifyCommand[] = cfg.commands.length
      ? cfg.commands.map((c, i) => ({ name: `check ${i + 1}`, command: c }))
      : s.hubLocal
        ? await detectVerifyCommands(s.folder)
        : [];
    const sandbox: SandboxClient | null =
      this.#o.code.sandboxFor(s) ?? (s.hubLocal ? this.#o.code.hubSandbox() : null);
    const checks: VerifyCheckView[] = [];
    let status: VerifyRunView['status'];
    if (!commands.length) {
      status = 'skipped';
      checks.push(
        skipped('no checks', 'no build or test command was found; set them in code.autoVerify'),
      );
    } else if (!sandbox || !(await sandbox.available().catch(() => ({ ok: false }))).ok) {
      status = 'skipped';
      checks.push(skipped('sandbox', 'no sandbox is available to run the checks'));
    } else {
      for (const c of commands)
        checks.push(await this.#check(s, sandbox, c, cfg.timeoutSeconds, id));
      status = checks.every((c) => c.status === 'passed')
        ? 'passed'
        : checks.some((c) => c.status === 'failed' || c.status === 'timeout')
          ? 'failed'
          : 'error';
    }
    await this.#o.db.transaction(() => {
      this.#o.db.raw
        .prepare(
          'UPDATE code_verify_run SET status = ?, checks_json = ?, completed_at = ? WHERE id = ?',
        )
        .run(status, JSON.stringify(checks), this.#iso(), id);
    });
    await this.#o.code.announce(s, 'code.verify.completed', {
      sessionId: s.id,
      verifyId: id,
      trigger,
      status,
      checks: checks.map((c) => ({ name: c.name, status: c.status, exitCode: c.exitCode })),
    });
    if (trigger === 'auto' && status === 'failed')
      await this.#feedback(s, checks, cfg.feedbackTurns);
    return this.get(s.accountId, s.id, id);
  }

  async #check(
    s: CodeSessionInfo,
    sandbox: SandboxClient,
    c: VerifyCommand,
    timeoutSeconds: number,
    verifyId: string,
  ): Promise<VerifyCheckView> {
    const started = Date.now();
    const turnId = `code-verify:${verifyId}`;
    try {
      const r = await sandbox.exec({
        cmd: c.command,
        cwd: s.folder,
        roots: [{ path: s.folder, access: 'write', label: 'session folder' }],
        network: 'off',
        yieldMs: timeoutSeconds * 1000,
        signal: AbortSignal.timeout(timeoutSeconds * 1000 + 30_000),
        turnId,
      });
      const log = capHeadTail(defaultRedactor.redactString(r.output), LOG_CHARS).text;
      if (r.status === 'running') {
        await sandbox.write(r.sessionId, { signal: 'terminate' }).catch(() => undefined);
        await sandbox.killTurn(turnId).catch(() => undefined);
        return { ...c, status: 'timeout', exitCode: null, log, durationMs: Date.now() - started };
      }
      return {
        ...c,
        status: r.exitCode === 0 ? 'passed' : 'failed',
        exitCode: r.exitCode,
        log,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      return {
        ...c,
        status: 'error',
        exitCode: null,
        log: defaultRedactor.redactString(err instanceof Error ? err.message : String(err)),
        durationMs: Date.now() - started,
      };
    }
  }

  /** Send failed checks back to the agent, at most `limit` turns in a row. */
  async #feedback(s: CodeSessionInfo, checks: VerifyCheckView[], limit: number) {
    const turns = this.#o.code.turns;
    const streak = this.#streak.get(s.id) ?? 0;
    if (!turns || streak >= limit) return;
    const failed = checks.filter((c) => c.status === 'failed' || c.status === 'timeout');
    const text = [
      'Auto-verify: the project checks failed after your last edits.',
      ...failed.map(
        (c) =>
          `\n### ${c.name}: \`${c.command}\` ${c.status === 'timeout' ? 'timed out' : `exited ${c.exitCode}`}\n${c.log.slice(-4000)}`,
      ),
      '',
      'Fix the cause, then the checks run again.',
    ].join('\n');
    this.#streak.set(s.id, streak + 1);
    try {
      const started = await turns.startTurn({
        accountId: s.accountId,
        threadId: s.threadId,
        text,
        trigger: 'event',
        triggerRef: `verify:${s.id}`,
        authority: { kind: 'none', origin: 'tool' },
        authorKind: 'system',
      });
      this.#feedbackTurns.add(started.turnId);
    } catch (err) {
      this.#log.warn('sending failed checks to the agent failed', { err, sessionId: s.id });
    }
  }

  #iso(): string {
    return this.#now().toISOString();
  }
}

function skipped(name: string, why: string): VerifyCheckView {
  return { name, command: '', status: 'skipped', exitCode: null, log: why, durationMs: 0 };
}

function viewOf(r: VerifyRow): VerifyRunView {
  let checks: VerifyCheckView[];
  try {
    checks = JSON.parse(r.checksJson) as VerifyCheckView[];
  } catch {
    checks = [];
  }
  return {
    id: r.id,
    sessionId: r.sessionId,
    trigger: r.trigger,
    status: r.status,
    checks,
    createdAt: r.createdAt,
    completedAt: r.completedAt,
  };
}
