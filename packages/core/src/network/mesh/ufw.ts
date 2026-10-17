// The Hub's firewall (docs/22 §6 step 5): with ufw present, the assistant adds `allow` rules for
// the Hub's port on the mesh interface (and WireGuard's UDP port); it never enables, disables or
// resets ufw and never adds a deny rule, so applying cannot cut an existing path. Undo deletes
// only the rules this step added. Without ufw the step is a report of the ports to open.
import type { NetworkSetupStepKind } from '@nova/shared';
import type { MeshCommand, MeshExec } from './runner.ts';
import { firstLine } from './tailscale.ts';
import { check, type MeshStepHandler } from './types.ts';

export interface FirewallRule {
  port: number;
  proto: 'tcp' | 'udp';
  /** Only on this interface; null for any. */
  iface: string | null;
}

export interface FirewallDetection {
  tool: 'ufw' | null;
  active: boolean | null;
  detail: string | null;
}

/** The rule spec shared by `allow` and `delete allow`. */
export function ufwRuleArgs(r: FirewallRule): string[] {
  return r.iface
    ? ['in', 'on', r.iface, 'to', 'any', 'port', String(r.port), 'proto', r.proto]
    : [`${r.port}/${r.proto}`];
}

export function ufwAllow(r: FirewallRule): MeshCommand {
  return { bin: 'ufw', args: ['allow', ...ufwRuleArgs(r), 'comment', 'nova'], timeoutMs: 30_000 };
}

export function ufwDelete(r: FirewallRule): MeshCommand {
  return { bin: 'ufw', args: ['delete', 'allow', ...ufwRuleArgs(r)], timeoutMs: 30_000 };
}

/** `ufw show added` lists rules as the commands that made them. */
function hasRule(added: string, r: FirewallRule): boolean {
  const spec = ['allow', ...ufwRuleArgs(r)].join(' ');
  return added.split('\n').some((l) => l.trim().startsWith(`ufw ${spec}`));
}

async function added(exec: MeshExec): Promise<string | null> {
  const r = await exec.run({ bin: 'ufw', args: ['show', 'added'], timeoutMs: 30_000 });
  return r.code === 0 ? r.stdout : null;
}

export async function detectUfw(exec: MeshExec): Promise<FirewallDetection> {
  const v = await exec.run({ bin: 'ufw', args: ['version'], timeoutMs: 10_000 });
  if (v.code !== 0) return { tool: null, active: null, detail: 'ufw is not installed' };
  const s = await exec.run({ bin: 'ufw', args: ['status'], timeoutMs: 10_000 });
  const m = /Status:\s*(active|inactive)/.exec(s.stdout);
  return {
    tool: 'ufw',
    active: m ? m[1] === 'active' : null,
    detail: m ? null : (firstLine(s.stderr) ?? 'status unreadable (needs root)'),
  };
}

export const ufwHandler: MeshStepHandler = {
  async snapshot(step, ctx) {
    const rules = step.params.rules as FirewallRule[];
    const text = (await added(ctx.exec)) ?? '';
    return { existing: rules.map((r) => hasRule(text, r)) };
  },
  async apply(step, ctx, snap) {
    const rules = step.params.rules as FirewallRule[];
    const existing = snap.existing as boolean[];
    for (const [i, r] of rules.entries()) if (!existing[i]) await ctx.exec.must(ufwAllow(r));
  },
  async verify(step, ctx) {
    const rules = step.params.rules as FirewallRule[];
    const text = await added(ctx.exec);
    if (text === null) return [check('firewall rules', false, 'ufw rules unreadable')];
    return rules.map((r) =>
      check(`ufw allows ${r.port}/${r.proto}${r.iface ? ` on ${r.iface}` : ''}`, hasRule(text, r)),
    );
  },
  // Only the rules this step added and that are there now: a rule whose `allow` failed is not
  // "deleted" (ufw would refuse, and stop the undo before the rules that need it).
  async undo(step, ctx, snap) {
    const rules = step.params.rules as FirewallRule[];
    const existing = Array.isArray(snap.existing) ? (snap.existing as boolean[]) : [];
    const text = await added(ctx.exec);
    if (text === null) throw new Error('the ufw rules could not be read');
    const errors: string[] = [];
    for (const [i, r] of [...rules.entries()].reverse()) {
      if (existing[i] === true || !hasRule(text, r)) continue;
      try {
        await ctx.exec.must(ufwDelete(r));
      } catch (err) {
        errors.push((err as Error).message);
      }
    }
    if (errors.length) throw new Error(errors.join('; '));
  },
  undoCommands(step, snap) {
    const rules = step.params.rules as FirewallRule[];
    const existing = Array.isArray(snap.existing) ? (snap.existing as boolean[]) : [];
    // Newest first, like every undo.
    return rules
      .filter((_r, i) => existing[i] !== true)
      .map(ufwDelete)
      .reverse();
  },
};

export function firewallHandler(kind: NetworkSetupStepKind): MeshStepHandler | null {
  return kind === 'firewall.ports' ? ufwHandler : null;
}
