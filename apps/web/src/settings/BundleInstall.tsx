// Install an MCP server from a bundle (FR-199, docs/08 §2.5): pick the file, then review the
// preview: its signature state, a form generated from its typed user config (sensitive values
// as password fields; they go to the vault), and the permissions Nova proposes, which you confirm
// or narrow. An unverified bundle needs an explicit sideload confirmation.
import { useRef, useState } from 'react';
import { defineMessages, fmt } from '@nova/i18n';
import type { BundleConfigField, BundlePreview, McpServerView } from '@nova/shared';
import { Button, Dialog, Icon, RadioGroup, Spinner, TextField, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { readAsBase64 } from '../chat/attachments.ts';
import { useServices } from '../services.tsx';
import { VerifiedBadge } from './badges.tsx';

/** The Hub accepts bundles up to 50 MB. */
export const BUNDLE_MAX_BYTES = 50 * 1024 * 1024;

export const BUNDLE_TEXT = defineMessages('settings.bundle', {
  serverType: {
    node: 'Node.js',
    python: 'Python',
    uv: 'Python (built with uv)',
    binary: 'a program for this platform',
  },
  fs: {
    none: 'No file access',
    read: 'Read the files and folders entered above',
    project: 'Read and write the folders entered above',
  },
  needValue: 'Enter {field}.',
  notNumber: '{field} must be a number.',
  tooBig: '{name} is {size}; bundles can be at most {max}.',
  readFailed: 'Could not read {name}: {error}',
  install: 'Install a bundle',
  file: 'Bundle file',
  installFailed: 'Could not install the bundle.',
  title: 'Install {name} {version}?',
  cancel: 'Cancel',
  installButton: 'Install',
  by: 'by {author}',
  runsWith: 'Runs with {runtime}',
  unverified:
    'Unverified: this bundle is not signed by a publisher you trust. It stays labelled ' +
    'Unverified in your server list and the audit log.',
  sideload: 'I trust where this bundle came from; install it unverified',
  warnings: 'Warnings',
  tools: 'Tools it offers',
  toolsAsk: 'Its tools ask you first until you change their defaults.',
  settings: 'Settings',
  permissions: 'Permissions to confirm',
  hosts: 'Hosts it may reach',
  noNetwork: 'No network access.',
  files: 'Files',
  notSandboxed:
    "Nova records these permissions with the server. MCP servers are not sandboxed yet: this one runs as the Hub's user, so install it only if you trust where it came from.",
  optional: '{field} (optional)',
  sensitiveHint: 'Stored in the vault; it is never shown again.',
  pathHint: 'A full path on the Hub.',
  perLine: 'One per line.',
});
const S = BUNDLE_TEXT;

const FS_VALUES: readonly BundlePreview['permissions']['fs'][] = ['none', 'read', 'project'];

export type ConfigDraft = Record<string, string | boolean>;

/** Form values to start from: defaults, never for sensitive fields. */
export function initialConfig(fields: readonly BundleConfigField[]): ConfigDraft {
  const out: ConfigDraft = {};
  for (const f of fields) {
    const d = f.default;
    const scalar = (v: unknown) =>
      typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
    if (f.type === 'boolean') out[f.key] = d === true;
    else if (f.sensitive) out[f.key] = '';
    else if (Array.isArray(d)) out[f.key] = d.map(scalar).filter(Boolean).join('\n');
    else out[f.key] = scalar(d);
  }
  return out;
}

/** Typed user config for the install request, or an error per field. */
export function configValues(
  fields: readonly BundleConfigField[],
  draft: ConfigDraft,
): { values: Record<string, unknown> } | { errors: Record<string, string> } {
  const values: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const raw = draft[f.key];
    if (f.type === 'boolean') {
      values[f.key] = raw === true;
      continue;
    }
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text) {
      if (f.required) errors[f.key] = S.needValue({ field: f.title.toLowerCase() });
      continue;
    }
    if (f.type === 'number') {
      const n = Number(text);
      if (!Number.isFinite(n)) errors[f.key] = S.notNumber({ field: f.title });
      else values[f.key] = n;
      continue;
    }
    if (f.multiple) {
      values[f.key] = text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      continue;
    }
    values[f.key] = text;
  }
  return Object.keys(errors).length ? { errors } : { values };
}

/** A button that reads a bundle file and opens its install preview. */
export function BundleInstallButton({ onInstalled }: { onInstalled: (s: McpServerView) => void }) {
  const { api } = useServices();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);
  const [preview, setPreview] = useState<BundlePreview | null>(null);

  const pick = async (file: File) => {
    if (file.size > BUNDLE_MAX_BYTES) {
      toast.show(
        S.tooBig({
          name: file.name,
          size: fmt.bytes(file.size),
          max: fmt.bytes(BUNDLE_MAX_BYTES),
        }),
        { tone: 'error' },
      );
      return;
    }
    setReading(true);
    try {
      const data = await readAsBase64(file);
      setPreview(await api.previewBundle({ name: file.name, data }));
    } catch (err) {
      toast.show(S.readFailed({ name: file.name, error: errorMessage(err) }), { tone: 'error' });
    } finally {
      setReading(false);
    }
  };

  return (
    <>
      <Button onClick={() => input.current?.click()} disabled={reading}>
        {reading ? <Spinner /> : <Icon name="download" />} {S.install}
      </Button>
      <input
        ref={input}
        type="file"
        accept=".mcpb,.zip,application/zip"
        hidden
        aria-label={S.file}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void pick(file);
        }}
      />
      {preview ? (
        <BundlePreviewDialog
          preview={preview}
          onClose={() => setPreview(null)}
          onInstalled={(s) => {
            setPreview(null);
            onInstalled(s);
          }}
        />
      ) : null}
    </>
  );
}

function BundlePreviewDialog({
  preview,
  onClose,
  onInstalled,
}: {
  preview: BundlePreview;
  onClose: () => void;
  onInstalled: (s: McpServerView) => void;
}) {
  const { api } = useServices();
  const [draft, setDraft] = useState<ConfigDraft>(() => initialConfig(preview.userConfig));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [hosts, setHosts] = useState<Set<string>>(() => new Set(preview.permissions.network));
  const [fs, setFs] = useState(preview.permissions.fs);
  const [sideload, setSideload] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const unverified = preview.signature === 'unverified';
  const title = preview.displayName ?? preview.name;

  const install = async () => {
    const out = configValues(preview.userConfig, draft);
    if ('errors' in out) {
      setErrors(out.errors);
      return;
    }
    setErrors({});
    setFailure(null);
    setBusy(true);
    try {
      onInstalled(
        await api.installBundle({
          previewId: preview.previewId,
          permissions: { network: preview.permissions.network.filter((h) => hosts.has(h)), fs },
          userConfig: out.values,
          ...(unverified ? { confirmSideload: sideload } : {}),
        }),
      );
    } catch (err) {
      setFailure(errorMessage(err, S.installFailed));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={S.title({ name: title, version: preview.version })}
      description={preview.description}
      onClose={onClose}
      className="ws-wide-dialog"
      footer={
        <>
          <Button onClick={onClose}>{S.cancel}</Button>
          <Button
            variant="primary"
            disabled={busy || (unverified && !sideload)}
            onClick={() => void install()}
          >
            {busy ? <Spinner /> : null} {S.installButton}
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="ws-row-meta">
          <VerifiedBadge verified={!unverified} />
          <code className="ws-code-inline" dir="ltr">
            {preview.name}
          </code>
          {preview.author ? (
            <span className="muted">{S.by({ author: preview.author })}</span>
          ) : null}
          <span className="muted">{S.runsWith({ runtime: S.serverType[preview.serverType] })}</span>
        </p>
        {unverified ? (
          <div className="ws-callout" role="note">
            <Icon name="alert" />
            <div className="stack">
              <p>{S.unverified}</p>
              <label className="ws-check">
                <input
                  type="checkbox"
                  checked={sideload}
                  onChange={(e) => setSideload(e.target.checked)}
                />
                <span>{S.sideload}</span>
              </label>
            </div>
          </div>
        ) : null}
        {preview.warnings.length ? (
          <ul className="ws-plain-list" aria-label={S.warnings}>
            {preview.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        ) : null}
        {preview.tools.length ? (
          <section aria-labelledby="bundle-tools">
            <h3 id="bundle-tools" className="ws-subhead">
              {S.tools}
            </h3>
            <ul className="ws-plain-list">
              {preview.tools.map((t) => (
                <li key={t.name}>
                  <code className="ws-code-inline" dir="ltr">
                    {t.name}
                  </code>
                  {t.description ? ` ${t.description}` : ''}
                </li>
              ))}
            </ul>
            <p className="muted">{S.toolsAsk}</p>
          </section>
        ) : null}
        {preview.userConfig.length ? (
          <section aria-labelledby="bundle-config" className="stack">
            <h3 id="bundle-config" className="ws-subhead">
              {S.settings}
            </h3>
            {preview.userConfig.map((f) => (
              <ConfigField
                key={f.key}
                field={f}
                value={draft[f.key] ?? ''}
                error={errors[f.key]}
                onChange={(v) => setDraft((d) => ({ ...d, [f.key]: v }))}
              />
            ))}
          </section>
        ) : null}
        <section aria-labelledby="bundle-perms" className="stack">
          <h3 id="bundle-perms" className="ws-subhead">
            {S.permissions}
          </h3>
          {preview.permissions.network.length ? (
            <fieldset className="ws-fieldset">
              <legend>{S.hosts}</legend>
              {preview.permissions.network.map((h) => (
                <label key={h} className="ws-check">
                  <input
                    type="checkbox"
                    checked={hosts.has(h)}
                    onChange={(e) =>
                      setHosts((s) => {
                        const next = new Set(s);
                        if (e.target.checked) next.add(h);
                        else next.delete(h);
                        return next;
                      })
                    }
                  />
                  <span dir="ltr">{h}</span>
                </label>
              ))}
            </fieldset>
          ) : (
            <p className="muted">{S.noNetwork}</p>
          )}
          <RadioGroup
            legend={S.files}
            name="bundle-fs"
            value={fs}
            onChange={(v) => setFs(v as BundlePreview['permissions']['fs'])}
            options={FS_VALUES.map((value) => ({ value, label: S.fs[value] }))}
          />
          <p className="muted">{S.notSandboxed}</p>
        </section>
        {failure ? (
          <p role="alert" className="nv-field-error">
            {failure}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

function ConfigField({
  field: f,
  value,
  error,
  onChange,
}: {
  field: BundleConfigField;
  value: string | boolean;
  error: string | undefined;
  onChange: (v: string | boolean) => void;
}) {
  const label = f.required ? f.title : S.optional({ field: f.title });
  const hint =
    [
      f.description,
      f.sensitive ? S.sensitiveHint : null,
      f.type === 'directory' || f.type === 'file' ? S.pathHint : null,
      f.multiple ? S.perLine : null,
    ]
      .filter(Boolean)
      .join(' ') || undefined;
  if (f.type === 'boolean') {
    return (
      <label className="ws-check">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>{f.title}</span>
        {f.description ? <span className="muted">{f.description}</span> : null}
      </label>
    );
  }
  const text = typeof value === 'string' ? value : '';
  if (f.multiple) {
    const id = `bundle-cfg-${f.key}`;
    return (
      <div className="nv-field">
        <label className="nv-field-label" htmlFor={id}>
          {label}
        </label>
        <textarea
          id={id}
          className="nv-input ws-textarea"
          rows={3}
          value={text}
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={
            [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') ||
            undefined
          }
          onChange={(e) => onChange(e.target.value)}
        />
        {hint ? (
          <span id={`${id}-hint`} className="nv-field-hint">
            {hint}
          </span>
        ) : null}
        {error ? (
          <span id={`${id}-error`} className="nv-field-error" role="alert">
            {error}
          </span>
        ) : null}
      </div>
    );
  }
  return (
    <TextField
      label={label}
      type={f.sensitive ? 'password' : f.type === 'number' ? 'number' : 'text'}
      autoComplete={f.sensitive ? 'new-password' : 'off'}
      spellCheck={false}
      value={text}
      hint={hint}
      error={error}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
