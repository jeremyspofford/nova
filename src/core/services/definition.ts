// A service definition (docs/plans/M10-orchestration.md, "The service definition"): one JSON file per
// service and version, the one format every driver reads. The supervisor driver (M10e) runs its
// `program` as a plain program; the K3s driver (M10j) will run its `image` as pods. Enabling K3s
// changes where a service runs, never what it is.
//
// How it maps to the `nova-service` chart's values (rendered by the K3s driver, M10j; nothing here
// renders them), next to what the supervisor driver does with each field:
//
//   service, version   release <service>; a Deployment per version  | one slot per version
//   artifact.image     image.repository, image.digest                | refused for now (no Docker runs)
//   artifact.program   not rendered                                  | installed and started by the supervisor
//   ports              service.ports; a stable and a preview Service | a stable port forwarded by the supervisor
//   health             readiness and liveness probes                 | the supervisor's health loop
//   contract_tests     not rendered; Nova runs them on the preview   | Nova runs them on the new port
//   placement pinned   nodeSelector nova/device=<id>                 | that device (this hub only, for now)
//   placement other    affinity, failover rule, replicas, spread     | the resolver (M10f)
//   roles, needs       nodeSelector nova/role-<role>, gpu labels     | the device record (M10f)
//   resources          requests and limits                           | refused if this machine can't fit it
//   state              a local-path volume                           | a folder under the service's own folder
//   secrets            names; the Secret made at apply, never in git | refused for now (no vault hand-off)
//   live version       live: <version>                               | where the stable port points
//   soak_s             the previous Deployment kept at 0 replicas    | the previous slot kept, stopped
//
// The command (ADR Point 6: "the command a workload starts with is part of its signed manifest,
// never an argument to a verb"): what runs is the pinned artifact and nothing else. A command is
// either the artifact itself (`<name> args…` or `./<name> args…`, `<name>` being the last segment of
// its url), or Nova's own Node with the artifact as its script (`node <name> args…`), the words
// after it being the program's own arguments. Never another program on PATH, an absolute or `../`
// path, a shell, or an interpreter option or inline code (`-e`, `--eval`, `--input-type`,
// `--require`, `--import`) before the artifact. The supervisor driver checks it again at every start:
// the file it runs is a regular file inside the version's slot whose SHA-256 is the pinned one.
//
// Ports below 1024 are refused (they need privileges and belong to the system); the ports Nova uses
// itself (the console's, the device door's) are refused by the driver, from Nova's configuration.
export const ALONGSIDE = Object.freeze(['full', 'shadow', 'copy', 'none'] as const);
export type Alongside = (typeof ALONGSIDE)[number];
export const PLACEMENT_MODES = Object.freeze(['pinned', 'preferred', 'floating'] as const);
export type PlacementMode = (typeof PLACEMENT_MODES)[number];
export const EGRESS = Object.freeze(['none', 'local', 'internet'] as const);
export const PLATFORMS = Object.freeze(['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64', 'win32-arm64'] as const);
// The console is the one service whose artifact is a git tag of Nova's own repository.
export const CONSOLE = 'nova-console';

export interface ProgramArtifact { url: string; sha256: string; command: string[] }
export interface ReleaseArtifact { tag: string; command: string[] }
export interface Artifact { image?: string; program?: Record<string, ProgramArtifact>; release?: ReleaseArtifact }
export interface Port { name: string; port: number }
export interface Placement { mode: PlacementMode; device?: string; roles?: string[]; needs?: Record<string, number>; failover?: string; replicas?: number }

export interface ServiceDefinition {
  service: string;
  version: string;
  artifact: Artifact;
  ports: Port[];
  health: { http: string; every_s: number };
  contract_tests: string[];
  alongside: Alongside;
  placement: Placement;
  resources?: { memory_mb?: number };
  state?: { volume: string; size_gb?: number } | null;
  secrets: string[];
  egress: (typeof EGRESS)[number];
  os_permissions: string[];
  // How long the previous version is kept, stopped, after a promotion. Absent: until the next one.
  soak_s?: number;
}

// What the validator may know about where a service could go. `roles` is absent for a device whose
// roles aren't known (devices get roles in M10f); only devices that have them are checked.
export interface DeviceView { id: string; platform: string; roles?: string[] }

const KEYS = new Set(['service', 'version', 'artifact', 'ports', 'health', 'contract_tests', 'alongside', 'placement', 'resources', 'state', 'secrets', 'egress', 'os_permissions', 'soak_s']);
const NAME = /^[a-z][a-z0-9-]{0,52}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PORT_NAME = /^[a-z][a-z0-9-]{0,14}$/;
const DIGEST = /^[a-z0-9][a-z0-9._\/:-]*@sha256:[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SECRET_NAME = /^secret:\/\/[A-Za-z0-9][A-Za-z0-9._\/-]{0,127}$/;
const HTTP_PATH = /^\/[A-Za-z0-9._~!$&'()*+,;=:@\/?%-]*$/;
const CONTRACT = /^http:\/[A-Za-z0-9._~!$&'()*+,;=:@\/?%-]*$/;
const CONSOLE_TESTS = new Set(['release-tests', 'smoke']);
const RESERVED = new Set(['current', 'base']);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStrs = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isInt = (v: unknown, min: number, max: number) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
const isCommand = (v: unknown) => isStrs(v) && v.length > 0 && v.every((x) => x.length > 0 && x.length < 4096 && !x.includes('\0'));
// The interpreters a program may name before its own file: Nova's own Node, and nothing else.
export const INTERPRETERS: ReadonlySet<string> = new Set(['node']);
const PROGRAM_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// The file name an artifact's url gives it, or null when it gives none Nova would install.
export function programName(url: string): string | null {
  let name: string;
  try { name = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? ''); } catch { return null; }
  return PROGRAM_NAME.test(name) && name !== 'definition.json' ? name : null;
}

// Why this command doesn't start exactly the pinned artifact, or null when it does.
export function commandProblem(command: string[], name: string): string | null {
  const isProgram = (w: string | undefined) => w === name || w === `./${name}`;
  const [first, second] = command;
  if (first !== undefined && INTERPRETERS.has(first)) {
    if (isProgram(second)) return null;
    return `With ${first}, the next word must be its own program, ${name}: no interpreter option or inline code (such as -e, --eval, --input-type, --require or --import) and no other file.`;
  }
  if (isProgram(first)) return null;
  return `Its command starts with ${JSON.stringify(first ?? '')}. A program starts as itself (${name} or ./${name}) or with Nova’s own Node (node ${name} …): never another program, a shell, an absolute path or a path out of its folder.`;
}
// macOS and Windows devices never run containers (ADR Point 6(a)): K3s agent nodes are Linux only.
export const notLinux = (platform: string) => /^(darwin|mac|ios|ipados|win)/i.test(platform);

export type Validated = { ok: true; def: ServiceDefinition } | { ok: false; problems: string[] };

// Every reason this definition can't be used, in plain words; an empty list means it can.
export function validate(input: unknown, o: { devices?: DeviceView[] } = {}): Validated {
  const p: string[] = [];
  if (!isObj(input)) return { ok: false, problems: ['A service definition is a JSON object.'] };
  const d = input;
  for (const k of Object.keys(d)) if (!KEYS.has(k)) p.push(`“${k}” isn’t part of a service definition.`);
  const name = typeof d.service === 'string' ? d.service : '';
  if (!NAME.test(name)) p.push('service is its name: lowercase letters, digits and dashes, starting with a letter, at most 53 characters.');
  const isConsole = name === CONSOLE;
  if (typeof d.version !== 'string' || !VERSION.test(d.version)) p.push('version is letters, digits, dots, dashes or underscores, at most 64 characters.');
  else if (!isConsole && RESERVED.has(d.version.toLowerCase())) p.push(`version can’t be “${d.version}”: the supervisor uses that name itself.`);

  // The artifact: an image, a program per platform, or (the console only) a release tag.
  const a = d.artifact;
  let hasImage = false;
  let hasProgram = false;
  if (!isObj(a)) p.push('artifact is an object with an image, a program, or both.');
  else {
    for (const k of Object.keys(a)) if (!['image', 'program', 'release'].includes(k)) p.push(`artifact.${k} isn’t an artifact form: use image or program.`);
    if (a.image !== undefined) {
      hasImage = true;
      if (typeof a.image !== 'string' || !DIGEST.test(a.image)) p.push('artifact.image is pinned by its digest: <repository>@sha256:<64 hex digits>.');
    }
    if (a.program !== undefined) {
      hasProgram = true;
      if (!isObj(a.program) || !Object.keys(a.program).length) p.push('artifact.program has one entry per platform, such as linux-x64.');
      else {
        for (const [plat, prog] of Object.entries(a.program)) {
          if (!(PLATFORMS as readonly string[]).includes(plat)) { p.push(`artifact.program.${plat} isn’t a platform Nova knows (${PLATFORMS.join(', ')}).`); continue; }
          if (!isObj(prog)) { p.push(`artifact.program.${plat} is {url, sha256, command}.`); continue; }
          if (typeof prog.url !== 'string' || !/^(file|https):\/\/\S+$/.test(prog.url)) p.push(`artifact.program.${plat}.url is a file: or https: address.`);
          if (typeof prog.sha256 !== 'string' || !SHA256.test(prog.sha256)) p.push(`artifact.program.${plat}.sha256 is the file’s SHA-256, 64 lowercase hex digits.`);
          const name = typeof prog.url === 'string' ? programName(prog.url) : null;
          if (typeof prog.url === 'string' && !name) p.push(`artifact.program.${plat}.url must end in the program’s file name (letters, digits, dots, dashes or underscores; not definition.json).`);
          if (!isCommand(prog.command)) p.push(`artifact.program.${plat}.command is the command that starts it, as a list of words (never one shell string).`);
          else if (name) { const why = commandProblem(prog.command as string[], name); if (why) p.push(`artifact.program.${plat}.command: ${why}`); }
          for (const k of Object.keys(prog)) if (!['url', 'sha256', 'command'].includes(k)) p.push(`artifact.program.${plat}.${k} isn’t part of a program.`);
        }
      }
    }
    if (a.release !== undefined) {
      if (!isConsole) p.push('Only Nova’s own console runs from a release tag of Nova’s repository; a service brings an image or a program.');
      else if (!isObj(a.release) || typeof a.release.tag !== 'string' || !VERSION.test(a.release.tag) || !isCommand(a.release.command)) p.push('artifact.release is {tag, command}.');
    } else if (!hasImage && !hasProgram) p.push('artifact needs an image or a program: there is nothing to run.');
  }

  // Ports: named, unique, on this machine's range.
  if (!Array.isArray(d.ports)) p.push('ports is a list of {name, port}.');
  else {
    const names = new Set<string>();
    const nums = new Set<number>();
    for (const [i, port] of d.ports.entries()) {
      if (!isObj(port) || typeof port.name !== 'string' || !PORT_NAME.test(port.name)) { p.push(`ports[${i}].name is lowercase letters, digits and dashes, at most 15 characters.`); continue; }
      // The console alone may say 0: the configured port, or a free one it names when it starts.
      if (!isInt(port.port, isConsole ? 0 : 1024, 65_535)) p.push(`ports[${i}].port (${port.name}) is a port number from 1024 to 65535: lower ones need privileges and belong to the system.`);
      if (names.has(port.name)) p.push(`Two ports are named ${port.name}.`);
      if (nums.has(port.port as number)) p.push(`Port ${port.port} is listed twice.`);
      names.add(port.name);
      nums.add(port.port as number);
    }
  }

  const h = d.health;
  if (!isObj(h) || typeof h.http !== 'string' || !HTTP_PATH.test(h.http) || !isInt(h.every_s, 1, 3600)) p.push('health is {http: "/path", every_s: 1 to 3600}: a GET on the service’s first port that answers 2xx when it is healthy.');
  else if (!Array.isArray(d.ports) || !d.ports.length) p.push('A health check needs a port to check: ports is empty.');

  if (!isStrs(d.contract_tests)) p.push('contract_tests is a list (it may be empty).');
  else for (const t of d.contract_tests) {
    if (CONTRACT.test(t)) continue;
    if (isConsole && CONSOLE_TESTS.has(t)) continue;
    if (t.startsWith('probe:')) p.push(`The contract test “${t}” names a probe, and Nova has no named probes for services yet: use http:/<path>, a GET that must answer 2xx.`);
    else p.push(`The contract test “${t}” isn’t one Nova can run: use http:/<path>, a GET that must answer 2xx.`);
  }

  if (!(ALONGSIDE as readonly string[]).includes(d.alongside as string)) p.push(`alongside is how a new version runs next to the old one: ${ALONGSIDE.join(', ')}.`);
  if (!(EGRESS as readonly string[]).includes(d.egress as string)) p.push(`egress is ${EGRESS.join(', ')}.`);
  if (!isStrs(d.os_permissions)) p.push('os_permissions is a list (it may be empty).');
  if (d.soak_s !== undefined && !isInt(d.soak_s, 0, 30 * 86_400)) p.push('soak_s is a whole number of seconds, at most 30 days.');
  if (d.resources !== undefined && (!isObj(d.resources) || (d.resources.memory_mb !== undefined && !isInt(d.resources.memory_mb, 1, 1_048_576)) || Object.keys(d.resources).some((k) => k !== 'memory_mb'))) p.push('resources is {memory_mb}.');
  const hasState = d.state !== undefined && d.state !== null;
  if (hasState && (!isObj(d.state) || typeof d.state.volume !== 'string' || !NAME.test(d.state.volume) || (d.state.size_gb !== undefined && !isInt(d.state.size_gb, 1, 100_000)))) p.push('state is {volume, size_gb}: the volume named like a service.');

  // Secrets are names only: a value here would be written to the services repository and the logs.
  if (!isStrs(d.secrets)) p.push('secrets is a list of secret:// names (it may be empty).');
  else for (const s of d.secrets) if (!SECRET_NAME.test(s)) p.push('A secret is written as its value, not as a secret:// name. A definition holds names only; values stay in the vault.');

  // Placement.
  const pl = d.placement;
  if (!isObj(pl) || !(PLACEMENT_MODES as readonly string[]).includes(pl.mode as string)) p.push(`placement.mode is ${PLACEMENT_MODES.join(', ')}.`);
  else {
    if (pl.mode === 'pinned' && (typeof pl.device !== 'string' || !pl.device)) p.push('A pinned service names its device: placement.device.');
    if (pl.mode !== 'pinned' && pl.device !== undefined) p.push('Only a pinned service names one device; use roles for the others.');
    if (pl.roles !== undefined && (!isStrs(pl.roles) || !pl.roles.length)) p.push('placement.roles is a list of roles.');
    if (pl.needs !== undefined && (!isObj(pl.needs) || Object.values(pl.needs).some((v) => typeof v !== 'number' || v < 0))) p.push('placement.needs is numbers, such as {gpu_vram_gb: 8}.');
    if (pl.replicas !== undefined && (pl.mode !== 'floating' || !isInt(pl.replicas, 1, 64))) p.push('Only a floating service has replicas: 1 to 64.');
    if (pl.failover !== undefined && (typeof pl.failover !== 'string' || !pl.failover)) p.push('placement.failover is a device or “any”.');
    // A floating service runs on whichever device is healthy: its state would be left behind.
    if (pl.mode === 'floating' && hasState) p.push('A floating service can’t have state: it moves between devices, and its state would stay behind. Pin it, or prefer a device with a failover.');
    const devices = o.devices;
    if (devices) {
      const pinned = pl.mode === 'pinned' && typeof pl.device === 'string' ? devices.find((x) => x.id === pl.device) : null;
      if (pl.mode === 'pinned' && typeof pl.device === 'string' && !pinned) p.push(`There is no device ${pl.device} to pin it to.`);
      // Containers run only on Linux nodes (ADR Point 6(a)).
      if (pinned && hasImage && !hasProgram && notLinux(pinned.platform)) p.push(`It comes only as a container image, and ${pinned.id} is a ${pinned.platform} device: containers run only on Linux. Add a program for that platform, or pin it to a Linux device.`);
      const roles = isStrs(pl.roles) ? pl.roles : [];
      if (roles.length) {
        const known = (pinned ? [pinned] : devices).filter((x) => Array.isArray(x.roles));
        if (known.length && !known.some((x) => roles.every((r) => x.roles!.includes(r)))) p.push(`No device${pinned ? ` (${pinned.id} included)` : ''} has the roles it asks for (${roles.join(', ')}), so there is nowhere it may run.`);
      }
    }
  }
  return p.length ? { ok: false, problems: [...new Set(p)] } : { ok: true, def: d as unknown as ServiceDefinition };
}

// Who must agree before a version takes traffic (the ADR's tier table): the console, anything with
// secrets or OS permissions (capture) is tier 3, every time; any other service is tier 2.
export function promotionTier(def: ServiceDefinition): 2 | 3 {
  return def.service === CONSOLE || def.secrets.length > 0 || def.os_permissions.length > 0 ? 3 : 2;
}

// This machine's platform key, as a definition names it.
export function platformKey(platform: string = process.platform, arch: string = process.arch): string {
  return `${platform}-${arch}`;
}
