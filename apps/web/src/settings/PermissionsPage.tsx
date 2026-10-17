// Settings → Permissions (FR-190, FR-084 partial, FR-191, FR-100; docs/12 §2.1, §3, §4, §7.1):
// the folders tools may use, the permission profile and approval policy (security settings, so
// managed policy can lock them), policy rules, command rules, remembered approvals with Revoke,
// and a preview of what the policy engine would decide for a call.
import { useEffect, useId, useState } from 'react';
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
import { useSettings } from '../settings.tsx';
import { MANAGED, formatWhen } from './common.ts';
import { CommandRulesSection } from './CommandRules.tsx';
import { PolicyRulesSection } from './PolicyRules.tsx';
import { TIER_TEXT, grantDurationText } from './policy-text.ts';
import { EffectChip } from './ToolsPage.tsx';
import '../workspace.css';

export function PermissionsPage() {
  return (
    <div className="settings-page">
      <h2>Permissions</h2>
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
        toast.show(`Could not save the folders: ${errorMessage(err)}`, { tone: 'error' });
        return false;
      },
    );

  const add = async () => {
    const p = path.trim();
    if (!isAbsolutePath(p)) {
      setError('Enter a full path on the Hub, for example /home/sam/notes.');
      return;
    }
    if (roots.value.some((r) => r.path === p)) {
      setError('This folder is already listed.');
      return;
    }
    setError(null);
    const root: Root = { path: p, access, ...(label.trim() ? { label: label.trim() } : {}) };
    if (await save([...roots.value, root], `${p} added.`)) {
      setPath('');
      setLabel('');
      setAccess('read');
    }
  };

  return (
    <section className="settings-section" aria-labelledby="perm-folders">
      <h3 id="perm-folders">Folders</h3>
      <p className="muted">
        Folders on the Hub that file and command tools may use. The Hub&apos;s own workspace folder
        is always included. Protected locations such as .git, keys and credentials stay read-only or
        hidden inside every folder.
      </p>
      {locked ? <p className="nv-field-hint nv-field-lock">{MANAGED}</p> : null}
      {roots.value.length ? (
        <ul className="ws-list" aria-label="Folders">
          {roots.value.map((r, i) => (
            <li key={r.path} className="ws-list-row" aria-label={r.label ?? r.path}>
              <div className="ws-source-main">
                {r.label ? <strong>{r.label}</strong> : null}
                <code className="ws-code-inline">{r.path}</code>
              </div>
              <div className="row ws-row-actions">
                <SelectField
                  label={`Access to ${r.path}`}
                  hideLabel
                  value={r.access}
                  locked={locked}
                  onChange={(v) =>
                    void save(
                      roots.value.map((x, j) =>
                        j === i ? { ...x, access: v as 'read' | 'write' } : x,
                      ),
                      `${r.path} is now ${v === 'write' ? 'read and write' : 'read only'}.`,
                    )
                  }
                  options={[
                    { value: 'read', label: 'Read only' },
                    { value: 'write', label: 'Read and write' },
                  ]}
                />
                <Button
                  variant="ghost"
                  disabled={locked}
                  aria-label={`Remove ${r.path}`}
                  onClick={() =>
                    void save(
                      roots.value.filter((_, j) => j !== i),
                      `${r.path} removed.`,
                    )
                  }
                >
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No extra folders. Tools use only the Hub workspace folder.</p>
      )}
      {!locked ? (
        <form
          className="ws-toolbar"
          aria-label="Add a folder"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <TextField
            label="Folder path"
            value={path}
            spellCheck={false}
            autoComplete="off"
            placeholder="/home/sam/notes"
            error={error ?? undefined}
            onChange={(e) => {
              setPath(e.target.value);
              setError(null);
            }}
          />
          <SelectField
            label="Access"
            value={access}
            onChange={(v) => setAccess(v as 'read' | 'write')}
            options={[
              { value: 'read', label: 'Read only' },
              { value: 'write', label: 'Read and write' },
            ]}
          />
          <TextField
            label="Label"
            value={label}
            maxLength={100}
            onChange={(e) => setLabel(e.target.value)}
          />
          <Button type="submit" disabled={!path.trim()}>
            Add folder
          </Button>
        </form>
      ) : null}
    </section>
  );
}

// ---- profile and approval policy (docs/12 §2.1, §7.1) ---------------------------------------------

const POLICY_OPTIONS = [
  {
    value: 'ask_always',
    label: 'Ask every time',
    description:
      'Ask before every action that is not read-only, unless a rule or a remembered approval allows it.',
  },
  {
    value: 'defaults',
    label: 'Use tool defaults',
    description: 'Each tool’s default decides: read-only tools run, consequential ones ask.',
  },
  {
    value: 'review',
    label: 'Auto-review',
    description:
      'Pre-approvable actions inside the profile run; consequential ones go to the auto-reviewer, which can only be stricter.',
  },
  {
    value: 'never_ask',
    label: 'Skip tool-default questions',
    description:
      'A tool default that asks becomes allow. Your rules, managed policy and actions that must be confirmed still ask.',
  },
] as const;

export function profileSummary(p: PermissionProfileView): string {
  const fs = p.fs.map((e) => `${e.access} ${e.path.replace(/^:/, '')}`).join(', ');
  const net =
    p.network.mode === 'off'
      ? 'no network'
      : p.network.mode === 'allowlist'
        ? `network: ${p.network.allow.length ? p.network.allow.join(', ') : 'allow list'}`
        : 'limited network';
  const vm = p.requiresSubstrate ? '; only inside a VM or container' : '';
  return `${fs || 'no files'}; ${net}${vm}.`;
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
      (err: unknown) => alive && setError(errorMessage(err, 'Could not load the profiles.')),
    );
    return () => {
      alive = false;
    };
  }, [api]);

  const fail = (err: unknown) =>
    toast.show(`Could not save: ${errorMessage(err)}`, { tone: 'error' });
  const list =
    profiles ??
    // Until the list loads (or if it fails), the current choice is still shown.
    [];
  const options = list.map((p) => ({
    value: p.id,
    label: p.builtin ? p.name : `${p.name} (custom)`,
    description: profileSummary(p),
  }));
  if (!options.some((o) => o.value === profile.value))
    options.unshift({ value: profile.value, label: profile.value, description: '' });

  return (
    <section className="settings-section" aria-labelledby="perm-profile">
      <h3 id="perm-profile">What tools may do</h3>
      {error ? (
        <p role="alert" className="nv-field-error">
          {error}
        </p>
      ) : null}
      {profiles === null && !error ? <Spinner label="Loading profiles" /> : null}
      <RadioGroup
        legend="Permission profile"
        name="permission-profile"
        value={profile.value}
        locked={profile.locked}
        hint="What the sandbox lets tools in chats read, write and reach."
        onChange={(v) => void settings.set('tools.permissionProfile', v).catch(fail)}
        options={options}
      />
      <RadioGroup
        legend="When to ask"
        name="approval-policy"
        value={policy.value}
        locked={policy.locked}
        onChange={(v) =>
          void settings
            .set('tools.approvalPolicy', v as (typeof POLICY_OPTIONS)[number]['value'])
            .catch(fail)
        }
        options={[...POLICY_OPTIONS]}
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
      (err: unknown) =>
        alive && setError(errorMessage(err, 'Could not load remembered approvals.')),
    );
    return () => {
      alive = false;
    };
  }, [api, version]);

  const revoke = async (g: PermissionGrantView) => {
    try {
      await api.revokeGrant(g.id);
      setGrants((list) => list?.filter((x) => x.id !== g.id) ?? null);
      toast.show(`Revoked: ${g.label}. Nova asks again next time.`, { tone: 'success' });
    } catch (err) {
      toast.show(`Could not revoke ${g.label}: ${errorMessage(err)}`, { tone: 'error' });
    }
  };

  return (
    <section className="settings-section" aria-labelledby="perm-grants">
      <h3 id="perm-grants">Remembered approvals</h3>
      <p className="muted">
        Approvals you answered with Allow for this session or Always allow. Revoke one and Nova asks
        again.
      </p>
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setVersion((v) => v + 1)}>Retry</Button>
        </div>
      ) : null}
      {grants === null && !error ? <Spinner label="Loading remembered approvals" /> : null}
      {grants?.length === 0 ? (
        <EmptyState
          level={3}
          title="No remembered approvals"
          description="They appear here when you allow an action for a session or always."
        />
      ) : null}
      {grants?.length ? (
        <ul className="ws-list" aria-label="Remembered approvals">
          {grants.map((g) => (
            <li key={g.id} className="ws-list-row" aria-label={g.label}>
              <div className="ws-source-main">
                <strong>{g.label}</strong>
                <span className="muted ws-row-meta">
                  <span>{grantDurationText(g)}</span>
                  {g.scopeKind && g.scopeKind !== 'global' ? (
                    <span>
                      In this {g.scopeKind}
                      {g.scopeRef ? ` (${g.scopeRef})` : ''}
                    </span>
                  ) : null}
                  {g.expiresAt ? (
                    <span>Expires {new Date(g.expiresAt).toLocaleString()}</span>
                  ) : null}
                  <span>Added {formatWhen(g.createdAt)}</span>
                </span>
              </div>
              <Button
                variant="ghost"
                aria-label={`Revoke ${g.label}`}
                onClick={() => void revoke(g)}
              >
                Revoke
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
        setArgsError('Arguments must be JSON, for example {"path": "notes/plan.md"}.');
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
      setFailure(errorMessage(err, 'Could not preview the decision.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section" aria-labelledby="perm-preview">
      <h3 id="perm-preview">Preview a decision</h3>
      <p className="muted">See what Nova would do for a tool call. Nothing runs.</p>
      <form
        className="stack"
        aria-label="Preview a decision"
        onSubmit={(e) => {
          e.preventDefault();
          if (tool.trim()) void run();
        }}
      >
        <TextField
          label="Tool"
          value={tool}
          list={`${id}-tools`}
          spellCheck={false}
          autoComplete="off"
          placeholder="fs.write"
          onChange={(e) => setTool(e.target.value)}
        />
        <datalist id={`${id}-tools`}>
          {tools.map((t) => (
            <option key={t.name} value={t.name} />
          ))}
        </datalist>
        <div className="nv-field">
          <label className="nv-field-label" htmlFor={`${id}-args`}>
            Arguments (JSON, optional)
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
          <span>As if you asked for it in a message</span>
        </label>
        <div className="row">
          <Button type="submit" disabled={busy || !tool.trim()}>
            {busy ? <Spinner /> : null} Preview
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
              <span>Tier: {TIER_TEXT[result.tier]}</span>
              <span>Decided by: {result.source}</span>
              {result.ruleId ? <span>Rule: {result.ruleId}</span> : null}
            </span>
          </div>
        ) : null}
      </div>
    </section>
  );
}
