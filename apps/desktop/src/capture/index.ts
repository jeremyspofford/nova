// Attach window (FR-214, docs/04 §3.2): capture the frontmost window as a screenshot plus its
// accessibility text, redact, and hold the result as a draft the user reviews. Nothing leaves the
// computer until the user confirms in the preview (contracts/ipc-channels.md rule 6).
// - Fail closed: a window whose app cannot be named is not captured; excluded apps (matched by
//   app name, process or bundle id, and window title) and Nova's own windows never are.
// - The screenshot is that very window: its capture source id where the platform gives one, else
//   the one source with exactly its title; anything ambiguous attaches no image.
// - Password fields are never read; text and title are redacted away from the main process.
// The platform parts are providers behind interfaces (identity.ts, atspi.ts).
import { randomUUID } from 'node:crypto';
import type { ShellCaptureDraftView } from '@nova/shared';
import { AtspiReader, type Gdbus } from './atspi.ts';
import type { FrontWindow } from './identity.ts';
import { redactJob, type RedactJob, type RedactResult } from './redact.ts';
import { CAPTURE_TEXT } from '../text.ts';

export type { FrontWindow } from './identity.ts';
export { redactText } from './redact.ts';

export type WindowTextResult =
  { text: string; complete: boolean; passwordFieldsSkipped: number } | { unavailable: string };

export interface FrontmostWindow {
  window: FrontWindow;
  readText(): Promise<WindowTextResult>;
}

/** Which window is in front and how to read its text. */
export interface WindowLocator {
  frontmost(): Promise<FrontmostWindow | null>;
}

export interface Screenshot {
  png: Buffer;
  width: number;
  height: number;
}

/** The window's pixels (Electron's desktopCapturer in the app). */
export type ScreenshotProvider = (window: FrontWindow) => Promise<Screenshot | null>;

/** Redaction of a capture's title and text (in the app: a utility process with a timeout). */
export type Redact = (job: RedactJob) => Promise<RedactResult>;

export interface CaptureDraft {
  id: string;
  appName: string;
  windowTitle: string;
  image: Screenshot | null;
  text: string | null;
  textNote: string | null;
  redactions: { rule: string; count: number }[];
  passwordFieldsSkipped: number;
  capturedAt: string;
}

export type CaptureRefusal =
  'no_window' | 'unknown_app' | 'excluded' | 'own_window' | 'nothing_to_attach';

export type CaptureResult =
  { ok: true; draft: CaptureDraft } | { ok: false; reason: CaptureRefusal; message: string };

export interface CaptureOptions {
  /** Apps never captured: case-insensitive parts of an app name, process or bundle id, or title. */
  excludedApps: readonly string[];
  /** Names and process names of this app (never captured). */
  ownNames: readonly string[];
  /** This app's processes: a window of one of them is Nova's, whatever it is called. */
  ownPids?: readonly number[];
  /** Defaults to redacting in this process (tests); the app passes its isolated redactor. */
  redact?: Redact;
  now?: () => Date;
}

/** Whether a window is excluded (FR-214): by app name, process or bundle id, or title. */
export function isExcluded(win: FrontWindow, excludedApps: readonly string[]): boolean {
  const fields = [win.appName, win.appId ?? '', win.title].map((f) => f.toLowerCase());
  return excludedApps.some((e) => {
    const needle = e.trim().toLowerCase();
    return needle !== '' && fields.some((f) => f.includes(needle));
  });
}

/**
 * The capture source of this window: the one with its id when known, else the only one with
 * exactly its title. Null when there is none or more than one: no image is better than another
 * app's window.
 */
export function pickSource<S extends { id: string; name: string }>(
  sources: readonly S[],
  win: FrontWindow,
): S | null {
  if (win.sourceId) return sources.find((s) => s.id === win.sourceId) ?? null;
  if (!win.title.trim()) return null;
  const exact = sources.filter((s) => s.name === win.title);
  return exact.length === 1 ? (exact[0] ?? null) : null;
}

/** Capture the frontmost window into a draft. */
export async function captureFrontmost(
  locator: WindowLocator,
  screenshot: ScreenshotProvider,
  opts: CaptureOptions,
): Promise<CaptureResult> {
  const front = await locator.frontmost();
  if (!front) return { ok: false, reason: 'no_window', message: CAPTURE_TEXT.noWindow };
  const win = front.window;
  if (!win.appName.trim() && !win.appId)
    return { ok: false, reason: 'unknown_app', message: CAPTURE_TEXT.unknownApp };
  const own = opts.ownNames.map((n) => n.toLowerCase());
  const ids = [win.appName, win.appId ?? '', win.title].map((f) => f.toLowerCase());
  if (
    own.some((n) => ids.includes(n)) ||
    (win.pid !== null && (opts.ownPids ?? []).includes(win.pid))
  )
    return {
      ok: false,
      reason: 'own_window',
      message: CAPTURE_TEXT.ownWindow,
    };
  if (isExcluded(win, opts.excludedApps))
    return {
      ok: false,
      reason: 'excluded',
      message:
        win.appName || win.appId
          ? CAPTURE_TEXT.excluded({ app: win.appName || win.appId || '' })
          : CAPTURE_TEXT.excludedUnknown,
    };
  const [shot, textResult] = await Promise.all([
    screenshot(win).catch(() => null),
    front.readText().catch((err: unknown): WindowTextResult => ({
      unavailable: CAPTURE_TEXT.unreadable({
        detail: err instanceof Error ? err.message : CAPTURE_TEXT.unknownError,
      }),
    })),
  ]);
  const raw = 'unavailable' in textResult ? null : textResult;
  const redact = opts.redact ?? ((job: RedactJob) => Promise.resolve(redactJob(job)));
  let red: RedactResult;
  let textNote: string | null = 'unavailable' in textResult ? textResult.unavailable : null;
  try {
    red = await redact({ title: win.title, text: raw?.text ?? null });
  } catch {
    // Unchecked text never reaches the preview: leave it (and the title) out.
    red = {
      title: win.appName || win.appId || CAPTURE_TEXT.windowFallback,
      text: null,
      redactions: [],
    };
    if (raw) textNote = CAPTURE_TEXT.notChecked;
  }
  const text = red.text !== null && red.text.length > 0 ? red.text : null;
  if (raw && red.text !== null) {
    if (!text) textNote = CAPTURE_TEXT.noText;
    else if (!raw.complete) textNote = CAPTURE_TEXT.partial;
  }
  if (!shot && !text)
    return {
      ok: false,
      reason: 'nothing_to_attach',
      message: win.appName
        ? CAPTURE_TEXT.nothingFrom({
            app: win.appName,
            why: textNote ?? CAPTURE_TEXT.noImageNoText,
          })
        : CAPTURE_TEXT.nothingFromWindow({ why: textNote ?? CAPTURE_TEXT.noImageNoText }),
    };
  return {
    ok: true,
    draft: {
      id: randomUUID().replace(/-/g, ''),
      appName: win.appName || win.appId || '',
      windowTitle: red.title,
      image: shot,
      text,
      textNote,
      redactions: red.redactions,
      passwordFieldsSkipped: raw?.passwordFieldsSkipped ?? 0,
      capturedAt: (opts.now ?? (() => new Date()))().toISOString(),
    },
  };
}

/** What the preview shows (ShellCaptureDraftView). */
export function draftView(d: CaptureDraft, currentThreadId: string | null): ShellCaptureDraftView {
  return {
    draftId: d.id,
    appName: d.appName,
    windowTitle: d.windowTitle,
    image: d.image
      ? {
          dataUrl: `data:image/png;base64,${d.image.png.toString('base64')}`,
          width: d.image.width,
          height: d.image.height,
        }
      : null,
    text: d.text,
    textNote: d.textNote,
    redactions: d.redactions,
    passwordFieldsSkipped: d.passwordFieldsSkipped,
    currentThreadId,
    capturedAt: d.capturedAt,
  };
}

function safeName(s: string): string {
  const base = s
    .replace(/[^A-Za-z0-9 _.-]+/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60);
  return base || 'window';
}

/** The message attachments the user kept: the image and the text as separate files (FR-021). */
export function draftAttachments(
  d: CaptureDraft,
  keep: { image: boolean; text: boolean },
): { name: string; mime: string; data: string }[] {
  const out: { name: string; mime: string; data: string }[] = [];
  const name = safeName(d.windowTitle || d.appName);
  if (keep.image && d.image)
    out.push({ name: `${name}.png`, mime: 'image/png', data: d.image.png.toString('base64') });
  if (keep.text && d.text) {
    // A header names where the text came from; it is data for the model, not an instruction.
    const body = `Window: ${d.windowTitle}\nApp: ${d.appName}\nCaptured: ${d.capturedAt}\n\n${d.text}\n`;
    out.push({
      name: `${name}.txt`,
      mime: 'text/plain',
      data: Buffer.from(body, 'utf8').toString('base64'),
    });
  }
  return out;
}

/** Text providers for systems the shell cannot read yet: says so in the attachment. */
export function noTextReason(platform: string): string {
  if (platform === 'darwin') return CAPTURE_TEXT.noTextMac;
  if (platform === 'win32') return CAPTURE_TEXT.noTextWindows;
  return CAPTURE_TEXT.noTextLinux;
}

/**
 * Linux: AT-SPI names the active window, its app and its process (from the bus, not the app) and
 * reads its text; X11 gives the same window's capture id when its process matches. Without
 * AT-SPI, the X11 window alone (no text).
 */
export function linuxLocator(opts: {
  gdbus: Gdbus | null;
  x11: () => Promise<FrontWindow | null>;
  procName: (pid: number) => string | null;
}): WindowLocator {
  const reader = opts.gdbus ? new AtspiReader(opts.gdbus) : null;
  return {
    async frontmost() {
      const [a, x] = await Promise.all([
        reader ? reader.activeWindow().catch(() => null) : Promise.resolve(null),
        opts.x11().catch(() => null),
      ]);
      if (a && reader) {
        const sameWindow = x !== null && a.pid !== null && x.pid === a.pid;
        return {
          window: {
            appName: a.app,
            appId: a.pid !== null ? opts.procName(a.pid) : null,
            title: a.title,
            sourceId: sameWindow ? x.sourceId : null,
            pid: a.pid,
          },
          readText: () => reader.windowText(a),
        };
      }
      if (!x) return null;
      return { window: x, readText: () => Promise.resolve({ unavailable: noTextReason('linux') }) };
    },
  };
}

/** macOS and Windows: the platform names the window in front; its text is not read yet. */
export function platformLocator(
  front: () => Promise<FrontWindow | null>,
  platform: string,
): WindowLocator {
  return {
    async frontmost() {
      const win = await front().catch(() => null);
      if (!win) return null;
      return {
        window: win,
        readText: () => Promise.resolve({ unavailable: noTextReason(platform) }),
      };
    },
  };
}
