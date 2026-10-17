// Modal dialog (docs/04 §4.2, §4.4): aria-modal, labelled by its title, traps Tab, closes on Esc
// and backdrop click, and returns focus to the element that opened it.
import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { focusableWithin, trapTab } from '../focus.ts';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Shown under the title and linked as the accessible description. */
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** Focused when the dialog opens; defaults to the first focusable element. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Where focus goes on close when the opener no longer exists. */
  fallbackFocus?: () => HTMLElement | null;
  closeOnBackdrop?: boolean;
  className?: string;
}

export function Dialog(props: DialogProps) {
  // Mounting only while open gives each opening a fresh focus capture.
  if (!props.open) return null;
  return createPortal(<DialogPanel {...props} />, document.body);
}

function DialogPanel({
  onClose,
  title,
  description,
  children,
  footer,
  initialFocusRef,
  fallbackFocus,
  closeOnBackdrop = true,
  className,
}: DialogProps) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const onCloseRef = useRef(onClose);
  const fallbackRef = useRef(fallbackFocus);
  useEffect(() => {
    onCloseRef.current = onClose;
    fallbackRef.current = fallbackFocus;
  });

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const target =
      initialFocusRef?.current ?? focusableWithin(panel.current)[0] ?? panel.current ?? null;
    target?.focus();
    return () => {
      // Return focus after React finishes removing the dialog.
      queueMicrotask(() => {
        if (opener && opener.isConnected) opener.focus();
        else fallbackRef.current?.()?.focus();
      });
    };
  }, [initialFocusRef]);

  return (
    <div
      className="nv-dialog-backdrop"
      onMouseDown={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget) onCloseRef.current();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={className ? `nv-dialog ${className}` : 'nv-dialog'}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onCloseRef.current();
            return;
          }
          trapTab(e, panel.current);
        }}
      >
        <h2 id={titleId} className="nv-dialog-title">
          {title}
        </h2>
        {description ? (
          <div id={descId} className="nv-dialog-description">
            {description}
          </div>
        ) : null}
        {children ? <div className="nv-dialog-body">{children}</div> : null}
        {footer ? <div className="nv-dialog-footer">{footer}</div> : null}
      </div>
    </div>
  );
}
