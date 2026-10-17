// Capabilities (FR-142, FR-148): what this device can serve the Hub and why not (a module missing
// or not allowed, or a novad below the minimum), what it reports about itself (detected facts,
// read-only), and the Advanced overrides the Hub may set. An override replaces the device's own
// value; a blank field leaves the device's value. Everything the device sends is shown as text.
import { useId, useState } from 'react';
import {
  deviceCapabilityOverridesSchema,
  type DeviceCapabilityOverrides,
  type DeviceView,
} from '@nova/shared';
import { Button, Icon, SelectField, TextField, useToast } from '@nova/ui';
import { useDevicesApi } from './api.ts';
import type { PanelProps } from './DevicePage.tsx';
import {
  CAPABILITY_LABEL,
  capabilityReason,
  deviceErrorMessage,
  formatBytes,
  moduleLabel,
  parseQuietHours,
  pathProblem,
} from './format.ts';

const GIB = 1024 ** 3;

type Section = keyof DeviceCapabilityOverrides;
type Kind = 'int' | 'num' | 'gib' | 'text' | 'paths' | 'ranges' | 'select';

interface Field {
  section: Section;
  key: string;
  label: string;
  kind: Kind;
  min?: number;
  max?: number;
  options?: { value: string; label: string }[];
  hint?: string;
}

const SECTION_LABEL: Record<Section, string> = {
  models: 'Models',
  computePolicy: 'Compute',
  scheduling: 'Scheduling',
  limits: 'Network',
  power: 'Power',
  locale: 'Locale',
};

export const OVERRIDE_FIELDS: Field[] = [
  {
    section: 'models',
    key: 'storagePaths',
    label: 'Model folders',
    kind: 'paths',
    hint: 'One full path per line.',
  },
  { section: 'models', key: 'cacheQuotaBytes', label: 'Model cache limit (GB)', kind: 'gib' },
  {
    section: 'computePolicy',
    key: 'gpuSharing',
    label: 'GPU sharing',
    kind: 'select',
    options: [
      { value: 'shared', label: 'Shared with other work' },
      { value: 'exclusive', label: 'Only Nova jobs' },
    ],
  },
  {
    section: 'computePolicy',
    key: 'vramReserveBytes',
    label: 'GPU memory kept free (GB)',
    kind: 'gib',
  },
  {
    section: 'computePolicy',
    key: 'maxConcurrentJobs',
    label: 'Jobs at once',
    kind: 'int',
    min: 0,
  },
  {
    section: 'computePolicy',
    key: 'maxJobDurationSec',
    label: 'Longest job (seconds)',
    kind: 'int',
    min: 1,
  },
  {
    section: 'scheduling',
    key: 'quietHours',
    label: 'Quiet hours the device declares',
    kind: 'ranges',
    hint: 'Like 22:00-07:00; separate several with commas.',
  },
  {
    section: 'scheduling',
    key: 'routingWeight',
    label: 'Routing weight',
    kind: 'num',
    min: 0,
    max: 1000,
    hint: 'Higher gets more work when several devices fit. 0 to 1000.',
  },
  { section: 'scheduling', key: 'energyPriceTier', label: 'Energy price tier', kind: 'text' },
  {
    section: 'limits',
    key: 'maxEgressMbps',
    label: 'Upload limit (Mbps)',
    kind: 'num',
    min: 0,
    max: 100_000,
  },
  { section: 'power', key: 'policy', label: 'Power policy', kind: 'text' },
  {
    section: 'power',
    key: 'thermalLimitC',
    label: 'Thermal limit (°C)',
    kind: 'int',
    min: 30,
    max: 120,
  },
  { section: 'locale', key: 'locale', label: 'Locale', kind: 'text', hint: 'Like en-US.' },
];

const fieldId = (f: Field) => `${f.section}.${f.key}`;

function rec(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/** A value as the field shows it. */
function toText(f: Field, v: unknown): string {
  if (v === undefined || v === null) return '';
  if (f.kind === 'gib' && typeof v === 'number') return String(Math.round((v / GIB) * 100) / 100);
  if (Array.isArray(v)) return v.map(String).join(f.kind === 'paths' ? '\n' : ', ');
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
}

/** What the device reports for a field, for the hint. */
function reportedText(f: Field, v: unknown): string | null {
  if (v === undefined || v === null || (Array.isArray(v) && !v.length)) return null;
  if (f.kind === 'gib' && typeof v === 'number') return formatBytes(v);
  return toText(f, v);
}

export function draftFrom(o: DeviceCapabilityOverrides): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of OVERRIDE_FIELDS) out[fieldId(f)] = toText(f, rec(o[f.section])[f.key]);
  return out;
}

/** The overrides a draft stands for, or the problem with each bad field. */
export function overridesFrom(
  draft: Record<string, string>,
): { ok: true; value: DeviceCapabilityOverrides } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const raw: Record<string, Record<string, unknown>> = {};
  for (const f of OVERRIDE_FIELDS) {
    const id = fieldId(f);
    const text = (draft[id] ?? '').trim();
    if (!text) continue;
    let value: unknown = text;
    if (f.kind === 'int' || f.kind === 'num' || f.kind === 'gib') {
      const n = Number(text);
      const whole = f.kind === 'int';
      if (!Number.isFinite(n) || (whole && !Number.isInteger(n))) {
        errors[id] = `Enter ${whole ? 'a whole number' : 'a number'}.`;
        continue;
      }
      if ((f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max) || n < 0) {
        errors[id] = `Enter a number from ${f.min ?? 0} to ${f.max ?? 'any size'}.`;
        continue;
      }
      value = f.kind === 'gib' ? Math.round(n * GIB) : n;
    } else if (f.kind === 'paths') {
      const paths = text
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      const bad = paths.map(pathProblem).find(Boolean);
      if (bad) {
        errors[id] = bad;
        continue;
      }
      value = paths;
    } else if (f.kind === 'ranges') {
      const r = parseQuietHours(text);
      if ('bad' in r) {
        errors[id] = `“${r.bad}” is not a time range like 22:00-07:00.`;
        continue;
      }
      value = r.ranges;
    }
    (raw[f.section] ??= {})[f.key] = value;
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  const parsed = deviceCapabilityOverridesSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const id = issue.path.slice(0, 2).join('.');
      errors[id] ??= issue.message;
    }
    return { ok: false, errors };
  }
  return { ok: true, value: parsed.data };
}

export function CapabilitiesPanel({ device, onDevice }: PanelProps) {
  return (
    <div className="stack">
      <CapabilityStatuses device={device} />
      <ReportedDocument device={device} />
      <OverridesForm
        key={JSON.stringify(device.capabilityOverrides)}
        device={device}
        onDevice={onDevice}
      />
    </div>
  );
}

function CapabilityStatuses({ device }: { device: DeviceView }) {
  return (
    <section className="ws-section devices-flat" aria-labelledby="caps-status">
      <h2 id="caps-status">What it can do</h2>
      {device.updateRequired ? (
        <p className="devices-note">
          <Icon name="alert" /> Some capabilities need a newer novad. Update the device in the
          Updates tab; it keeps the others meanwhile.
        </p>
      ) : null}
      {device.capabilities.length ? (
        <ul className="devices-caps" aria-label="Capabilities">
          {device.capabilities.map((c) => {
            const why = capabilityReason(c);
            return (
              <li key={c.name} data-available={c.available || undefined}>
                <Icon
                  name={c.available ? 'check' : c.reason === 'update_required' ? 'alert' : 'stop'}
                />
                <span className="devices-cap-name">{CAPABILITY_LABEL[c.name]}</span>
                <span className="muted">
                  {why ?? `Available · ${moduleLabel(c.module)} module`}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="muted ws-flush">The device has not reported its capabilities yet.</p>
      )}
    </section>
  );
}

/** The detected facts worth reading, from the device's signed capability document. */
export function reportedFacts(doc: Record<string, unknown> | null): [string, string][] {
  if (!doc) return [];
  const out: [string, string][] = [];
  const add = (label: string, v: unknown) => {
    if (v === undefined || v === null || v === '') return;
    out.push([label, typeof v === 'string' ? v : JSON.stringify(v)]);
  };
  const hw = rec(doc.hardware);
  add(
    'Processor',
    [hw.arch, typeof hw.cores === 'number' ? `${hw.cores} cores` : null]
      .filter(Boolean)
      .join(', ') || null,
  );
  if (typeof hw.ramBytes === 'number') add('Memory', formatBytes(hw.ramBytes));
  if (Array.isArray(hw.gpus) && hw.gpus.length)
    add(
      'GPUs',
      hw.gpus
        .map((g) => {
          const r = rec(g);
          const vram = typeof r.vramBytes === 'number' ? ` (${formatBytes(r.vramBytes)})` : '';
          return `${typeof r.name === 'string' ? r.name : 'GPU'}${vram}`;
        })
        .join(', '),
    );
  if (Array.isArray(hw.disks) && hw.disks.length)
    add(
      'Disks',
      hw.disks
        .map((x) => {
          const r = rec(x);
          const free = typeof r.freeBytes === 'number' ? `${formatBytes(r.freeBytes)} free` : '';
          return [typeof r.mount === 'string' ? r.mount : '', free].filter(Boolean).join(' ');
        })
        .join(', '),
    );
  const os = rec(doc.os);
  add('System', [os.family, os.version].filter((x) => typeof x === 'string').join(' ') || null);
  const sandbox = Object.entries(rec(os.sandbox))
    .filter(([, v]) => v === true)
    .map(([k]) => k);
  add('Sandbox', sandbox.length ? sandbox.join(', ') : 'None found; commands are refused');
  const services = rec(doc.services);
  if (Array.isArray(services.computeBackends) && services.computeBackends.length)
    add('Model servers', services.computeBackends.join(', '));
  const peripherals = rec(doc.peripherals);
  const have = Object.entries(peripherals)
    .filter(([, v]) => v === true || (typeof v === 'number' && v > 0))
    .map(([k, v]) => (typeof v === 'number' ? `${v} ${k}` : k));
  if (have.length) add('Peripherals', have.join(', '));
  const access = rec(doc.access);
  if (Array.isArray(access.fsScopes))
    add('Shared folders', access.fsScopes.length ? access.fsScopes.join(', ') : 'None');
  const locale = rec(doc.locale);
  add('Time zone', locale.timezone);
  return out;
}

function ReportedDocument({ device }: { device: DeviceView }) {
  const facts = reportedFacts(device.capability);
  return (
    <section className="ws-section devices-flat" aria-labelledby="caps-reported">
      <h2 id="caps-reported">Reported by the device</h2>
      <p className="muted ws-flush">
        Detected on the device, with any changes made there. Only the device can change these.
      </p>
      {facts.length ? (
        <dl className="devices-facts">
          {facts.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="muted ws-flush">Nothing reported yet.</p>
      )}
      {device.capability ? (
        <details className="ws-advanced">
          <summary>Show the full document</summary>
          <pre className="ws-command devices-json" tabIndex={0} aria-label="Capability document">
            {JSON.stringify(device.capability, null, 2)}
          </pre>
        </details>
      ) : null}
    </section>
  );
}

function OverridesForm({
  device,
  onDevice,
}: {
  device: DeviceView;
  onDevice: (d: DeviceView) => void;
}) {
  const api = useDevicesApi();
  const toast = useToast();
  const base = useId();
  const initial = draftFrom(device.capabilityOverrides);
  const [draft, setDraft] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const revoked = device.status === 'revoked';
  const dirty = OVERRIDE_FIELDS.some((f) => (draft[fieldId(f)] ?? '') !== initial[fieldId(f)]);
  const doc = device.capability ?? {};

  const save = async () => {
    const r = overridesFrom(draft);
    if (!r.ok) {
      setErrors(r.errors);
      return;
    }
    setErrors({});
    setBusy(true);
    setSaveError(null);
    try {
      const next = await api.updateNovadDevice(device.id, { capabilityOverrides: r.value });
      toast.show(
        next.configPending
          ? 'Saved. The device takes it when it next checks in.'
          : 'Saved. The device has it.',
        { tone: 'success' },
      );
      // The form remounts with the saved values (its key is the overrides).
      onDevice(next);
    } catch (err) {
      setSaveError(deviceErrorMessage(err, 'Could not save the overrides.'));
    } finally {
      setBusy(false);
    }
  };

  const sections = [...new Set(OVERRIDE_FIELDS.map((f) => f.section))];
  return (
    <section className="ws-section devices-flat" aria-labelledby={`${base}-h`}>
      <h2 id={`${base}-h`}>Hub overrides</h2>
      <p className="muted ws-flush">
        Advanced. An override replaces what the device declares for routing and limits; leave a
        field blank to keep the device&apos;s own value.
      </p>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <fieldset className="devices-overrides" disabled={revoked || busy}>
          <legend className="nv-vh">Hub overrides</legend>
          {sections.map((s) => (
            <div
              key={s}
              className="devices-override-group"
              role="group"
              aria-label={SECTION_LABEL[s]}
            >
              <h3>{SECTION_LABEL[s]}</h3>
              {OVERRIDE_FIELDS.filter((f) => f.section === s).map((f) => {
                const id = fieldId(f);
                const reported = reportedText(f, rec(doc[f.section])[f.key]);
                const hint =
                  [f.hint, reported ? `The device reports ${reported}.` : null]
                    .filter(Boolean)
                    .join(' ') || undefined;
                const set = (v: string) => setDraft((d) => ({ ...d, [id]: v }));
                if (f.kind === 'select')
                  return (
                    <SelectField
                      key={id}
                      label={f.label}
                      value={draft[id] ?? ''}
                      onChange={set}
                      hint={hint}
                      error={errors[id]}
                      options={[{ value: '', label: 'The device decides' }, ...(f.options ?? [])]}
                    />
                  );
                if (f.kind === 'paths')
                  return (
                    <div key={id} className="nv-field">
                      <label className="nv-field-label" htmlFor={`${base}-${id}`}>
                        {f.label}
                      </label>
                      <textarea
                        id={`${base}-${id}`}
                        className="nv-input ws-textarea"
                        rows={3}
                        value={draft[id] ?? ''}
                        aria-invalid={errors[id] ? true : undefined}
                        aria-describedby={`${base}-${id}-hint${errors[id] ? ` ${base}-${id}-err` : ''}`}
                        onChange={(e) => set(e.target.value)}
                      />
                      <span id={`${base}-${id}-hint`} className="nv-field-hint">
                        {hint}
                      </span>
                      {errors[id] ? (
                        <span id={`${base}-${id}-err`} className="nv-field-error" role="alert">
                          {errors[id]}
                        </span>
                      ) : null}
                    </div>
                  );
                const numeric = f.kind === 'int' || f.kind === 'num' || f.kind === 'gib';
                return (
                  <TextField
                    key={id}
                    label={f.label}
                    value={draft[id] ?? ''}
                    inputMode={numeric ? (f.kind === 'int' ? 'numeric' : 'decimal') : undefined}
                    className={numeric ? 'ws-number' : undefined}
                    hint={hint}
                    error={errors[id]}
                    onChange={(e) => set(e.target.value)}
                  />
                );
              })}
            </div>
          ))}
        </fieldset>
        {revoked ? <p className="muted ws-flush">This device was revoked.</p> : null}
        {saveError ? (
          <p role="alert" className="nv-field-error">
            {saveError}
          </p>
        ) : null}
        <div className="row">
          <Button type="submit" variant="primary" disabled={!dirty || busy || revoked}>
            Save overrides
          </Button>
          <Button
            disabled={!dirty || busy}
            onClick={() => {
              setDraft(initial);
              setErrors({});
            }}
          >
            Discard changes
          </Button>
        </div>
      </form>
    </section>
  );
}
