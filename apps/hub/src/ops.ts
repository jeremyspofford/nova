// Audit log, notifications, logs and diagnostics (FR-013, FR-104 partial, FR-118). Filled in by M3.
import { noopAudit, noopNotifier } from '@nova/core';
import type { HubContext, OpsArea } from './hub-context.ts';

export function setupOps(_ctx: HubContext): Promise<OpsArea> {
  return Promise.resolve({
    audit: noopAudit,
    notifier: noopNotifier,
    register: () => undefined,
    close: () => Promise.resolve(),
  });
}
