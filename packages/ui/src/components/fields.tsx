// Form fields beyond TextField (docs/04 §4.2): SelectField, ColorField and RadioGroup. Each has a
// visible label, links hint and error text, and shows a managed-policy lock (docs/14 §1.2).
import {
  createContext,
  useContext,
  useId,
  useState,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { subscribe } from '@nova/i18n';
import { UI_TEXT } from '../strings.ts';

const HEX6 = /^#[0-9a-f]{6}$/i;

/**
 * Shown on controls whose value comes from managed policy, in the active locale. A live binding:
 * read it at render time (copying it into a constant at load freezes the language); prefer
 * `UI_TEXT.managed`.
 */
export let MANAGED_TEXT = UI_TEXT.managed;
subscribe(() => {
  MANAGED_TEXT = UI_TEXT.managed;
});

/** Draws the note of a locked field: `id` must stay on the element the field points to. */
export type LockNoteRenderer = (note: { id: string; setting?: string }) => ReactNode;

const LockNoteContext = createContext<LockNoteRenderer | null>(null);

/**
 * Lets the app draw every locked field's note itself, e.g. "Managed by your organization (policy
 * file)" with where the policy comes from (docs/14 §1.2). Without it the note is the plain words.
 */
export function LockNoteProvider({
  render,
  children,
}: {
  render: LockNoteRenderer;
  children: ReactNode;
}) {
  return <LockNoteContext.Provider value={render}>{children}</LockNoteContext.Provider>;
}

/** The note of a locked field, with the `id` the field's aria-describedby names (WCAG 1.3.1). */
export function LockNote({ id, setting }: { id: string; setting?: string }) {
  const render = useContext(LockNoteContext);
  if (render) return <>{render({ id, setting })}</>;
  return (
    <span id={id} className="nv-field-hint nv-field-lock">
      {UI_TEXT.managed}
    </span>
  );
}

function Described({
  id,
  hint,
  error,
  locked,
  setting,
}: {
  id: string;
  hint?: ReactNode;
  error?: string;
  locked?: boolean;
  setting?: string;
}) {
  return (
    <>
      {locked ? <LockNote id={`${id}-lock`} setting={setting} /> : null}
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
  /** The setting a lock comes from, so its note can name the policy's source. */
  setting?: string;
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
  setting,
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
      <Described id={id} hint={hint} error={error} locked={locked} setting={setting} />
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
  /** The setting a lock comes from, so its note can name the policy's source. */
  setting?: string;
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
  setting,
  resetLabel = UI_TEXT.color.reset,
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
          dir="ltr"
          aria-label={UI_TEXT.color.hex({ label })}
          aria-describedby={locked ? `${id}-lock` : undefined}
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
          aria-label={UI_TEXT.color.resetFor({ action: resetLabel, label })}
        >
          {resetLabel}
        </button>
      </div>
      <Described
        id={id}
        hint={hint}
        locked={locked}
        setting={setting}
        error={invalid ? UI_TEXT.color.invalid : undefined}
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
  /** The setting a lock comes from, so its note can name the policy's source. */
  setting?: string;
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
  setting,
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
            // Each choice also names the lock, so it is heard on the choice itself.
            aria-describedby={
              [o.description ? `${id}-${i}-desc` : null, locked ? `${id}-lock` : null]
                .filter(Boolean)
                .join(' ') || undefined
            }
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
      <Described id={id} hint={hint} locked={locked} setting={setting} />
    </fieldset>
  );
}
