// Policy engine, approvals, rules, grants and permission profiles (FR-048, FR-099, FR-100,
// FR-189, FR-190, FR-191). Filled in by M3.
import { allowAllGate, type AuditSink, type Notifier } from '@nova/core';
import type { HubContext, PolicyArea } from './hub-context.ts';

export function setupPolicy(
  _ctx: HubContext & { audit: AuditSink; notifier: Notifier },
): Promise<PolicyArea> {
  return Promise.resolve({
    gate: allowAllGate,
    register: () => undefined,
    close: () => Promise.resolve(),
  });
}
