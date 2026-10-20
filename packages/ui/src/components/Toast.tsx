// Toasts (docs/04 §4.2, §6): brief, non-blocking notices in a polite live region; errors use an
// assertive one. Each toast can carry one action and is dismissable; it never holds the only
// copy of information the user needs.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { UI_TEXT } from '../strings.ts';

export type ToastTone = 'info' | 'success' | 'error';

export interface ToastOptions {
  tone?: ToastTone;
  /** Milliseconds before it hides; 0 keeps it until dismissed. */
  duration?: number;
  action?: { label: string; onClick: () => void };
}

interface ToastEntry extends Required<Omit<ToastOptions, 'action'>> {
  id: number;
  message: string;
  action?: ToastOptions['action'];
}

export interface ToastApi {
  show: (message: string, options?: ToastOptions) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast must be used inside <ToastProvider>');
  return api;
}

export function ToastProvider({
  children,
  defaultDuration = 5000,
}: {
  children: ReactNode;
  defaultDuration?: number;
}) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const next = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (message: string, options: ToastOptions = {}) => {
      const id = next.current++;
      const entry: ToastEntry = {
        id,
        message,
        tone: options.tone ?? 'info',
        // A toast with an action waits for the user: an action never times out (WCAG 2.2.1).
        duration: options.duration ?? (options.action ? 0 : defaultDuration),
        action: options.action,
      };
      setToasts((list) => [...list.slice(-3), entry]);
      return id;
    },
    [defaultDuration],
  );

  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);
  const polite = toasts.filter((t) => t.tone !== 'error');
  const urgent = toasts.filter((t) => t.tone === 'error');

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="nv-toasts" role="region" aria-label={UI_TEXT.notifications}>
        <div aria-live="polite" aria-relevant="additions text">
          {polite.map((t) => (
            <ToastView key={t.id} toast={t} onDismiss={dismiss} />
          ))}
        </div>
        <div aria-live="assertive" aria-relevant="additions text">
          {urgent.map((t) => (
            <ToastView key={t.id} toast={t} onDismiss={dismiss} />
          ))}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

function ToastView({ toast, onDismiss }: { toast: ToastEntry; onDismiss: (id: number) => void }) {
  // Pointer or focus on the toast holds it; it counts down again from the start when they leave
  // (WCAG 2.2.1).
  const [held, setHeld] = useState({ pointer: false, focus: false });
  const paused = held.pointer || held.focus;
  useEffect(() => {
    if (toast.duration <= 0 || paused) return;
    const t = setTimeout(() => onDismiss(toast.id), toast.duration);
    return () => clearTimeout(t);
  }, [toast.id, toast.duration, onDismiss, paused]);
  return (
    <div
      className="nv-toast"
      data-tone={toast.tone}
      onMouseEnter={() => setHeld((h) => ({ ...h, pointer: true }))}
      onMouseLeave={() => setHeld((h) => ({ ...h, pointer: false }))}
      onFocus={() => setHeld((h) => ({ ...h, focus: true }))}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setHeld((h) => ({ ...h, focus: false }));
      }}
    >
      <span className="nv-toast-message">{toast.message}</span>
      {toast.action ? (
        <button
          type="button"
          className="nv-btn"
          data-variant="ghost"
          onClick={() => {
            toast.action?.onClick();
            onDismiss(toast.id);
          }}
        >
          {toast.action.label}
        </button>
      ) : null}
      <button
        type="button"
        className="nv-btn"
        data-variant="ghost"
        data-size="icon"
        aria-label={UI_TEXT.dismissNotification}
        onClick={() => onDismiss(toast.id)}
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  );
}
