// Persisted event log plus live delivery (contracts/events.md). Persisted events are written to
// the `event` table before they are published, so a reconnecting client can replay them.
import { and, asc, gt, sql, type SQL } from 'drizzle-orm';
import { EventBus, makeEvent, type EventEnvelope, type NewEvent } from '@nova/shared';
import { schema, type NovaDatabase } from '@nova/storage';

const { event } = schema;

export class EventStore {
  readonly bus: EventBus;
  readonly #db: NovaDatabase;

  constructor(db: NovaDatabase, bus = new EventBus()) {
    this.#db = db;
    this.bus = bus;
  }

  /** Persist and publish. */
  async emit<P extends Record<string, unknown>>(e: NewEvent<P>): Promise<EventEnvelope<P>> {
    const env = makeEvent(e);
    // Serialized with other writers so the insert never joins someone else's open transaction.
    await this.#db.transaction(() =>
      this.#db.orm.insert(event).values({
        id: env.id,
        name: env.name,
        schemaVersion: env.schemaVersion,
        ts: env.ts,
        accountId: env.accountId ?? null,
        actor: env.actor,
        correlationJson: env.correlation ? JSON.stringify(env.correlation) : null,
        payloadJson: JSON.stringify(env.payload),
      }),
    );
    this.bus.publish(env);
    return env;
  }

  /** Publish without persisting (token deltas, progress). */
  emitEphemeral<P extends Record<string, unknown>>(e: NewEvent<P>): EventEnvelope<P> {
    const env = makeEvent(e);
    this.bus.publish(env);
    return env;
  }

  /**
   * Persisted events after `afterId` (UUIDv7 ids sort by time), oldest first; optionally only
   * those correlated with one thread.
   */
  async since(
    afterId: string | null,
    limit = 500,
    filter: { threadId?: string; accountId?: string; systemEvents?: boolean } = {},
  ): Promise<EventEnvelope[]> {
    const where: SQL[] = [];
    if (afterId) where.push(gt(event.id, afterId));
    // One account's events, and account-less system events unless `systemEvents` is false (they
    // are the Hub owner's: network, Relay and endpoint changes; decision 5).
    if (filter.accountId)
      where.push(
        filter.systemEvents === false
          ? sql`${event.accountId} = ${filter.accountId}`
          : sql`(${event.accountId} IS NULL OR ${event.accountId} = ${filter.accountId})`,
      );
    if (filter.threadId)
      where.push(sql`json_extract(${event.correlationJson}, '$.threadId') = ${filter.threadId}`);
    const rows = await this.#db.orm
      .select()
      .from(event)
      .where(where.length ? and(...where) : undefined)
      .orderBy(asc(event.id))
      .limit(limit);
    return rows.map((r) => {
      const env: EventEnvelope = {
        id: r.id,
        name: r.name,
        schemaVersion: r.schemaVersion,
        ts: r.ts,
        actor: r.actor,
        payload: JSON.parse(r.payloadJson) as Record<string, unknown>,
      };
      if (r.accountId) env.accountId = r.accountId;
      if (r.correlationJson)
        env.correlation = JSON.parse(r.correlationJson) as EventEnvelope['correlation'];
      return env;
    });
  }
}
