// A device's Firmware tab (FR-146; docs/23 §6; ADR-042, ADR-096 D3-D4): whether Nova can change
// this machine's firmware settings (or the plain reason it cannot, with the hardware support
// matrix), its platform facts, the allowlisted settings with their values and which are
// read-only, the firmware updates fwupd lists (read-only), and the write-only BIOS admin password.
// With "Allow BIOS/firmware changes" on, the owner plans a change (a dry run with a snapshot; the
// diff marks security-degrading rows), asks for approval on a Hub-only card, applies it (with an
// optional restart guarded by the device's watchdog), and rolls back any applied change behind its
// own approval. With the toggle off, the tab explains what the toggle does and links to it. Every
// change and its watchdog outcome is in the history, with values before and after. Owner-only.
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  FIRMWARE_KEYS,
  type FirmwareChangeInput,
  type FirmwareChangeView,
  type FirmwareHistoryView,
  type FirmwarePolicyView,
  type FirmwareSettingView,
  type FirmwareSupportEntry,
  type FirmwareValue,
} from '@nova/shared';
import { defineMessages, fmt } from '@nova/i18n';
import { Button, Icon, SelectField, Spinner, TextField, useToast } from '@nova/ui';
import type { PanelProps } from '../devices/DevicePage.tsx';
import { listText } from '../devices/format.ts';
import { Chip, ConfirmDialog, LoadError, useLoad } from '../devices/parts.tsx';
import { useHubStream } from '../hub-events.ts';
import { rich } from '../i18n/rich.tsx';
import { useAnnounce } from '../services.tsx';
import { useSetting } from '../settings.tsx';
import { focusMoved, formatWhen, moveItem, useInterval } from '../settings/common.ts';
import { MemberGate } from '../team/role.tsx';
import { useDebounced } from '../work/events.ts';
import { followLink } from '../work/nav.tsx';
import { useFirmwareApi, type FirmwareRead } from './api-m75.ts';
import { ChangeCard } from './FirmwareChange.tsx';
import {
  FIRMWARE_SETTINGS_PATH,
  FIRMWARE_TEXT,
  methodText,
  OPEN_STATUSES,
  firmwareErrorMessage,
  inPlainWords,
  keyLabel,
  sameValue,
  supportReasonText,
  valueText,
  weakensSecurity,
} from './format.ts';
import './firmware.css';

export const FIRMWARE_PANEL_TEXT = defineMessages('firmware.panel', {
  /** What the owner-only notice names. */
  ownerOnlyWhat: 'Device firmware',
  title: 'Firmware',
  revoked: 'This device was revoked: its firmware cannot be read.',
  readAgainDone: 'Firmware settings read again.',
  readFailed: 'Could not read the firmware settings.',
  reading: 'Reading the firmware settings',
  settings: 'Settings',
  planned: 'Planned. Check the diff, then ask for approval.',
  currentChange: 'Current change',
  updates: 'Firmware updates',
  updatesIntro:
    'As listed by fwupd on the device. Nova shows them but does not install firmware updates.',
  noUpdates: 'No firmware updates listed.',
  history: 'History',
  historyFailed: 'Could not load the firmware history.',
  loadingHistory: 'Loading the history',
  noChanges: 'No firmware changes yet.',
  changes: 'Firmware changes',
  rollbackTitle: 'Roll back this firmware change on {device}?',
  rollbackBodyAt:
    'Nova plans restoring the settings from before this change (its snapshot of {when}) and asks for your approval on that diff. Nothing changes on {device} until you approve and apply it.',
  rollbackBody:
    'Nova plans restoring the settings from before this change and asks for your approval on that diff. Nothing changes on {device} until you approve and apply it.',
  planRollback: 'Plan the rollback',
  rollbackPlanned: 'Rollback planned. Approve it, then apply it.',
  toRestore: 'Settings to restore',
  restoreItem: '{setting}: back to {value}',
  offTitle: 'BIOS and firmware changes are off.',
  offWhy:
    'They are off by default: a wrong firmware setting can keep a machine from starting, or weaken its security.',
  offWhat:
    'Turned on, you can change the settings below on supported machines. Each change is a dry run first, shows exactly what will change, keeps a snapshot, needs your approval here in Nova, and can be rolled back. Nova never changes firmware by itself. Reading the settings works either way.',
  supported: 'Supported',
  notSupported: 'Not supported',
  canChange: 'Nova can change the allowlisted settings below.',
  /** `support` is the support matrix's name for the machine (from the Hub). */
  canChangeAs: 'Nova can change the allowlisted settings below ({support}).',
  platform: 'Platform',
  machine: 'Machine',
  firmware: 'Firmware',
  reachedThrough: 'Reached through',
  read: 'Read',
  unknown: 'Unknown',
  /** `bios` is the firmware's maker and version, `date` its date, as the device reports them. */
  biosDated: '{bios} ({date}), {mode, select, uefi {UEFI} other {legacy BIOS}}',
  bios: '{bios}, {mode, select, uefi {UEFI} other {legacy BIOS}}',
  methodVia: '{method} ({driver})',
  readCached: '{when} (kept for a minute)',
  matrix: 'Hardware support matrix',
  matrixFailed: 'Could not load the support matrix.',
  loadingMatrix: 'Loading the support matrix',
  matrixCaption: 'Which machines Nova can change firmware settings on (Linux only)',
  maker: 'Maker',
  notes: 'Notes',
  yes: 'Yes',
  noBecause: 'No: {reason}',
  none: 'None',
  noSettings: 'The device reports no settings.',
  settingsCaption: 'The settings Nova may change (an allowlist); it never touches others',
  value: 'Value',
  canBe: 'Can be',
  anyOrder: 'Any order of the same entries',
  wholeNumber: 'A whole number',
  text: 'Text',
  readOnly: 'Read-only',
  /** `values` are the values that weaken security, joined with "or". */
  weakensWhen: 'Weakens security when {values}',
  mustBeNumber: '{setting} must be a whole number.',
  chooseOne: 'Choose at least one new value.',
  planFailed: 'Could not plan the change.',
  planTitle: 'Plan a change',
  allReadOnly: 'Every setting on this machine is read-only.',
  planIntro:
    'Planning is a dry run: novad works out the diff and keeps a snapshot of the current values. Nothing changes on {device} until you approve and apply the plan.',
  noChange: 'No change (now {value})',
  weakensOption: '{value} (weakens security)',
  nowHint: 'Now {value}. Leave empty to keep it.',
  weakensLead: 'This weakens security:',
  /** `lead` is the bold "This weakens security:", `changes` the chosen settings and values. */
  weakensChosenOn:
    '{lead} {changes}. Changes like this are blocked unless “Allow changes that weaken security” is on (it is on).',
  weakensChosenOff:
    '{lead} {changes}. Changes like this are blocked unless “Allow changes that weaken security” is on (it is off).',
  /** A chosen value in the warning above: "Secure Boot Disabled". */
  choice: '{setting} {value}',
  planChange: 'Plan the change',
  orderHint: 'Move entries up or down; the first is tried first.',
  changed: 'Changed.',
  unchanged: 'No change.',
  orderItem: '{n}. {entry}',
  moveUp: 'Move {entry} up',
  moveDown: 'Move {entry} down',
  up: 'Up',
  down: 'Down',
  keepOrder: 'Keep the current order',
  passwordStored: 'BIOS admin password stored.',
  passwordFailed: 'Could not store the password.',
  password: 'BIOS admin password',
  hasPassword: '{device} has a BIOS admin password: Nova needs it to apply changes.',
  noPassword: '{device} reports no BIOS admin password.',
  inVault: 'Stored in the Hub’s vault.',
  notStored: 'Not stored yet.',
  noneStored: 'None stored.',
  passwordKept:
    'It is kept in the Hub’s vault, sent to the device only with an approved change, and never shown again, here or anywhere.',
  replacePassword: 'Replace the BIOS admin password',
  store: 'Store',
  removeMore: 'Remove…',
  removeTitle: 'Remove the BIOS admin password of {device}?',
  removeBodyHas:
    'Nova forgets it. Changes to this machine are refused until you store it again. The password on the machine itself stays as it is.',
  removeBody: 'Nova forgets it. The machine itself is not changed.',
  remove: 'Remove',
  passwordRemoved: 'BIOS admin password removed.',
});

const S = FIRMWARE_PANEL_TEXT;

/** The events that change what the tab shows (contracts/events.md). */
export const FIRMWARE_EVENTS = [
  'device.firmware.changed',
  'approval.decided',
  'approval.requested',
  'settings.changed',
] as const;

export function FirmwarePanel(props: PanelProps) {
  return (
    <MemberGate ownerOnly what={S.ownerOnlyWhat}>
      <FirmwareBody {...props} />
    </MemberGate>
  );
}

function FirmwareBody({ device }: PanelProps) {
  const api = useFirmwareApi();
  const toast = useToast();
  const announce = useAnnounce();
  const base = useId();
  const revoked = device.status === 'revoked';
  const read = useLoad<FirmwareRead | null>(
    () => (revoked ? Promise.resolve(null) : api.readFirmware(device.id)),
    `${device.id}:${revoked}`,
  );
  const history = useLoad<FirmwareHistoryView | null>(
    () => (revoked ? Promise.resolve(null) : api.getFirmwareHistory(device.id)),
    `h:${device.id}:${revoked}`,
  );
  const [refreshing, setRefreshing] = useState(false);
  const [focusApproval, setFocusApproval] = useState(false);
  const [rollingBack, setRollingBack] = useState<FirmwareChangeView | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // The toggle as the settings store has it, until (or when) the device cannot be read.
  const storeOn = useSetting('devices.firmware.allowChanges').value;

  const reloadHistory = useDebounced(history.reload, 150);
  const reloadRead = useDebounced(read.reload, 150);
  useHubStream(FIRMWARE_EVENTS, (env) => {
    if (env.name === 'device.firmware.changed') {
      if (env.payload.deviceId !== device.id) return;
      reloadHistory();
      // An applied, rolled-back or reverted change moved the values on the device.
      if (
        ['applied', 'rolled_back', 'reverted', 'revert_failed'].includes(String(env.payload.status))
      )
        reloadRead();
      return;
    }
    if (env.name === 'settings.changed') {
      const key = typeof env.payload.key === 'string' ? env.payload.key : '';
      if (key.startsWith('devices.firmware.')) reloadRead();
      return;
    }
    reloadHistory();
  });

  const changes = history.data?.changes ?? [];
  const current = changes.find((c) => OPEN_STATUSES.includes(c.status)) ?? null;
  const ticking = changes.some((c) => c.watchdog?.state === 'pending');
  useInterval(() => setNow(Date.now()), 1000, ticking);

  if (revoked) {
    return (
      <section className="ws-section devices-flat" aria-labelledby={`${base}-h`}>
        <h2 id={`${base}-h`}>{S.title}</h2>
        <p className="muted ws-flush">{S.revoked}</p>
      </section>
    );
  }

  const fw = read.data;
  const policy: FirmwarePolicyView | null = fw?.policy ?? null;
  const on = policy ? policy.allowChanges : storeOn;
  const supported = fw?.supported === true;
  // What the device reports now, for a change its watchdog could not revert.
  const held = fw ? Object.fromEntries(fw.settings.map((s) => [s.key, s.value])) : null;
  const snapshotTaken = (id: string | null) =>
    history.data?.snapshots.find((s) => s.id === id)?.takenAt ?? null;

  const refresh = async () => {
    setRefreshing(true);
    try {
      const v = await api.readFirmware(device.id, { fresh: true });
      read.setData(() => v);
      announce(S.readAgainDone);
    } catch (err) {
      toast.show(firmwareErrorMessage(err, S.readFailed), {
        tone: 'error',
      });
    } finally {
      setRefreshing(false);
    }
  };

  const upsert = (c: FirmwareChangeView) =>
    history.setData((h) => ({
      changes: [c, ...(h?.changes ?? []).filter((x) => x.id !== c.id)],
      snapshots: h?.snapshots ?? [],
    }));

  const onChanged = (c: FirmwareChangeView, how: 'asked' | 'applied' | 'other') => {
    upsert(c);
    setFocusApproval(how === 'asked');
    history.reload();
    if (how === 'applied') read.reload();
  };

  return (
    <div className="stack">
      <section className="ws-section devices-flat" aria-labelledby={`${base}-h`}>
        <div className="ws-section-header">
          <h2 id={`${base}-h`}>{S.title}</h2>
          <Button onClick={() => void refresh()} disabled={refreshing}>
            {refreshing ? <Spinner /> : <Icon name="refresh" />} {FIRMWARE_TEXT.readAgain}
          </Button>
        </div>
        {!on && !read.loading ? <OffNote /> : null}
        {read.error ? (
          <LoadError error={read.error} fallback={S.readFailed} onRetry={read.reload} />
        ) : null}
        {read.loading ? <Spinner label={S.reading} /> : null}
        {fw ? <SupportFacts fw={fw} /> : null}
      </section>

      {fw ? (
        <section className="ws-section devices-flat" aria-labelledby={`${base}-s`}>
          <h2 id={`${base}-s`}>{S.settings}</h2>
          <SettingsTable settings={fw.settings} />
        </section>
      ) : null}

      {fw && supported && on ? (
        <PlanForm
          deviceId={device.id}
          deviceName={device.name}
          settings={fw.settings}
          policy={fw.policy}
          onPlanned={(c) => {
            upsert(c);
            history.reload();
            announce(S.planned);
          }}
        />
      ) : null}

      {current ? (
        <section className="ws-section devices-flat" aria-labelledby={`${base}-c`}>
          <h2 id={`${base}-c`}>{S.currentChange}</h2>
          <ChangeCard
            change={current}
            device={device}
            policy={policy}
            current
            now={now}
            focusApproval={focusApproval}
            noWatchdog={fw?.adminPasswordSet === true}
            held={held}
            onChanged={onChanged}
            onReload={history.reload}
          />
        </section>
      ) : null}

      {fw ? (
        <BiosPassword
          deviceId={device.id}
          deviceName={device.name}
          machineHasOne={fw.adminPasswordSet}
          stored={fw.adminPasswordStored}
          onStored={(stored) =>
            read.setData((v) => (v ? { ...v, adminPasswordStored: stored } : v))
          }
        />
      ) : null}

      {fw ? (
        <section className="ws-section devices-flat" aria-labelledby={`${base}-u`}>
          <h2 id={`${base}-u`}>{S.updates}</h2>
          <p className="muted ws-flush">{S.updatesIntro}</p>
          {fw.updates.length ? (
            <ul className="ws-list" aria-label={S.updates}>
              {/* fwupd's names, versions and summaries, as the device reports them. */}
              {fw.updates.map((u, i) => (
                <li key={`${u.device}-${i}`} className="ws-list-row">
                  <span dir="auto">
                    <strong>{u.device}</strong> {u.version}
                    {u.summary ? <span className="muted"> {u.summary}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="ws-flush">{S.noUpdates}</p>
          )}
        </section>
      ) : null}

      <section className="ws-section devices-flat" aria-labelledby={`${base}-hist`}>
        <h2 id={`${base}-hist`}>{S.history}</h2>
        {history.error ? (
          <LoadError error={history.error} fallback={S.historyFailed} onRetry={history.reload} />
        ) : null}
        {history.loading ? <Spinner label={S.loadingHistory} /> : null}
        {history.data && !changes.length ? <p className="muted ws-flush">{S.noChanges}</p> : null}
        {changes.length ? (
          <ul className="fw-list" aria-label={S.changes}>
            {changes
              .filter((c) => c.id !== current?.id)
              .map((c) => (
                <li key={c.id}>
                  <ChangeCard
                    change={c}
                    device={device}
                    policy={policy}
                    current={false}
                    now={now}
                    snapshotTakenAt={snapshotTaken(c.snapshotId)}
                    held={held}
                    onChanged={onChanged}
                    onReload={history.reload}
                    onRollback={setRollingBack}
                  />
                </li>
              ))}
          </ul>
        ) : null}
      </section>

      <ConfirmDialog
        open={rollingBack !== null}
        title={S.rollbackTitle({ device: device.name })}
        description={
          rollingBack && snapshotTaken(rollingBack.snapshotId)
            ? S.rollbackBodyAt({
                when: formatWhen(snapshotTaken(rollingBack.snapshotId)),
                device: device.name,
              })
            : S.rollbackBody({ device: device.name })
        }
        confirmLabel={S.planRollback}
        onClose={() => setRollingBack(null)}
        onConfirm={async () => {
          if (!rollingBack?.snapshotId) return;
          const view = await inPlainWords(
            api.rollbackFirmwareSnapshot(device.id, rollingBack.snapshotId),
          );
          setRollingBack(null);
          onChanged(view, 'asked');
          announce(S.rollbackPlanned);
        }}
      >
        {rollingBack ? (
          <ul aria-label={S.toRestore}>
            {rollingBack.diff.map((e) => (
              <li key={e.key}>
                {S.restoreItem({ setting: keyLabel(e.key), value: valueText(e.from) })}
              </li>
            ))}
          </ul>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}

/** The toggle is off: what it does, and where to turn it on. */
function OffNote() {
  return (
    <div className="ws-callout" role="note">
      <Icon name="shield" />
      <div className="stack">
        <p>
          <strong>{S.offTitle}</strong> {S.offWhy}
        </p>
        <p>{S.offWhat}</p>
        <p>
          <a href={FIRMWARE_SETTINGS_PATH} onClick={(e) => followLink(e, FIRMWARE_SETTINGS_PATH)}>
            {FIRMWARE_TEXT.turnOnInSettings}
          </a>
        </p>
      </div>
    </div>
  );
}

function SupportFacts({ fw }: { fw: FirmwareRead }) {
  const p = fw.platform;
  return (
    <div className="stack">
      <p className="row">
        {fw.supported ? (
          <Chip tone="ready" icon="check" text={S.supported} />
        ) : (
          <Chip tone="blocked" icon="stop" text={S.notSupported} />
        )}
        {fw.supported ? (
          <span className="muted">
            {fw.support ? S.canChangeAs({ support: fw.support.label }) : S.canChange}
          </span>
        ) : (
          <span>{supportReasonText(fw.reason)}</span>
        )}
      </p>
      <SupportMatrix />
      {/* The machine's maker, model and firmware version are as the device reports them. */}
      <dl className="devices-facts" aria-label={S.platform}>
        <div>
          <dt>{S.machine}</dt>
          <dd>{p ? `${p.vendor} ${p.product}`.trim() || S.unknown : FIRMWARE_TEXT.notReported}</dd>
        </div>
        <div>
          <dt>{S.firmware}</dt>
          <dd>{p ? biosText(p) : FIRMWARE_TEXT.notReported}</dd>
        </div>
        <div>
          <dt>{S.reachedThrough}</dt>
          <dd>
            {fw.support?.driver
              ? S.methodVia({ method: methodText(fw.method), driver: fw.support.driver })
              : methodText(fw.method)}
          </dd>
        </div>
        <div>
          <dt>{S.read}</dt>
          <dd>
            {fw.cached ? S.readCached({ when: formatWhen(fw.readAt) }) : formatWhen(fw.readAt)}
          </dd>
        </div>
      </dl>
    </div>
  );
}

/** "Dell Inc. 1.21.0 (2025-04-11), UEFI": the firmware's maker, version and date, and its mode. */
function biosText(p: NonNullable<FirmwareRead['platform']>): string {
  const bios = `${p.biosVendor} ${p.biosVersion}`.trim();
  const mode = p.uefi ? 'uefi' : 'legacy';
  return p.biosDate ? S.biosDated({ bios, date: p.biosDate, mode }) : S.bios({ bios, mode });
}

/** The hardware support matrix, loaded when opened. */
function SupportMatrix() {
  const api = useFirmwareApi();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<FirmwareSupportEntry[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (!open || items) return;
    let alive = true;
    api.getFirmwareSupport().then(
      (r) => alive && setItems(r.items),
      (err: unknown) => alive && setError(err),
    );
    return () => {
      alive = false;
    };
  }, [api, open, items]);
  return (
    <details onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>{S.matrix}</summary>
      {error ? <p role="alert">{firmwareErrorMessage(error, S.matrixFailed)}</p> : null}
      {open && !items && !error ? <Spinner label={S.loadingMatrix} /> : null}
      {items ? (
        <div className="fw-table-wrap">
          <table className="ws-table">
            <caption>{S.matrixCaption}</caption>
            <thead>
              <tr>
                <th scope="col">{S.maker}</th>
                <th scope="col">{S.supported}</th>
                <th scope="col">{S.settings}</th>
                <th scope="col">{S.notes}</th>
              </tr>
            </thead>
            <tbody>
              {/* Makers and their notes are the Hub's support matrix, in its own words (D9). */}
              {items.map((e) => (
                <tr key={e.vendor}>
                  <th scope="row">{e.label}</th>
                  <td>
                    {e.supported ? S.yes : S.noBecause({ reason: supportReasonText(e.reason) })}
                  </td>
                  <td>
                    {Object.keys(e.keys).length
                      ? listText(Object.keys(e.keys).map(keyLabel))
                      : S.none}
                  </td>
                  <td dir="auto">{e.notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </details>
  );
}

/** Values of a setting that weaken security (the device's list, and the Hub's own rule). */
function degradingOf(s: FirmwareSettingView): string[] {
  const all = new Set(s.securityDegrading);
  for (const v of s.allowed ?? []) if (weakensSecurity(s.key, v, s.securityDegrading)) all.add(v);
  return [...all];
}

function SettingsTable({ settings }: { settings: FirmwareSettingView[] }) {
  if (!settings.length) return <p className="muted ws-flush">{S.noSettings}</p>;
  return (
    <div className="fw-table-wrap">
      <table className="ws-table">
        <caption>{S.settingsCaption}</caption>
        <thead>
          <tr>
            <th scope="col">{FIRMWARE_TEXT.columns.setting}</th>
            <th scope="col">{S.value}</th>
            <th scope="col">{S.canBe}</th>
            <th scope="col">{S.notes}</th>
          </tr>
        </thead>
        <tbody>
          {settings.map((s) => {
            const bad = degradingOf(s);
            return (
              <tr key={s.key}>
                <th scope="row">
                  {keyLabel(s.key)}
                  <span className="muted ws-row-meta"> {s.vendorKey}</span>
                </th>
                <td>{valueText(s.value)}</td>
                <td>
                  {s.type === 'order'
                    ? S.anyOrder
                    : s.allowed?.length
                      ? listText(s.allowed)
                      : s.type === 'int'
                        ? S.wholeNumber
                        : S.text}
                </td>
                <td>
                  {s.readOnly ? (
                    <span>
                      <Icon name="stop" /> {S.readOnly}
                    </span>
                  ) : null}
                  {bad.length ? (
                    <span className="fw-degrading">
                      <Icon name="alert" />{' '}
                      {S.weakensWhen({ values: fmt.list(bad, { type: 'disjunction' }) })}
                    </span>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The new value chosen for each setting ('' keeps it); the boot order as a list. */
type Choices = Record<string, string>;

function PlanForm({
  deviceId,
  deviceName,
  settings,
  policy,
  onPlanned,
}: {
  deviceId: string;
  deviceName: string;
  settings: FirmwareSettingView[];
  policy: FirmwarePolicyView;
  onPlanned: (c: FirmwareChangeView) => void;
}) {
  const api = useFirmwareApi();
  const base = useId();
  const writable = useMemo(
    () =>
      settings.filter((s) => !s.readOnly && (FIRMWARE_KEYS as readonly string[]).includes(s.key)),
    [settings],
  );
  const [choices, setChoices] = useState<Choices>({});
  const [order, setOrder] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);

  const changes = (): FirmwareChangeInput[] | string => {
    const out: FirmwareChangeInput[] = [];
    for (const s of writable) {
      const key = s.key as FirmwareChangeInput['key'];
      if (s.type === 'order') {
        if (order && !sameValue(order, s.value)) out.push({ key, value: order });
        continue;
      }
      const raw = (choices[s.key] ?? '').trim();
      if (!raw) continue;
      let value: FirmwareValue = raw;
      if (s.type === 'int') {
        if (!/^-?\d+$/.test(raw)) return S.mustBeNumber({ setting: keyLabel(s.key) });
        value = Number(raw);
      }
      if (!sameValue(value, s.value)) out.push({ key, value });
    }
    return out;
  };

  const chosenBad = writable.filter((s) => {
    if (s.type === 'order') return false;
    const raw = (choices[s.key] ?? '').trim();
    return raw !== '' && weakensSecurity(s.key, raw, s.securityDegrading);
  });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const list = changes();
    if (typeof list === 'string' || !list.length) {
      setError(typeof list === 'string' ? list : S.chooseOne);
      errorRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const c = await api.planFirmware(deviceId, list);
      setChoices({});
      setOrder(null);
      onPlanned(c);
    } catch (err) {
      setError(firmwareErrorMessage(err, S.planFailed));
    } finally {
      setBusy(false);
    }
  };

  if (!writable.length)
    return (
      <section className="ws-section devices-flat" aria-labelledby={`${base}-h`}>
        <h2 id={`${base}-h`}>{S.planTitle}</h2>
        <p className="muted ws-flush">{S.allReadOnly}</p>
      </section>
    );

  return (
    <section className="ws-section devices-flat" aria-labelledby={`${base}-h`}>
      <h2 id={`${base}-h`}>{S.planTitle}</h2>
      <p className="muted ws-flush">{S.planIntro({ device: deviceName })}</p>
      <form className="stack" onSubmit={(e) => void submit(e)} aria-labelledby={`${base}-h`}>
        <div className="fw-plan-grid">
          {writable.map((s) =>
            s.type === 'order' ? (
              <OrderField
                key={s.key}
                setting={s}
                value={order ?? (Array.isArray(s.value) ? s.value : [])}
                onChange={setOrder}
              />
            ) : s.type === 'enum' && s.allowed?.length ? (
              <SelectField
                key={s.key}
                label={keyLabel(s.key)}
                value={choices[s.key] ?? ''}
                onChange={(v) => setChoices((c) => ({ ...c, [s.key]: v }))}
                options={[
                  { value: '', label: S.noChange({ value: valueText(s.value) }) },
                  ...s.allowed
                    .filter((v) => v !== s.value)
                    .map((v) => ({
                      value: v,
                      label: weakensSecurity(s.key, v, s.securityDegrading)
                        ? S.weakensOption({ value: v })
                        : v,
                    })),
                ]}
              />
            ) : (
              <TextField
                key={s.key}
                label={keyLabel(s.key)}
                value={choices[s.key] ?? ''}
                inputMode={s.type === 'int' ? 'numeric' : undefined}
                placeholder={valueText(s.value)}
                hint={S.nowHint({ value: valueText(s.value) })}
                onChange={(e) => setChoices((c) => ({ ...c, [s.key]: e.target.value }))}
              />
            ),
          )}
        </div>
        {chosenBad.length ? (
          <div className="ws-callout" role="note">
            <Icon name="alert" />
            <p>
              {rich(policy.allowSecurityDegrading ? S.weakensChosenOn : S.weakensChosenOff, {
                lead: <strong>{S.weakensLead}</strong>,
                changes: listText(
                  chosenBad.map((s) =>
                    S.choice({ setting: keyLabel(s.key), value: choices[s.key] ?? '' }),
                  ),
                ),
              })}
            </p>
          </div>
        ) : null}
        <div className="row">
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? <Spinner /> : null} {S.planChange}
          </Button>
        </div>
        {error ? (
          <p role="alert" tabIndex={-1} ref={errorRef} className="nv-field-error">
            {error}
          </p>
        ) : null}
      </form>
    </section>
  );
}

/** The boot order: the same entries, moved up or down (never added or removed). */
function OrderField({
  setting,
  value,
  onChange,
}: {
  setting: FirmwareSettingView;
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const id = useId();
  const listRef = useRef<HTMLOListElement>(null);
  const changed = !sameValue(value, setting.value);
  const move = (i: number, dir: 'up' | 'down') => {
    const entry = value[i];
    if (entry === undefined) return;
    onChange(moveItem(value, i, dir === 'up' ? -1 : 1));
    focusMoved(listRef.current, entry, dir);
  };
  return (
    <fieldset className="ws-fieldset">
      <legend>{keyLabel(setting.key)}</legend>
      <p id={`${id}-hint`} className="nv-field-hint">
        {S.orderHint} {changed ? S.changed : S.unchanged}
      </p>
      <ol ref={listRef} className="fw-order" aria-describedby={`${id}-hint`}>
        {value.map((entry, i) => (
          <li key={entry} data-move-key={entry}>
            {/* A boot entry's name, as the device reports it. */}
            <span dir="auto">{S.orderItem({ n: i + 1, entry })}</span>
            <Button
              variant="ghost"
              data-move="up"
              aria-label={S.moveUp({ entry })}
              disabled={i === 0}
              onClick={() => move(i, 'up')}
            >
              {S.up}
            </Button>
            <Button
              variant="ghost"
              data-move="down"
              aria-label={S.moveDown({ entry })}
              disabled={i === value.length - 1}
              onClick={() => move(i, 'down')}
            >
              {S.down}
            </Button>
          </li>
        ))}
      </ol>
      {changed ? (
        <Button
          variant="ghost"
          onClick={() => onChange(Array.isArray(setting.value) ? setting.value : [])}
        >
          {S.keepOrder}
        </Button>
      ) : null}
    </fieldset>
  );
}

/** The BIOS admin password: written to the Hub's vault, never shown or read back. */
function BiosPassword({
  deviceId,
  deviceName,
  machineHasOne,
  stored,
  onStored,
}: {
  deviceId: string;
  deviceName: string;
  machineHasOne: boolean;
  stored: boolean;
  onStored: (stored: boolean) => void;
}) {
  const api = useFirmwareApi();
  const toast = useToast();
  const base = useId();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.setBiosPassword(deviceId, password);
      setPassword('');
      onStored(r.stored);
      toast.show(S.passwordStored, { tone: 'success' });
    } catch (err) {
      setError(firmwareErrorMessage(err, S.passwordFailed));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="ws-section devices-flat" aria-labelledby={`${base}-h`}>
      <h2 id={`${base}-h`}>{S.password}</h2>
      <p className="ws-flush">
        {machineHasOne
          ? S.hasPassword({ device: deviceName })
          : S.noPassword({ device: deviceName })}{' '}
        {stored ? (
          <strong>{S.inVault}</strong>
        ) : machineHasOne ? (
          <strong>{S.notStored}</strong>
        ) : (
          S.noneStored
        )}
      </p>
      <p className="muted ws-flush">{S.passwordKept}</p>
      <form className="row" onSubmit={(e) => void save(e)}>
        <TextField
          label={stored ? S.replacePassword : S.password}
          type="password"
          autoComplete="new-password"
          value={password}
          maxLength={256}
          onChange={(e) => setPassword(e.target.value)}
          error={error ?? undefined}
        />
        <Button type="submit" disabled={!password || busy}>
          {busy ? <Spinner /> : null} {S.store}
        </Button>
        {stored ? (
          <Button variant="danger" onClick={() => setClearing(true)}>
            {S.removeMore}
          </Button>
        ) : null}
      </form>
      <ConfirmDialog
        open={clearing}
        title={S.removeTitle({ device: deviceName })}
        description={machineHasOne ? S.removeBodyHas : S.removeBody}
        confirmLabel={S.remove}
        danger
        onClose={() => setClearing(false)}
        onConfirm={async () => {
          const r = await inPlainWords(api.clearBiosPassword(deviceId));
          setClearing(false);
          onStored(r.stored);
          toast.show(S.passwordRemoved, { tone: 'success' });
        }}
      />
    </section>
  );
}
