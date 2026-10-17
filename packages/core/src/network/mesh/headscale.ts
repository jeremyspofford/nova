// The Headscale server adapter (docs/22 §2.2: the recommended self-hosted control plane): users,
// one-use pre-auth keys, the ACL policy and route approval through the `headscale` CLI (0.26
// command shapes, JSON output with `-o json`). A remote server is reached with
// HEADSCALE_CLI_ADDRESS and the API key in HEADSCALE_CLI_API_KEY (environment, never argv). A
// pre-auth key is read from stdout straight into the vault. MagicDNS is a server config file
// setting (`dns.magic_dns`) that Nova does not edit.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  MeshAclSummary,
  MeshDetectionView,
  MeshPeerView,
  NetworkSetupStepKind,
} from '@nova/shared';
import { defaultRedactor } from '@nova/security';
import { MeshCommandError, type MeshCommand, type MeshExec } from './runner.ts';
import {
  asRecord,
  asString,
  asStrings,
  check,
  emptyDetection,
  parseJson,
  runAll,
  type JsonObject,
  type MeshAdapter,
  type MeshStepHandler,
} from './types.ts';

export interface HeadscaleCli {
  /** host:port of a remote server's gRPC API; null uses the local socket. */
  cliAddress: string | null;
  apiKeyRef: string | null;
}

export const LOCAL_HEADSCALE: HeadscaleCli = { cliAddress: null, apiKeyRef: null };

export function headscaleCommand(cli: HeadscaleCli, args: string[]): MeshCommand {
  const cmd: MeshCommand = { bin: 'headscale', args, timeoutMs: 30_000 };
  if (cli.cliAddress) {
    cmd.env = { HEADSCALE_CLI_ADDRESS: cli.cliAddress };
    if (cli.apiKeyRef) cmd.env.HEADSCALE_CLI_API_KEY = { secretRef: cli.apiKeyRef };
  }
  return cmd;
}

export interface HeadscaleUser {
  id: string;
  name: string;
}

export function parseHeadscaleUsers(text: string): HeadscaleUser[] | null {
  const v = parseJson(text);
  if (!Array.isArray(v)) return null;
  return v.map((u) => {
    const r = asRecord(u);
    return { id: idOf(r.id), name: asString(r.name) ?? '' };
  });
}

// protojson prints 64-bit ids as strings; older builds print numbers.
function idOf(v: unknown): string {
  return typeof v === 'number' ? String(v) : (asString(v) ?? '');
}

export interface HeadscaleNode {
  id: string;
  name: string;
  givenName: string;
  ips: string[];
  online: boolean;
  user: string | null;
  tags: string[];
  approved: string[];
  available: string[];
}

export function parseHeadscaleNodes(text: string): HeadscaleNode[] | null {
  const v = parseJson(text);
  if (!Array.isArray(v)) return null;
  return v.map((n) => {
    const r = asRecord(n);
    return {
      id: idOf(r.id),
      name: asString(r.name) ?? '',
      givenName: asString(r.given_name) ?? asString(r.name) ?? '',
      ips: asStrings(r.ip_addresses),
      online: r.online === true,
      user: asString(asRecord(r.user).name),
      tags: [...new Set([...asStrings(r.forced_tags), ...asStrings(r.valid_tags)])],
      approved: asStrings(r.approved_routes),
      available: asStrings(r.available_routes),
    };
  });
}

async function listUsers(exec: MeshExec, cli: HeadscaleCli): Promise<HeadscaleUser[] | null> {
  const r = await exec.run(headscaleCommand(cli, ['users', 'list', '-o', 'json']));
  return r.code === 0 ? parseHeadscaleUsers(r.stdout) : null;
}

async function listNodes(exec: MeshExec, cli: HeadscaleCli): Promise<HeadscaleNode[] | null> {
  const r = await exec.run(headscaleCommand(cli, ['nodes', 'list', '-o', 'json']));
  return r.code === 0 ? parseHeadscaleNodes(r.stdout) : null;
}

/**
 * The Hub's node on Headscale by its name, with its approved routes; null when it is not there.
 * A server that does not answer is an error, never "no node".
 */
export async function headscaleNodeRoutes(
  exec: MeshExec,
  cli: HeadscaleCli,
  hostname: string,
): Promise<{ id: string; approved: string[] } | null> {
  const cmd = headscaleCommand(cli, ['nodes', 'list', '-o', 'json']);
  const r = await exec.run(cmd);
  if (r.code !== 0) throw new MeshCommandError(cmd, r);
  const nodes = parseHeadscaleNodes(r.stdout);
  if (!nodes) throw new Error('headscale printed no node list');
  const n = nodes.find((x) => x.givenName === hostname || x.name === hostname);
  return n ? { id: n.id, approved: n.approved } : null;
}

export function headscaleApproveCommand(
  cli: HeadscaleCli,
  nodeId: string,
  routes: string[],
): MeshCommand {
  return headscaleCommand(cli, [
    'nodes',
    'approve-routes',
    '--identifier',
    nodeId,
    `--routes=${routes.join(',')}`,
  ]);
}

// ---- the ACL policy ----------------------------------------------------------------------------

/** HuJSON (comments, trailing commas) → JSON, or null. */
export function parseHuJson(text: string): Record<string, unknown> | null {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i++;
      } else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else out += c;
  }
  const v = parseJson(out.replace(/,(\s*[}\]])/g, '$1'));
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** What the policy step writes: the previous policy plus the Hub's tags and port. */
export function mergeNovaPolicy(
  previous: Record<string, unknown> | null,
  input: { tags: string[]; owner: string; port: number },
): Record<string, unknown> {
  // No policy means Headscale allows everything; keep that rather than narrowing the mesh (a
  // policy with only Nova's rule would cut every other path: the lock-out the guard is for).
  const base: Record<string, unknown> = previous
    ? structuredClone(previous)
    : { acls: [{ action: 'accept', src: ['*'], dst: ['*:*'] }] };
  const tagOwners = { ...asRecord(base.tagOwners) };
  for (const t of input.tags) {
    const owners = asStrings(tagOwners[t]);
    if (!owners.includes(input.owner)) tagOwners[t] = [...owners, input.owner];
  }
  base.tagOwners = tagOwners;
  const acls = Array.isArray(base.acls) ? [...(base.acls as unknown[])] : [];
  for (const t of input.tags) {
    const dst = `${t}:${input.port}`;
    const has = acls.some((a) => {
      const r = asRecord(a);
      return r.action === 'accept' && asStrings(r.dst).includes(dst);
    });
    if (!has) acls.push({ action: 'accept', src: ['*'], dst: [dst] });
  }
  base.acls = acls;
  return base;
}

export function summarizePolicy(policy: Record<string, unknown> | null, detail: string | null) {
  return {
    provider: 'headscale',
    source: policy ? 'headscale-policy' : 'none',
    rules: Array.isArray(policy?.acls) ? policy.acls.length : 0,
    groups: Object.keys(asRecord(policy?.groups)),
    tagOwners: Object.keys(asRecord(policy?.tagOwners)),
    tags: [],
    detail,
  } satisfies MeshAclSummary;
}

// Headscale's own answer when no policy is stored (database mode): its error ends with
// "acl policy not found". Nothing else means "no policy": a refused connection, a timeout or any
// other error must never read as "allow everything".
const NO_POLICY = /(?:^|:\s)acl policy not found\.?\s*$/m;

export type HeadscalePolicyRead = { state: 'policy'; text: string } | { state: 'none' };

/** The server's policy as stored; throws on any failure but Headscale's explicit "no policy". */
export async function readHeadscalePolicy(
  exec: MeshExec,
  cli: HeadscaleCli,
): Promise<HeadscalePolicyRead> {
  const cmd = headscaleCommand(cli, ['policy', 'get']);
  const r = await exec.run(cmd);
  if (r.code === 0 && r.stdout.trim()) return { state: 'policy', text: r.stdout };
  if (r.code !== 0 && !r.timedOut && r.error === null && NO_POLICY.test(r.stderr.trim()))
    return { state: 'none' };
  if (r.code === 0) throw new Error('headscale policy get printed nothing');
  throw new MeshCommandError(cmd, r);
}

/** What Headscale does with no policy at all: allow everything. */
const ALLOW_ALL = { acls: [{ action: 'accept', src: ['*'], dst: ['*:*'] }] };

export function policyPaths(dataDir: string, runId: string) {
  const dir = join(dataDir, 'network', 'setup', runId);
  return {
    dir,
    next: join(dir, 'headscale-policy.json'),
    previous: join(dir, 'headscale-policy.previous.json'),
  };
}

/** Parameters stored on the `server.*` steps. */
export interface HeadscaleStepParams {
  cli: HeadscaleCli;
  user: string;
  tags: string[];
  port: number;
  /** server.authkey: where the new key goes in the vault. */
  keyRef?: string;
}

const userHandler: MeshStepHandler = {
  async snapshot(step, ctx) {
    const p = step.params as unknown as HeadscaleStepParams;
    const users = await listUsers(ctx.exec, p.cli);
    return { existed: !!users?.some((u) => u.name === p.user) };
  },
  async apply(step, ctx, snap) {
    if (snap.existed === true) return;
    await runAll(ctx, step.commands);
  },
  async verify(step, ctx) {
    const p = step.params as unknown as HeadscaleStepParams;
    const users = await listUsers(ctx.exec, p.cli);
    return [check(`Headscale user ${p.user}`, !!users?.some((u) => u.name === p.user))];
  },
  undoCommands(step, snap) {
    const p = step.params as unknown as HeadscaleStepParams;
    if (snap.existed === true) return [];
    return [headscaleCommand(p.cli, ['users', 'destroy', '--name', p.user, '--force'])];
  },
};

/** The previous policy as the undo sets it back: verbatim, or allow-all when there was none. */
function previousPolicyText(snap: JsonObject): string {
  return snap.hadPolicy === true && typeof snap.previousText === 'string'
    ? snap.previousText
    : JSON.stringify(ALLOW_ALL, null, 2);
}

const aclHandler: MeshStepHandler = {
  // The policy read here is the one the step merges into and the one the undo restores; a
  // server that cannot say what its policy is stops the step before anything changes.
  async snapshot(step, ctx) {
    const p = step.params as unknown as HeadscaleStepParams;
    const read = await readHeadscalePolicy(ctx.exec, p.cli);
    if (read.state === 'policy' && !parseHuJson(read.text))
      throw new Error('the current Headscale policy could not be parsed; edit it by hand');
    const snap: JsonObject = {
      hadPolicy: read.state === 'policy',
      previousText: read.state === 'policy' ? read.text : null,
      previousFile: policyPaths(ctx.dataDir, ctx.runId).previous,
    };
    await writePolicyFile(ctx.dataDir, ctx.runId, 'previous', previousPolicyText(snap));
    return snap;
  },
  async apply(step, ctx, snap) {
    const p = step.params as unknown as HeadscaleStepParams;
    const previous = snap.hadPolicy === true ? parseHuJson(String(snap.previousText)) : null;
    if (snap.hadPolicy === true && !previous) throw new Error('the saved policy is unreadable');
    const merged = mergeNovaPolicy(previous, {
      tags: p.tags,
      owner: `${p.user}@`,
      port: p.port,
    });
    await writePolicyFile(ctx.dataDir, ctx.runId, 'next', JSON.stringify(merged, null, 2));
    await runAll(ctx, step.commands);
  },
  async verify(step, ctx) {
    const p = step.params as unknown as HeadscaleStepParams;
    let pol: Record<string, unknown> | null;
    try {
      const read = await readHeadscalePolicy(ctx.exec, p.cli);
      pol = read.state === 'policy' ? parseHuJson(read.text) : null;
    } catch (err) {
      return [check('Headscale policy readable', false, (err as Error).message)];
    }
    const owners = asRecord(pol?.tagOwners);
    return [
      check(
        'Headscale policy owns the Hub tags',
        p.tags.every((t) => asStrings(owners[t]).length > 0),
      ),
    ];
  },
  undoCommands(step, snap) {
    const p = step.params as unknown as HeadscaleStepParams;
    const file = asString(snap.previousFile);
    return file ? [headscaleCommand(p.cli, ['policy', 'set', '--file', file])] : [];
  },
  // Write the saved policy again first, so the undo does not depend on the file surviving.
  async undo(step, ctx, snap) {
    await writePolicyFile(ctx.dataDir, ctx.runId, 'previous', previousPolicyText(snap));
    await runAll(ctx, aclHandler.undoCommands(step, snap));
  },
};

async function writePolicyFile(
  dataDir: string,
  runId: string,
  which: 'next' | 'previous',
  text: string,
): Promise<void> {
  const paths = policyPaths(dataDir, runId);
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  await writeFile(paths[which], text, { mode: 0o600 });
}

const authKeyHandler: MeshStepHandler = {
  snapshot() {
    return Promise.resolve({});
  },
  async apply(step, ctx) {
    const p = step.params as unknown as HeadscaleStepParams;
    if (!p.keyRef) throw new Error('no vault ref for the key');
    const users = await listUsers(ctx.exec, p.cli);
    const user = users?.find((u) => u.name === p.user);
    if (!user) throw new Error(`Headscale has no user ${p.user}`);
    const args = ['preauthkeys', 'create', '--user', user.id || user.name, '--expiration', '1h'];
    if (p.tags.length) args.push('--tags', p.tags.join(','));
    args.push('-o', 'json');
    const r = await ctx.exec.must({ ...headscaleCommand(p.cli, args), secretOutput: true });
    const key = asString(asRecord(parseJson(r.stdout)).key);
    if (!key) throw new Error('headscale printed no pre-auth key');
    defaultRedactor.addLiteral(key);
    await ctx.secrets.put(p.keyRef, key);
  },
  // Right after it is made the key is in the vault; once the Hub joined with it, it is removed
  // (it is single-use), and joining is what `mesh.up` verifies.
  async verify(step, ctx) {
    const p = step.params as unknown as HeadscaleStepParams;
    if (p.keyRef && (await ctx.secrets.has(p.keyRef)))
      return [check('pre-auth key in the vault', true)];
    return [check('pre-auth key', true, 'used to join, then removed from the vault')];
  },
  // Expiring a key needs the key in argv; it is single-use and expires within the hour, so the
  // undo only drops it from the vault.
  undoCommands() {
    return [];
  },
  async undo(step, ctx) {
    const p = step.params as unknown as HeadscaleStepParams;
    if (p.keyRef) await ctx.secrets.delete(p.keyRef);
  },
};

const HANDLERS: Partial<Record<NetworkSetupStepKind, MeshStepHandler>> = {
  'server.user': userHandler,
  'server.acl': aclHandler,
  'server.authkey': authKeyHandler,
};

export class HeadscaleAdapter implements MeshAdapter {
  readonly provider = 'headscale' as const;

  async detect(exec: MeshExec, cli: HeadscaleCli = LOCAL_HEADSCALE): Promise<MeshDetectionView> {
    const v = await exec.run(headscaleCommand(cli, ['version', '-o', 'json']));
    if (v.error === 'not_found' || v.code === 127)
      return emptyDetection('headscale', 'headscale is not installed');
    const version =
      asString(asRecord(parseJson(v.stdout)).version) ??
      /v?\d+\.\d+\.\d+[\w.-]*/.exec(v.stdout)?.[0] ??
      null;
    const users = await listUsers(exec, cli);
    if (!users) {
      return {
        ...emptyDetection('headscale', 'the Headscale server did not answer'),
        installed: true,
        version,
      };
    }
    const nodes = (await listNodes(exec, cli)) ?? [];
    const peers: MeshPeerView[] = nodes.map((n) => ({
      name: n.givenName,
      dnsName: null,
      ips: n.ips,
      online: n.online,
      os: null,
      tags: n.tags,
    }));
    return {
      provider: 'headscale',
      installed: true,
      version,
      loggedIn: true,
      state: `${users.length} users`,
      controlUrl: null,
      ips: [],
      dnsName: null,
      tags: [],
      peers,
      routes: [],
      exitNode: false,
      detail: null,
    };
  }

  /** The ACL summary for diagnostics (FR-139): counts and names only. */
  async aclSummary(exec: MeshExec, cli: HeadscaleCli = LOCAL_HEADSCALE): Promise<MeshAclSummary> {
    try {
      const read = await readHeadscalePolicy(exec, cli);
      return summarizePolicy(
        read.state === 'policy' ? parseHuJson(read.text) : null,
        read.state === 'none' ? 'no policy: Headscale allows everything' : null,
      );
    } catch (err) {
      return summarizePolicy(null, (err as Error).message);
    }
  }

  handler(kind: NetworkSetupStepKind): MeshStepHandler | null {
    return HANDLERS[kind] ?? null;
  }
}
