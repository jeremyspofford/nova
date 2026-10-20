// Skills (FR-046, docs/14 §1.1 "skill roots and shadowed skills"): every skill with its source,
// the skill that shadows it by precedence (managed > project > user > plugin > built-in), an
// on/off switch and its body; user skills can be created here and user or project skills deleted.
import { useEffect, useState } from 'react';
import { defineMessages, fmt } from '@nova/i18n';
import type { SkillDetail, SkillView } from '@nova/shared';
import { Button, Dialog, EmptyState, Spinner, Switch, TextField, useToast } from '@nova/ui';
import { errorMessage, type CreateSkillRequest } from '../api.ts';
import { useServices } from '../services.tsx';
import { SKILL_SOURCE_TEXT } from './plugin-text.ts';

export const SKILLS_TEXT = defineMessages('settings.skills', {
  nameRule: 'Use 1 to 64 lowercase letters, digits and hyphens, starting with a letter or digit.',
  needDescription: 'Say what the skill does; Nova uses this to pick it.',
  tooLong: 'Keep it under {max} characters.',
  tooManyTools: 'List at most {max} tools.',
  needBody: 'Write the instructions the skill gives.',
  loadFailed: 'Could not load skills.',
  changeFailed: 'Could not change {name}: {error}',
  deleted: 'Skill {name} deleted.',
  deleteFailed: 'Could not delete {name}: {error}',
  title: 'Skills',
  intro:
    "Only a skill's name and description sit in a chat until it is used; type /name in the " +
    'composer to use one. When two skills share a name, managed wins over project, then yours, ' +
    'then plugins, then built-in.',
  newSkill: 'New skill',
  retry: 'Retry',
  loading: 'Loading skills',
  none: 'No skills yet',
  noneHint: 'Create one, install a plugin that brings some, or import them.',
  shadowedBy:
    'Shadowed by {name} ({source, select, builtin {built-in} user {yours} project {project} plugin {plugin} managed {managed} import {imported} other {{source}}}); this one is not used.',
  shadowedById: 'Shadowed by {id}; this one is not used.',
  toggle: 'Use {name}',
  viewName: 'View {name}',
  view: 'View',
  deleteName: 'Delete {name}',
  delete: 'Delete',
  created: 'Skill {name} created. Use it with /{name}.',
  deleteTitle: 'Delete the skill {name}?',
  deleteThis: 'Delete this skill?',
  deleteBody: 'Its folder and files are deleted from the Hub.',
  cancel: 'Cancel',
  loadOneFailed: 'Could not load the skill.',
  skillTitle: 'Skill {name}',
  close: 'Close',
  loadingOne: 'Loading the skill',
  source: 'Source',
  sourceOf: '{source} ({plugin})',
  whenToUse: 'When to use',
  tools: 'Tools it may use',
  anyTool: 'Any allowed tool',
  files: 'Files',
  instructions: 'Instructions',
  createFailed: 'Could not create the skill.',
  createTitle: 'New skill',
  createBody: 'Saved as SKILL.md in your skills folder on the Hub.',
  name: 'Name',
  nameHint: 'Lowercase letters, digits and hyphens; you type /name to use it.',
  description: 'Description',
  whenToUseOptional: 'When to use (optional)',
  toolsOptional: 'Tools it may use (optional)',
  toolsHint:
    'Tool names separated by commas, for example fs.read, web.search. Empty allows any tool ' +
    'the chat may use.',
  create: 'Create skill',
});
const S = SKILLS_TEXT;

export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface SkillForm {
  name: string;
  description: string;
  whenToUse: string;
  allowedTools: string;
  body: string;
}

export const EMPTY_SKILL: SkillForm = {
  name: '',
  description: '',
  whenToUse: '',
  allowedTools: '',
  body: '',
};

/** The create body, or the field errors; nothing is sent while any field is invalid. */
export function skillRequest(
  f: SkillForm,
): { body: CreateSkillRequest } | { errors: Partial<Record<keyof SkillForm, string>> } {
  const errors: Partial<Record<keyof SkillForm, string>> = {};
  const name = f.name.trim();
  if (!SKILL_NAME.test(name)) errors.name = S.nameRule;
  const description = f.description.trim();
  if (!description) errors.description = S.needDescription;
  else if (description.length > 1024) errors.description = S.tooLong({ max: 1024 });
  if (f.whenToUse.trim().length > 1024) errors.whenToUse = S.tooLong({ max: 1024 });
  const tools = f.allowedTools
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (tools.length > 50) errors.allowedTools = S.tooManyTools({ max: 50 });
  if (!f.body.trim()) errors.body = S.needBody;
  if (Object.keys(errors).length) return { errors };
  return {
    body: {
      name,
      description,
      body: f.body,
      ...(f.whenToUse.trim() ? { whenToUse: f.whenToUse.trim() } : {}),
      ...(tools.length ? { allowedTools: tools } : {}),
    },
  };
}

export function SkillsSection({ version }: { version: number }) {
  const { api } = useServices();
  const toast = useToast();
  const [skills, setSkills] = useState<SkillView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [viewing, setViewing] = useState<SkillView | null>(null);
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<SkillView | null>(null);

  useEffect(() => {
    let alive = true;
    api.listSkills().then(
      ({ items }) => {
        if (!alive) return;
        setSkills(items);
        setError(null);
      },
      (err: unknown) => alive && setError(errorMessage(err, S.loadFailed)),
    );
    return () => {
      alive = false;
    };
  }, [api, version, reload]);

  const byId = new Map((skills ?? []).map((s) => [s.id, s]));

  const toggle = async (s: SkillView, on: boolean) => {
    try {
      const next = await api.updateSkill(s.id, { enabled: on });
      setSkills((list) => list?.map((x) => (x.id === s.id ? next : x)) ?? null);
    } catch (err) {
      toast.show(S.changeFailed({ name: s.name, error: errorMessage(err) }), { tone: 'error' });
    }
  };

  const remove = async (s: SkillView) => {
    setRemoving(null);
    try {
      await api.deleteSkill(s.id);
      toast.show(S.deleted({ name: s.name }), { tone: 'success' });
      setReload((r) => r + 1);
    } catch (err) {
      toast.show(S.deleteFailed({ name: s.name, error: errorMessage(err) }), { tone: 'error' });
    }
  };

  return (
    <section className="settings-section" aria-labelledby="plugins-skills">
      <h3 id="plugins-skills">{S.title}</h3>
      <p className="muted">{S.intro}</p>
      <div className="row">
        <Button onClick={() => setCreating(true)}>{S.newSkill}</Button>
      </div>
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setReload((r) => r + 1)}>{S.retry}</Button>
        </div>
      ) : null}
      {skills === null && !error ? <Spinner label={S.loading} /> : null}
      {skills?.length === 0 ? (
        <EmptyState level={3} title={S.none} description={S.noneHint} />
      ) : null}
      {skills?.length ? (
        <ul className="ws-list" aria-label={S.title}>
          {skills.map((s) => {
            const winner = s.shadowedBy ? byId.get(s.shadowedBy) : undefined;
            const deletable = s.source === 'user' || s.source === 'project';
            return (
              <li key={s.id} className="ws-list-row" aria-label={s.name}>
                <div className="ws-source-main">
                  <span className="ws-row-meta">
                    <strong>/{s.name}</strong>
                    <span className="ws-badge">{SKILL_SOURCE_TEXT[s.source]}</span>
                    {s.pluginId ? <span className="muted">{s.pluginId}</span> : null}
                  </span>
                  <span className="muted" dir="auto">
                    {s.description}
                  </span>
                  {s.shadowedBy ? (
                    <span className="ws-row-meta ws-warning">
                      {winner
                        ? S.shadowedBy({ name: winner.name, source: winner.source })
                        : S.shadowedById({ id: s.shadowedBy })}
                    </span>
                  ) : null}
                </div>
                <div className="row ws-row-actions">
                  <Switch
                    label={S.toggle({ name: s.name })}
                    checked={s.enabled}
                    onChange={(v) => void toggle(s, v)}
                  />
                  <Button
                    variant="ghost"
                    onClick={() => setViewing(s)}
                    aria-label={S.viewName({ name: s.name })}
                  >
                    {S.view}
                  </Button>
                  {deletable ? (
                    <Button
                      variant="ghost"
                      onClick={() => setRemoving(s)}
                      aria-label={S.deleteName({ name: s.name })}
                    >
                      {S.delete}
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      {viewing ? <SkillViewer skill={viewing} onClose={() => setViewing(null)} /> : null}
      {creating ? (
        <SkillCreator
          onClose={() => setCreating(false)}
          onCreated={(s) => {
            setCreating(false);
            toast.show(S.created({ name: s.name }), { tone: 'success' });
            setReload((r) => r + 1);
          }}
        />
      ) : null}
      <Dialog
        open={removing !== null}
        title={removing ? S.deleteTitle({ name: removing.name }) : S.deleteThis}
        description={S.deleteBody}
        onClose={() => setRemoving(null)}
        footer={
          <>
            <Button onClick={() => setRemoving(null)}>{S.cancel}</Button>
            <Button variant="danger" onClick={() => removing && void remove(removing)}>
              {S.delete}
            </Button>
          </>
        }
      />
    </section>
  );
}

function SkillViewer({ skill, onClose }: { skill: SkillView; onClose: () => void }) {
  const { api } = useServices();
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.getSkill(skill.id).then(
      (d) => alive && setDetail(d),
      (err: unknown) => alive && setError(errorMessage(err, S.loadOneFailed)),
    );
    return () => {
      alive = false;
    };
  }, [api, skill.id]);

  return (
    <Dialog
      open
      title={S.skillTitle({ name: skill.name })}
      description={skill.description}
      onClose={onClose}
      className="ws-wide-dialog"
      footer={<Button onClick={onClose}>{S.close}</Button>}
    >
      {error ? (
        <p role="alert" className="nv-field-error">
          {error}
        </p>
      ) : null}
      {!detail && !error ? <Spinner label={S.loadingOne} /> : null}
      {detail ? (
        <div className="stack">
          <dl className="ws-dl">
            <dt>{S.source}</dt>
            <dd>
              {detail.pluginId
                ? S.sourceOf({ source: SKILL_SOURCE_TEXT[detail.source], plugin: detail.pluginId })
                : SKILL_SOURCE_TEXT[detail.source]}
            </dd>
            {detail.whenToUse ? (
              <>
                <dt>{S.whenToUse}</dt>
                <dd dir="auto">{detail.whenToUse}</dd>
              </>
            ) : null}
            <dt>{S.tools}</dt>
            <dd>
              {detail.allowedTools.length
                ? fmt.list(detail.allowedTools, { type: 'unit' })
                : S.anyTool}
            </dd>
            {detail.files.length ? (
              <>
                <dt>{S.files}</dt>
                <dd dir="ltr">{fmt.list(detail.files, { type: 'unit' })}</dd>
              </>
            ) : null}
          </dl>
          <pre role="group" className="ws-log" tabIndex={0} aria-label={S.instructions}>
            {detail.body}
          </pre>
        </div>
      ) : null}
    </Dialog>
  );
}

function SkillCreator({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (s: SkillView) => void;
}) {
  const { api } = useServices();
  const [form, setForm] = useState<SkillForm>(EMPTY_SKILL);
  const [errors, setErrors] = useState<Partial<Record<keyof SkillForm, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof SkillForm) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    const out = skillRequest(form);
    if ('errors' in out) {
      setErrors(out.errors);
      return;
    }
    setErrors({});
    setFailure(null);
    setBusy(true);
    try {
      onCreated(await api.createSkill(out.body));
    } catch (err) {
      setFailure(errorMessage(err, S.createFailed));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={S.createTitle}
      description={S.createBody}
      onClose={onClose}
      className="ws-wide-dialog"
    >
      <form
        className="stack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextField
          label={S.name}
          value={form.name}
          spellCheck={false}
          hint={S.nameHint}
          error={errors.name}
          onChange={(e) => set('name')(e.target.value)}
        />
        <TextField
          label={S.description}
          value={form.description}
          error={errors.description}
          onChange={(e) => set('description')(e.target.value)}
        />
        <TextField
          label={S.whenToUseOptional}
          value={form.whenToUse}
          error={errors.whenToUse}
          onChange={(e) => set('whenToUse')(e.target.value)}
        />
        <TextField
          label={S.toolsOptional}
          value={form.allowedTools}
          spellCheck={false}
          hint={S.toolsHint}
          error={errors.allowedTools}
          onChange={(e) => set('allowedTools')(e.target.value)}
        />
        <div className="nv-field">
          <label className="nv-field-label" htmlFor="skill-body">
            {S.instructions}
          </label>
          <textarea
            id="skill-body"
            className="nv-input ws-textarea"
            rows={8}
            value={form.body}
            aria-invalid={errors.body ? true : undefined}
            aria-describedby={errors.body ? 'skill-body-error' : undefined}
            onChange={(e) => set('body')(e.target.value)}
          />
          {errors.body ? (
            <span id="skill-body-error" className="nv-field-error" role="alert">
              {errors.body}
            </span>
          ) : null}
        </div>
        {failure ? (
          <p role="alert" className="nv-field-error">
            {failure}
          </p>
        ) : null}
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>{S.cancel}</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? <Spinner /> : null} {S.create}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
