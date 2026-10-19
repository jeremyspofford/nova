// Small controls shared by the settings pages: a labelled switch row whose description and
// managed-policy lock are linked to the switch (docs/04 §4.4, docs/14 §1.2). The lock names the
// policy's source when the Hub says it (M8, FR-106).
import { useId, type ReactNode } from 'react';
import { ManagedNote } from '../managed/ManagedNote.tsx';

export function SwitchField({
  label,
  description,
  checked,
  onChange,
  locked,
  disabled,
  setting,
}: {
  label: string;
  description?: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  locked?: boolean;
  disabled?: boolean;
  /** The setting the switch shows: a lock then names the policy source of that setting. */
  setting?: string;
}) {
  const id = `sw${useId()}`;
  const describedBy =
    [description ? `${id}-desc` : null, locked ? `${id}-lock` : null].filter(Boolean).join(' ') ||
    undefined;
  return (
    <div className="ws-switch-field">
      <div className="ws-switch-text">
        <span id={`${id}-label`} className="nv-field-label">
          {label}
        </span>
        {description ? (
          <span id={`${id}-desc`} className="nv-field-hint">
            {description}
          </span>
        ) : null}
        {locked ? <ManagedNote id={`${id}-lock`} setting={setting} /> : null}
      </div>
      <button
        type="button"
        role="switch"
        className="nv-switch"
        aria-checked={checked}
        aria-labelledby={`${id}-label`}
        aria-describedby={describedBy}
        disabled={locked || disabled}
        onClick={() => onChange(!checked)}
      />
    </div>
  );
}
