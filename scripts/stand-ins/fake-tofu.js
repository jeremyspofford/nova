#!/usr/bin/env node
// A stand-in for OpenTofu's command line (M10d), for tests only. It is never a real tool and talks to
// no provider: the "infrastructure" is a state file in the project's folder. It speaks the subset of
// the CLI Nova's adapter uses, in OpenTofu's shapes:
//
//   tofu version
//   tofu init -input=false -no-color
//   tofu plan -input=false -no-color [-destroy] -lock=true -detailed-exitcode -out=FILE
//   tofu show -json FILE | tofu show -no-color FILE | tofu show -json   (the state)
//   tofu apply -input=false -no-color FILE
//
// The configuration is `main.tf.json` (OpenTofu's JSON syntax: {"resource": {TYPE: {NAME: {…}}}}),
// the state `terraform.tfstate`. The "provider" needs a credential in STANDIN_TOKEN, as a real one
// would, and is leaky on purpose: it prints the token in its output, so a test can prove Nova keeps
// it out of everything it writes. Each call is written to .fake-tofu-calls.jsonl in the folder (its
// arguments and the names, never the values, of its environment).
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const cwd = process.cwd();
const cmd = args[0];
const flags = args.slice(1);
const flag = (name) => flags.includes(name);
const value = (name) => flags.find((f) => f.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
const files = flags.filter((f) => !f.startsWith('-'));
const out = (s) => process.stdout.write(`${s}\n`);
const fail = (s, code = 1) => { process.stderr.write(`\nError: ${s}\n`); process.exit(code); };

appendFileSync(join(cwd, '.fake-tofu-calls.jsonl'), `${JSON.stringify({ args, env: Object.keys(process.env).sort() })}\n`);

const STATE = join(cwd, 'terraform.tfstate');
const readJson = (p, fallback) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; } };
const state = () => readJson(STATE, { version: 4, serial: 0, lineage: randomUUID(), resources: [] });
const config = () => {
  const c = readJson(join(cwd, 'main.tf.json'), null);
  if (!c) fail('No configuration files: this folder has no main.tf.json.');
  const out = [];
  for (const [type, byName] of Object.entries(c.resource ?? {})) {
    for (const [name, attrs] of Object.entries(byName ?? {})) out.push({ address: `${type}.${name}`, type, name, attrs: attrs ?? {} });
  }
  return out;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const credential = () => {
  const t = process.env.STANDIN_TOKEN;
  if (!t) fail('No valid credential sources found for the stand-in provider (STANDIN_TOKEN).');
  // The leaky provider: it says which token it uses.
  out(`stand-in provider: authenticated with token ${t}`);
  return t;
};

const show = (changes) => {
  const word = { create: '+ create', update: '~ update in-place', delete: '- destroy' };
  const lines = ['OpenTofu used the selected providers to generate the following execution plan.', ''];
  for (const c of changes) {
    const a = c.change.actions[0];
    lines.push(`  # ${c.address} will be ${a === 'create' ? 'created' : a === 'delete' ? 'destroyed' : 'updated in-place'}`);
    lines.push(`  ${word[a]} "${c.type}" "${c.name}" {`);
    const after = c.change.after ?? c.change.before ?? {};
    for (const [k, v] of Object.entries(after)) lines.push(`      ${k} = ${JSON.stringify(v)}`);
    lines.push('    }', '');
  }
  const n = (a) => changes.filter((c) => c.change.actions[0] === a).length;
  lines.push(changes.length ? `Plan: ${n('create')} to add, ${n('update')} to change, ${n('delete')} to destroy.` : 'No changes. Your infrastructure matches the configuration.');
  return lines.join('\n');
};

switch (cmd) {
  case 'version':
    out('OpenTofu v1.8.0-standin');
    break;
  case 'init':
    mkdirSync(join(cwd, '.terraform'), { recursive: true });
    out('OpenTofu has been successfully initialized!');
    break;
  case 'plan': {
    if (!flag('-input=false')) fail('the stand-in wants -input=false, as automation does.');
    credential();
    const planFile = value('-out');
    if (!planFile) fail('the stand-in wants -out=FILE.');
    const s = state();
    const have = new Map(s.resources.map((r) => [`${r.type}.${r.name}`, r]));
    const changes = [];
    if (flag('-destroy')) {
      for (const r of s.resources) changes.push({ address: `${r.type}.${r.name}`, mode: 'managed', type: r.type, name: r.name, change: { actions: ['delete'], before: r.instances[0].attributes, after: null } });
    } else {
      const want = config();
      for (const w of want) {
        const r = have.get(w.address);
        if (!r) changes.push({ address: w.address, mode: 'managed', type: w.type, name: w.name, change: { actions: ['create'], before: null, after: w.attrs } });
        else if (!same(r.instances[0].attributes, w.attrs)) changes.push({ address: w.address, mode: 'managed', type: w.type, name: w.name, change: { actions: ['update'], before: r.instances[0].attributes, after: w.attrs } });
      }
      const names = new Set(want.map((w) => w.address));
      for (const r of s.resources) if (!names.has(`${r.type}.${r.name}`)) changes.push({ address: `${r.type}.${r.name}`, mode: 'managed', type: r.type, name: r.name, change: { actions: ['delete'], before: r.instances[0].attributes, after: null } });
    }
    const plan = { format: 'fake-tofu-plan', lineage: s.lineage, serial: s.serial, resource_changes: changes };
    writeFileSync(planFile, JSON.stringify(plan));
    out(show(changes));
    process.exit(flag('-detailed-exitcode') && changes.length ? 2 : 0);
    break;
  }
  case 'show': {
    if (!files.length) {
      // The state, as `tofu show -json` gives it.
      const s = state();
      const resources = s.resources.map((r) => ({ address: `${r.type}.${r.name}`, mode: 'managed', type: r.type, name: r.name, values: r.instances[0].attributes }));
      out(JSON.stringify({ format_version: '1.0', values: { root_module: { resources } } }));
      break;
    }
    const plan = readJson(files[0], null);
    if (!plan || plan.format !== 'fake-tofu-plan') fail(`${files[0]} isn't a saved plan.`);
    if (flag('-json')) out(JSON.stringify({ format_version: '1.2', resource_changes: plan.resource_changes }));
    else out(show(plan.resource_changes));
    break;
  }
  case 'apply': {
    if (!flag('-input=false')) fail('the stand-in wants -input=false, as automation does.');
    credential();
    if (!files.length) fail('the stand-in applies a saved plan only.');
    const plan = readJson(files[0], null);
    if (!plan || plan.format !== 'fake-tofu-plan') fail(`${files[0]} isn't a saved plan.`);
    const s = state();
    if (existsSync(STATE) && (plan.lineage !== s.lineage || plan.serial !== s.serial)) fail('Saved plan is stale: the state changed since it was made. Make a new plan.');
    const byAddr = new Map(s.resources.map((r) => [`${r.type}.${r.name}`, r]));
    let added = 0; let changed = 0; let destroyed = 0;
    for (const c of plan.resource_changes) {
      const a = c.change.actions[0];
      if (a === 'create') { byAddr.set(c.address, { mode: 'managed', type: c.type, name: c.name, instances: [{ attributes: { ...c.change.after, id: createHash('sha256').update(c.address).digest('hex').slice(0, 12) } }] }); added++; }
      else if (a === 'update') { byAddr.set(c.address, { mode: 'managed', type: c.type, name: c.name, instances: [{ attributes: c.change.after }] }); changed++; }
      else if (a === 'delete') { byAddr.delete(c.address); destroyed++; }
    }
    // The stand-in keeps the configuration's attributes as they were asked for (an id aside), so a
    // second plan of the same configuration has no changes.
    for (const [, r] of byAddr) { const { id: _id, ...rest } = r.instances[0].attributes; r.instances[0].attributes = rest; }
    writeFileSync(STATE, JSON.stringify({ version: 4, serial: s.serial + 1, lineage: s.lineage, resources: [...byAddr.values()] }, null, 2));
    out(`Apply complete! Resources: ${added} added, ${changed} changed, ${destroyed} destroyed.`);
    break;
  }
  default:
    fail(`the stand-in doesn't know “${cmd}”.`);
}
