// PresetScale (docs/04 §3.1, §4.2): the Faster to Smarter model control (FR-221). Native radios in
// a fieldset, so it is one tab stop and the arrow keys move the choice; every stop keeps a visible
// label, and the end captions only repeat the direction of the scale.
import { useId, type ReactNode } from 'react';
import { UI_TEXT } from '../strings.ts';

export interface PresetScaleOption {
  value: string;
  label: string;
  /** Extra detail for assistive tech and the tooltip. */
  description?: string;
}

export interface PresetScaleProps {
  /** Accessible name of the group. */
  label: string;
  /** Ordered from the low end (faster) to the high end (smarter). */
  options: PresetScaleOption[];
  /** The chosen option, or null when the current choice is not on the scale. */
  value: string | null;
  onChange: (value: string) => void;
  startLabel?: string;
  endLabel?: string;
  disabled?: boolean;
  /** Shown after the scale, e.g. a link to the advanced settings. */
  children?: ReactNode;
  className?: string;
}

export function PresetScale({
  label,
  options,
  value,
  onChange,
  startLabel = UI_TEXT.faster,
  endLabel = UI_TEXT.smarter,
  disabled,
  children,
  className,
}: PresetScaleProps) {
  const id = `p${useId()}`;
  return (
    <fieldset
      className={className ? `nv-preset ${className}` : 'nv-preset'}
      disabled={disabled}
      data-empty={value === null || undefined}
    >
      <legend className="nv-vh">{label}</legend>
      <span className="nv-preset-end" aria-hidden="true">
        {startLabel}
      </span>
      <span className="nv-preset-track">
        {options.map((o, i) => (
          <label key={o.value} className="nv-preset-stop" title={o.description}>
            <input
              type="radio"
              name={id}
              value={o.value}
              checked={value === o.value}
              disabled={disabled}
              aria-labelledby={`${id}-${i}`}
              aria-describedby={o.description ? `${id}-${i}-d` : undefined}
              onChange={() => onChange(o.value)}
            />
            <span id={`${id}-${i}`} className="nv-preset-label">
              {o.label}
            </span>
            {o.description ? (
              <span id={`${id}-${i}-d`} className="nv-vh">
                {o.description}
              </span>
            ) : null}
          </label>
        ))}
      </span>
      <span className="nv-preset-end" aria-hidden="true">
        {endLabel}
      </span>
      {children}
    </fieldset>
  );
}
