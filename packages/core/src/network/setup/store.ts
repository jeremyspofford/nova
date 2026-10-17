// Network Setup persistence (migration 0030_network_setup): runs, steps, snapshots and consents,
// through raw statements. Nothing here holds a secret (refs only; see the migration).
import { uuidv7 } from '@nova/shared';
import type {
  MeshProvider,
  NetworkSetupCheckView,
  NetworkSetupConsentView,
  NetworkSetupRunStatus,
  NetworkSetupStepKind,
  NetworkSetupStepProvider,
  NetworkSetupStepStatus,
  NetworkSetupTransport,
} from '@nova/shared';
import type { NovaDatabase } from '@nova/storage';
import type { MeshCommand } from '../mesh/runner.ts';
import type { JsonObject, MeshStep, MeshStepPlan } from '../mesh/types.ts';

export interface SetupRunRecord {
  id: string;
  accountId: string;
  provider: MeshProvider;
  status: NetworkSetupRunStatus;
  options: JsonObject;
  outputs: Record<string, string>;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SetupStepRecord extends MeshStep {
  accountId: string;
  status: NetworkSetupStepStatus;
  checks: NetworkSetupCheckView[];
  error: string | null;
  autoRolledBack: boolean;
  changeRef: string | null;
  appliedAt: string | null;
  verifiedAt: string | null;
  rolledBackAt: string | null;
}

export interface SetupSnapshotRecord {
  id: string;
  data: JsonObject;
  undo: MeshCommand[];
  createdAt: string;
}

interface RunRow {
  id: string;
  account_id: string;
  provider: string;
  status: string;
  options_json: string;
  outputs_json: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface StepRow {
  id: string;
  run_id: string;
  account_id: string;
  idx: number;
  kind: string;
  provider: string;
  mode: string;
  title: string;
  description: string;
  commands_json: string;
  params_json: string;
  affects_json: string;
  undo_affects_json: string;
  expects_json: string;
  system_change: number;
  status: string;
  checks_json: string;
  error: string | null;
  auto_rolled_back: number;
  change_ref: string | null;
  applied_at: string | null;
  verified_at: string | null;
  rolled_back_at: string | null;
}

const json = <T>(text: string, fallback: T): T => {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

function runOf(r: RunRow): SetupRunRecord {
  return {
    id: r.id,
    accountId: r.account_id,
    provider: r.provider as MeshProvider,
    status: r.status as NetworkSetupRunStatus,
    options: json(r.options_json, {}),
    outputs: json(r.outputs_json, {}),
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function stepOf(r: StepRow): SetupStepRecord {
  return {
    id: r.id,
    runId: r.run_id,
    accountId: r.account_id,
    index: r.idx,
    kind: r.kind as NetworkSetupStepKind,
    provider: r.provider as NetworkSetupStepProvider,
    mode: r.mode as MeshStepPlan['mode'],
    title: r.title,
    description: r.description,
    commands: json(r.commands_json, []),
    params: json(r.params_json, {}),
    affects: json<NetworkSetupTransport[]>(r.affects_json, []),
    undoAffects: json<NetworkSetupTransport[]>(r.undo_affects_json, []),
    expects: json<NetworkSetupTransport[]>(r.expects_json, []),
    systemChange: r.system_change === 1,
    status: r.status as NetworkSetupStepStatus,
    checks: json(r.checks_json, []),
    error: r.error,
    autoRolledBack: r.auto_rolled_back === 1,
    changeRef: r.change_ref,
    appliedAt: r.applied_at,
    verifiedAt: r.verified_at,
    rolledBackAt: r.rolled_back_at,
  };
}

/** A plan step's first status: changes and checks wait; the rest are settled at once. */
function initialStatus(mode: MeshStepPlan['mode']): NetworkSetupStepStatus {
  return mode === 'manual' ? 'manual' : mode === 'skip' ? 'skipped' : 'pending';
}

export class SetupStore {
  readonly #db: NovaDatabase;
  readonly #now: () => Date;

  constructor(db: NovaDatabase, now: () => Date) {
    this.#db = db;
    this.#now = now;
  }

  async createRun(input: {
    id: string;
    accountId: string;
    provider: MeshProvider;
    options: JsonObject;
    outputs: Record<string, string>;
    detection: unknown;
    steps: MeshStepPlan[];
  }): Promise<void> {
    const now = this.#now().toISOString();
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare(
          `INSERT INTO network_setup_run (id, account_id, provider, status, options_json,
             outputs_json, detection_json, error, created_at, updated_at)
           VALUES (?, ?, ?, 'planned', ?, ?, ?, NULL, ?, ?)`,
        )
        .run(
          input.id,
          input.accountId,
          input.provider,
          JSON.stringify(input.options),
          JSON.stringify(input.outputs),
          JSON.stringify(input.detection),
          now,
          now,
        );
      const ins = this.#db.raw.prepare(
        `INSERT INTO network_setup_step (id, run_id, account_id, idx, kind, provider, mode, title,
           description, commands_json, params_json, affects_json, undo_affects_json, expects_json,
           system_change, status, checks_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
      );
      for (const [i, s] of input.steps.entries()) {
        ins.run(
          uuidv7(),
          input.id,
          input.accountId,
          i,
          s.kind,
          s.provider,
          s.mode,
          s.title,
          s.description,
          JSON.stringify(s.commands),
          JSON.stringify(s.params),
          JSON.stringify(s.affects),
          JSON.stringify(s.undoAffects),
          JSON.stringify(s.expects),
          s.systemChange ? 1 : 0,
          initialStatus(s.mode),
          now,
          now,
        );
      }
    });
  }

  run(accountId: string, id: string): SetupRunRecord | null {
    const r = this.#db.raw
      .prepare('SELECT * FROM network_setup_run WHERE id = ? AND account_id = ?')
      .get(id, accountId) as RunRow | undefined;
    return r ? runOf(r) : null;
  }

  runs(accountId: string, limit = 50): SetupRunRecord[] {
    const rows = this.#db.raw
      .prepare(
        'SELECT * FROM network_setup_run WHERE account_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
      )
      .all(accountId, limit) as unknown as RunRow[];
    return rows.map(runOf);
  }

  steps(runId: string): SetupStepRecord[] {
    const rows = this.#db.raw
      .prepare('SELECT * FROM network_setup_step WHERE run_id = ? ORDER BY idx')
      .all(runId) as unknown as StepRow[];
    return rows.map(stepOf);
  }

  /** One step by id (the change log's undo handler). */
  stepById(stepId: string): SetupStepRecord | null {
    const r = this.#db.raw.prepare('SELECT * FROM network_setup_step WHERE id = ?').get(stepId) as
      StepRow | undefined;
    return r ? stepOf(r) : null;
  }

  async updateStep(
    id: string,
    patch: Partial<
      Pick<
        SetupStepRecord,
        | 'status'
        | 'checks'
        | 'error'
        | 'autoRolledBack'
        | 'changeRef'
        | 'appliedAt'
        | 'verifiedAt'
        | 'rolledBackAt'
      >
    >,
  ): Promise<void> {
    const cols: string[] = [];
    const vals: (string | number | null)[] = [];
    const set = (col: string, v: string | number | null) => {
      cols.push(`${col} = ?`);
      vals.push(v);
    };
    if (patch.status !== undefined) set('status', patch.status);
    if (patch.checks !== undefined) set('checks_json', JSON.stringify(patch.checks));
    if (patch.error !== undefined) set('error', patch.error);
    if (patch.autoRolledBack !== undefined) set('auto_rolled_back', patch.autoRolledBack ? 1 : 0);
    if (patch.changeRef !== undefined) set('change_ref', patch.changeRef);
    if (patch.appliedAt !== undefined) set('applied_at', patch.appliedAt);
    if (patch.verifiedAt !== undefined) set('verified_at', patch.verifiedAt);
    if (patch.rolledBackAt !== undefined) set('rolled_back_at', patch.rolledBackAt);
    set('updated_at', this.#now().toISOString());
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare(`UPDATE network_setup_step SET ${cols.join(', ')} WHERE id = ?`)
        .run(...vals, id);
    });
  }

  async updateRun(
    id: string,
    patch: {
      status?: NetworkSetupRunStatus;
      error?: string | null;
      outputs?: Record<string, string>;
    },
  ): Promise<void> {
    const cols: string[] = ['updated_at = ?'];
    const vals: (string | null)[] = [this.#now().toISOString()];
    if (patch.status !== undefined) {
      cols.push('status = ?');
      vals.push(patch.status);
    }
    if (patch.error !== undefined) {
      cols.push('error = ?');
      vals.push(patch.error);
    }
    if (patch.outputs !== undefined) {
      cols.push('outputs_json = ?');
      vals.push(JSON.stringify(patch.outputs));
    }
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare(`UPDATE network_setup_run SET ${cols.join(', ')} WHERE id = ?`)
        .run(...vals, id);
    });
  }

  async saveSnapshot(
    step: SetupStepRecord,
    data: JsonObject,
    undo: MeshCommand[],
  ): Promise<string> {
    const id = uuidv7();
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare(
          `INSERT INTO network_setup_snapshot (id, step_id, run_id, account_id, data_json, undo_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          step.id,
          step.runId,
          step.accountId,
          JSON.stringify(data),
          JSON.stringify(undo),
          this.#now().toISOString(),
        );
    });
    return id;
  }

  async updateSnapshot(id: string, data: JsonObject, undo: MeshCommand[]): Promise<void> {
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare('UPDATE network_setup_snapshot SET data_json = ?, undo_json = ? WHERE id = ?')
        .run(JSON.stringify(data), JSON.stringify(undo), id);
    });
  }

  /** The step's latest snapshot. */
  snapshot(stepId: string): SetupSnapshotRecord | null {
    const r = this.#db.raw
      .prepare(
        `SELECT id, data_json, undo_json, created_at FROM network_setup_snapshot
         WHERE step_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(stepId) as
      { id: string; data_json: string; undo_json: string; created_at: string } | undefined;
    return r
      ? {
          id: r.id,
          data: json(r.data_json, {}),
          undo: json(r.undo_json, []),
          createdAt: r.created_at,
        }
      : null;
  }

  // ---- consents --------------------------------------------------------------------------------

  consent(accountId: string, kind: string, provider: string): NetworkSetupConsentView | null {
    const r = this.#db.raw
      .prepare(
        `SELECT id, kind, provider, description, granted_at FROM network_setup_consent
         WHERE account_id = ? AND kind = ? AND provider = ? AND revoked_at IS NULL`,
      )
      .get(accountId, kind, provider) as ConsentRow | undefined;
    return r ? consentOf(r) : null;
  }

  consents(accountId: string): NetworkSetupConsentView[] {
    const rows = this.#db.raw
      .prepare(
        `SELECT id, kind, provider, description, granted_at FROM network_setup_consent
         WHERE account_id = ? AND revoked_at IS NULL ORDER BY granted_at, id`,
      )
      .all(accountId) as unknown as ConsentRow[];
    return rows.map(consentOf);
  }

  async grantConsent(
    accountId: string,
    kind: string,
    provider: string,
    description: string,
  ): Promise<NetworkSetupConsentView> {
    const id = uuidv7();
    const now = this.#now().toISOString();
    // One consent per kind and provider: a new description replaces the old one.
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare(
          `UPDATE network_setup_consent SET revoked_at = ?
           WHERE account_id = ? AND kind = ? AND provider = ? AND revoked_at IS NULL`,
        )
        .run(now, accountId, kind, provider);
      this.#db.raw
        .prepare(
          `INSERT INTO network_setup_consent (id, account_id, kind, provider, description, granted_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, accountId, kind, provider, description, now);
    });
    return this.consent(accountId, kind, provider)!;
  }

  async revokeConsent(accountId: string, id: string): Promise<NetworkSetupConsentView | null> {
    const row = this.#db.raw
      .prepare(
        `SELECT id, kind, provider, description, granted_at FROM network_setup_consent
         WHERE id = ? AND account_id = ? AND revoked_at IS NULL`,
      )
      .get(id, accountId) as ConsentRow | undefined;
    if (!row) return null;
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare('UPDATE network_setup_consent SET revoked_at = ? WHERE id = ?')
        .run(this.#now().toISOString(), id);
    });
    return consentOf(row);
  }
}

interface ConsentRow {
  id: string;
  kind: string;
  provider: string;
  description: string;
  granted_at: string;
}

function consentOf(r: ConsentRow): NetworkSetupConsentView {
  return {
    id: r.id,
    kind: r.kind as NetworkSetupStepKind,
    provider: r.provider as NetworkSetupStepProvider,
    description: r.description,
    grantedAt: r.granted_at,
  };
}
