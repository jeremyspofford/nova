// Small feedback components (docs/04 §4.2, §6): VisuallyHidden, Spinner, EmptyState, StatusChip.
import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon.tsx';

/** Text for assistive tech only (WCAG technique C7). */
export function VisuallyHidden({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <span className="nv-vh" id={id}>
      {children}
    </span>
  );
}

/**
 * Indeterminate progress. With a label it is a polite status; without one it is decorative.
 * The animation stops under reduced motion (tokens.css).
 */
export function Spinner({ label, size = '1em' }: { label?: string; size?: string }) {
  const dims = { width: size, height: size };
  if (!label) return <span className="nv-spinner" style={dims} aria-hidden="true" />;
  return (
    <span role="status" className="nv-spinner-wrap">
      <span className="nv-spinner" style={dims} aria-hidden="true" />
      <VisuallyHidden>{label}</VisuallyHidden>
    </span>
  );
}

export interface EmptyStateProps {
  title: string;
  description?: ReactNode;
  icon?: IconName;
  action?: ReactNode;
  /** Heading level so the empty state fits the page outline. */
  level?: 2 | 3;
}

export function EmptyState({ title, description, icon, action, level = 2 }: EmptyStateProps) {
  const Heading = level === 2 ? 'h2' : 'h3';
  return (
    <div className="nv-empty">
      {icon ? (
        <span className="nv-empty-icon">
          <Icon name={icon} size="32px" />
        </span>
      ) : null}
      <Heading className="nv-empty-title">{title}</Heading>
      {description ? <div className="nv-empty-description">{description}</div> : null}
      {action ? <div className="nv-empty-action">{action}</div> : null}
    </div>
  );
}

/** The four runtime statuses (docs/04 §1.1, FR-215). */
export type Status = 'needs_input' | 'blocked' | 'running' | 'ready';

const STATUS: Record<Status, { text: string; icon: IconName | null }> = {
  needs_input: { text: 'Needs input', icon: 'hand' },
  blocked: { text: 'Blocked', icon: 'stop' },
  running: { text: 'Running', icon: null },
  ready: { text: 'Ready', icon: 'check' },
};

/** Status chip: always icon plus text, never color alone (docs/04 §7). */
export function StatusChip({
  status,
  reason,
  compact,
}: {
  status: Status;
  reason?: string;
  /** Icon only visually; the text stays available to assistive tech. */
  compact?: boolean;
}) {
  const s = STATUS[status];
  const text = reason ? `${s.text}: ${reason}` : s.text;
  return (
    <span
      className="nv-chip"
      data-status={status}
      data-compact={compact || undefined}
      title={compact ? text : undefined}
    >
      {s.icon ? <Icon name={s.icon} /> : <Spinner />}
      {compact ? <VisuallyHidden>{text}</VisuallyHidden> : <span>{text}</span>}
    </span>
  );
}
