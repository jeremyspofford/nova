// Tooltip (docs/04 §4.2): shown on hover and keyboard focus, dismissed with Esc (WCAG 1.4.13),
// and linked to its target with aria-describedby. Tooltips only repeat information; never put
// the only label for a control here.
import { cloneElement, useId, useState, type ReactElement } from 'react';

export interface TooltipProps {
  content: string;
  children: ReactElement<{ 'aria-describedby'?: string }>;
}

export function Tooltip({ content, children }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span
      className="nv-tooltip-anchor"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      {cloneElement(children, { 'aria-describedby': id })}
      <span role="tooltip" id={id} className="nv-tooltip" hidden={!open}>
        {content}
      </span>
    </span>
  );
}
