// M7.5 boot (FR-143, ADR-096 D5): boot profiles tried once with a watchdog and made the default
// with approval, the Hub's watchdog, network boot (PXE/iPXE) and a fake novad for tests.
// packages/core/src/index.ts re-exports it.
export {
  BootService,
  bootRevertText,
  type BootDevice,
  type BootDeviceLink,
  type BootPowerCycleLink,
  type BootPowerCycleLookup,
  type BootServiceOptions,
  type BootSettings,
} from './service.ts';
export {
  PxeService,
  ipxeScript,
  pxeTokenHash,
  type PxeHolder,
  type PxeImageFile,
  type PxeServiceOptions,
} from './pxe.ts';
export {
  BOOT_AUTHZ_KINDS,
  BOOT_COMMIT_PATH,
  BOOT_REVERT_PATH,
  BOOT_SET_PATH,
  BOOT_STATUS_PATH,
  BOOT_WATCHDOG_EVENTS,
  bootAuthorizer,
  bootBodySha256,
  bootSetAnswerSchema,
  bootStatusView,
  bootWatchdogEventSchema,
  deviceBootStatusSchema,
  type BootAuthorizationRequest,
  type BootAuthorizer,
  type BootAuthzKind,
  type BootWatchdogEvent,
} from './protocol.ts';
export { FakeBootDevice, type FakeBootDeviceOptions } from './fake.ts';
