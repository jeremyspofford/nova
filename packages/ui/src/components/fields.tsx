// Form fields beyond TextField (docs/04 §4.2): SelectField, ColorField and RadioGroup. Each has a
// visible label, links hint and error text, and shows a managed-policy lock (docs/14 §1.2).
import { useId, useState, type ReactNode, type SelectHTMLAttributes } from 'react';

const HEX6 = /^#[0-9a-f]{6}$/i;

/** Shown on controls whose value comes from managed policy. */
export const MANAGED_TEXT = 'Managed by your organization';

function Described({
  id,
  hint,
  error,
  locked,
}: {
  id: string;
  hint?: ReactNode;
  error?: string;
  locked?: boolean;
}) {
  return (
    <>
      {locked ? (
        <span id={`${id}-lock`} className="nv-field-hint nv-field-lock">
          {MANAGED_TEXT}
        </span>
      ) : null}
      {hint ? (
        <span id={`${id}-hint`} className="nv-field-hint">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={`${id}-error`} className="nv-field-error" role="alert">
          {error}
        </span>
      ) : null}
    </>
  );
}

function describedBy(id: string, hint?: unknown, error?: unknown, locked?: boolean) {
  return (
    [locked && `${id}-lock`, hint ? `${id}-hint` : null, error ? `${id}-error` : null]
      .filter(Boolean)
      .join(' ') || undefined
  );
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  /** Tooltip text, e.g. why an option is disabled. */
  title?: string;
}

export interface SelectFieldProps extends Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  'id' | 'onChange' | 'value'
> {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options?: SelectOption[];
  /** Grouped options; rendered as optgroups after any ungrouped options. */
  groups?: { label: string; options: SelectOption[] }[];
  hint?: ReactNode;
  error?: string;
  locked?: boolean;
  /** Hide the label visually (it stays the accessible name). */
  hideLabel?: boolean;
}

export function SelectField({
  label,
  value,
  onChange,
  options = [],
  groups = [],
  hint,
  error,
  locked,
  hideLabel,
  disabled,
  className,
  ...rest
}: SelectFieldProps) {
  const id = `s${useId()}`;
  const opt = (o: SelectOption) => (
    <option key={o.value} value={o.value} disabled={o.disabled} title={o.title}>
      {o.label}
    </option>
  );
  return (
    <div className={className ? `nv-field ${className}` : 'nv-field'}>
      <label className={hideLabel ? 'nv-vh' : 'nv-field-label'} htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="nv-input nv-select"
        value={value}
        disabled={disabled || locked}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error, locked)}
        onChange={(e) => onChange(e.target.value)}
        {...rest}
      >
        {options.map(opt)}
        {groups.map((g, i) => (
          <optgroup key={`${i}-${g.label}`} label={g.label}>
            {g.options.map(opt)}
          </optgroup>
        ))}
      </select>
      <Described id={id} hint={hint} error={error} locked={locked} />
    </div>
  );
}

export interface ColorFieldProps {
  label: string;
  /** The override, or null when the theme's color is in use. */
  value: string | null;
  /** The theme's color, shown while there is no override. */
  fallback: string;
  onChange: (hex: string) => void;
  onReset: () => void;
  hint?: ReactNode;
  locked?: boolean;
  resetLabel?: string;
}

/** A color swatch plus a hex text box (for keyboard and screen-reader users) and a reset. */
export function ColorField({
  label,
  value,
  fallback,
  onChange,
  onReset,
  hint,
  locked,
  resetLabel = 'Reset to theme',
}: ColorFieldProps) {
  const id = `c${useId()}`;
  const shown = (value ?? fallback).toLowerCase();
  const [draft, setDraft] = useState<{ base: string; text: string } | null>(null);
  // A draft belongs to the value it was typed against; a new value from outside discards it.
  const text = draft && draft.base === shown ? draft.text : shown;
  const invalid = !HEX6.test(text);

  const commit = () => {
    if (!invalid && text.toLowerCase() !== shown) onChange(text.toLowerCase());
    setDraft(null);
  };

  return (
    <div className="nv-field nv-color">
      <span className="nv-field-label" id={`${id}-label`}>
        {label}
      </span>
      <div className="nv-color-row">
        <input
          type="color"
          className="nv-color-swatch"
          aria-labelledby={`${id}-label`}
          aria-describedby={describedBy(id, hint, undefined, locked)}
          value={shown}
          disabled={locked}
          onChange={(e) => onChange(e.target.value.toLowerCase())}
        />
        <input
          type="text"
          className="nv-input nv-color-hex"
          aria-label={`${label} hex value`}
          aria-invalid={invalid ? true : undefined}
          value={text}
          disabled={locked}
          spellCheck={false}
          maxLength={7}
          onChange={(e) => setDraft({ base: shown, text: e.target.value })}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            }
          }}
        />
        <button
          type="button"
          className="nv-btn"
          data-variant="ghost"
          disabled={locked || value === null}
          onClick={onReset}
          aria-label={`${resetLabel}: ${label}`}
        >
          {resetLabel}
        </button>
      </div>
      <Described
        id={id}
        hint={hint}
        locked={locked}
        error={invalid ? 'Enter a hash sign and six hex digits (0–9, a–f)' : undefined}
      />
    </div>
  );
}

export interface RadioOption {
  value: string;
  label: string;
  description?: ReactNode;
}

export interface RadioGroupProps {
  legend: string;
  name: string;
  value: string;
  options: RadioOption[];
  onChange: (value: string) => void;
  locked?: boolean;
  hint?: ReactNode;
  className?: string;
}

/** Native radios in a fieldset: arrow keys move the selection, one tab stop for the group. */
export function RadioGroup({
  legend,
  name,
  value,
  options,
  onChange,
  locked,
  hint,
  className,
}: RadioGroupProps) {
  const id = `r${useId()}`;
  return (
    <fieldset
      className={className ? `nv-radios ${className}` : 'nv-radios'}
      disabled={locked}
      aria-describedby={describedBy(id, hint, undefined, locked)}
    >
      <legend className="nv-field-label">{legend}</legend>
      {options.map((o, i) => (
        <label key={o.value} className="nv-radio">
          {/* The label names the radio; the description describes it, so names stay short. */}
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={value === o.value}
            disabled={locked}
            aria-labelledby={`${id}-${i}-label`}
            aria-describedby={o.description ? `${id}-${i}-desc` : undefined}
            onChange={() => onChange(o.value)}
          />
          <span className="nv-radio-text">
            <span id={`${id}-${i}-label`}>{o.label}</span>
            {o.description ? (
              <span id={`${id}-${i}-desc`} className="nv-field-hint">
                {o.description}
              </span>
            ) : null}
          </span>
        </label>
      ))}
      <Described id={id} hint={hint} locked={locked} />
    </fieldset>
  );
}
