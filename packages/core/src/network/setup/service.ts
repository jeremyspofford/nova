// The Network Setup assistant (FR-136, docs/22 §6): detect, plan, apply one step at a time,
// verify, roll back. Every change step needs `network.setup.allowSystemChanges` when it runs host
// commands, the owner's one-time consent per change kind and provider (the exact description,
// remembered until revoked), and passes the lock-out guard. It snapshots what it changes, applies,
// checks itself, then runs the reachability test: a failing test, or the loss of the transport
// the owner came in on, rolls it back on the spot. Applied steps go to the network change log so
// the generic one-click rollback reverts them too.
import { BlockList } from 'node:net';
import type { SecretStore } from '@nova/secrets';
import {
  NovaError,
  uuidv7,
  type MeshAclSummary,
  type MeshDetectionView,
  type MeshProvider,
  type NetworkDetectionView,
  type NetworkSetupCheckView,
  type NetworkSetupConsentView,
  type NetworkSetupOptions,
  type NetworkSetupRequestTransport,
  type NetworkSetupRunStatus,
  type NetworkSetupRunView,
  type NetworkSetupStepView,
  type NetworkSetupTransport,
  type NetworkSetupVerifyView,
} from '@nova/shared';
import { defaultRedactor } from '@nova/security';
import type { NovaDatabase } from '@nova/storage';
import type { Logger } from '@nova/telemetry';
import type { EventSink } from '../../events.ts';
import type { AuditSink } from '../../tools/types.ts';
import { isLinkLocalIp, isLoopbackIp, isMeshIp, normalizeIp } from '../subnet.ts';
import {
  defaultNetworkProbe,
  detectInterfaces,
  detectPackageManager,
  lanSubnets,
  parseResolvConf,
  type NetworkProbe,
} from '../mesh/detect.ts';
import { HeadscaleAdapter } from '../mesh/headscale.ts';
import { installHandler } from '../mesh/install.ts';
import { NetbirdAdapter } from '../mesh/netbird.ts';
import {
  MeshExec,
  ProcessMeshRunner,
  previewCommand,
  type MeshCommandRunner,
} from '../mesh/runner.ts';
import { TailscaleAdapter } from '../mesh/tailscale.ts';
import {
  check,
  type JsonObject,
  type MeshStepContext,
  type MeshStepHandler,
} from '../mesh/types.ts';
import { detectUfw, firewallHandler } from '../mesh/ufw.ts';
import { WireguardAdapter, ensureWireguardKey } from '../mesh/wireguard.ts';
import { planNetworkSetup } from './planner.ts';
import {
  SETUP_CHANGE_KIND,
  lockoutRefusal,
  transportLost,
  type MeshEndpointCandidate,
  type SetupChangeLog,
  type SetupReachability,
  type SetupReachabilityResult,
  type SetupRelay,
  type SetupTrust,
} from './seams.ts';
import { SetupStore, type SetupRunRecord, type SetupStepRecord } from './store.ts';

export interface NetworkSetupServiceOptions {
  db: NovaDatabase;
  secrets: SecretStore;
  events: EventSink;
  log: Logger;
  audit?: AuditSink;
  now?: () => Date;
  dataDir: string;
  /** The port the Hub listens on (firewall rules, ACL rules, mesh URLs). */
  hubPort: () => number;
  /** `network.setup.allowSystemChanges`: host commands run only while it is on. */
  allowSystemChanges: () => Promise<boolean>;
  /** Tests: a runner over fake CLIs. */
  runner?: MeshCommandRunner;
  probe?: Partial<NetworkProbe>;
  /** The Hub's URL at a mesh host (scheme and port); default http://host:port. */
  hubUrl?: (host: string) => string;
  /** How long a detection is reused by the endpoint source (default 60 s). */
  detectionTtlMs?: number;
  /** Reachability retries after a change (default 5, 2 s apart): a new path takes a moment. */
  verifyRetries?: number;
  verifyDelayMs?: number;
}

const PRIVATE4 = new BlockList();
PRIVATE4.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE4.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE4.addSubnet('192.168.0.0', 16, 'ipv4');
const PRIVATE6 = new BlockList();
PRIVATE6.addSubnet('fc00::', 7, 'ipv6');

export class NetworkSetupService {
  readonly tailscale = new TailscaleAdapter();
  readonly headscale = new HeadscaleAdapter();
  readonly netbird = new NetbirdAdapter();
  readonly wireguard = new WireguardAdapter();
  readonly #store: SetupStore;
  readonly #opts: NetworkSetupServiceOptions;
  readonly #now: () => Date;
  readonly #runner: MeshCommandRunner;
  readonly #probe: NetworkProbe;
  readonly #log: Logger;
  #audit: AuditSink | null;
  #reach: SetupReachability | null = null;
  #trust: SetupTrust | null = null;
  #relay: SetupRelay | null = null;
  #changes: SetupChangeLog | null = null;
  #busy = false;
  #cached: { at: number; view: NetworkDetectionView } | null = null;
  #detecting: Promise<NetworkDetectionView> | null = null;

  constructor(opts: NetworkSetupServiceOptions) {
    this.#opts = opts;
    this.#now = opts.now ?? (() => new Date());
    this.#store = new SetupStore(opts.db, this.#now);
    this.#runner = opts.runner ?? new ProcessMeshRunner();
    this.#probe = defaultNetworkProbe(opts.probe);
    this.#log = opts.log;
    this.#audit = opts.audit ?? null;
  }

  // ---- seams -------------------------------------------------------------------------------------

  useAudit(audit: AuditSink): void {
    this.#audit = audit;
  }
  useReachability(r: SetupReachability): void {
    this.#reach = r;
  }
  useTrust(t: SetupTrust): void {
    this.#trust = t;
  }
  useRelay(r: SetupRelay): void {
    this.#relay = r;
  }
  /** Record applied steps in the network change log and revert them from it. */
  useChangeLog(log: SetupChangeLog): void {
    this.#changes = log;
    log.registerUndo(SETUP_CHANGE_KIND, async (undo) => {
      const accountId = typeof undo.accountId === 'string' ? undo.accountId : '';
      const runId = typeof undo.runId === 'string' ? undo.runId : '';
      const stepId = typeof undo.stepId === 'string' ? undo.stepId : '';
      const step = this.#store.stepById(stepId);
      // Already undone here (the run's own rollback): nothing left to revert.
      if (step && step.runId === runId && step.status === 'rolled_back') return;
      await this.rollback(accountId, runId, { stepId }, 'unknown');
    });
  }

  #exec(): MeshExec {
    return new MeshExec(this.#runner, this.#opts.secrets);
  }

  // ---- detection (docs/22 §6 step 1) -------------------------------------------------------------

  /** Detect now (CLIs, interfaces, DNS, firewall, package manager). */
  async detect(): Promise<NetworkDetectionView> {
    if (this.#detecting) return this.#detecting;
    this.#detecting = this.#detect().finally(() => {
      this.#detecting = null;
    });
    return this.#detecting;
  }

  async #detect(): Promise<NetworkDetectionView> {
    const exec = this.#exec();
    const interfaces = detectInterfaces(this.#probe.interfaces());
    const [ts, hs, nb, wg] = await Promise.all([
      this.tailscale.detect(exec),
      this.headscale.detect(exec),
      this.netbird.detect(exec),
      this.wireguard.detect(exec),
    ]);
    // WireGuard has no status JSON: its addresses are its interfaces'.
    const wgIps = interfaces
      .filter((i) => i.provider === 'wireguard')
      .flatMap((i) => i.addresses.map((a) => a.address));
    const meshes = [ts, hs, nb, { ...wg, ips: wgIps, loggedIn: wg.loggedIn || wgIps.length > 0 }];
    const resolv = await this.#probe.readFile('/etc/resolv.conf');
    const dns = resolv
      ? { ...parseResolvConf(resolv), source: '/etc/resolv.conf' }
      : { nameservers: [], search: [], source: null };
    const view: NetworkDetectionView = {
      platform: this.#probe.platform,
      interfaces,
      subnets: lanSubnets(interfaces),
      dns,
      meshes,
      firewall: await detectUfw(exec),
      packageManager: detectPackageManager(this.#probe),
      meshUrls: this.#meshUrls(meshes),
      detectedAt: this.#now().toISOString(),
    };
    this.#cached = { at: this.#now().getTime(), view };
    return view;
  }

  #meshUrls(meshes: MeshDetectionView[]): string[] {
    const url =
      this.#opts.hubUrl ??
      ((host: string) =>
        `http://${host.includes(':') ? `[${host}]` : host}:${this.#opts.hubPort()}`);
    const out: string[] = [];
    for (const m of meshes) {
      if (m.provider === 'headscale' || !m.loggedIn) continue;
      if (m.dnsName) out.push(url(m.dnsName));
      for (const ip of m.ips) if (!ip.includes(':')) out.push(url(ip));
    }
    return [...new Set(out)];
  }

  /** The latest detection, reused for `detectionTtlMs`. */
  async detection(): Promise<NetworkDetectionView> {
    const ttl = this.#opts.detectionTtlMs ?? 60_000;
    if (this.#cached && this.#now().getTime() - this.#cached.at < ttl) return this.#cached.view;
    return this.detect();
  }

  /** The Hub's mesh URLs for the endpoint registry (`useEndpointSource({transport: 'mesh'})`). */
  async meshEndpoints(): Promise<MeshEndpointCandidate[]> {
    const d = await this.detection();
    // The network area's registry sets the real priority (LAN → Mesh → Relay → Direct) and
    // tests each candidate before it is advertised.
    return d.meshUrls.map((url, i) => {
      const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
      const from = d.meshes.find((m) => m.loggedIn && (m.dnsName === host || m.ips.includes(host)));
      return {
        transport: 'mesh',
        url,
        priority: 20 + i,
        health: 'unknown',
        latencyMs: null,
        checkedAt: null,
        detail: from ? from.provider : null,
      };
    });
  }

  /** The ACL summary for diagnostics (FR-139). */
  async aclSummary(): Promise<MeshAclSummary> {
    const d = await this.detection();
    const ts = d.meshes.find((m) => m.provider === 'tailscale');
    const hs = d.meshes.find((m) => m.provider === 'headscale');
    if (hs?.installed && hs.loggedIn) {
      const s = await this.headscale.aclSummary(this.#exec());
      return { ...s, tags: ts?.tags ?? [] };
    }
    const joined = d.meshes.find((m) => m.loggedIn && m.provider !== 'headscale');
    return {
      provider: joined?.provider ?? null,
      source: 'none',
      rules: 0,
      groups: [],
      tagOwners: [],
      tags: joined?.tags ?? [],
      detail: joined
        ? `the access rules live in the ${joined.provider} control plane`
        : 'no mesh is set up',
    };
  }

  /** The mesh certificate source for the trust area (`tailscale cert`). */
  meshCertificate(host: string): Promise<{ certPem: string; keyPem: string; notAfter: string }> {
    return this.tailscale.certificate(this.#exec(), host);
  }

  /**
   * Which transport an owner's request came in on, from the Hub address it reached: a mesh
   * address (the detected ones or the shared mesh ranges) is `mesh`, a private address `lan`,
   * anything else `direct`; loopback or no address is `unknown` (the guard then wants a healthy
   * path the change does not touch). Never `local`: that takes an explicit marker.
   */
  transportOf(localAddress: string | undefined | null): NetworkSetupRequestTransport {
    const a = localAddress ? normalizeIp(localAddress) : null;
    // Loopback proves nothing: an SSH tunnel or a proxy on the Hub arrives from 127.0.0.1 too.
    // Only a caller that knows (an explicit marker) may say `local`.
    if (!a || isLoopbackIp(a)) return 'unknown';
    const meshIps = new Set(this.#cached?.view.meshes.flatMap((m) => m.ips) ?? []);
    if (meshIps.has(a) || isMeshIp(a)) return 'mesh';
    const v4 = !a.includes(':');
    if (isLinkLocalIp(a) || (v4 ? PRIVATE4.check(a, 'ipv4') : PRIVATE6.check(a, 'ipv6')))
      return 'lan';
    return 'direct';
  }

  // ---- plan ---------------------------------------------------------------------------------------

  async plan(
    accountId: string,
    provider: MeshProvider,
    options: NetworkSetupOptions = {},
  ): Promise<NetworkSetupRunView> {
    const runId = uuidv7();
    const detection = await this.detect();
    const put: string[] = [];
    const store = async (name: string, value: string | undefined) => {
      if (!value) return null;
      const ref = `secret://network/setup/${runId}/${name}`;
      defaultRedactor.addLiteral(value);
      await this.#opts.secrets.put(ref, value);
      put.push(ref);
      return ref;
    };
    const outputs: Record<string, string> = {};
    try {
      const authKey = await store('auth-key', options.authKey);
      const headscaleApiKey = await store('headscale-api-key', options.headscale?.apiKey);
      let wireguardKey: { ref: string; publicKey: string } | null = null;
      if (provider === 'wireguard' && options.wireguard) {
        wireguardKey = await ensureWireguardKey(
          this.#opts.secrets,
          options.wireguard.interface ?? 'wg-nova',
        );
        outputs.wireguardPublicKey = wireguardKey.publicKey;
      }
      const steps = planNetworkSetup(provider, options, {
        runId,
        dataDir: this.#opts.dataDir,
        hubPort: this.#opts.hubPort(),
        platform: this.#probe.platform,
        detection,
        secretRefs: { authKey, headscaleApiKey },
        wireguardKey,
      });
      await this.#store.createRun({
        id: runId,
        accountId,
        provider,
        options: storedOptions(options, authKey, headscaleApiKey),
        outputs,
        detection,
        steps,
      });
    } catch (err) {
      for (const ref of put) await this.#opts.secrets.delete(ref).catch(() => false);
      throw err;
    }
    return this.getRun(accountId, runId);
  }

  // ---- apply (docs/22 §6 steps 2-7) -------------------------------------------------------------

  async apply(
    accountId: string,
    input: { runId: string; stepId?: string; consent?: { stepId: string; description: string } },
    transport: NetworkSetupRequestTransport,
  ): Promise<{ run: NetworkSetupRunView; step: NetworkSetupStepView }> {
    const run = this.#run(accountId, input.runId);
    const steps = this.#store.steps(run.id);
    const step = input.stepId
      ? steps.find((s) => s.id === input.stepId)
      : steps.find((s) => ['pending', 'failed', 'rolled_back'].includes(s.status));
    if (!step) {
      if (input.stepId) throw new NovaError('not_found', 'setup step not found');
      throw conflict('nothing_to_apply', 'every step of this run is done');
    }
    if (step.mode === 'manual' || step.mode === 'skip')
      throw conflict('not_applicable', 'this step is done by hand or already in place');
    if (step.status === 'applied' || step.status === 'verified')
      throw conflict('already_applied', 'this step is applied');
    if (step.status === 'rollback_failed')
      throw conflict('rollback_pending', 'undoing this step failed: roll it back again first', {
        stepId: step.id,
      });
    const earlier = steps.find(
      (s) =>
        s.index < step.index &&
        (s.mode === 'change' || s.mode === 'check') &&
        s.status !== 'verified',
    );
    if (earlier)
      throw conflict('earlier_step_pending', `apply "${earlier.title}" first`, {
        stepId: earlier.id,
      });
    if (this.#busy) throw conflict('setup_busy', 'another setup step is running');
    // Held from here on, across every await, so two requests never change the host at once.
    this.#busy = true;
    try {
      if (step.mode === 'check') await this.#check(accountId, step);
      else await this.#change(accountId, step, input.consent, transport);
    } finally {
      this.#busy = false;
    }
    return this.#result(accountId, run.id, step.id);
  }

  async #change(
    accountId: string,
    step: SetupStepRecord,
    consent: { stepId: string; description: string } | undefined,
    transport: NetworkSetupRequestTransport,
  ): Promise<void> {
    if (step.systemChange && !(await this.#opts.allowSystemChanges())) {
      await this.#auditApply(accountId, step, 'denied', 'system_changes_disabled');
      throw new NovaError(
        'policy_denied',
        'host changes are off: turn on network.setup.allowSystemChanges to let Nova run this step',
        {
          details: {
            reason: 'system_changes_disabled',
            setting: 'network.setup.allowSystemChanges',
          },
        },
      );
    }
    const before = await this.#test();
    const refusal = lockoutRefusal(transport, step.affects, before);
    if (refusal) {
      await this.#auditApply(accountId, step, 'denied', 'would_lock_out');
      throw conflict(
        'would_lock_out',
        `this step could cut the ${transport === 'unknown' ? 'connection' : transport} path you are using, and no other path to the Hub passes its test`,
        { transport, affects: refusal.affects },
      );
    }
    await this.#consent(accountId, step, consent);
    await this.#applyStep(accountId, step, transport, before);
  }

  async #consent(
    accountId: string,
    step: SetupStepRecord,
    given: { stepId: string; description: string } | undefined,
  ): Promise<void> {
    // A remembered consent covers only the exact change the owner read: a step of the same kind
    // and provider that says something else (another server, user, route or port) asks again.
    const remembered = this.#store.consent(accountId, step.kind, step.provider);
    if (remembered?.description === step.description) return;
    if (!given || given.stepId !== step.id || given.description !== step.description) {
      throw new NovaError('policy_denied', 'confirm this step first: send its description back', {
        details: {
          reason: 'consent_required',
          stepId: step.id,
          description: step.description,
          ...(remembered ? { changed: true } : {}),
        },
      });
    }
    await this.#store.grantConsent(accountId, step.kind, step.provider, step.description);
    await this.#audit?.append({
      accountId,
      actor: 'user',
      kind: 'network',
      action: 'network.setup.consent',
      resource: `network_setup_step:${step.id}`,
      decision: 'granted',
      detail: { kind: step.kind, provider: step.provider, runId: step.runId },
    });
  }

  async #applyStep(
    accountId: string,
    step: SetupStepRecord,
    transport: NetworkSetupRequestTransport,
    before: SetupReachabilityResult[] | null,
  ): Promise<void> {
    await this.#store.updateRun(step.runId, { status: 'in_progress', error: null });
    const run = this.#run(accountId, step.runId);
    const outputs = { ...run.outputs };
    const exec = this.#exec();
    const ctx = this.#ctx(exec, step.runId, outputs);
    const handler = this.#handler(step);
    let snapshotId: string | null = null;
    let snap: JsonObject = {};
    try {
      snap = await handler.snapshot(step, ctx);
      snapshotId = await this.#store.saveSnapshot(step, snap, handler.undoCommands(step, snap));
      await handler.apply(step, ctx, snap);
    } catch (err) {
      const error = message(err);
      // Put back whatever part of the step ran before it failed. If that fails too, the step is
      // left `rollback_failed` (both errors kept) so a rollback can try again; it is never
      // treated as cleanly failed.
      let undoError: string | null = null;
      if (snapshotId) {
        try {
          await this.#undo(step, ctx, snap);
        } catch (e) {
          undoError = message(e);
        }
      }
      await this.#auditApply(accountId, step, 'allowed', 'failed', exec, error);
      if (undoError) {
        const both = `${error}; undoing it failed too: ${undoError}`;
        await this.#store.updateStep(step.id, {
          status: 'rollback_failed',
          error: both,
          checks: [],
          autoRolledBack: true,
        });
        await this.#auditRollback(accountId, step.runId, [step.id], [step.id], {
          auto: true,
          reason: both,
          exec,
        });
        await this.#emit(accountId, step, 'rollback_failed', { autoRolledBack: true, error: both });
      } else {
        await this.#store.updateStep(step.id, { status: 'failed', error, checks: [] });
        await this.#emit(accountId, step, 'failed', { error });
        if (snapshotId) await this.#afterUndo(step);
      }
      await this.#settleRun(step.runId);
      return;
    }
    // A handler may learn more while applying (e.g. a node id); keep the undo exact.
    await this.#store.updateSnapshot(snapshotId, snap, handler.undoCommands(step, snap));
    await this.#store.updateRun(step.runId, { outputs });
    await this.#store.updateStep(step.id, {
      status: 'applied',
      error: null,
      autoRolledBack: false,
      appliedAt: this.#now().toISOString(),
    });
    await this.#emit(accountId, step, 'applied');

    // Verify: the step's own checks, then the reachability test (the paths it promised, and the
    // owner's own path).
    let checks: NetworkSetupCheckView[] = [];
    let failure: string | null = null;
    try {
      checks = await handler.verify(step, ctx);
      const bad = checks.find((c) => !c.ok);
      if (bad) failure = `${bad.name} did not pass${bad.detail ? `: ${bad.detail}` : ''}`;
    } catch (err) {
      failure = message(err);
    }
    if (!failure) {
      if (step.expects.includes('mesh')) this.#cached = null;
      const r = await this.#reachable(step.expects, transport, step.affects, before);
      checks.push(...r.checks);
      failure = r.failure;
    }
    if (failure) {
      let undone = true;
      try {
        await this.#undo(step, ctx, snap);
      } catch (err) {
        undone = false;
        failure = `${failure}; the rollback failed too: ${message(err)}`;
      }
      const at = this.#now().toISOString();
      await this.#store.updateStep(step.id, {
        status: undone ? 'rolled_back' : 'rollback_failed',
        checks,
        error: failure,
        autoRolledBack: true,
        rolledBackAt: at,
      });
      await this.#auditApply(
        accountId,
        step,
        'allowed',
        undone ? 'rolled_back' : 'rollback_failed',
        exec,
        failure,
      );
      await this.#auditRollback(accountId, step.runId, [step.id], undone ? [] : [step.id], {
        auto: true,
        reason: failure,
        exec,
      });
      await this.#emit(accountId, step, undone ? 'rolled_back' : 'rollback_failed', {
        autoRolledBack: true,
        error: failure,
      });
      if (undone) await this.#afterUndo(step);
      this.#cached = null;
      await this.#settleRun(step.runId);
      return;
    }
    let changeRef: string | null = null;
    if (this.#changes) {
      try {
        const rec = await bounded(
          this.#changes.record({
            kind: SETUP_CHANGE_KIND,
            summary: `Network setup: ${step.title}`,
            undo: { accountId, runId: step.runId, stepId: step.id },
            accountId,
          }),
          SEAM_TIMEOUT_MS,
          'the change log',
        );
        changeRef = typeof rec === 'string' ? rec : rec.id;
      } catch (err) {
        this.#log.warn('recording a setup step in the change log failed', { err: message(err) });
      }
    }
    await this.#store.updateStep(step.id, {
      status: 'verified',
      checks,
      verifiedAt: this.#now().toISOString(),
      changeRef,
    });
    await this.#auditApply(accountId, step, 'allowed', 'verified', exec);
    await this.#emit(accountId, step, 'verified');
    // A joined node needs its auth or setup key no more.
    if (step.kind === 'mesh.up') await this.#dropStepKey(step);
    await this.#settleRun(step.runId);
  }

  /** The closing reachability step: a test only, nothing to roll back. */
  async #check(accountId: string, step: SetupStepRecord): Promise<void> {
    this.#cached = null;
    const r = await this.#reachable(step.expects, 'local', [], null);
    const status = r.failure ? 'failed' : 'verified';
    await this.#store.updateStep(step.id, {
      status,
      checks: r.checks,
      error: r.failure,
      ...(status === 'verified' ? { verifiedAt: this.#now().toISOString() } : {}),
    });
    await this.#emit(accountId, step, status, r.failure ? { error: r.failure } : {});
    await this.#settleRun(step.runId);
  }

  async #test(): Promise<SetupReachabilityResult[] | null> {
    if (!this.#reach) return null;
    try {
      return await bounded(this.#reach.test(), SEAM_TIMEOUT_MS, 'the reachability test');
    } catch (err) {
      this.#log.warn('the reachability test failed', { err: message(err) });
      return null;
    }
  }

  /**
   * After a change: every expected transport answers (retried while a new path comes up), and
   * the owner's own transport did not go away.
   */
  async #reachable(
    expects: NetworkSetupTransport[],
    transport: NetworkSetupRequestTransport,
    affects: NetworkSetupTransport[],
    before: SetupReachabilityResult[] | null,
  ): Promise<{ checks: NetworkSetupCheckView[]; failure: string | null }> {
    const needsTest = expects.length > 0 || (before !== null && transport !== 'local');
    if (!needsTest) return { checks: [], failure: null };
    if (!this.#reach) {
      return expects.length
        ? {
            checks: [check('reachability test', false, 'no reachability test is connected')],
            failure: 'no reachability test is connected, so the new path cannot be checked',
          }
        : { checks: [], failure: null };
    }
    const retries = this.#opts.verifyRetries ?? 5;
    const delay = this.#opts.verifyDelayMs ?? 2000;
    let after: SetupReachabilityResult[] | null = null;
    let missing: NetworkSetupTransport[] = [];
    let lost: NetworkSetupTransport | null = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0 && delay > 0) await new Promise((r) => setTimeout(r, delay));
      after = await this.#test();
      const results = after ?? [];
      missing = expects.filter((t) => !results.some((r) => r.transport === t && r.ok));
      lost = transportLost(transport, affects, before, after);
      if (!missing.length && !lost) break;
    }
    const checks = expects.map((t) => {
      const hit = (after ?? []).filter((r) => r.transport === t);
      const ok = hit.find((r) => r.ok);
      return check(
        `${t} reachable`,
        !!ok,
        ok ? ok.url : (hit[0]?.detail ?? `no ${t} path answered`),
      );
    });
    if (lost) checks.push(check(`your ${lost} path`, false, 'it stopped answering'));
    const failure = lost
      ? `the Hub stopped answering on the ${lost} path you are using`
      : missing.length
        ? `the ${missing.join(' and ')} path failed its reachability test`
        : null;
    return { checks, failure };
  }

  // ---- verify (manual) ---------------------------------------------------------------------------

  async verify(accountId: string, runId: string, stepId?: string): Promise<NetworkSetupVerifyView> {
    const run = this.#run(accountId, runId);
    const steps = this.#store
      .steps(runId)
      .filter((s) => (stepId ? s.id === stepId : true))
      .filter((s) => s.status === 'applied' || s.status === 'verified');
    if (stepId && !steps.length)
      throw conflict('not_applied', 'only an applied step can be verified');
    const exec = this.#exec();
    const all: NetworkSetupCheckView[] = [];
    for (const s of steps) {
      const handler = this.#handler(s);
      let checks: NetworkSetupCheckView[];
      try {
        checks = await handler.verify(s, this.#ctx(exec, runId, { ...run.outputs }));
      } catch (err) {
        checks = [check(s.title, false, message(err))];
      }
      await this.#store.updateStep(s.id, { checks });
      all.push(...checks);
    }
    this.#cached = null;
    const expects = [...new Set(steps.flatMap((s) => s.expects))];
    const r = await this.#reachable(expects, 'local', [], null);
    all.push(...r.checks);
    return { run: await this.getRun(accountId, runId), ok: all.every((c) => c.ok), checks: all };
  }

  // ---- rollback (docs/22 §6 step 8) --------------------------------------------------------------

  /**
   * Undo a whole run (its applied steps, newest first) or only its last applied step. Guarded
   * like applying: an undo that could cut the owner's path needs another healthy one.
   */
  async rollback(
    accountId: string,
    runId: string,
    input: { stepId?: string },
    transport: NetworkSetupRequestTransport,
  ): Promise<NetworkSetupRunView> {
    this.#run(accountId, runId);
    const applied = this.#store
      .steps(runId)
      .filter((s) => ['applied', 'verified', 'rollback_failed'].includes(s.status))
      .filter((s) => s.mode === 'change')
      .sort((a, b) => b.index - a.index);
    let targets = applied;
    if (input.stepId) {
      const last = applied[0];
      if (!last || last.id !== input.stepId) {
        throw conflict(
          'not_last_step',
          'only the last applied step can be rolled back alone; roll back the run instead',
        );
      }
      targets = [last];
    }
    if (!targets.length) throw conflict('nothing_to_roll_back', 'nothing in this run is applied');
    if (this.#busy) throw conflict('setup_busy', 'another setup step is running');
    this.#busy = true;
    try {
      await this.#undoSteps(accountId, runId, targets, input, transport);
    } finally {
      this.#busy = false;
      this.#cached = null;
    }
    await this.#settleRun(runId);
    return this.getRun(accountId, runId);
  }

  async #undoSteps(
    accountId: string,
    runId: string,
    targets: SetupStepRecord[],
    input: { stepId?: string },
    transport: NetworkSetupRequestTransport,
  ): Promise<void> {
    // Undoing puts back what the owner had, so it runs even while host changes are off (refusing
    // it could leave them locked out); applying is what the setting gates. It is audited either
    // way, with the setting's value.
    const allowed = await this.#opts.allowSystemChanges();
    const affects = [...new Set(targets.flatMap((s) => s.undoAffects))];
    const refusal = lockoutRefusal(transport, affects, await this.#test());
    if (refusal) {
      throw conflict(
        'would_lock_out',
        'rolling this back could cut the path you are using, and no other path to the Hub passes its test',
        { transport, affects },
      );
    }
    const done: string[] = [];
    const failed: string[] = [];
    const exec = this.#exec();
    for (const s of targets) {
      const ctx = this.#ctx(exec, runId, {});
      const snap = this.#store.snapshot(s.id);
      try {
        await this.#undo(s, ctx, snap?.data ?? {});
        await this.#store.updateStep(s.id, {
          status: 'rolled_back',
          error: null,
          autoRolledBack: false,
          rolledBackAt: this.#now().toISOString(),
        });
        await this.#emit(accountId, s, 'rolled_back');
        await this.#afterUndo(s);
        done.push(s.id);
      } catch (err) {
        // Kept `rollback_failed` with what went wrong before (if anything), so it can be retried.
        const now = `undoing it failed: ${message(err)}`;
        const error = (s.error ? `${s.error}; ${now}` : now).slice(-1000);
        await this.#store.updateStep(s.id, { status: 'rollback_failed', error });
        await this.#emit(accountId, s, 'rollback_failed', { error });
        failed.push(s.id);
      }
    }
    // A whole-run rollback voids the closing reachability test.
    if (!input.stepId) {
      for (const c of this.#store.steps(runId).filter((s) => s.mode === 'check'))
        await this.#store.updateStep(c.id, { status: 'pending', checks: [], error: null });
    }
    await this.#auditRollback(accountId, runId, [...done, ...failed], failed, {
      auto: false,
      exec,
      allowSystemChanges: allowed,
    });
  }

  async #auditRollback(
    accountId: string,
    runId: string,
    steps: string[],
    failed: string[],
    o: { auto: boolean; exec: MeshExec; reason?: string; allowSystemChanges?: boolean },
  ): Promise<void> {
    await this.#audit?.append({
      accountId,
      actor: o.auto ? 'system' : 'user',
      kind: 'network',
      action: 'network.setup.rollback',
      resource:
        steps.length === 1 ? `network_setup_step:${steps[0]}` : `network_setup_run:${runId}`,
      decision: 'allowed',
      result: failed.length ? 'rollback_failed' : 'rolled_back',
      detail: {
        runId,
        steps,
        failed,
        auto: o.auto,
        commands: o.exec.records.map((r) => r.argv),
        ...(o.reason ? { reason: o.reason.slice(0, 500) } : {}),
        ...(o.allowSystemChanges !== undefined ? { allowSystemChanges: o.allowSystemChanges } : {}),
      },
    });
  }

  /**
   * After a step is undone: the secret it joined with goes, and once nothing of the run is left
   * applied, every secret the owner typed for the run goes too.
   */
  async #afterUndo(step: SetupStepRecord): Promise<void> {
    if (step.kind === 'mesh.up') await this.#dropStepKey(step);
    const live = this.#store
      .steps(step.runId)
      .some(
        (s) => s.mode === 'change' && ['applied', 'verified', 'rollback_failed'].includes(s.status),
      );
    if (live) return;
    const prefix = `secret://network/setup/${step.runId}/`;
    for (const ref of await this.#opts.secrets.list(prefix).catch(() => [] as string[]))
      await this.#opts.secrets.delete(ref).catch(() => false);
  }

  /** The auth, setup or pre-auth key a `mesh.up` step joined with (never a WireGuard key). */
  async #dropStepKey(step: SetupStepRecord): Promise<void> {
    for (const k of ['authKeyRef', 'setupKeyRef']) {
      const ref = step.params[k];
      if (typeof ref === 'string' && ref.startsWith(`secret://network/setup/${step.runId}/`))
        await this.#opts.secrets.delete(ref).catch(() => false);
    }
  }

  async #undo(step: SetupStepRecord, ctx: MeshStepContext, snap: JsonObject): Promise<void> {
    const handler = this.#handler(step);
    if (handler.undo) {
      await handler.undo(step, ctx, snap);
      return;
    }
    // Every undo command runs even when one fails (they put back independent things, and each
    // can run again on a retry); the errors are reported together.
    const errors: string[] = [];
    for (const c of handler.undoCommands(step, snap)) {
      try {
        await ctx.exec.must(c);
      } catch (err) {
        errors.push(message(err));
      }
    }
    if (errors.length) throw new Error(errors.join('; '));
  }

  // ---- consents ----------------------------------------------------------------------------------

  consents(accountId: string): NetworkSetupConsentView[] {
    return this.#store.consents(accountId);
  }

  async revokeConsent(accountId: string, id: string): Promise<void> {
    const c = await this.#store.revokeConsent(accountId, id);
    if (!c) throw new NovaError('not_found', 'consent not found');
    await this.#audit?.append({
      accountId,
      actor: 'user',
      kind: 'network',
      action: 'network.setup.consent',
      resource: `network_setup_consent:${id}`,
      decision: 'revoked',
      detail: { kind: c.kind, provider: c.provider },
    });
  }

  // ---- views -------------------------------------------------------------------------------------

  listRuns(accountId: string): Promise<NetworkSetupRunView[]> {
    return Promise.resolve(this.#store.runs(accountId).map((r) => this.#view(accountId, r)));
  }

  getRun(accountId: string, id: string): Promise<NetworkSetupRunView> {
    return Promise.resolve(this.#view(accountId, this.#run(accountId, id)));
  }

  #run(accountId: string, id: string): SetupRunRecord {
    const r = this.#store.run(accountId, id);
    if (!r) throw new NovaError('not_found', 'setup run not found');
    return r;
  }

  async #result(accountId: string, runId: string, stepId: string) {
    const run = await this.getRun(accountId, runId);
    const step = run.steps.find((s) => s.id === stepId);
    if (!step) throw new NovaError('not_found', 'setup step not found');
    return { run, step };
  }

  #view(accountId: string, r: SetupRunRecord): NetworkSetupRunView {
    return {
      id: r.id,
      provider: r.provider,
      status: r.status,
      options: publicOptions(r.options),
      outputs: r.outputs,
      steps: this.#store.steps(r.id).map((s) => this.#stepView(accountId, s)),
      error: r.error,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  #stepView(accountId: string, s: SetupStepRecord): NetworkSetupStepView {
    const snap = this.#store.snapshot(s.id);
    return {
      id: s.id,
      runId: s.runId,
      index: s.index,
      kind: s.kind,
      provider: s.provider,
      title: s.title,
      description: s.description,
      commands: s.commands.map(previewCommand),
      undoCommands: (snap?.undo ?? []).map(previewCommand),
      affects: s.affects,
      undoAffects: s.undoAffects,
      systemChange: s.systemChange,
      status: s.status,
      consent: {
        required: s.mode === 'change',
        remembered:
          this.#store.consent(accountId, s.kind, s.provider)?.description === s.description,
      },
      checks: s.checks,
      error: s.error,
      autoRolledBack: s.autoRolledBack,
      appliedAt: s.appliedAt,
      verifiedAt: s.verifiedAt,
      rolledBackAt: s.rolledBackAt,
    };
  }

  async #settleRun(runId: string): Promise<void> {
    const steps = this.#store.steps(runId).filter((s) => s.mode === 'change' || s.mode === 'check');
    const changes = steps.filter((s) => s.mode === 'change');
    let status: NetworkSetupRunStatus;
    const stuck = steps.find((s) => s.status === 'rollback_failed');
    const failed =
      stuck ??
      steps.find((s) => s.status === 'failed' || (s.status === 'rolled_back' && s.autoRolledBack));
    if (failed) status = 'failed';
    else if (steps.every((s) => s.status === 'verified')) status = 'completed';
    else if (
      changes.some((s) => s.status === 'rolled_back') &&
      changes.every((s) => s.status === 'rolled_back' || s.status === 'pending')
    )
      status = 'rolled_back';
    else if (steps.some((s) => s.status !== 'pending')) status = 'in_progress';
    else status = 'planned';
    await this.#store.updateRun(runId, {
      status,
      error: stuck
        ? `${stuck.title} could not be undone; roll back again: ${stuck.error ?? ''}`.slice(0, 1000)
        : failed
          ? (failed.error ?? `${failed.title} failed`)
          : null,
    });
  }

  // ---- handlers ----------------------------------------------------------------------------------

  #ctx(exec: MeshExec, runId: string, outputs: Record<string, string>): MeshStepContext {
    return { exec, secrets: this.#opts.secrets, dataDir: this.#opts.dataDir, runId, outputs };
  }

  #handler(step: SetupStepRecord): MeshStepHandler {
    let h: MeshStepHandler | null = null;
    if (step.kind === 'client.install') h = installHandler;
    else if (step.kind === 'firewall.ports') h = firewallHandler(step.kind);
    else if (step.provider === 'hub') h = this.#hubHandler(step.kind);
    else if (step.provider === 'tailscale') h = this.tailscale.handler(step.kind);
    else if (step.provider === 'headscale') h = this.headscale.handler(step.kind);
    else if (step.provider === 'netbird') h = this.netbird.handler(step.kind);
    else if (step.provider === 'wireguard') h = this.wireguard.handler(step.kind);
    if (!h) throw new NovaError('server_error', `no handler for ${step.provider} ${step.kind}`);
    return h;
  }

  #hubHandler(kind: string): MeshStepHandler | null {
    if (kind === 'trust.cert') {
      return {
        snapshot: () => Promise.resolve({}),
        apply: async (step, ctx) => {
          if (!this.#trust) throw new Error('the trust area is not connected');
          if (step.params.mode === 'mesh') {
            this.#cached = null;
            const d = await this.detection();
            const host = d.meshes.find((m) => m.provider === 'tailscale')?.dnsName;
            if (!host) throw new Error('the Hub has no MagicDNS name on the mesh yet');
            const cert = await bounded(
              this.#trust.requestMeshCert(host),
              CERT_TIMEOUT_MS,
              'the trust area',
            );
            ctx.outputs.meshCertHost = cert.host;
            ctx.outputs.meshCertNotAfter = cert.notAfter;
          } else {
            const ca = await bounded(
              this.#trust.ensureLocalCa(),
              CERT_TIMEOUT_MS,
              'the trust area',
            );
            ctx.outputs.caFingerprint = ca.caFingerprint;
          }
        },
        verify: (step, ctx) =>
          Promise.resolve([
            check(
              step.params.mode === 'mesh' ? 'mesh certificate' : 'Hub local CA',
              !!(ctx.outputs.meshCertNotAfter ?? ctx.outputs.caFingerprint),
            ),
          ]),
        // Getting a certificate or making sure the CA exists changes no path; nothing to undo.
        undoCommands: () => [],
      };
    }
    if (kind === 'relay.enroll') {
      return {
        snapshot: async () => {
          if (!this.#relay) throw new Error('the relay area is not connected');
          const s = await bounded(this.#relay.state(), SEAM_TIMEOUT_MS, 'the relay area');
          return { enabled: s.enabled, url: s.url };
        },
        apply: async (step) => {
          if (!this.#relay) throw new Error('the relay area is not connected');
          await bounded(
            this.#relay.set({ enabled: true, url: String(step.params.url) }),
            SEAM_TIMEOUT_MS,
            'the relay area',
          );
        },
        verify: async () => {
          const s = this.#relay
            ? await bounded(this.#relay.state(), SEAM_TIMEOUT_MS, 'the relay area')
            : null;
          return [check('Relay enabled', s?.enabled === true, s?.url ?? null)];
        },
        undoCommands: () => [],
        undo: async (_step, _ctx, snap) => {
          if (!this.#relay) throw new Error('the relay area is not connected');
          await bounded(
            this.#relay.set({
              enabled: snap.enabled === true,
              url: typeof snap.url === 'string' ? snap.url : null,
            }),
            SEAM_TIMEOUT_MS,
            'the relay area',
          );
        },
      };
    }
    if (kind === 'reachability') {
      return {
        snapshot: () => Promise.resolve({}),
        apply: () => Promise.resolve(),
        verify: () => Promise.resolve([]),
        undoCommands: () => [],
      };
    }
    return null;
  }

  // ---- audit and events --------------------------------------------------------------------------

  async #auditApply(
    accountId: string,
    step: SetupStepRecord,
    decision: 'allowed' | 'denied',
    result: string,
    exec?: MeshExec,
    error?: string,
  ): Promise<void> {
    await this.#audit?.append({
      accountId,
      actor: 'user',
      kind: 'network',
      action: 'network.setup.apply',
      resource: `network_setup_step:${step.id}`,
      decision,
      result,
      detail: {
        runId: step.runId,
        kind: step.kind,
        provider: step.provider,
        commands: exec ? exec.records.map((r) => r.argv) : [],
        ...(error ? { error: error.slice(0, 300) } : {}),
      },
    });
  }

  async #emit(
    accountId: string,
    step: SetupStepRecord,
    status: string,
    extra: { autoRolledBack?: boolean; error?: string } = {},
  ): Promise<void> {
    await this.#opts.events.emit({
      name: 'network.setup.step',
      accountId,
      actor: 'user',
      payload: {
        runId: step.runId,
        stepId: step.id,
        kind: step.kind,
        provider: step.provider,
        status,
        autoRolledBack: extra.autoRolledBack ?? false,
        ...(extra.error ? { error: extra.error.slice(0, 300) } : {}),
      },
    });
  }
}

// Every await under the setup lock is bounded (commands by their own timeouts, the other areas
// by these), so the lock is always released.
const SEAM_TIMEOUT_MS = 60_000;
const CERT_TIMEOUT_MS = 180_000;

function bounded<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms / 1000} s`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function conflict(reason: string, msg: string, details: Record<string, unknown> = {}): NovaError {
  return new NovaError('conflict', msg, { details: { reason, ...details } });
}

function message(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return defaultRedactor.redactString(m).slice(0, 500);
}

/** Options as stored: write-only secrets become vault refs. */
function storedOptions(
  o: NetworkSetupOptions,
  authKeyRef: string | null,
  apiKeyRef: string | null,
): JsonObject {
  const { authKey: _a, headscale, ...rest } = o;
  const out: JsonObject = { ...rest };
  if (authKeyRef) out.authKeyRef = authKeyRef;
  if (headscale) {
    const { apiKey: _k, ...h } = headscale;
    out.headscale = apiKeyRef ? { ...h, apiKeyRef } : h;
  }
  return out;
}

/** Options as shown: refs become `stored`. */
function publicOptions(o: JsonObject): JsonObject {
  const { authKeyRef, headscale, ...rest } = o;
  const out: JsonObject = { ...rest };
  if (authKeyRef) out.authKey = 'stored';
  if (headscale && typeof headscale === 'object') {
    const { apiKeyRef, ...h } = headscale as JsonObject;
    out.headscale = apiKeyRef ? { ...h, apiKey: 'stored' } : h;
  }
  return out;
}
