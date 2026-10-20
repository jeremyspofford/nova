// Spend caps per provider (FR-116; docs/14 §6) on Settings → Profile & usage, every account its
// own: for each cloud provider you use, the cap (an amount each UTC day or month), the share at
// which it warns, and whether it stops calls at the cap or only warns; this period's spend
// against it with its state. `?cap=<provider>` (the chat's "Raise the cap" link) opens that
// provider's cap. Also "Clear usage data": the usage records go, the caps keep this period's
// spend.
import { useEffect, useId, useRef, useState } from 'react';
import type { ProviderLimitView, SpendCapView } from '@nova/shared';
import { Button, SelectField, Spinner, TextField, useToast } from '@nova/ui';
import { useHubStream } from '../hub-events.ts';
import { StateChip } from '../settings/badges.tsx';
import { SwitchField } from '../settings/controls.tsx';
import { useDatactlApi } from './api-m8.ts';
import {
  SPEND_STRINGS as S,
  capDraft,
  capRulesText,
  capSpentText,
  capState,
  dataErrorMessage,
  parseCapDraft,
  periodOptions,
  providerName,
  type CapDraft,
} from './format.ts';
import { ConfirmDialog, ErrorBox, useFetched } from './parts.tsx';
import './datactl.css';

/** The cap the page was opened for (`?cap=<provider>`), once. */
function requestedCap(): string | null {
  try {
    return new URLSearchParams(window.location.search).get('cap');
  } catch {
    return null;
  }
}

interface Loaded {
  caps: SpendCapView[];
  limits: ProviderLimitView[];
}

export function SpendCapsSection({ onCleared }: { onCleared?: () => void }) {
  const api = useDatactlApi();
  const id = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const supported = typeof api.listSpendCaps === 'function';
  const data = useFetched<Loaded>(
    supported
      ? async () => {
          const [caps, limits] = await Promise.all([
            api.listSpendCaps!(),
            api.listProviderLimits
              ? api.listProviderLimits()
              : Promise.resolve({ items: [] as ProviderLimitView[] }),
          ]);
          return { caps: caps.items, limits: limits.items };
        }
      : null,
  );
  const [editing, setEditing] = useState<string | null>(requestedCap);
  const [removing, setRemoving] = useState<string | null>(null);
  const toast = useToast();
  useHubStream(['spend.cap.warning', 'spend.cap.reached'], () => data.reload());

  // Opened from "Raise the cap": bring the section into view once it has loaded.
  const scrolled = useRef(false);
  useEffect(() => {
    if (scrolled.current || !data.data || !requestedCap()) return;
    scrolled.current = true;
    sectionRef.current?.scrollIntoView?.({ block: 'start' });
  }, [data.data]);

  if (!supported) return null;
  const caps = data.data?.caps ?? [];
  const kinds = new Set<string>(caps.map((c) => c.provider));
  for (const l of data.data?.limits ?? []) if (!l.local) kinds.add(l.provider);
  if (editing) kinds.add(editing);
  const providers = [...kinds].sort((a, b) => providerName(a).localeCompare(providerName(b)));

  const saved = (cap: SpendCapView) => {
    data.setData((d) =>
      d ? { ...d, caps: [...d.caps.filter((c) => c.provider !== cap.provider), cap] } : d,
    );
    setEditing(null);
    toast.show(S.saved, { tone: 'success' });
  };

  return (
    <>
      <section
        ref={sectionRef}
        id="spend-caps"
        className="settings-section"
        aria-labelledby={id}
        tabIndex={-1}
      >
        <h3 id={id}>{S.title}</h3>
        <p className="muted">{S.intro}</p>
        {data.error ? (
          <ErrorBox message={dataErrorMessage(data.error, S.loadError)} onRetry={data.reload} />
        ) : null}
        {data.loading ? <Spinner label={S.loading} /> : null}
        {data.data && providers.length === 0 ? <p className="muted">{S.none}</p> : null}
        {providers.length ? (
          <ul className="dc-caps">
            {providers.map((p) => {
              const cap = caps.find((c) => c.provider === p) ?? null;
              return (
                <li key={p} className="dc-cap">
                  <CapRow
                    provider={p}
                    cap={cap}
                    editing={editing === p}
                    onEdit={() => setEditing(p)}
                    onCancel={() => setEditing(null)}
                    onRemove={() => setRemoving(p)}
                    onSaved={saved}
                  />
                </li>
              );
            })}
          </ul>
        ) : null}
        <ConfirmDialog
          open={removing !== null}
          title={S.removeTitle}
          confirmLabel={S.removeConfirm}
          danger
          errorText={(err) => dataErrorMessage(err, S.removeFailed)}
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            const p = removing!;
            await api.removeSpendCap!(p);
            data.setData((d) => (d ? { ...d, caps: d.caps.filter((c) => c.provider !== p) } : d));
            setRemoving(null);
            toast.show(S.removed, { tone: 'success' });
          }}
        >
          {removing ? <p>{S.removeBody({ provider: providerName(removing) })}</p> : null}
        </ConfirmDialog>
      </section>
      {api.clearUsage ? (
        <ClearUsageSection
          onCleared={() => {
            data.reload();
            onCleared?.();
          }}
        />
      ) : null}
    </>
  );
}

function CapRow({
  provider,
  cap,
  editing,
  onEdit,
  onCancel,
  onRemove,
  onSaved,
}: {
  provider: string;
  cap: SpendCapView | null;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onRemove: () => void;
  onSaved: (cap: SpendCapView) => void;
}) {
  const name = providerName(provider);
  const headId = useId();
  // Back from the editor, focus returns to the button that opened it.
  const button = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(editing);
  useEffect(() => {
    if (wasEditing.current && !editing) button.current?.focus();
    wasEditing.current = editing;
  }, [editing]);
  if (editing)
    return <CapEditor provider={provider} cap={cap} onCancel={onCancel} onSaved={onSaved} />;
  const state = cap ? capState(cap) : null;
  return (
    <div className="dc-cap-row" aria-labelledby={headId} role="group">
      <div className="dc-cap-head">
        <strong id={headId}>{name}</strong>
        {state ? <StateChip text={state.text} tone={state.tone} icon={state.icon} /> : null}
      </div>
      {cap ? (
        <>
          <meter
            className="dc-meter"
            min={0}
            max={cap.limitUsd}
            value={Math.min(cap.spentUsd, cap.limitUsd)}
            low={cap.limitUsd * cap.warnAt}
            high={cap.limitUsd * 0.999}
            optimum={0}
            aria-label={S.meter({ provider: name })}
            aria-valuetext={capSpentText(cap)}
          />
          <p>{capSpentText(cap)}</p>
          <p className="muted">{capRulesText(cap)}</p>
        </>
      ) : (
        <p className="muted">{S.noCap}</p>
      )}
      <div className="row">
        <Button ref={button} onClick={onEdit}>
          {cap ? S.edit : S.set}
        </Button>
        {cap ? (
          <Button variant="ghost" onClick={onRemove}>
            {S.remove}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function CapEditor({
  provider,
  cap,
  onCancel,
  onSaved,
}: {
  provider: string;
  cap: SpendCapView | null;
  onCancel: () => void;
  onSaved: (cap: SpendCapView) => void;
}) {
  const api = useDatactlApi();
  const [draft, setDraft] = useState<CapDraft>(() => capDraft(cap));
  const [fieldError, setFieldError] = useState<{ field: 'limit' | 'warn'; text: string } | null>(
    null,
  );
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  const headId = useId();
  useEffect(() => {
    first.current?.focus();
  }, []);

  const save = async () => {
    const parsed = parseCapDraft(draft);
    if ('error' in parsed) {
      setFieldError({ field: parsed.field, text: parsed.error });
      return;
    }
    setFieldError(null);
    setFailure(null);
    setBusy(true);
    try {
      onSaved(await api.setSpendCap!(provider, parsed.body));
    } catch (err) {
      setFailure(dataErrorMessage(err, S.saveFailed));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="dc-cap-form stack"
      aria-labelledby={headId}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <strong id={headId}>{S.editTitle({ provider: providerName(provider) })}</strong>
      <TextField
        ref={first}
        label={S.limit}
        inputMode="decimal"
        value={draft.limit}
        error={fieldError?.field === 'limit' ? fieldError.text : undefined}
        onChange={(e) => setDraft({ ...draft, limit: e.target.value })}
      />
      <SelectField
        label={S.period}
        value={draft.period}
        options={periodOptions()}
        onChange={(v) => setDraft({ ...draft, period: v === 'day' ? 'day' : 'month' })}
      />
      <TextField
        label={S.warnAt}
        inputMode="numeric"
        value={draft.warnPercent}
        error={fieldError?.field === 'warn' ? fieldError.text : undefined}
        onChange={(e) => setDraft({ ...draft, warnPercent: e.target.value })}
      />
      <SwitchField
        label={S.hardStop}
        description={S.hardStopHint}
        checked={draft.hardStop}
        onChange={(next) => setDraft({ ...draft, hardStop: next })}
      />
      {failure ? (
        <p role="alert" className="nv-field-error">
          {failure}
        </p>
      ) : null}
      <div className="row">
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? <Spinner /> : null} {S.save}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          {S.cancel}
        </Button>
      </div>
    </form>
  );
}

function ClearUsageSection({ onCleared }: { onCleared: () => void }) {
  const api = useDatactlApi();
  const toast = useToast();
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <section className="settings-section" aria-labelledby={id}>
      <h3 id={id}>{S.clearTitle}</h3>
      <p className="muted">{S.clearIntro}</p>
      <div className="row">
        <Button variant="danger" onClick={() => setOpen(true)}>
          {S.clearButton}
        </Button>
      </div>
      <ConfirmDialog
        open={open}
        title={S.clearConfirmTitle}
        confirmLabel={S.clearConfirm}
        danger
        errorText={(err) => dataErrorMessage(err, S.clearFailed)}
        onClose={() => setOpen(false)}
        onConfirm={async () => {
          const { removed } = await api.clearUsage!();
          setOpen(false);
          toast.show(S.cleared({ n: removed }), { tone: 'success' });
          onCleared();
        }}
      >
        <p>{S.clearIntro}</p>
      </ConfirmDialog>
    </section>
  );
}
