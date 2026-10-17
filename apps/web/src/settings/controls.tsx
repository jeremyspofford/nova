// Small controls shared by the settings pages: a labelled switch row whose description and
// managed-policy lock are linked to the switch (docs/04 §4.4, docs/14 §1.2).
import { useId, type ReactNode } from 'react';
import { MANAGED } from './common.ts';

export function SwitchField({
  label,
  description,
  checked,
  onChange,
  locked,
  disabled,
}: {
  label: string;
  description?: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  locked?: boolean;
  disabled?: boolean;
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
        {locked ? (
          <span id={`${id}-lock`} className="nv-field-hint nv-field-lock">
            {MANAGED}
          </span>
        ) : null}
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
