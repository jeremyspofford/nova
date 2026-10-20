// What an update changes, shown alike in the marketplace's install dialog and the extension
// preview (FR-049, FR-117; docs/14 §5): each changed permission worded part by part, with a change
// that lets the item do more without asking marked Sensitive (never the raw detail), and a change
// of publisher said first, with the explicit acceptance it needs (it clears the extension's stored
// secrets and data).
import type { MarketPermissionDiff } from '@nova/shared';
import { Icon } from '@nova/ui';
import {
  CHANGE_TEXT,
  INSTALL_TEXT,
  PUBLISHER_CHANGE_TEXT,
  describeChange,
  publisherSideText,
} from './format.ts';

type Changed = MarketPermissionDiff['changed'][number];

function SensitiveMark() {
  return (
    <span className="market-sensitive">
      <Icon name="alert" /> {CHANGE_TEXT.sensitive}
    </span>
  );
}

/** One changed permission of an update, as a list item. */
export function ChangedPermission({
  change,
  kind,
  label,
}: {
  change: Changed;
  /** The line's kind, from the new version's lines (else read from its key). */
  kind?: string;
  /** "Changed" in the list's own words. */
  label: string;
}) {
  const v = describeChange(change, kind);
  return (
    <li className="market-change" data-sensitive={v.sensitive || undefined}>
      <span>
        <strong>{label}:</strong>{' '}
        {v.plain
          ? INSTALL_TEXT.diffChangedLine({
              text: change.text,
              before: change.before ?? CHANGE_TEXT.none,
              after: change.after ?? CHANGE_TEXT.none,
            })
          : change.text}{' '}
        {v.sensitive ? <SensitiveMark /> : null}
      </span>
      {v.fields.length ? (
        <ul className="market-change-parts">
          {v.fields.map((f) => {
            const text = CHANGE_TEXT.field({ label: f.label, before: f.before, after: f.after });
            return (
              <li key={f.label} data-sensitive={f.sensitive || undefined}>
                {f.sensitive ? <strong>{text}</strong> : text}
              </li>
            );
          })}
        </ul>
      ) : null}
      {v.unreadable ? <p className="muted market-change-note">{CHANGE_TEXT.unreadable}</p> : null}
    </li>
  );
}

interface PublisherSide {
  key: string | null;
  name: string | null;
  fingerprint: string | null;
  trusted: boolean;
}

/** An update signed by another publisher (or by none): who it was, who it is, and the consent. */
export function PublisherChangeNotice({
  change,
  accepted,
  onAccept,
}: {
  change: { from: PublisherSide; to: PublisherSide };
  accepted: boolean;
  onAccept: (accepted: boolean) => void;
}) {
  return (
    <div className="ws-callout market-publisher-change" role="note" data-tone="blocked">
      <Icon name="alert" />
      <div className="stack">
        <p className="market-strong">{PUBLISHER_CHANGE_TEXT.title}</p>
        <p>{PUBLISHER_CHANGE_TEXT.from({ who: publisherSideText(change.from) })}</p>
        <p>{PUBLISHER_CHANGE_TEXT.to({ who: publisherSideText(change.to) })}</p>
        <p>{PUBLISHER_CHANGE_TEXT.clears}</p>
        <label className="ws-check">
          <input type="checkbox" checked={accepted} onChange={(e) => onAccept(e.target.checked)} />
          <span>{PUBLISHER_CHANGE_TEXT.accept}</span>
        </label>
      </div>
    </div>
  );
}
