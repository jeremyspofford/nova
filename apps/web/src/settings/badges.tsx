// Small status pieces shared by the M4 settings pages. Every state pairs an icon with text, never
// color alone (docs/04 §7).
import { Icon, type IconName } from '@nova/ui';

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
      <Icon name="shield" /> Verified
    </span>
  ) : (
    <span className="ws-badge" data-tone="warn">
      <Icon name="alert" /> Unverified
    </span>
  );
}
