// Small status pieces shared by the M4 settings pages. Every state pairs an icon with text, never
// color alone (docs/04 §7).
import { defineMessages } from '@nova/i18n';
import { Icon, type IconName } from '@nova/ui';

const S = defineMessages('settings.badges', {
  verified: 'Verified',
  unverified: 'Unverified',
});

export function StateChip({
  text,
  tone,
  icon,
}: {
  text: string;
  tone: string | null;
  icon: IconName;
}) {
  return (
    <span className="nv-chip" data-status={tone ?? undefined}>
      <Icon name={icon} />
      <span>{text}</span>
    </span>
  );
}

/** Signed by a trusted publisher, or not (docs/14 §5: unsigned items stay labelled Unverified). */
export function VerifiedBadge({ verified }: { verified: boolean }) {
  return verified ? (
    <span className="ws-badge" data-tone="ok">
      <Icon name="shield" /> {S.verified}
    </span>
  ) : (
    <span className="ws-badge" data-tone="warn">
      <Icon name="alert" /> {S.unverified}
    </span>
  );
}
