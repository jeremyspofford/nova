// Site templates (M10b plan, "Site templates"): a flow that ended verified becomes a validated,
// versioned decision template for its site, through the decision-template path that exists
// (propose → dry runs → activation as a ledger task whose dry runs Nova re-runs itself).
//
// The template's dry runs *are* the flow: one case per step, holding the step itself (sign-in
// values are never in a step) and the ground truth seen after it in the run that succeeded: the
// path the page was on, and the selector the next step needed. Negative controls (a wrong path, a
// missing marker, an obstacle) expect `stop`, so the rule is checked both ways before activation.
// The rule is deterministic: the next run follows the steps and re-checks each step's ground truth
// through it. Whatever a template says, its steps go through the plan validator, which refuses the
// pay control.
import { CoreError } from '../errors.ts';
import type { DryRunCase, Rule, Template, TemplateDef } from '../decide.ts';
import { FLOW_NAME, type Step } from './plan.ts';
import { siteHost } from './logins.ts';

export const FLOW_PREFIX = 'browser-site.';

export function flowTemplateId(host: string, name: string): string {
  if (!FLOW_NAME.test(name)) throw new CoreError('validation', 'A flow’s name is lowercase letters, digits and dashes.');
  return `${FLOW_PREFIX}${siteHost(host).replace(/:/g, '-')}.${name}`;
}

export interface LearntStep { step: Step; path: string; marker: string }
export interface Learnt { host: string; name: string; steps: LearntStep[] }

export function flowDef(host: string, name: string, version: number): TemplateDef {
  return {
    template_id: flowTemplateId(host, name),
    version,
    situation: `Whether a step of the flow “${name}” Nova learnt on ${siteHost(host)} is on track: after the step, the page is at the path the flow expects, the element the next step needs is there, and nothing (a sign-in, a CAPTCHA, a paywall) is in the way.`,
    inputs: { step: 'number', action: 'string', expect_path: 'string', seen_path: 'string', expect_marker: 'string', marker_seen: 'boolean', obstacle: 'boolean' },
    questions: [{ id: 'on_track', type: 'noul' }, { id: 'next', type: 'choice', options: ['continue', 'stop', 'unknown'] }],
    escalation: { confidence_floor: 0.5 },
  };
}

// The ground truth, as a rule: on track only when the path and the marker are as learnt and
// nothing is in the way.
export const FLOW_RULE: Rule = (i) => {
  const why: string[] = [];
  if (i.seen_path !== i.expect_path) why.push(`the page is at ${String(i.seen_path)}, not ${String(i.expect_path)}`);
  if (i.expect_marker !== '' && i.marker_seen !== true) why.push(`${String(i.expect_marker)} isn’t on the page`);
  if (i.obstacle === true) why.push('something is in the way');
  const ok = why.length === 0;
  return { answers: { on_track: ok ? 1 : 0, next: ok ? 'continue' : 'stop' }, confidence: 1, why: ok ? `Step ${String(i.step)} is on track.` : `Step ${String(i.step)}: ${why.join('; ')}.` };
};

const CONTROL = -1;

export function dryRuns(l: Learnt): DryRunCase[] {
  const cases: DryRunCase[] = l.steps.map((s, i) => ({
    inputs: { step: i, action: JSON.stringify(s.step), expect_path: s.path, seen_path: s.path, expect_marker: s.marker, marker_seen: true, obstacle: false },
    expect: { next: 'continue' },
  }));
  const first = l.steps[0];
  const marked = l.steps.find((s) => s.marker);
  if (first) {
    cases.push({ inputs: { step: CONTROL, action: '', expect_path: first.path, seen_path: `${first.path === '/' ? '' : first.path}/nova-check-elsewhere`, expect_marker: '', marker_seen: true, obstacle: false }, expect: { next: 'stop' } });
    cases.push({ inputs: { step: CONTROL, action: '', expect_path: first.path, seen_path: first.path, expect_marker: '', marker_seen: true, obstacle: true }, expect: { next: 'stop' } });
  }
  if (marked) cases.push({ inputs: { step: CONTROL, action: '', expect_path: marked.path, seen_path: marked.path, expect_marker: marked.marker, marker_seen: false, obstacle: false }, expect: { next: 'stop' } });
  return cases;
}

// The flow in an active template: its steps, in order, with what each should leave the page at.
export function stepsOf(t: Pick<Template, 'dry_runs' | 'template_id' | 'version'>): LearntStep[] {
  const cases = t.dry_runs.filter((c) => c.expect?.next === 'continue' && typeof c.inputs.step === 'number' && (c.inputs.step as number) >= 0)
    .sort((a, b) => (a.inputs.step as number) - (b.inputs.step as number));
  if (!cases.length) throw new CoreError('validation', `${t.template_id} v${t.version} has no steps.`);
  return cases.map((c) => {
    let step: Step;
    try { step = JSON.parse(String(c.inputs.action)) as Step; } catch { throw new CoreError('validation', `${t.template_id} v${t.version} has a step Nova can’t read.`); }
    return { step, path: String(c.inputs.expect_path ?? ''), marker: String(c.inputs.expect_marker ?? '') };
  });
}

// The selector a step needs on the page before it runs, for the step before's marker.
export function markerOf(s: Step | undefined): string {
  if (!s) return '';
  if (s.do === 'login') return s.username;
  if (s.do === 'checkout') return s.total;
  if ('selector' in s && typeof s.selector === 'string') return s.selector;
  return '';
}
