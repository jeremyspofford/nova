// Closing an overlay from its backdrop (docs/04 §4.4, WCAG 2.5.2 pointer cancellation): only a
// press that starts and is released on the backdrop closes it. A press that slips off a field and
// is released outside, or that starts on the backdrop and moves away before release, does nothing,
// so it never discards what was typed.
import { useRef, type MouseEvent } from 'react';

export interface BackdropProps {
  onMouseDown: (e: MouseEvent<HTMLElement>) => void;
  onMouseUp: (e: MouseEvent<HTMLElement>) => void;
  onClick: (e: MouseEvent<HTMLElement>) => void;
}

export function useBackdropDismiss(onClose: () => void, enabled = true): BackdropProps {
  const press = useRef({ down: false, up: false });
  return {
    onMouseDown: (e) => {
      press.current = { down: e.target === e.currentTarget, up: false };
    },
    onMouseUp: (e) => {
      press.current.up = e.target === e.currentTarget;
    },
    onClick: (e) => {
      const { down, up } = press.current;
      press.current = { down: false, up: false };
      if (enabled && down && up && e.target === e.currentTarget) onClose();
    },
  };
}
