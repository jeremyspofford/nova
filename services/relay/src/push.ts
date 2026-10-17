// Push wake-ups for mobile clients (FR-137, docs/22 §3.2): when a frame waits for a client route
// that is not connected and has a push registration, the Relay sends a content-free wake-up (the
// route id only; it cannot see more). Real APNs and FCM adapters arrive in M7; until then the
// Relay takes a `PushSender` and ships a recording mock.

export interface PushMessage {
  platform: 'apns' | 'fcm';
  token: string;
  topic: string | null;
  /** Always `wake`: the Relay knows nothing else to say. */
  kind: 'wake';
  routeId: string;
}

export interface PushSender {
  readonly name: string;
  send(msg: PushMessage): Promise<void>;
}

/** Records wake-ups instead of sending them (tests, and the default until M7). */
export class MockPushSender implements PushSender {
  readonly name = 'mock';
  readonly sent: PushMessage[] = [];
  send(msg: PushMessage): Promise<void> {
    this.sent.push(msg);
    return Promise.resolve();
  }
}
