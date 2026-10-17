// Skills (FR-046, docs/14 §1.1 "skill roots and shadowed skills"): every skill with its source,
// the skill that shadows it by precedence (managed > project > user > plugin > built-in), an
// on/off switch and its body; user skills can be created here and user or project skills deleted.
import { useEffect, useState } from 'react';
import type { SkillDetail, SkillView } from '@nova/shared';
import { Button, Dialog, EmptyState, Spinner, Switch, TextField, useToast } from '@nova/ui';
import { errorMessage, type CreateSkillRequest } from '../api.ts';
import { useServices } from '../services.tsx';
import { SKILL_SOURCE_TEXT } from './plugin-text.ts';

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
  if (!SKILL_NAME.test(name))
    errors.name =
      'Use 1 to 64 lowercase letters, digits and hyphens, starting with a letter or digit.';
  const description = f.description.trim();
  if (!description) errors.description = 'Say what the skill does; Nova uses this to pick it.';
  else if (description.length > 1024) errors.description = 'Keep it under 1,024 characters.';
  if (f.whenToUse.trim().length > 1024) errors.whenToUse = 'Keep it under 1,024 characters.';
  const tools = f.allowedTools
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (tools.length > 50) errors.allowedTools = 'List at most 50 tools.';
  if (!f.body.trim()) errors.body = 'Write the instructions the skill gives.';
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
      (err: unknown) => alive && setError(errorMessage(err, 'Could not load skills.')),
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
      toast.show(`Could not change ${s.name}: ${errorMessage(err)}`, { tone: 'error' });
    }
  };

  const remove = async (s: SkillView) => {
    setRemoving(null);
    try {
      await api.deleteSkill(s.id);
      toast.show(`Skill ${s.name} deleted.`, { tone: 'success' });
      setReload((r) => r + 1);
    } catch (err) {
      toast.show(`Could not delete ${s.name}: ${errorMessage(err)}`, { tone: 'error' });
    }
  };

  return (
    <section className="settings-section" aria-labelledby="plugins-skills">
      <h3 id="plugins-skills">Skills</h3>
      <p className="muted">
        Only a skill&apos;s name and description sit in a chat until it is used; type /name in the
        composer to use one. When two skills share a name, managed wins over project, then yours,
        then plugins, then built-in.
      </p>
      <div className="row">
        <Button onClick={() => setCreating(true)}>New skill</Button>
      </div>
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setReload((r) => r + 1)}>Retry</Button>
        </div>
      ) : null}
      {skills === null && !error ? <Spinner label="Loading skills" /> : null}
      {skills?.length === 0 ? (
        <EmptyState
          level={3}
          title="No skills yet"
          description="Create one, install a plugin that brings some, or import them."
        />
      ) : null}
      {skills?.length ? (
        <ul className="ws-list" aria-label="Skills">
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
                  <span className="muted">{s.description}</span>
                  {s.shadowedBy ? (
                    <span className="ws-row-meta ws-warning">
                      Shadowed by{' '}
                      {winner
                        ? `${winner.name} (${SKILL_SOURCE_TEXT[winner.source].toLowerCase()})`
                        : s.shadowedBy}
                      ; this one is not used.
                    </span>
                  ) : null}
                </div>
                <div className="row ws-row-actions">
                  <Switch
                    label={`Use ${s.name}`}
                    checked={s.enabled}
                    onChange={(v) => void toggle(s, v)}
                  />
                  <Button
                    variant="ghost"
                    onClick={() => setViewing(s)}
                    aria-label={`View ${s.name}`}
                  >
                    View
                  </Button>
                  {deletable ? (
                    <Button
                      variant="ghost"
                      onClick={() => setRemoving(s)}
                      aria-label={`Delete ${s.name}`}
                    >
                      Delete
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
            toast.show(`Skill ${s.name} created. Use it with /${s.name}.`, { tone: 'success' });
            setReload((r) => r + 1);
          }}
        />
      ) : null}
      <Dialog
        open={removing !== null}
        title={removing ? `Delete the skill ${removing.name}?` : 'Delete this skill?'}
        description="Its folder and files are deleted from the Hub."
        onClose={() => setRemoving(null)}
        footer={
          <>
            <Button onClick={() => setRemoving(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => removing && void remove(removing)}>
              Delete
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
      (err: unknown) => alive && setError(errorMessage(err, 'Could not load the skill.')),
    );
    return () => {
      alive = false;
    };
  }, [api, skill.id]);

  return (
    <Dialog
      open
      title={`Skill ${skill.name}`}
      description={skill.description}
      onClose={onClose}
      className="ws-wide-dialog"
      footer={<Button onClick={onClose}>Close</Button>}
    >
      {error ? (
        <p role="alert" className="nv-field-error">
          {error}
        </p>
      ) : null}
      {!detail && !error ? <Spinner label="Loading the skill" /> : null}
      {detail ? (
        <div className="stack">
          <dl className="ws-dl">
            <dt>Source</dt>
            <dd>
              {SKILL_SOURCE_TEXT[detail.source]}
              {detail.pluginId ? ` (${detail.pluginId})` : ''}
            </dd>
            {detail.whenToUse ? (
              <>
                <dt>When to use</dt>
                <dd>{detail.whenToUse}</dd>
              </>
            ) : null}
            <dt>Tools it may use</dt>
            <dd>
              {detail.allowedTools.length ? detail.allowedTools.join(', ') : 'Any allowed tool'}
            </dd>
            {detail.files.length ? (
              <>
                <dt>Files</dt>
                <dd>{detail.files.join(', ')}</dd>
              </>
            ) : null}
          </dl>
          <pre className="ws-log" tabIndex={0} aria-label="Instructions">
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
      setFailure(errorMessage(err, 'Could not create the skill.'));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title="New skill"
      description="Saved as SKILL.md in your skills folder on the Hub."
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
          label="Name"
          value={form.name}
          spellCheck={false}
          hint="Lowercase letters, digits and hyphens; you type /name to use it."
          error={errors.name}
          onChange={(e) => set('name')(e.target.value)}
        />
        <TextField
          label="Description"
          value={form.description}
          error={errors.description}
          onChange={(e) => set('description')(e.target.value)}
        />
        <TextField
          label="When to use (optional)"
          value={form.whenToUse}
          error={errors.whenToUse}
          onChange={(e) => set('whenToUse')(e.target.value)}
        />
        <TextField
          label="Tools it may use (optional)"
          value={form.allowedTools}
          spellCheck={false}
          hint="Tool names separated by commas, for example fs.read, web.search. Empty allows any tool the chat may use."
          error={errors.allowedTools}
          onChange={(e) => set('allowedTools')(e.target.value)}
        />
        <div className="nv-field">
          <label className="nv-field-label" htmlFor="skill-body">
            Instructions
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
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? <Spinner /> : null} Create skill
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
