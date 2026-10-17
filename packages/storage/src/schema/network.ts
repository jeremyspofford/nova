// M6.5 network tables (migration 0029_network.sql; FR-135, FR-139, docs/22 §2, §6, §9). SQL
// migrations are authoritative; test/schema.test.ts checks them. Wakes stay in wake_request (0024).
import { index, sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { account } from './core.ts';

const TRANSPORTS = ['lan', 'mesh', 'relay', 'direct'] as const;

/** One reachability probe of one of the Hub's candidate endpoints; kept 7 days. */
export const networkEndpointCheck = sqliteTable(
  'network_endpoint_check',
  {
    id: text('id').primaryKey(),
    transport: text('transport', { enum: TRANSPORTS }).notNull(),
    url: text('url').notNull(),
    health: text('health', { enum: ['ok', 'failing'] }).notNull(),
    latencyMs: integer('latency_ms'),
    detail: text('detail'),
    checkedAt: text('checked_at').notNull(),
  },
  (t) => [
    index('idx_network_endpoint_check_url').on(t.url, t.checkedAt),
    index('idx_network_endpoint_check_at').on(t.checkedAt),
  ],
);

/** A change to what the Hub advertises (advertised, withdrawn, up, down, primary). */
export const networkTransportEvent = sqliteTable(
  'network_transport_event',
  {
    id: text('id').primaryKey(),
    kind: text('kind', {
      enum: ['advertised', 'withdrawn', 'up', 'down', 'off', 'primary'],
    }).notNull(),
    transport: text('transport', { enum: TRANSPORTS }),
    fromTransport: text('from_transport', { enum: TRANSPORTS }),
    url: text('url'),
    detail: text('detail'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_network_transport_event_at').on(t.createdAt)],
);

/** A network change and the serializable descriptor that undoes it (never a secret). */
export const networkChange = sqliteTable(
  'network_change',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').references(() => account.id),
    actor: text('actor').notNull(),
    kind: text('kind').notNull(),
    summary: text('summary').notNull(),
    undoJson: text('undo_json').notNull(),
    status: text('status', { enum: ['applied', 'rolled_back'] })
      .notNull()
      .default('applied'),
    error: text('error'),
    createdAt: text('created_at').notNull(),
    rolledBackAt: text('rolled_back_at'),
  },
  (t) => [index('idx_network_change_status').on(t.status, t.createdAt)],
);
