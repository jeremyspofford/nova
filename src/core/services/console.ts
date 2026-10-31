// Nova's own console as a service (docs/plans/M10-orchestration.md, Point 1): the definition the
// supervisor starts it from. Its artifact is the git tag of the release it runs ("base" is the
// commit the supervisor pinned when it started), its health is the server's own check, and it runs
// alongside on a copy of the home (`copy`): SQLite has one writer, so a new release is tried in a
// sandbox on a copy, then switched. Its deploy path is the supervisor's, unchanged (ADR-9, M7b).
import { CONSOLE, type ServiceDefinition } from './definition.ts';

export const CONSOLE_HEALTH = '/api/v1/health';

// `port`: the configured port; 0 lets it choose a free one (the server says which when ready).
export function consoleDefinition(o: { version: string; port: number }): ServiceDefinition {
  return {
    service: CONSOLE,
    version: o.version,
    artifact: { release: { tag: o.version, command: ['node', 'src/server.js'] } },
    ports: [{ name: 'console', port: o.port }],
    health: { http: CONSOLE_HEALTH, every_s: 30 },
    contract_tests: ['release-tests', 'smoke'],
    alongside: 'copy',
    placement: { mode: 'pinned', device: 'hub' },
    state: { volume: 'home' },
    secrets: [],
    egress: 'local',
    os_permissions: [],
  };
}
