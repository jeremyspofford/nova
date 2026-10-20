// Settings → Permissions (FR-190, FR-084 partial, FR-191, FR-100; docs/12 §2.1, §3, §4, §7.1):
// the folders tools may use, the permission profile and approval policy (security settings, so
// managed policy can lock them), policy rules, command rules, remembered approvals with Revoke,
// and a preview of what the policy engine would decide for a call.
import { useEffect, useId, useState } from 'react';
import { defineMessages, fmt } from '@nova/i18n';
import type {
  PermissionGrantView,
  PermissionProfileView,
  PolicyPreview,
  ToolView,
} from '@nova/shared';
import {
  Button,
  EmptyState,
  RadioGroup,
  SelectField,
  Spinner,
  TextField,
  useToast,
} from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useServices } from '../services.tsx';
import { ManagedNote } from '../managed/ManagedNote.tsx';
import { useSettings } from '../settings.tsx';
import { formatWhen } from './common.ts';
import { CommandRulesSection } from './CommandRules.tsx';
import { PolicyRulesSection } from './PolicyRules.tsx';
import { TIER_TEXT, grantDurationText } from './policy-text.ts';
import { EffectChip } from './ToolsPage.tsx';
import '../workspace.css';

export const PERMISSIONS_TEXT = defineMessages('settings.permissions', {
  title: 'Permissions',
  foldersSaveFailed: 'Could not save the folders: {error}',
  needPath: 'Enter a full path on the Hub, for example /home/sam/notes.',
  pathExample: '/home/sam/notes',
  alreadyListed: 'This folder is already listed.',
  added: '{path} added.',
  folders: 'Folders',
  foldersHint:
    "Folders on the Hub that file and command tools may use. The Hub's own workspace folder is " +
    'always included. Protected locations such as .git, keys and credentials stay read-only or ' +
    'hidden inside every folder.',
  accessTo: 'Access to {path}',
  nowAccess:
    '{access, select, write {{path} is now read and write.} other {{path} is now read only.}}',
  readOnly: 'Read only',
  readWrite: 'Read and write',
  removeName: 'Remove {path}',
  removed: '{path} removed.',
  remove: 'Remove',
  noFolders: 'No extra folders. Tools use only the Hub workspace folder.',
  addFolderForm: 'Add a folder',
  folderPath: 'Folder path',
  access: 'Access',
  label: 'Label',
  addFolder: 'Add folder',
  policy: {
    ask_always: {
      label: 'Ask every time',
      description:
        'Ask before every action that is not read-only, unless a rule or a remembered approval ' +
        'allows it.',
    },
    defaults: {
      label: 'Use tool defaults',
      description: 'Each tool’s default decides: read-only tools run, consequential ones ask.',
    },
    review: {
      label: 'Auto-review',
      description:
        'Pre-approvable actions inside the profile run; consequential ones go to the ' +
        'auto-reviewer, which can only be stricter.',
    },
    never_ask: {
      label: 'Skip tool-default questions',
      description:
        'A tool default that asks becomes allow. Your rules, managed policy and actions that ' +
        'must be confirmed still ask.',
    },
  },
  fsEntry: '{access, select, read {read {path}} write {write {path}} other {{access} {path}}}',
  noFiles: 'no files',
  noNetwork: 'no network',
  networkHosts: 'network: {hosts}',
  networkAllowList: 'network: allow list',
  limitedNetwork: 'limited network',
  summary: '{files}; {network}.',
  summaryVm: '{files}; {network}; only inside a VM or container.',
  profilesFailed: 'Could not load the profiles.',
  saveFailed: 'Could not save: {error}',
  custom: '{name} (custom)',
  whatToolsMayDo: 'What tools may do',
  loadingProfiles: 'Loading profiles',
  profile: 'Permission profile',
  profileHint: 'What the sandbox lets tools in chats read, write and reach.',
  whenToAsk: 'When to ask',
  grantsFailed: 'Could not load remembered approvals.',
  revoked: 'Revoked: {label}. Nova asks again next time.',
  revokeFailed: 'Could not revoke {label}: {error}',
  grants: 'Remembered approvals',
  grantsHint:
    'Approvals you answered with Allow for this session or Always allow. Revoke one and Nova ' +
    'asks again.',
  retry: 'Retry',
  loadingGrants: 'Loading remembered approvals',
  noGrants: 'No remembered approvals',
  noGrantsHint: 'They appear here when you allow an action for a session or always.',
  inScope:
    '{kind, select, project {In this project} thread {In this chat} agent {In this agent} space {In this space} other {In this {kind}}}',
  inScopeRef:
    '{kind, select, project {In this project ({ref})} thread {In this chat ({ref})} agent {In this agent ({ref})} space {In this space ({ref})} other {In this {kind} ({ref})}}',
  expires: 'Expires {when}',
  addedAt: 'Added {when}',
  revokeName: 'Revoke {label}',
  revoke: 'Revoke',
  argsJson: 'Arguments must be JSON, for example {example}.',
  previewFailed: 'Could not preview the decision.',
  preview: 'Preview a decision',
  previewHint: 'See what Nova would do for a tool call. Nothing runs.',
  tool: 'Tool',
  argsLabel: 'Arguments (JSON, optional)',
  asIfAsked: 'As if you asked for it in a message',
  previewButton: 'Preview',
  tier: 'Tier: {tier}',
  decidedBy: 'Decided by: {source}',
  rule: 'Rule: {id}',
});
const S = PERMISSIONS_TEXT;
// Examples typed into fields: a tool name and JSON, the same in every language.
const TOOL_EXAMPLE = 'fs.write';
const ARGS_EXAMPLE = '{"path": "notes/plan.md"}';

export function PermissionsPage() {
  return (
    <div className="settings-page">
      <h2>{S.title}</h2>
      <FoldersSection />
      <ProfileSection />
      <PolicyRulesSection />
      <CommandRulesSection />
      <GrantsSection />
      <PreviewSection />
    </div>
  );
}

// ---- folders (FR-190, `tools.roots`) -------------------------------------------------------------------

type Root = { path: string; access: 'read' | 'write'; label?: string };

/** A full path on the Hub: POSIX, a drive letter, or a UNC share. */
export function isAbsolutePath(p: string): boolean {
  return /^(\/|[A-Za-z]:[\\/]|\\\\[^\\])/.test(p);
}

function FoldersSection() {
  const settings = useSettings();
  const toast = useToast();
  const roots = settings.get('tools.roots');
  const [path, setPath] = useState('');
  const [access, setAccess] = useState<'read' | 'write'>('read');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const locked = roots.locked;

  const save = (next: Root[], done: string) =>
    settings.set('tools.roots', next).then(
      () => {
        toast.show(done, { tone: 'success' });
        return true;
      },
      (err: unknown) => {
        toast.show(S.foldersSaveFailed({ error: errorMessage(err) }), { tone: 'error' });
        return false;
      },
    );

  const add = async () => {
    const p = path.trim();
    if (!isAbsolutePath(p)) {
      setError(S.needPath);
      return;
    }
    if (roots.value.some((r) => r.path === p)) {
      setError(S.alreadyListed);
      return;
    }
    setError(null);
    const root: Root = { path: p, access, ...(label.trim() ? { label: label.trim() } : {}) };
    if (await save([...roots.value, root], S.added({ path: p }))) {
      setPath('');
      setLabel('');
      setAccess('read');
    }
  };

  return (
    <section
      className="settings-section"
      aria-labelledby="perm-folders"
      aria-describedby={locked ? 'perm-folders-lock' : undefined}
    >
      <h3 id="perm-folders">{S.folders}</h3>
      <p className="muted">{S.foldersHint}</p>
      {locked ? <ManagedNote as="p" id="perm-folders-lock" setting="tools.roots" /> : null}
      {roots.value.length ? (
        <ul className="ws-list" aria-label={S.folders}>
          {roots.value.map((r, i) => (
            <li key={r.path} className="ws-list-row" aria-label={r.label ?? r.path}>
              <div className="ws-source-main">
                {r.label ? <strong>{r.label}</strong> : null}
                <code className="ws-code-inline" dir="ltr">
                  {r.path}
                </code>
              </div>
              <div className="row ws-row-actions">
                <SelectField
                  label={S.accessTo({ path: r.path })}
                  hideLabel
                  value={r.access}
                  locked={locked}
                  setting="tools.roots"
                  onChange={(v) =>
                    void save(
                      roots.value.map((x, j) =>
                        j === i ? { ...x, access: v as 'read' | 'write' } : x,
                      ),
                      S.nowAccess({ access: v, path: r.path }),
                    )
                  }
                  options={[
                    { value: 'read', label: S.readOnly },
                    { value: 'write', label: S.readWrite },
                  ]}
                />
                <Button
                  variant="ghost"
                  disabled={locked}
                  aria-label={S.removeName({ path: r.path })}
                  onClick={() =>
                    void save(
                      roots.value.filter((_, j) => j !== i),
                      S.removed({ path: r.path }),
                    )
                  }
                >
                  {S.remove}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">{S.noFolders}</p>
      )}
      {!locked ? (
        <form
          className="ws-toolbar"
          aria-label={S.addFolderForm}
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <TextField
            label={S.folderPath}
            value={path}
            spellCheck={false}
            autoComplete="off"
            placeholder={S.pathExample}
            error={error ?? undefined}
            onChange={(e) => {
              setPath(e.target.value);
              setError(null);
            }}
          />
          <SelectField
            label={S.access}
            value={access}
            onChange={(v) => setAccess(v as 'read' | 'write')}
            options={[
              { value: 'read', label: S.readOnly },
              { value: 'write', label: S.readWrite },
            ]}
          />
          <TextField
            label={S.label}
            value={label}
            maxLength={100}
            onChange={(e) => setLabel(e.target.value)}
          />
          <Button type="submit" disabled={!path.trim()}>
            {S.addFolder}
          </Button>
        </form>
      ) : null}
    </section>
  );
}

// ---- profile and approval policy (docs/12 §2.1, §7.1) ---------------------------------------------

const POLICIES = ['ask_always', 'defaults', 'review', 'never_ask'] as const;

/** The approval policies with their words, read in the active locale. */
const policyOptions = () =>
  POLICIES.map((value) => ({
    value,
    label: S.policy[value].label,
    description: S.policy[value].description,
  }));

export function profileSummary(p: PermissionProfileView): string {
  const fs = fmt.list(
    p.fs.map((e) => S.fsEntry({ access: e.access, path: e.path.replace(/^:/, '') })),
    { type: 'unit' },
  );
  const net =
    p.network.mode === 'off'
      ? S.noNetwork
      : p.network.mode === 'allowlist'
        ? p.network.allow.length
          ? S.networkHosts({ hosts: fmt.list(p.network.allow, { type: 'unit' }) })
          : S.networkAllowList
        : S.limitedNetwork;
  const parts = { files: fs || S.noFiles, network: net };
  return p.requiresSubstrate ? S.summaryVm(parts) : S.summary(parts);
}

function ProfileSection() {
  const { api } = useServices();
  const settings = useSettings();
  const toast = useToast();
  const profile = settings.get('tools.permissionProfile');
  const policy = settings.get('tools.approvalPolicy');
  const [profiles, setProfiles] = useState<PermissionProfileView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.listProfiles().then(
      ({ items }) => alive && setProfiles(items),
      (err: unknown) => alive && setError(errorMessage(err, S.profilesFailed)),
    );
    return () => {
      alive = false;
    };
  }, [api]);

  const fail = (err: unknown) =>
    toast.show(S.saveFailed({ error: errorMessage(err) }), { tone: 'error' });
  const list =
    profiles ??
    // Until the list loads (or if it fails), the current choice is still shown.
    [];
  const options = list.map((p) => ({
    value: p.id,
    label: p.builtin ? p.name : S.custom({ name: p.name }),
    description: profileSummary(p),
  }));
  if (!options.some((o) => o.value === profile.value))
    options.unshift({ value: profile.value, label: profile.value, description: '' });

  return (
    <section className="settings-section" aria-labelledby="perm-profile">
      <h3 id="perm-profile">{S.whatToolsMayDo}</h3>
      {error ? (
        <p role="alert" className="nv-field-error">
          {error}
        </p>
      ) : null}
      {profiles === null && !error ? <Spinner label={S.loadingProfiles} /> : null}
      <RadioGroup
        legend={S.profile}
        name="permission-profile"
        value={profile.value}
        locked={profile.locked}
        setting="tools.permissionProfile"
        hint={S.profileHint}
        onChange={(v) => void settings.set('tools.permissionProfile', v).catch(fail)}
        options={options}
      />
      <RadioGroup
        legend={S.whenToAsk}
        name="approval-policy"
        value={policy.value}
        locked={policy.locked}
        setting="tools.approvalPolicy"
        onChange={(v) =>
          void settings.set('tools.approvalPolicy', v as (typeof POLICIES)[number]).catch(fail)
        }
        options={policyOptions()}
      />
    </section>
  );
}

// ---- remembered approvals (FR-100, docs/12 §4.2) ---------------------------------------------------

function GrantsSection() {
  const { api } = useServices();
  const toast = useToast();
  const [grants, setGrants] = useState<PermissionGrantView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let alive = true;
    api.listGrants().then(
      ({ items }) => {
        if (!alive) return;
        setGrants(items);
        setError(null);
      },
      (err: unknown) => alive && setError(errorMessage(err, S.grantsFailed)),
    );
    return () => {
      alive = false;
    };
  }, [api, version]);

  const revoke = async (g: PermissionGrantView) => {
    try {
      await api.revokeGrant(g.id);
      setGrants((list) => list?.filter((x) => x.id !== g.id) ?? null);
      toast.show(S.revoked({ label: g.label }), { tone: 'success' });
    } catch (err) {
      toast.show(S.revokeFailed({ label: g.label, error: errorMessage(err) }), { tone: 'error' });
    }
  };

  return (
    <section className="settings-section" aria-labelledby="perm-grants">
      <h3 id="perm-grants">{S.grants}</h3>
      <p className="muted">{S.grantsHint}</p>
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setVersion((v) => v + 1)}>{S.retry}</Button>
        </div>
      ) : null}
      {grants === null && !error ? <Spinner label={S.loadingGrants} /> : null}
      {grants?.length === 0 ? (
        <EmptyState level={3} title={S.noGrants} description={S.noGrantsHint} />
      ) : null}
      {grants?.length ? (
        <ul className="ws-list" aria-label={S.grants}>
          {grants.map((g) => (
            <li key={g.id} className="ws-list-row" aria-label={g.label}>
              <div className="ws-source-main">
                <strong>{g.label}</strong>
                <span className="muted ws-row-meta">
                  <span>{grantDurationText(g)}</span>
                  {g.scopeKind && g.scopeKind !== 'global' ? (
                    <span>
                      {g.scopeRef
                        ? S.inScopeRef({ kind: g.scopeKind, ref: g.scopeRef })
                        : S.inScope({ kind: g.scopeKind })}
                    </span>
                  ) : null}
                  {g.expiresAt ? (
                    <span>{S.expires({ when: fmt.dateTime(g.expiresAt) })}</span>
                  ) : null}
                  <span>{S.addedAt({ when: formatWhen(g.createdAt) })}</span>
                </span>
              </div>
              <Button
                variant="ghost"
                aria-label={S.revokeName({ label: g.label })}
                onClick={() => void revoke(g)}
              >
                {S.revoke}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

// ---- preview a decision (FR-048: the effective policy is previewable) -----------------------------

function PreviewSection() {
  const { api } = useServices();
  const id = `pv${useId()}`;
  const [tools, setTools] = useState<ToolView[]>([]);
  const [tool, setTool] = useState('');
  const [args, setArgs] = useState('');
  const [userAsked, setUserAsked] = useState(true);
  const [argsError, setArgsError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [result, setResult] = useState<PolicyPreview | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api.listTools().then(
      ({ items }) => alive && setTools(items),
      () => undefined, // the box still works with a typed tool name
    );
    return () => {
      alive = false;
    };
  }, [api]);

  const run = async () => {
    let parsed: unknown;
    if (args.trim()) {
      try {
        parsed = JSON.parse(args);
      } catch {
        setArgsError(S.argsJson({ example: ARGS_EXAMPLE }));
        return;
      }
    }
    setArgsError(null);
    setFailure(null);
    setBusy(true);
    try {
      setResult(
        await api.previewPolicy({
          tool: tool.trim(),
          userAsked,
          ...(parsed !== undefined ? { args: parsed } : {}),
        }),
      );
    } catch (err) {
      setResult(null);
      setFailure(errorMessage(err, S.previewFailed));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section" aria-labelledby="perm-preview">
      <h3 id="perm-preview">{S.preview}</h3>
      <p className="muted">{S.previewHint}</p>
      <form
        className="stack"
        aria-label={S.preview}
        onSubmit={(e) => {
          e.preventDefault();
          if (tool.trim()) void run();
        }}
      >
        <TextField
          label={S.tool}
          value={tool}
          list={`${id}-tools`}
          spellCheck={false}
          autoComplete="off"
          placeholder={TOOL_EXAMPLE}
          onChange={(e) => setTool(e.target.value)}
        />
        <datalist id={`${id}-tools`}>
          {tools.map((t) => (
            <option key={t.name} value={t.name} />
          ))}
        </datalist>
        <div className="nv-field">
          <label className="nv-field-label" htmlFor={`${id}-args`}>
            {S.argsLabel}
          </label>
          <textarea
            id={`${id}-args`}
            className="nv-input ws-textarea"
            rows={3}
            spellCheck={false}
            value={args}
            aria-invalid={argsError ? true : undefined}
            aria-describedby={argsError ? `${id}-args-error` : undefined}
            onChange={(e) => {
              setArgs(e.target.value);
              setArgsError(null);
            }}
          />
          {argsError ? (
            <span id={`${id}-args-error`} className="nv-field-error" role="alert">
              {argsError}
            </span>
          ) : null}
        </div>
        <label className="ws-check">
          <input
            type="checkbox"
            checked={userAsked}
            onChange={(e) => setUserAsked(e.target.checked)}
          />
          <span>{S.asIfAsked}</span>
        </label>
        <div className="row">
          <Button type="submit" disabled={busy || !tool.trim()}>
            {busy ? <Spinner /> : null} {S.previewButton}
          </Button>
        </div>
      </form>
      {failure ? (
        <p role="alert" className="nv-field-error">
          {failure}
        </p>
      ) : null}
      <div role="status" className="ws-preview-result">
        {result ? (
          <div className="panel-inset">
            <span className="ws-row-meta">
              <EffectChip effect={result.effect} />
              <span>{result.reason}</span>
            </span>
            <span className="muted ws-row-meta">
              <span>{S.tier({ tier: TIER_TEXT[result.tier] })}</span>
              <span>{S.decidedBy({ source: result.source })}</span>
              {result.ruleId ? <span>{S.rule({ id: result.ruleId })}</span> : null}
            </span>
          </div>
        ) : null}
      </div>
    </section>
  );
}
