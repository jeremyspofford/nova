// The capture pilot's definition (M10h; the orchestration ADR Point 6, Decision 4): Screenpipe as a
// managed native workload, deployed, supervised and versioned by Nova, under Screenpipe's own code
// signature. Nova never signs or changes its program: each platform's artifact is pinned by the
// SHA-256 of the file as its publisher released it, and the hub's signature is over the manifest that
// pins it. A Nova-built capture component comes later, under ADR-2; signing identities are the
// owner's call.
//
// In the build, every artifact is the stand-in (scripts/stand-ins/stand-in-screenpipe.js), run by
// Nova's own Node: no real Screenpipe is downloaded or installed anywhere (Hard limits).
//   ports      api 3030, Screenpipe's own
//   health     /health
//   alongside  none: the ADR allows shadow only once two copies are shown to run side by side on that
//              OS, which hasn't been checked on any; so a new version starts at the switch, and the
//              one before is kept for one step back
//   placement  preferred, by the capture-source role; never a thin client
//   permissions  screen recording and the microphone: promotion is tier 3, every time
//   egress     none: it answers on 127.0.0.1 only, and its words reach the hub by the capture data
//              path, carried by the device agent
//   secrets    none: no credential goes to a spoke in M10h (the vault broker isn't built)
import type { ProgramArtifact, ServiceDefinition } from './definition.ts';

export const SCREENPIPE = 'screenpipe';
export const SCREENPIPE_PORT = 3030;

export function screenpipeDefinition(o: { version: string; program: Record<string, ProgramArtifact>; device?: string }): ServiceDefinition {
  return {
    service: SCREENPIPE,
    version: o.version,
    artifact: { program: o.program },
    ports: [{ name: 'api', port: SCREENPIPE_PORT }],
    health: { http: '/health', every_s: 30 },
    contract_tests: [],
    alongside: 'none',
    placement: o.device ? { mode: 'pinned', device: o.device, roles: ['capture-source'] } : { mode: 'preferred', roles: ['capture-source'] },
    state: { volume: 'screenpipe' },
    secrets: [],
    egress: 'none',
    os_permissions: ['screen-recording', 'microphone'],
  };
}
