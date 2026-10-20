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
import { defineMessages, messageFor } from '@nova/i18n';
import { useDevicesApi } from './api.ts';
import type { PanelProps } from './DevicePage.tsx';
import {
  CAPABILITY_LABEL,
  capabilityReason,
  deviceErrorMessage,
  formatBytes,
  listText,
  moduleLabel,
  parseQuietHours,
  pathProblem,
} from './format.ts';

/** The Capabilities tab's words (FR-016). */
export const CAPABILITIES_TEXT = defineMessages('devices.capabilities', {
  sections: {
    models: 'Models',
    computePolicy: 'Compute',
    scheduling: 'Scheduling',
    limits: 'Network',
    power: 'Power',
    locale: 'Locale',
  },
  /** Each override field's label, by its key. */
  fields: {
    storagePaths: 'Model folders',
    cacheQuotaBytes: 'Model cache limit (GB)',
    gpuSharing: 'GPU sharing',
    vramReserveBytes: 'GPU memory kept free (GB)',
    maxConcurrentJobs: 'Jobs at once',
    maxJobDurationSec: 'Longest job (seconds)',
    quietHours: 'Quiet hours the device declares',
    routingWeight: 'Routing weight',
    energyPriceTier: 'Energy price tier',
    maxEgressMbps: 'Upload limit (Mbps)',
    policy: 'Power policy',
    thermalLimitC: 'Thermal limit (°C)',
    locale: 'Locale',
  },
  /** Help under some fields, by the field's key. */
  hints: {
    storagePaths: 'One full path per line.',
    quietHours: 'Like 22:00-07:00; separate several with commas.',
    routingWeight: 'Higher gets more work when several devices fit. 0 to 1000.',
    locale: 'Like en-US.',
  },
  options: {
    shared: 'Shared with other work',
    exclusive: 'Only Nova jobs',
  },
  deviceDecides: 'The device decides',
  deviceReports: 'The device reports {value}.',
  invalid: {
    whole: 'Enter a whole number.',
    number: 'Enter a number.',
    range: 'Enter a number from {min} to {max}.',
    atLeast: 'Enter a number of {min} or more.',
    ranges: '“{text}” is not a time range like 22:00-07:00.',
  },
  status: {
    title: 'What it can do',
    needUpdate:
      'Some capabilities need a newer novad. Update the device in the Updates tab; it keeps the others meanwhile.',
    list: 'Capabilities',
    available: 'Available · {module} module',
    none: 'The device has not reported its capabilities yet.',
  },
  facts: {
    processor: 'Processor',
    memory: 'Memory',
    gpus: 'GPUs',
    disks: 'Disks',
    system: 'System',
    sandbox: 'Sandbox',
    modelServers: 'Model servers',
    peripherals: 'Peripherals',
    sharedFolders: 'Shared folders',
    timeZone: 'Time zone',
  },
  cores: '{n, plural, one {# core} other {# cores}}',
  gpu: 'GPU',
  gpuMemory: '{name} ({size})',
  diskFree: '{mount} {size} free',
  free: '{size} free',
  peripheralCount: '{n} {name}',
  noSandbox: 'None found; commands are refused',
  noFolders: 'None',
  reported: {
    title: 'Reported by the device',
    intro: 'Detected on the device, with any changes made there. Only the device can change these.',
    none: 'Nothing reported yet.',
    showDocument: 'Show the full document',
    document: 'Capability document',
  },
  overrides: {
    title: 'Hub overrides',
    intro:
      "Advanced. An override replaces what the device declares for routing and limits; leave a field blank to keep the device's own value.",
    revoked: 'This device was revoked.',
    save: 'Save overrides',
    discard: 'Discard changes',
    saved: 'Saved. The device has it.',
    savedPending: 'Saved. The device takes it when it next checks in.',
    saveFailed: 'Could not save the overrides.',
  },
});

const S = CAPABILITIES_TEXT;

const GIB = 1024 ** 3;

type Section = keyof DeviceCapabilityOverrides;
type Kind = 'int' | 'num' | 'gib' | 'text' | 'paths' | 'ranges' | 'select';

interface Field {
  section: Section;
  key: keyof typeof S.fields;
  kind: Kind;
  min?: number;
  max?: number;
  /** A select's values; their words are in `S.options`. */
  options?: readonly string[];
}

/** A field's label and help, read at render time. */
const fieldLabel = (f: Field): string => S.fields[f.key];
const fieldHint = (f: Field): string | undefined => messageFor(S.hints, f.key);

export const OVERRIDE_FIELDS: Field[] = [
  { section: 'models', key: 'storagePaths', kind: 'paths' },
  { section: 'models', key: 'cacheQuotaBytes', kind: 'gib' },
  {
    section: 'computePolicy',
    key: 'gpuSharing',
    kind: 'select',
    options: ['shared', 'exclusive'],
  },
  { section: 'computePolicy', key: 'vramReserveBytes', kind: 'gib' },
  { section: 'computePolicy', key: 'maxConcurrentJobs', kind: 'int', min: 0 },
  { section: 'computePolicy', key: 'maxJobDurationSec', kind: 'int', min: 1 },
  { section: 'scheduling', key: 'quietHours', kind: 'ranges' },
  { section: 'scheduling', key: 'routingWeight', kind: 'num', min: 0, max: 1000 },
  { section: 'scheduling', key: 'energyPriceTier', kind: 'text' },
  { section: 'limits', key: 'maxEgressMbps', kind: 'num', min: 0, max: 100_000 },
  { section: 'power', key: 'policy', kind: 'text' },
  { section: 'power', key: 'thermalLimitC', kind: 'int', min: 30, max: 120 },
  { section: 'locale', key: 'locale', kind: 'text' },
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
        errors[id] = whole ? S.invalid.whole : S.invalid.number;
        continue;
      }
      if ((f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max) || n < 0) {
        errors[id] =
          f.max === undefined
            ? S.invalid.atLeast({ min: f.min ?? 0 })
            : S.invalid.range({ min: f.min ?? 0, max: f.max });
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
        errors[id] = S.invalid.ranges({ text: r.bad });
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
      <h2 id="caps-status">{S.status.title}</h2>
      {device.updateRequired ? (
        <p className="devices-note">
          <Icon name="alert" /> {S.status.needUpdate}
        </p>
      ) : null}
      {device.capabilities.length ? (
        <ul className="devices-caps" aria-label={S.status.list}>
          {device.capabilities.map((c) => {
            const why = capabilityReason(c);
            return (
              <li key={c.name} data-available={c.available || undefined}>
                <Icon
                  name={c.available ? 'check' : c.reason === 'update_required' ? 'alert' : 'stop'}
                />
                <span className="devices-cap-name">{CAPABILITY_LABEL[c.name]}</span>
                <span className="muted">
                  {why ?? S.status.available({ module: moduleLabel(c.module) })}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="muted ws-flush">{S.status.none}</p>
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
  const F = S.facts;
  const strings = (xs: unknown[]) => xs.map((x) => (typeof x === 'string' ? x : String(x)));
  const hw = rec(doc.hardware);
  const cpu = [
    typeof hw.arch === 'string' && hw.arch ? hw.arch : null,
    typeof hw.cores === 'number' ? S.cores({ n: hw.cores }) : null,
  ].filter((x): x is string => x !== null);
  add(F.processor, cpu.length ? listText(cpu) : null);
  if (typeof hw.ramBytes === 'number') add(F.memory, formatBytes(hw.ramBytes));
  if (Array.isArray(hw.gpus) && hw.gpus.length)
    add(
      F.gpus,
      listText(
        hw.gpus.map((g) => {
          const r = rec(g);
          const name = typeof r.name === 'string' ? r.name : S.gpu;
          return typeof r.vramBytes === 'number'
            ? S.gpuMemory({ name, size: formatBytes(r.vramBytes) })
            : name;
        }),
      ),
    );
  if (Array.isArray(hw.disks) && hw.disks.length)
    add(
      F.disks,
      listText(
        hw.disks.map((x) => {
          const r = rec(x);
          const mount = typeof r.mount === 'string' ? r.mount : '';
          if (typeof r.freeBytes !== 'number') return mount;
          const size = formatBytes(r.freeBytes);
          return mount ? S.diskFree({ mount, size }) : S.free({ size });
        }),
      ),
    );
  const os = rec(doc.os);
  add(F.system, [os.family, os.version].filter((x) => typeof x === 'string').join(' ') || null);
  const sandbox = Object.entries(rec(os.sandbox))
    .filter(([, v]) => v === true)
    .map(([k]) => k);
  add(F.sandbox, sandbox.length ? listText(sandbox) : S.noSandbox);
  const services = rec(doc.services);
  if (Array.isArray(services.computeBackends) && services.computeBackends.length)
    add(F.modelServers, listText(strings(services.computeBackends)));
  const peripherals = rec(doc.peripherals);
  const have = Object.entries(peripherals)
    .filter(([, v]) => v === true || (typeof v === 'number' && v > 0))
    .map(([k, v]) => (typeof v === 'number' ? S.peripheralCount({ n: v, name: k }) : k));
  if (have.length) add(F.peripherals, listText(have));
  const access = rec(doc.access);
  if (Array.isArray(access.fsScopes))
    add(F.sharedFolders, access.fsScopes.length ? listText(strings(access.fsScopes)) : S.noFolders);
  const locale = rec(doc.locale);
  add(F.timeZone, locale.timezone);
  return out;
}

function ReportedDocument({ device }: { device: DeviceView }) {
  const facts = reportedFacts(device.capability);
  return (
    <section className="ws-section devices-flat" aria-labelledby="caps-reported">
      <h2 id="caps-reported">{S.reported.title}</h2>
      <p className="muted ws-flush">{S.reported.intro}</p>
      {facts.length ? (
        <dl className="devices-facts">
          {facts.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd dir="auto">{v}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="muted ws-flush">{S.reported.none}</p>
      )}
      {device.capability ? (
        <details className="ws-advanced">
          <summary>{S.reported.showDocument}</summary>
          <pre
            role="group"
            className="ws-command devices-json"
            tabIndex={0}
            aria-label={S.reported.document}
            dir="ltr"
          >
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
      toast.show(next.configPending ? S.overrides.savedPending : S.overrides.saved, {
        tone: 'success',
      });
      // The form remounts with the saved values (its key is the overrides).
      onDevice(next);
    } catch (err) {
      setSaveError(deviceErrorMessage(err, S.overrides.saveFailed));
    } finally {
      setBusy(false);
    }
  };

  const sections = [...new Set(OVERRIDE_FIELDS.map((f) => f.section))];
  return (
    <section className="ws-section devices-flat" aria-labelledby={`${base}-h`}>
      <h2 id={`${base}-h`}>{S.overrides.title}</h2>
      <p className="muted ws-flush">{S.overrides.intro}</p>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <fieldset className="devices-overrides" disabled={revoked || busy}>
          <legend className="nv-vh">{S.overrides.title}</legend>
          {sections.map((s) => (
            <div key={s} className="devices-override-group" role="group" aria-label={S.sections[s]}>
              <h3>{S.sections[s]}</h3>
              {OVERRIDE_FIELDS.filter((f) => f.section === s).map((f) => {
                const id = fieldId(f);
                const label = fieldLabel(f);
                const reported = reportedText(f, rec(doc[f.section])[f.key]);
                // Two whole sentences: the field's help, then what the device reports.
                const hint =
                  [fieldHint(f), reported ? S.deviceReports({ value: reported }) : null]
                    .filter(Boolean)
                    .join(' ') || undefined;
                const set = (v: string) => setDraft((d) => ({ ...d, [id]: v }));
                if (f.kind === 'select')
                  return (
                    <SelectField
                      key={id}
                      label={label}
                      value={draft[id] ?? ''}
                      onChange={set}
                      hint={hint}
                      error={errors[id]}
                      options={[
                        { value: '', label: S.deviceDecides },
                        ...(f.options ?? []).map((value) => ({
                          value,
                          label: messageFor(S.options, value) ?? value,
                        })),
                      ]}
                    />
                  );
                if (f.kind === 'paths')
                  return (
                    <div key={id} className="nv-field">
                      <label className="nv-field-label" htmlFor={`${base}-${id}`}>
                        {label}
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
                    label={label}
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
        {revoked ? <p className="muted ws-flush">{S.overrides.revoked}</p> : null}
        {saveError ? (
          <p role="alert" className="nv-field-error">
            {saveError}
          </p>
        ) : null}
        <div className="row">
          <Button type="submit" variant="primary" disabled={!dirty || busy || revoked}>
            {S.overrides.save}
          </Button>
          <Button
            disabled={!dirty || busy}
            onClick={() => {
              setDraft(initial);
              setErrors({});
            }}
          >
            {S.overrides.discard}
          </Button>
        </div>
      </form>
    </section>
  );
}
