// Five foundation primitives (docs/04 §4.2): Button, IconButton, TextField, Kbd, Switch.
// Every component is keyboard-operable, labelled for assistive tech, and styled only via tokens.
import {
  forwardRef,
  useId,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';

export type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', type = 'button', className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      data-variant={variant}
      className={className ? `nv-btn ${className}` : 'nv-btn'}
      {...rest}
    />
  );
});

export interface IconButtonProps extends Omit<ButtonProps, 'children'> {
  /** Accessible name; icon-only buttons must have one (WCAG 4.1.2). */
  label: string;
  icon: ReactNode;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, title, ...rest },
  ref,
) {
  return (
    <Button ref={ref} aria-label={label} title={title ?? label} data-size="icon" {...rest}>
      <span aria-hidden="true">{icon}</span>
    </Button>
  );
});

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string;
  hint?: string;
  error?: string;
  id?: string;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, hint, error, id, className, ...rest },
  ref,
) {
  const auto = useId();
  const inputId = id ?? `f${auto}`;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className="nv-field">
      <label className="nv-field-label" htmlFor={inputId}>
        {label}
      </label>
      <input
        ref={ref}
        id={inputId}
        className={className ? `nv-input ${className}` : 'nv-input'}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...rest}
      />
      {hint ? (
        <span id={hintId} className="nv-field-hint">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={errorId} className="nv-field-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
});

export interface KbdProps {
  /** Key names, e.g. ['Ctrl', 'K']; rendered with a visible separator. */
  keys: string[];
}

export function Kbd({ keys }: KbdProps) {
  return (
    <span className="nv-kbds" aria-label={keys.join(' plus ')}>
      {keys.map((k, i) => (
        <span key={`${k}-${i}`}>
          {i > 0 ? <span aria-hidden="true">+</span> : null}
          <kbd className="nv-kbd" aria-hidden="true">
            {k}
          </kbd>
        </span>
      ))}
    </span>
  );
}

export interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  id?: string;
}

export function Switch({ checked, onChange, label, disabled, id }: SwitchProps) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className="nv-switch"
      onClick={() => onChange(!checked)}
    />
  );
}
