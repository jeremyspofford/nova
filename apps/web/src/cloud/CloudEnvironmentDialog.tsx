// New cloud environment (FR-071, FR-062; docs/10 §2, §12): repositories cloned side by side under
// /workspace, a setup script run once (its result is kept until an explicit rebuild), an optional
// base image and caches, the network (off; only for the setup script or always only while the owner
// allows unrestricted network in Settings → Cloud runner, since that traffic skips the Hub's egress
// rules), the disk it may use
// (at most the cap in Settings → Cloud runner) and the folder sessions work in. It is made on the
// runner first, so the runner must be set up and on. The Hub checks the same rules; this form
// explains them before a request fails.
import { useId, useRef, useState } from 'react';
import type { z } from 'zod';
import {
  createCloudEnvironmentSchema,
  repoUrlHasCredentials,
  type CloudRunnerView,
  type SavedEnvironmentView,
} from '@nova/shared';
import { Button, Dialog, Icon, RadioGroup, Spinner, TextField } from '@nova/ui';
import { useSettings } from '../settings.tsx';
import { useCloudApi } from './api.ts';
import {
  CLOUD_SETTINGS_PATH,
  NETWORK_DESCRIPTION,
  NETWORK_TEXT,
  cloudErrorMessage,
  runnerUsable,
} from './format.ts';
import { InAppLink } from './parts.tsx';

type Body = z.input<typeof createCloudEnvironmentSchema>;
type Network = 'off' | 'setup' | 'on';

export interface CloudDraft {
  label: string;
  repos: string;
  setupScript: string;
  baseImage: string;
  caches: string;
  network: Network;
  diskMb: string;
  folder: string;
}

export const EMPTY_CLOUD_DRAFT: CloudDraft = {
  label: '',
  repos: '',
  setupScript: '',
  baseImage: '',
  caches: '',
  network: 'off',
  diskMb: '',
  folder: '',
};

const FIELD_TEXT: Record<string, string> = {
  label: 'Enter a name, up to 100 characters.',
  repoUrls: 'Enter each repository as an https:// address, one per line (at most 10).',
  setupScript: 'The setup script can be up to 20,000 characters.',
  baseImage: 'Enter an image reference in lowercase, such as node:22.',
  caches: 'Name each cache with lowercase letters, digits, - or _ (at most 8).',
  diskMb: 'Enter the disk size in whole MB.',
  folder: 'Enter a folder under /workspace, such as /workspace/app.',
};

/** The create body, or the field errors the Hub would answer with. */
export function buildCloudEnvironment(
  d: CloudDraft,
  diskCapMb: number,
  networkAllowed = true,
): { label: string; connection: Body['connection'] } | { errors: Record<string, string> } {
  const lines = (s: string) =>
    s
      .split(/[\n,]/)
      .map((x) => x.trim())
      .filter(Boolean);
  const errors: Record<string, string> = {};
  if (d.network !== 'off' && !networkAllowed)
    errors.network =
      'Cloud environments get no network on this Hub. Turn on Unrestricted network in Settings → Cloud runner first.';
  if (lines(d.repos).some(repoUrlHasCredentials))
    errors.repoUrls =
      'Leave user names and passwords out of repository addresses. Private repositories need access set up on the runner.';
  let diskMb: number | undefined;
  if (d.diskMb.trim()) {
    diskMb = Number(d.diskMb.trim());
    if (!/^\d+$/.test(d.diskMb.trim())) errors.diskMb = FIELD_TEXT.diskMb!;
    else if (diskMb > diskCapMb)
      errors.diskMb = `At most ${diskCapMb.toLocaleString()} MB, the cap in Settings → Cloud runner.`;
  }
  const body: Body = {
    kind: 'cloud',
    label: d.label.trim(),
    connection: {
      repoUrls: lines(d.repos),
      network: d.network,
      ...(d.setupScript.trim() ? { setupScript: d.setupScript } : {}),
      ...(d.baseImage.trim() ? { baseImage: d.baseImage.trim() } : {}),
      ...(d.caches.trim() ? { caches: lines(d.caches) } : {}),
      ...(diskMb !== undefined && !errors.diskMb ? { diskMb } : {}),
      ...(d.folder.trim() ? { folder: d.folder.trim() } : {}),
    },
  };
  const parsed = createCloudEnvironmentSchema.safeParse(body);
  if (!parsed.success)
    for (const issue of parsed.error.issues) {
      const key = String(issue.path.find((p) => typeof p === 'string' && p in FIELD_TEXT) ?? '');
      const field = key || String(issue.path[issue.path.length - 1] ?? 'label');
      errors[field] ??= FIELD_TEXT[field] ?? issue.message;
    }
  return Object.keys(errors).length
    ? { errors }
    : { label: body.label, connection: body.connection };
}

export function CloudEnvironmentDialog({
  open,
  runner,
  onClose,
  onCreated,
}: {
  open: boolean;
  /** The runner as last loaded; creation needs it set up and on. */
  runner: CloudRunnerView | null;
  onClose: () => void;
  onCreated: (e: SavedEnvironmentView) => void;
}) {
  return open ? (
    <CloudEnvironmentForm runner={runner} onClose={onClose} onCreated={onCreated} />
  ) : null;
}

function CloudEnvironmentForm({
  runner,
  onClose,
  onCreated,
}: {
  runner: CloudRunnerView | null;
  onClose: () => void;
  onCreated: (e: SavedEnvironmentView) => void;
}) {
  const api = useCloudApi();
  const settings = useSettings();
  const id = `ce${useId()}`;
  const first = useRef<HTMLInputElement>(null);
  const capMb = (runner?.caps ?? settings.get('cloud.runner.caps').value).diskMb;
  const [d, setD] = useState<CloudDraft>(EMPTY_CLOUD_DRAFT);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof CloudDraft>(k: K, v: CloudDraft[K]) =>
    setD((x) => ({ ...x, [k]: v }));
  const networkAllowed = settings.get('cloud.runner.unrestrictedNetwork').value;
  const built = buildCloudEnvironment(
    networkAllowed ? d : { ...d, network: 'off' },
    capMb,
    networkAllowed,
  );
  const errors = tried && 'errors' in built ? built.errors : {};
  const usable = runner ? runnerUsable(runner) : false;

  const submit = async () => {
    setTried(true);
    if ('errors' in built || busy || !usable) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(await api.createCloudEnvironment(built.label, built.connection));
    } catch (err) {
      setError(cloudErrorMessage(err, 'Could not create the environment.'));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title="New cloud environment"
      description="Repositories, a setup script and caches on the cloud runner. Code sessions and Work runs there keep going while your devices are off."
      onClose={onClose}
      initialFocusRef={first}
      className="ws-wide-dialog"
    >
      <form
        id={id}
        className="stack cl-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {!usable ? (
          <p className="ws-callout" role="note">
            <Icon name="alert" />
            <span>
              {runner?.state === 'unconfigured' || !runner
                ? 'No cloud runner is set up yet.'
                : !runner.enabled
                  ? 'The cloud runner is turned off.'
                  : 'The cloud runner cannot be reached.'}{' '}
              <InAppLink to={CLOUD_SETTINGS_PATH}>Open Settings → Cloud runner</InAppLink>
            </span>
          </p>
        ) : null}
        <TextField
          ref={first}
          label="Name"
          value={d.label}
          maxLength={100}
          autoComplete="off"
          required
          error={errors.label}
          onChange={(e) => set('label', e.target.value)}
        />
        <TextArea
          id={`${id}-repos`}
          label="Repositories"
          value={d.repos}
          rows={3}
          placeholder="https://github.com/team/app.git"
          hint="One https:// address per line; add #branch to pick a branch. They are cloned side by side under /workspace."
          error={errors.repoUrls}
          onChange={(v) => set('repos', v)}
        />
        <TextArea
          id={`${id}-setup`}
          label="Setup script (optional)"
          value={d.setupScript}
          rows={4}
          placeholder="npm ci"
          hint="Runs once in the first repository after cloning. Its result stays until you rebuild."
          error={errors.setupScript}
          onChange={(v) => set('setupScript', v)}
        />
        {networkAllowed ? (
          <>
            <RadioGroup
              legend="Network"
              name={`${id}-net`}
              value={d.network}
              onChange={(v) => set('network', v as Network)}
              options={(['off', 'setup', 'on'] as const).map((n) => ({
                value: n,
                label: NETWORK_TEXT[n],
                description: NETWORK_DESCRIPTION[n],
              }))}
            />
            {errors.network ? (
              <p className="nv-field-error" role="alert">
                {errors.network}
              </p>
            ) : null}
          </>
        ) : (
          <p className="muted cl-small">
            <Icon name="shield" /> No network: cloud commands on this Hub never reach the network,
            because their traffic would not pass its egress rules. The owner can allow it under
            Unrestricted network in{' '}
            <InAppLink to={CLOUD_SETTINGS_PATH}>Settings → Cloud runner</InAppLink>.
          </p>
        )}
        <details className="ws-advanced">
          <summary>More options</summary>
          <div className="stack">
            <TextField
              label="Base image (optional)"
              value={d.baseImage}
              autoComplete="off"
              spellCheck={false}
              placeholder="node:22"
              hint="The container image commands run in, when the runner uses containers."
              error={errors.baseImage}
              onChange={(e) => set('baseImage', e.target.value)}
            />
            <TextField
              label="Caches (optional)"
              value={d.caches}
              autoComplete="off"
              spellCheck={false}
              placeholder="npm, pip"
              hint="Folders kept across rebuilds, by name."
              error={errors.caches}
              onChange={(e) => set('caches', e.target.value)}
            />
            <TextField
              label="Disk (MB)"
              type="number"
              inputMode="numeric"
              className="ws-number"
              min={16}
              max={capMb}
              value={d.diskMb}
              placeholder={String(capMb)}
              hint={`At most ${capMb.toLocaleString()} MB.`}
              error={errors.diskMb}
              onChange={(e) => set('diskMb', e.target.value)}
            />
            <TextField
              label="Folder for sessions (optional)"
              value={d.folder}
              autoComplete="off"
              spellCheck={false}
              placeholder="/workspace/app"
              hint="Without it, the first repository."
              error={errors.folder}
              onChange={(e) => set('folder', e.target.value)}
            />
          </div>
        </details>
        {error ? (
          <p className="nv-field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || !usable}>
            {busy ? <Spinner /> : null} Create environment
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** A labelled textarea in the field style. */
export function TextArea({
  id,
  label,
  value,
  rows = 3,
  placeholder,
  hint,
  error,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  rows?: number;
  placeholder?: string;
  hint?: string;
  error?: string | undefined;
  onChange: (v: string) => void;
}) {
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-err` : null]
    .filter(Boolean)
    .join(' ');
  return (
    <div className="nv-field">
      <label className="nv-field-label" htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        className="nv-input ws-textarea cl-mono"
        rows={rows}
        spellCheck={false}
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint ? (
        <span id={`${id}-hint`} className="nv-field-hint">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={`${id}-err`} className="nv-field-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
