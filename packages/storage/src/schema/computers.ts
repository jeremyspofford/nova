// M6 computers and the egress proxy (migration 0022_computers.sql; docs/06 "agents & computers",
// docs/11, docs/12 §8, FR-080, FR-102, FR-193, ADR-063). SQL migrations are authoritative;
// test/schema.test.ts checks them. Egress scope ids are plain TEXT (runs, Code sessions, agents,
// plugins, MCP servers); credential values live in the vault, only `secret_ref` is stored.
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { agent } from './agents.ts';
import { account } from './core.ts';
import { device } from './nodes.ts';

const SCOPE_KINDS = ['run', 'session', 'agent', 'plugin', 'mcp_server'] as const;

/** A computer: an agent's own (cloud or a Hub sandbox) or a connected device (FR-080, FR-081). */
export const computer = sqliteTable(
  'computer',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    kind: text('kind', { enum: ['cloud', 'local_container', 'local_host'] }).notNull(),
    agentId: text('agent_id').references(() => agent.id, { onDelete: 'cascade' }),
    provider: text('provider'),
    baseImage: text('base_image'),
    state: text('state', { enum: ['starting', 'running', 'stopped', 'degraded', 'error'] })
      .notNull()
      .default('stopped'),
    deviceId: text('device_id').references(() => device.id),
    snapshotBlobPath: text('snapshot_blob_path'),
    specJson: text('spec_json'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    lastUsedAt: text('last_used_at'),
  },
  (t) => [index('idx_computer_account').on(t.accountId, t.createdAt)],
);

/** A copy of a computer's files under blobs/snapshots/<computer-id>/<snapshot-id>/. */
export const computerSnapshot = sqliteTable(
  'computer_snapshot',
  {
    id: text('id').primaryKey(),
    computerId: text('computer_id')
      .notNull()
      .references(() => computer.id, { onDelete: 'cascade' }),
    label: text('label'),
    blobPath: text('blob_path').notNull(),
    sizeBytes: integer('size_bytes'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_computer_snapshot').on(t.computerId, t.createdAt)],
);

/** A scope's network policy (Settings > Network); `mode` null inherits the global mode. */
export const egressScope = sqliteTable(
  'egress_scope',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    scopeKind: text('scope_kind', { enum: SCOPE_KINDS }).notNull(),
    scopeId: text('scope_id').notNull(),
    mode: text('mode', { enum: ['off', 'allowlist', 'limited'] }),
    allowJson: text('allow_json').notNull().default('[]'),
    denyJson: text('deny_json').notNull().default('[]'),
    hooksJson: text('hooks_json').notNull().default('[]'),
    allowLocalBinding: integer('allow_local_binding', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('uq_egress_scope').on(t.accountId, t.scopeKind, t.scopeId)],
);

/** A credential the proxy injects for its hosts (ADR-063); the value is in the vault. */
export const egressCredential = sqliteTable(
  'egress_credential',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    name: text('name').notNull(),
    hostsJson: text('hosts_json').notNull(),
    scheme: text('scheme', { enum: ['bearer', 'basic', 'header'] }).notNull(),
    headerName: text('header_name'),
    username: text('username'),
    scopeKind: text('scope_kind', { enum: SCOPE_KINDS }),
    scopeId: text('scope_id'),
    secretRef: text('secret_ref').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('idx_egress_credential_account').on(t.accountId, t.createdAt)],
);
