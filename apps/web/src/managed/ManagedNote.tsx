// Where a lock comes from (FR-106; docs/14 §1.2, docs/12 §10): the one "Managed by your
// organization" note every locked control shows, with the policy's source when the Hub says it
// (the setting's own source, else the sources in force), and the banner Settings shows above every
// section while a policy is in force or failing closed. Both read the shared managed view; the
// note renders the plain text when there is no Hub client or no view (an older Hub, a member).
import type { ManagedChannel } from '@nova/shared';
import { Icon } from '@nova/ui';
import { useHubStream } from '../hub-events.ts';
import { useOptionalServices, useServices } from '../services.tsx';
import {
  CHANNEL_LABEL,
  LOCK_SOURCE,
  MANAGED_PATH,
  MANAGED_STRINGS as S,
  lockChannel,
  policyShows,
} from './format.ts';
import { InAppLink } from './link.tsx';
import { useManagedView } from './store.ts';
import './managed.css';

export interface ManagedNoteProps {
  /** The setting the locked control shows: its own source when the policy names it. */
  setting?: string;
  /** For `aria-describedby` on the control. */
  id?: string;
  /** A paragraph under a group of controls, or a span inside a field (default). */
  as?: 'span' | 'p';
}

function NoteText({
  id,
  as = 'span',
  source,
}: Omit<ManagedNoteProps, 'setting'> & { source: ManagedChannel | 'both' | null }) {
  const Tag = as;
  return (
    <Tag id={id} className="nv-field-hint nv-field-lock mg-note">
      <span>{S.managed}</span>
      {source ? <span className="mg-note-source">{LOCK_SOURCE[source]}</span> : null}
    </Tag>
  );
}

function NoteFromHub({ api, setting, ...rest }: ManagedNoteProps & { api: object }) {
  const { view } = useManagedView(api);
  return <NoteText {...rest} source={lockChannel(view, setting)} />;
}

/** "Managed by your organization (policy file)": the note of a control managed policy locks. */
export function ManagedNote(props: ManagedNoteProps) {
  const services = useOptionalServices();
  if (!services) return <NoteText id={props.id} as={props.as} source={null} />;
  return <NoteFromHub {...props} api={services.api} />;
}

/**
 * Above every Settings section while your organization's policy is in force: that it manages the
 * Hub, its sources, and a link to what applies. While a trusted source fails to read, it says that
 * every agent tool is denied.
 */
export function ManagedBanner() {
  const { api } = useServices();
  const m = useManagedView(api);
  useHubStream(['managed.policy.changed'], () => void m.refresh());
  if (!policyShows(m.view) || !m.view) return null;
  const view = m.view;
  const inForce = view.sources.filter((s) => s.inForce);
  const failing = view.failClosed !== null;
  return (
    <div className="ws-callout mg-banner" role="note" data-tone={failing ? 'danger' : undefined}>
      <Icon name={failing ? 'alert' : 'shield'} />
      <div className="stack">
        {failing ? (
          <>
            <p className="mg-strong">{S.failClosedTitle}</p>
            <p>{S.failClosed}</p>
            <p className="muted mg-detail">{view.failClosed}</p>
          </>
        ) : (
          <p>{S.bannerActive}</p>
        )}
        {inForce.length ? (
          <ul className="mg-banner-sources">
            {inForce.map((s) => (
              <li key={s.channel}>
                {CHANNEL_LABEL[s.channel]}: <code className="mg-code">{s.location}</code>
              </li>
            ))}
          </ul>
        ) : null}
        <p>
          <InAppLink to={MANAGED_PATH}>{S.bannerSee}</InAppLink>
        </p>
      </div>
    </div>
  );
}
