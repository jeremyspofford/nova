// M7.5 out-of-band management (migration 0042_oob.sql; FR-147, ADR-096 D6): the BMCs the owner
// registered and every action asked of them. Credentials live in the vault (`secret://oob/<id>`);
// rows hold only the reference. SQL migrations are authoritative; test/schema.test.ts checks them.
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { account } from './core.ts';
import { device } from './nodes.ts';

/** A BMC endpoint; the registry is the allowlist of addresses the Hub contacts. */
export const oobEndpoint = sqliteTable(
  'oob_endpoint',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['redfish', 'ipmi', 'amt'] }).notNull(),
    address: text('address').notNull(),
    port: integer('port'),
    systemId: text('system_id'),
    credentialRef: text('credential_ref').notNull(),
    deviceId: text('device_id').references(() => device.id, { onDelete: 'set null' }),
    /** SHA-256 of the BMC certificate's DER, lower-case hex. */
    tlsPin: text('tls_pin'),
    tlsPinnedAt: text('tls_pinned_at'),
    /** Credentials go to a Redfish BMC only after the owner confirmed its pin. */
    tlsPinConfirmedAt: text('tls_pin_confirmed_at'),
    lastCheckAt: text('last_check_at'),
    lastCheckOk: integer('last_check_ok', { mode: 'boolean' }),
    lastError: text('last_error'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('idx_oob_endpoint_account').on(t.accountId, t.createdAt),
    index('idx_oob_endpoint_device').on(t.deviceId),
  ],
);

/** One action asked of a BMC, with its approval and the values before and after. */
export const oobAction = sqliteTable(
  'oob_action',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    endpointId: text('endpoint_id').references(() => oobEndpoint.id, { onDelete: 'set null' }),
    endpointName: text('endpoint_name').notNull(),
    action: text('action').notNull(),
    paramsJson: text('params_json').notNull().default('{}'),
    paramsHash: text('params_hash').notNull(),
    status: text('status', {
      enum: [
        'awaiting_approval',
        'approved',
        'running',
        'done',
        'failed',
        'denied',
        'expired',
        'applied',
      ],
    }).notNull(),
    approvalId: text('approval_id'),
    /** `bios.apply`: the `bios.plan` action it applied. */
    planId: text('plan_id'),
    beforeJson: text('before_json'),
    afterJson: text('after_json'),
    resultJson: text('result_json'),
    errorCode: text('error_code'),
    errorReason: text('error_reason'),
    errorMessage: text('error_message'),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at'),
    decidedAt: text('decided_at'),
    finishedAt: text('finished_at'),
  },
  (t) => [
    index('idx_oob_action_endpoint').on(t.endpointId, t.createdAt),
    index('idx_oob_action_account').on(t.accountId, t.createdAt),
    index('idx_oob_action_approval').on(t.approvalId),
  ],
);
