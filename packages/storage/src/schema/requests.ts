// M5 server-to-client requests (0019_requests; docs/06 `server_request`, FR-188). SQL migrations
// are authoritative; test/schema.test.ts checks them. Pending approvals are listed from the
// `approval` table, so no `approval` kind row is written here by the Hub.
import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { account } from './core.ts';
import { approval } from './policy.ts';

export const serverRequest = sqliteTable(
  'server_request',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    kind: text('kind', {
      enum: ['approval', 'user_input', 'elicitation', 'client_tool', 'credential_refresh'],
    }).notNull(),
    threadId: text('thread_id'),
    turnId: text('turn_id'),
    runId: text('run_id'),
    agentId: text('agent_id'),
    callId: text('call_id'),
    approvalId: text('approval_id').references(() => approval.id),
    /** NULL: any authorized client that declared the kind; a client_tool request may name one. */
    targetDeviceId: text('target_device_id'),
    payloadJson: text('payload_json').notNull(),
    status: text('status', { enum: ['pending', 'resolved', 'expired'] })
      .notNull()
      .default('pending'),
    /** `user` or `hook:<id>`. */
    resolvedBy: text('resolved_by'),
    resolvedByDevice: text('resolved_by_device'),
    resolutionJson: text('resolution_json'),
    /** Why an expired request ended: timeout, cancelled or restart. */
    expiredReason: text('expired_reason', { enum: ['timeout', 'cancelled', 'restart'] }),
    /** When the fallback notification was sent (FR-060). */
    notifiedAt: text('notified_at'),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    resolvedAt: text('resolved_at'),
  },
  (t) => [
    index('idx_server_request_pending').on(t.accountId, t.expiresAt),
    index('idx_server_request_thread').on(t.threadId),
  ],
);
