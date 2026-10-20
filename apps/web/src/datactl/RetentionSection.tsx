// How long each kind of data is kept (FR-105; docs/12 §9; ADR-097 D5): chats, Work runs, the audit
// log (never under its 365-day floor), artifacts and activity history, each a security setting
// managed policy can lock. Keeping less asks first, since the next daily sweep deletes what is past
// its time; keeping more does not. The last and next sweep, and a sweep now that says what it
// deletes before it runs.
import { useId, useState } from 'react';
import {
  AUDIT_RETENTION_FLOOR_DAYS,
  DELETED_RECOVERY_DAYS,
  RETENTION_ITEMS,
  RETENTION_SETTING_KEYS,
  type RetentionItem,
  type RetentionItemView,
} from '@nova/shared';
import { Button, SelectField, Spinner, useToast } from '@nova/ui';
import { useHubStream } from '../hub-events.ts';
import { formatWhen } from '../settings/common.ts';
import { useSettings } from '../settings.tsx';
import { useDatactlApi } from './api-m8.ts';
import {
  DATA_STRINGS as S,
  RETENTION_TEXT,
  SWEEP_TEXT,
  dataErrorMessage,
  retentionConfirmText,
  retentionHint,
  retentionOptions,
  retentionTitle,
  sweepCounts,
} from './format.ts';
import { ConfirmDialog, ErrorBox, useFetched } from './parts.tsx';

export function RetentionSection() {
  const api = useDatactlApi();
  const settings = useSettings();
  const toast = useToast();
  const id = useId();
  const view = useFetched(api.getRetention ? () => api.getRetention!() : null);
  const [shorten, setShorten] = useState<{ item: RetentionItem; days: number } | null>(null);
  const [sweeping, setSweeping] = useState(false);
  const [status, setStatus] = useState('');
  useHubStream(['data.retention.swept', 'settings.changed'], (env) => {
    const key = env.payload.key;
    if (
      env.name === 'settings.changed' &&
      !(typeof key === 'string' && key.startsWith('retention.'))
    )
      return;
    view.reload();
  });

  const write = async (item: RetentionItem, days: number | null) => {
    await settings.set(RETENTION_SETTING_KEYS[item], days);
    view.reload();
  };

  const choose = (item: RetentionItemView, value: string) => {
    const days = value === 'forever' ? null : Number(value);
    const current = settings.get(RETENTION_SETTING_KEYS[item.item]).value;
    if (days !== null && (current === null || days < current)) {
      setShorten({ item: item.item, days });
      return;
    }
    write(item.item, days).catch((err: unknown) =>
      toast.show(S.saveFailedWhy({ why: dataErrorMessage(err) }), { tone: 'error' }),
    );
  };

  const items = view.data?.items ?? [];
  const due = Object.fromEntries(items.map((i) => [i.item, i.due])) as Partial<
    Record<RetentionItem, number>
  >;
  const dueText = sweepCounts(due);
  const last = view.data?.lastSweep ?? null;

  return (
    <section className="settings-section" aria-labelledby={id}>
      <h3 id={id}>{S.retentionTitle}</h3>
      <p className="muted">{S.retentionIntro}</p>
      {view.error ? (
        <ErrorBox
          message={dataErrorMessage(view.error, S.retentionLoadError)}
          onRetry={view.reload}
        />
      ) : null}
      {view.loading ? <Spinner label={S.retentionLoading} /> : null}
      {RETENTION_ITEMS.map((key) => {
        const item = items.find((i) => i.item === key);
        if (!item) return null;
        const entry = settings.get(RETENTION_SETTING_KEYS[key]);
        const text = RETENTION_TEXT[key];
        return (
          <div key={key} className="dc-retention">
            <SelectField
              label={text.label}
              value={entry.value === null ? 'forever' : String(entry.value)}
              options={retentionOptions(item.floorDays, entry.value)}
              locked={entry.locked}
              setting={RETENTION_SETTING_KEYS[key]}
              hint={
                <>
                  {retentionHint(key)}{' '}
                  {key === 'audit'
                    ? S.retentionAuditFloor({ days: AUDIT_RETENTION_FLOOR_DAYS })
                    : null}
                  {key === 'threads' ? S.retentionRecovery({ days: DELETED_RECOVERY_DAYS }) : null}
                </>
              }
              onChange={(v) => choose(item, v)}
            />
            <p className="muted dc-due">
              {entry.value === null
                ? SWEEP_TEXT.kept
                : SWEEP_TEXT.due({ item: text.label, n: item.due })}
            </p>
          </div>
        );
      })}
      {view.data ? (
        <dl className="ws-dl">
          <dt>{S.lastSweep}</dt>
          <dd>
            {last ? (
              <>
                {SWEEP_TEXT.sweptAt({ when: formatWhen(last.startedAt), trigger: last.trigger })}{' '}
                {(() => {
                  const removed = sweepCounts(last.removed);
                  return removed
                    ? SWEEP_TEXT.removed({ what: removed })
                    : SWEEP_TEXT.removedNothing;
                })()}
                {last.error ? (
                  <span className="dc-warn"> {SWEEP_TEXT.failed({ why: last.error })}</span>
                ) : null}
              </>
            ) : (
              S.noSweep
            )}
          </dd>
          <dt>{S.nextSweep}</dt>
          <dd>{formatWhen(view.data.nextSweepAt)}</dd>
        </dl>
      ) : null}
      {view.data && api.sweepRetention ? (
        <div className="row">
          <Button onClick={() => setSweeping(true)}>{S.sweepButton}</Button>
        </div>
      ) : null}
      <p role="status" className="muted">
        {status}
      </p>
      <ConfirmDialog
        open={shorten !== null}
        title={shorten ? retentionTitle(shorten.item, shorten.days) : ''}
        confirmLabel={S.shortenConfirm}
        danger
        errorText={(err) => dataErrorMessage(err, S.saveFailed)}
        onClose={() => setShorten(null)}
        onConfirm={async () => {
          if (!shorten) return;
          await write(shorten.item, shorten.days);
          setShorten(null);
        }}
      >
        {shorten ? <p>{retentionConfirmText(shorten.item, shorten.days)}</p> : null}
      </ConfirmDialog>
      <ConfirmDialog
        open={sweeping}
        title={S.sweepTitle}
        confirmLabel={S.sweepConfirm}
        danger
        errorText={(err) => dataErrorMessage(err, S.sweepFailed)}
        onClose={() => setSweeping(false)}
        onConfirm={async () => {
          const r = await api.sweepRetention!();
          setSweeping(false);
          const removed = sweepCounts(r.removed);
          setStatus(removed ? SWEEP_TEXT.sweptSome({ what: removed }) : SWEEP_TEXT.sweptNone);
          view.reload();
        }}
      >
        <p>{dueText ? SWEEP_TEXT.willDelete({ what: dueText }) : S.sweepNothing}</p>
      </ConfirmDialog>
    </section>
  );
}
