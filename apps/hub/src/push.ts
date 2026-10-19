// Push area (FR-111, FR-060, docs/13 §6, docs/22 §3.2): Web Push subscriptions for browsers and the
// PWA, the Hub's VAPID key, a test push, and the OS/push leg the channels area's router calls
// (`leg`). Native apps register their APNs/FCM tokens with the Relay themselves; the leg asks the
// Relay (`useRelay`) to push to them with ids and a redacted title only. Every route needs a
// session and validates its body; a device session's subscription is tied to its device, and a
// revoked device's subscriptions are deleted with their secrets (`device.status.changed`).
//   GET    /api/v1/push/vapid-key           the application server key to subscribe with
//   GET    /api/v1/push/subscriptions       the account's browser subscriptions (no endpoints)
//   POST   /api/v1/push/subscriptions       add or renew one (PushSubscription.toJSON())
//   DELETE /api/v1/push/subscriptions/:id   remove one
//   POST   /api/v1/push/test                push a test to each (or one)
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createPushSubscriptionSchema, idSchema, pushTestSchema } from '@nova/shared';
import {
  PushService,
  type AuditSink,
  type EncryptOptions,
  type NativePush,
  type PushLeg,
} from '@nova/core';
import { deviceScopes } from './auth.ts';
import type { HubArea, HubContext } from './hub-context.ts';

export interface PushArea extends HubArea {
  service: PushService;
  /** The OS leg for the channels area: `channels.usePush(push.leg)`. */
  leg: PushLeg;
  /** The Relay connector (`relay.hub`), for native apps; null turns that path off. */
  useRelay(relay: NativePush | null): void;
}

export interface PushDeps {
  audit?: AuditSink;
  /** Tests: the push services' HTTP, a clock, endpoints on a local fake, fixed ciphertext. */
  fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  now?: () => Date;
  endpointProblem?: (url: URL, hosts: readonly string[]) => string | null;
  encrypt?: EncryptOptions;
}

const params = z.object({ id: idSchema });

export function setupPush(ctx: HubContext, deps: PushDeps = {}): Promise<PushArea> {
  const log = ctx.log.child('push');
  const service = new PushService({
    db: ctx.db,
    secrets: ctx.secrets,
    setting: ctx.setting,
    log,
    publicUrl: () => ctx.setting('channels.publicUrl'),
    ...(deps.audit ? { audit: deps.audit } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.endpointProblem ? { endpointProblem: deps.endpointProblem } : {}),
    ...(deps.encrypt ? { encrypt: deps.encrypt } : {}),
  });

  ctx.diagnostics.add('push', () => Promise.resolve(service.counts()));
  // A device revoked anywhere (Add Device, Devices) stops getting pushes at once (docs/22 §4.5).
  const offRevoked = ctx.events.bus.subscribe('device.status.changed', (e) => {
    const deviceId = e.payload.deviceId;
    if (e.payload.status !== 'revoked' || typeof deviceId !== 'string' || !e.accountId) return;
    service
      .removeForDevice(e.accountId, deviceId)
      .catch((err: unknown) =>
        log.warn('removing a revoked device’s push subscriptions failed', { err }),
      );
  });

  function register(app: FastifyInstance): void {
    app.get('/api/v1/push/vapid-key', async (req) => {
      const accountId = await ctx.accountOf(req);
      return { publicKey: await service.vapidPublicKey(accountId) };
    });

    app.get('/api/v1/push/subscriptions', async (req) => {
      const accountId = await ctx.accountOf(req);
      return { items: service.list(accountId) };
    });

    app.post('/api/v1/push/subscriptions', async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      const body = createPushSubscriptionSchema.parse(req.body);
      const view = await service.subscribe(accountId, body, {
        deviceId: deviceScopes(req)?.deviceId ?? null,
      });
      return reply.status(201).send(view);
    });

    app.delete('/api/v1/push/subscriptions/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = params.parse(req.params);
      await service.remove(accountId, id);
      return { ok: true };
    });

    app.post('/api/v1/push/test', async (req) => {
      const accountId = await ctx.accountOf(req);
      const body = pushTestSchema.parse(req.body ?? {});
      return service.test(accountId, body.subscriptionId);
    });
  }

  return Promise.resolve({
    service,
    leg: { notify: (n) => service.notify(n) },
    useRelay: (relay) => service.useNative(relay),
    register,
    close: () => {
      offRevoked();
      return Promise.resolve();
    },
  });
}
