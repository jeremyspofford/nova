// The pipeline's gates (ADR-9, OPERATING-RULES): the fixed order of stages, the least a canary may
// watch for, and what every change is probed with. These are core: they are constants frozen at
// load, no route or profile setting changes them, and a change that tries to (by naming a gate in
// what it proposes, or by targeting the pipeline itself) is refused before anything runs. The gates
// may never be weakened to make a change pass.

export const KINDS = Object.freeze(['extension', 'design-system', 'config', 'template', 'trigger-rules'] as const);
export type ChangeKind = (typeof KINDS)[number];

// Every change goes through all of these, in this order. None can be skipped.
export const STAGES = Object.freeze(['sandbox', 'tests', 'health', 'release', 'approval', 'canary', 'promote'] as const);
export type Stage = (typeof STAGES)[number];

// The shortest canary per kind, in seconds. A change may ask for a longer one, never a shorter one.
export const MIN_CANARY_S: Readonly<Record<ChangeKind, number>> = Object.freeze({
  extension: 30 * 60,
  'design-system': 10 * 60,
  config: 10 * 60,
  template: 15 * 60,
  'trigger-rules': 30 * 60,
});
export const MAX_CANARY_S = 7 * 86_400;
// How many times the probes must have run, all passing, before a canary may be promoted.
export const MIN_PROBE_RUNS = 3;

// What the sandbox is probed with, whatever the change: its own probe comes on top of these.
export const SANDBOX_PROBES = Object.freeze(['health', 'setup', 'ledger', 'memory', 'approval', 'privacy'] as const);
// What runs over the canary window, every time.
export const CANARY_PROBES = Object.freeze(['health', 'problems', 'errors', 'own'] as const);

// Words a change may not use about itself: each would turn a gate off or down.
export const GATE_FIELDS = Object.freeze(['skip', 'skip_stages', 'stages', 'gates', 'tier', 'approval', 'approved', 'no_canary', 'force', 'probes_off', 'core_probes', 'min_probe_runs', 'min_canary_s', 'sandbox', 'unsafe']);
// Where the gates live, by name: a change aimed at any of these is aimed at the pipeline.
const PIPELINE = /^(changes?|pipeline|gates?|foundry)$/i;
const PIPELINE_TARGET = /(^|[^a-z])(changes?|pipeline|gates?|canary|probes?|stages?)([^a-z]|$)/i;

export const GATES = Object.freeze({
  stages: STAGES,
  min_canary_s: MIN_CANARY_S,
  max_canary_s: MAX_CANARY_S,
  min_probe_runs: MIN_PROBE_RUNS,
  sandbox_probes: SANDBOX_PROBES,
  canary_probes: CANARY_PROBES,
});

export const REFUSED_WORDS = 'The pipeline’s gates are part of Nova’s core: no change can turn them off, shorten them or skip a stage.';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// Why this proposal would weaken a gate, in plain words, or null. Checked before anything else
// about it, so a change that tries never reaches the sandbox.
// Decision templates a security gate depends on (the ingest gate's screen, src/core/ingest), and the
// Noul questions each must keep: a change may tighten one, never take a question away or change it.
export const GATE_TEMPLATES: ReadonlyMap<string, readonly string[]> = new Map([
  ['ingest-screen', ['direct_instruction', 'hidden_instruction', 'exfiltration', 'impersonation', 'unrequested_action']],
]);

export function weakens(kind: ChangeKind, proposal: Record<string, unknown>, artifact: unknown): string | null {
  if (kind === 'template' && isObj(artifact) && isObj(artifact.template)) {
    const t = artifact.template;
    const keep = GATE_TEMPLATES.get(String(t.template_id));
    if (keep) {
      const qs = Array.isArray(t.questions) ? t.questions : [];
      const noul = new Set(qs.filter((q) => isObj(q) && q.type === 'noul').map((q) => (q as Record<string, unknown>).id));
      const missing = keep.filter((q) => !noul.has(q));
      if (missing.length) return `It drops or changes the ingest screen’s question${missing.length === 1 ? '' : 's'} ${missing.join(', ')}. ${REFUSED_WORDS}`;
    }
  }
  const named = [proposal, isObj(artifact) ? artifact : {}].flatMap((o) => Object.keys(o).filter((k) => (GATE_FIELDS as readonly string[]).includes(k)));
  if (named.length) return `It sets ${[...new Set(named)].join(', ')}, which only the pipeline decides. ${REFUSED_WORDS}`;
  const canary = proposal.canary;
  if (canary !== undefined) {
    if (!isObj(canary)) return 'canary must be {window_s?, device_id?}.';
    const extra = Object.keys(canary).filter((k) => k !== 'window_s' && k !== 'device_id');
    if (extra.length) return `canary.${extra[0]} isn’t something a change can set. ${REFUSED_WORDS}`;
    if (canary.window_s !== undefined) {
      if (!Number.isInteger(canary.window_s)) return 'canary.window_s is a whole number of seconds.';
      if ((canary.window_s as number) < MIN_CANARY_S[kind]) return `It asks for a ${canary.window_s} s canary; a ${kind} change is watched for at least ${MIN_CANARY_S[kind]} s. ${REFUSED_WORDS}`;
      if ((canary.window_s as number) > MAX_CANARY_S) return `A canary can last at most ${MAX_CANARY_S / 86_400} days.`;
    }
  }
  if (!isObj(artifact)) return null;
  // Its own probe adds to the core probes; it can't stand in for them.
  const probe = artifact.probe;
  if (isObj(probe) && (probe.replaces !== undefined || probe.core === false)) return `Its probe tries to replace the core probes. ${REFUSED_WORDS}`;
  if (kind === 'config') {
    if (typeof artifact.section === 'string' && PIPELINE.test(artifact.section)) return `It changes the ${artifact.section} settings, which hold the pipeline’s gates. ${REFUSED_WORDS}`;
    if (typeof artifact.key === 'string' && PIPELINE_TARGET.test(artifact.key)) return `It changes ${artifact.section}.${artifact.key}, a setting about the pipeline. ${REFUSED_WORDS}`;
  }
  if (kind === 'extension' && isObj(artifact.manifest)) {
    const perms = Array.isArray(artifact.manifest.permissions) ? artifact.manifest.permissions : [];
    if (perms.some((p) => isObj(p) && typeof p.target === 'string' && PIPELINE_TARGET.test(p.target) && p.kind === 'data-write')) {
      return `It asks to change the pipeline’s own records. ${REFUSED_WORDS}`;
    }
  }
  if (kind === 'trigger-rules' && Array.isArray(artifact.rules)) {
    for (const r of artifact.rules) {
      const owner = isObj(r) && isObj(r.action) && isObj(r.action.task) ? r.action.task.owner : null;
      if (typeof owner === 'string' && PIPELINE.test(owner)) return `Its rule “${String((r as Record<string, unknown>).name)}” would start the pipeline’s own work. ${REFUSED_WORDS}`;
    }
  }
  // Nothing a change carries is written into Nova's code.
  if (isObj(artifact.files) && Object.keys(artifact.files).some((p) => /^(\.\/)?(src|ui|scripts|design-systems|node_modules)\//.test(p) || p.includes('..'))) {
    return 'Its files reach outside its own folder, into Nova’s code. Changes never write to core.';
  }
  return null;
}
