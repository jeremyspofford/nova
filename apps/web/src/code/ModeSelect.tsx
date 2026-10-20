// The permission mode selector (FR-063, docs/04 §3): a labelled select whose unavailable modes
// stay listed, disabled, with the reason in their own text. Used in the session composer and in
// the New session dialog.
import { useId } from 'react';
import type { EnvironmentView, PermissionMode } from '@nova/shared';
import { defineMessages } from '@nova/i18n';
import { SelectField, VisuallyHidden } from '@nova/ui';
import { useSettings } from '../settings.tsx';
import { MODE_DESCRIPTION, modeOptions, type ModeContext } from './modes.ts';

export const MODE_SELECT_TEXT = defineMessages('code.modeSelect', {
  label: 'Permission mode',
});

/** What decides which modes are available, from the settings and the session's environment. */
export function useModeContext(environment: EnvironmentView | null): ModeContext {
  const settings = useSettings();
  return {
    reviewerModel: settings.get('review.model').value,
    allowBypass: settings.get('code.allowBypass').value,
    environment,
  };
}

export function ModeSelect({
  value,
  onChange,
  ctx,
  disabled,
  hideLabel,
  className,
}: {
  value: PermissionMode;
  onChange: (mode: PermissionMode) => void;
  ctx: ModeContext;
  disabled?: boolean;
  /** Keep the label for assistive tech only (in the composer bar). */
  hideLabel?: boolean;
  className?: string;
}) {
  const id = `mode${useId()}`;
  const options = modeOptions(ctx);
  return (
    <>
      <SelectField
        className={className}
        label={MODE_SELECT_TEXT.label}
        hideLabel={hideLabel}
        value={value}
        disabled={disabled}
        onChange={(v) => onChange(v as PermissionMode)}
        options={options}
        aria-describedby={`${id}-desc`}
      />
      {hideLabel ? (
        <VisuallyHidden id={`${id}-desc`}>{MODE_DESCRIPTION[value]}</VisuallyHidden>
      ) : (
        <span id={`${id}-desc`} className="nv-field-hint code-mode-hint">
          {MODE_DESCRIPTION[value]}
        </span>
      )}
    </>
  );
}
