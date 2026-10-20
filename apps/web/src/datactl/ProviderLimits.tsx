// Provider limits and spend (FR-115, FR-116) on Settings → Accounts: for each provider account its
// plan and limits as the provider reports them, the last limit it reported on a call (out of
// credit, rate limited), this month's estimated spend, and its spend cap with a link to set or
// change it on Profile & usage. Local model servers cost nothing and have no cap.
import { useId } from 'react';
import type { ProviderLimitView } from '@nova/shared';
import { Spinner } from '@nova/ui';
import { useHubStream } from '../hub-events.ts';
import { InAppLink } from '../managed/link.tsx';
import { StateChip } from '../settings/badges.tsx';
import { formatWhen } from '../settings/common.ts';
import { useDatactlApi } from './api-m8.ts';
import {
  LIMIT_TEXT,
  SPEND_STRINGS as S,
  capPath,
  capSpentText,
  capState,
  count,
  dataErrorMessage,
  formatUsd,
  formatUtcDate,
  providerName,
  reportedText,
} from './format.ts';
import { ErrorBox, useFetched } from './parts.tsx';
import './datactl.css';

function Entitlements({ e }: { e: NonNullable<ProviderLimitView['entitlements']> }) {
  const parts = [
    e.plan ? LIMIT_TEXT.plan({ plan: e.plan }) : null,
    e.limit !== null && e.used !== null
      ? LIMIT_TEXT.used({ used: count(e.used), limit: count(e.limit) })
      : e.limit !== null
        ? LIMIT_TEXT.limit({ limit: count(e.limit) })
        : null,
    e.resetAt ? LIMIT_TEXT.resets({ date: formatUtcDate(e.resetAt) }) : null,
  ].filter((x): x is string => x !== null);
  return <>{parts.length ? parts.join(' ') : LIMIT_TEXT.none}</>;
}

export function ProviderLimitsSection() {
  const api = useDatactlApi();
  const id = useId();
  const limits = useFetched(api.listProviderLimits ? () => api.listProviderLimits!() : null);
  useHubStream(['spend.cap.warning', 'spend.cap.reached'], () => limits.reload());
  if (!api.listProviderLimits) return null;
  const items = limits.data?.items ?? [];
  return (
    <section className="settings-section" aria-labelledby={id}>
      <h3 id={id}>{S.limitsTitle}</h3>
      <p className="muted">{S.limitsIntro}</p>
      {limits.error ? (
        <ErrorBox
          message={dataErrorMessage(limits.error, S.limitsLoadError)}
          onRetry={limits.reload}
        />
      ) : null}
      {limits.loading ? <Spinner label={S.limitsLoading} /> : null}
      {items.length ? (
        <ul className="dc-limits">
          {items.map((l) => {
            const state = l.spendCap ? capState(l.spendCap) : null;
            return (
              <li key={l.providerAccountId} className="dc-limit">
                <div className="dc-cap-head">
                  <strong dir="auto">{l.label}</strong>
                  <span className="muted">{providerName(l.provider)}</span>
                  {state ? (
                    <StateChip text={state.text} tone={state.tone} icon={state.icon} />
                  ) : null}
                </div>
                {l.local ? (
                  <p className="muted">{S.localNoCost}</p>
                ) : (
                  <dl className="ws-dl">
                    <dt>{S.thisMonth}</dt>
                    <dd>{LIMIT_TEXT.spent({ amount: formatUsd(l.spentThisMonthUsd) })}</dd>
                    <dt>{S.plan}</dt>
                    <dd>
                      {l.entitlements ? <Entitlements e={l.entitlements} /> : LIMIT_TEXT.none}
                    </dd>
                    <dt>{S.reported}</dt>
                    <dd>
                      {l.lastReported
                        ? LIMIT_TEXT.reportedAt({
                            text: reportedText(l.lastReported),
                            when: formatWhen(l.lastReported.at),
                          })
                        : S.noneReported}
                    </dd>
                    <dt>{S.title}</dt>
                    <dd>
                      <span>{l.spendCap ? capSpentText(l.spendCap) : S.noCap}</span>{' '}
                      <InAppLink to={capPath(l.provider)}>
                        {l.spendCap ? S.changeCap : S.setCap}
                      </InAppLink>
                    </dd>
                  </dl>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
