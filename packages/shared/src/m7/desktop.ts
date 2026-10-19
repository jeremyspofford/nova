// M7 desktop shell (FR-008, FR-009, FR-214, ADR-001, ADR-031): the bridge the shell gives the
// Hub's web UI (`window.novaShell`), the views of the shell's own pages, and the payloads of its
// IPC channels (contracts/ipc-channels.md), which the shell's main process validates.
import { z } from 'zod';
import type { DerivedStatus } from '../api.ts';

/** Ids the shell accepts in paths and payloads: the Hub's UUIDv7 and the URL-safe test ids. */
export const SHELL_ID = /^[A-Za-z0-9_-]{1,100}$/;
const shellId = z.string().regex(SHELL_ID);

// ---- the bridge for the Hub's web UI -------------------------------------------------------------

export const SHELL_SHORTCUT_ACTIONS = ['quickChat', 'attachWindow'] as const;
export type ShellShortcutAction = (typeof SHELL_SHORTCUT_ACTIONS)[number];

/** One global shortcut and whether the OS let the shell have it (docs/04 §5). */
export interface ShellShortcutView {
  action: ShellShortcutAction;
  /** Electron accelerator syntax (`Control+Alt+N`), or null when unbound. */
  accelerator: string | null;
  /** How the key reads on this platform (`Ctrl+Alt+N`, `⌃⌥N`). */
  label: string | null;
  registered: boolean;
  /** `conflict`: another app holds the key; `duplicate`: both actions use it; `invalid`. */
  problem: 'conflict' | 'duplicate' | 'invalid' | null;
}

/**
 * What the desktop shell offers the Hub's web UI as `window.novaShell` (absent in a browser). The
 * web UI may use it to offer "Open in new window" and to show shortcut conflicts in
 * Settings → Keyboard.
 */
export interface NovaShellBridge {
  readonly version: 1;
  readonly platform: string;
  /** Open an app route in a window of its own (FR-009). False when the path is not an app route. */
  openWindow(path: string): Promise<boolean>;
  shortcuts(): Promise<ShellShortcutView[]>;
  /** Remap (or, with null, unbind) a global shortcut; rejects with the reason when invalid. */
  setShortcut(
    action: ShellShortcutAction,
    accelerator: string | null,
  ): Promise<ShellShortcutView[]>;
  /** Local models through this computer's `novad` while the Hub is away (FR-128). */
  readonly localRuntime: NovaShellLocalRuntime;
}

// ---- local models while the Hub is away (FR-128, docs/21 §9) ----------------------------------------

/**
 * Why the local runtime cannot be used:
 * - `no_novad`: no Nova device agent runs on this computer (or it has no local runtime);
 * - `no_access`: it runs as another user, so this app may not reach its socket or token;
 * - `scope_missing`: the Hub has not granted this device `local-runtime` (Local models);
 * - `no_model_server`: no local model server answers behind it;
 * - `failed`: anything else (an unexpected answer, a request the server refused).
 */
export const SHELL_LOCAL_RUNTIME_REASONS = [
  'no_novad',
  'no_access',
  'scope_missing',
  'no_model_server',
  'failed',
] as const;
export type ShellLocalRuntimeReason = (typeof SHELL_LOCAL_RUNTIME_REASONS)[number];

/** `localRuntime.models()`: the local model ids, or why there are none. */
export interface ShellLocalRuntimeModelsView {
  ok: boolean;
  /** Set when `ok` is false. */
  reason?: ShellLocalRuntimeReason;
  /** A sentence for the user when `ok` is false, saying what to do. */
  message?: string;
  /** Sorted model ids; empty when `ok` is false. */
  models: string[];
}

export interface ShellLocalChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ShellLocalChatRequest {
  model: string;
  messages: ShellLocalChatMessage[];
}

/**
 * The local runtime as the web UI sees it. The shell's main process does the talking: the page
 * never sees the socket, the token or the address. `chat` streams the answer's text through
 * `onDelta` (reasoning is left out) and resolves with the whole text; it rejects with an Error
 * whose message is the same sentence `models()` gives for the reason.
 */
export interface NovaShellLocalRuntime {
  models(): Promise<ShellLocalRuntimeModelsView>;
  chat(req: ShellLocalChatRequest, onDelta: (text: string) => void): Promise<{ text: string }>;
}

/** The IPC payload of `localRuntime.chat`; `id` names the stream its deltas belong to. */
export const shellLocalChatSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    model: z.string().trim().min(1).max(200),
    messages: z
      .array(
        z
          .object({
            role: z.enum(['system', 'user', 'assistant']),
            content: z.string().max(200_000),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();
export type ShellLocalChatPayload = z.infer<typeof shellLocalChatSchema>;

// ---- the shell's own pages ------------------------------------------------------------------------

/** One row of the tray and quick overlay status list (FR-215: Needs input first). */
export interface ShellStatusItemView {
  kind: 'thread' | 'run' | 'session' | 'agent';
  id: string;
  title: string;
  status: DerivedStatus;
  reason: string | null;
  /** The web UI path that opens it. */
  path: string;
  updatedAt: string;
}

/** What the shell knows about its Hub, for its own pages. */
export interface ShellHubStateView {
  hubUrl: string | null;
  connected: boolean;
  /** Why the last check failed, in a sentence; null when it passed or none ran. */
  problem: string | null;
}

/** A window capture waiting for the user's decision (FR-214); nothing has left the computer yet. */
export interface ShellCaptureDraftView {
  draftId: string;
  appName: string;
  windowTitle: string;
  /** A PNG screenshot of the window as a data URL, or null when the OS gave none. */
  image: { dataUrl: string; width: number; height: number } | null;
  /** The window's accessibility text after redaction, or null when the OS offers none. */
  text: string | null;
  /** Why there is no text, or that some was left out; null when the text is complete. */
  textNote: string | null;
  /** How many matches each redaction rule masked. */
  redactions: { rule: string; count: number }[];
  /** Password fields are never read; how many were skipped. */
  passwordFieldsSkipped: number;
  /** Where Send goes: the chat open in the last used window, or a new chat. */
  currentThreadId: string | null;
  capturedAt: string;
}

// ---- IPC payloads (validated in main, never in the renderer) ---------------------------------------

export const shellOpenWindowSchema = z.object({ path: z.string().min(1).max(2000) }).strict();

/** First run: an Add Device link, or the Hub address and its fingerprint (docs/22 §5). */
export const shellConnectSchema = z
  .object({
    link: z.string().trim().max(4000).optional(),
    url: z.string().trim().max(2000).optional(),
    pin: z.string().trim().max(200).optional(),
    /** The user confirmed replacing the Hub this shell uses with another one. */
    replace: z.boolean().optional(),
  })
  .strict();
export type ShellConnectRequest = z.infer<typeof shellConnectSchema>;

export const shellTargetSchema = z.enum(['current', 'new']);

export const shellQuickSendSchema = z
  .object({ text: z.string().trim().min(1).max(200_000), target: shellTargetSchema })
  .strict();
export type ShellQuickSendRequest = z.infer<typeof shellQuickSendSchema>;

export const shellCaptureAttachSchema = z
  .object({
    draftId: shellId,
    includeImage: z.boolean(),
    includeText: z.boolean(),
    note: z.string().max(20_000).default(''),
    target: shellTargetSchema,
  })
  .strict()
  .refine((v) => v.includeImage || v.includeText, 'keep the image, the text or both');
export type ShellCaptureAttachRequest = z.infer<typeof shellCaptureAttachSchema>;

export const shellDraftRefSchema = z.object({ draftId: shellId }).strict();

export const shellShortcutSetSchema = z
  .object({
    action: z.enum(SHELL_SHORTCUT_ACTIONS),
    accelerator: z.string().trim().min(1).max(100).nullable(),
  })
  .strict();

// ---- the shell's own settings file (`shell.json` in its data folder) -------------------------------

const pinSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const shellConfigSchema = z.object({
  v: z.literal(1),
  /** The Hub this shell uses and the fingerprint pinned at Add Device (FR-134). */
  hub: z
    .object({
      url: z.string().url().max(2000),
      pin: pinSchema,
      /** The CA a verified statement vouched for (docs/22 §5 step 7); public material only. */
      caSha256: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .nullable()
        .default(null),
    })
    .nullable()
    .default(null),
  shortcuts: z
    .object({
      quickChat: z.string().max(100).nullable().optional(),
      attachWindow: z.string().max(100).nullable().optional(),
    })
    .default({}),
  attach: z
    .object({
      /** Apps whose windows are never captured, by name (case-insensitive substring). */
      excludedApps: z.array(z.string().trim().min(1).max(200)).max(200).default([]),
    })
    .default({ excludedApps: [] }),
  /**
   * Where this computer's `novad` offers the local runtime (FR-128), when not in a default place:
   * its Unix socket, or its loopback address (`http://127.0.0.1:PORT`) with the token file.
   */
  localRuntime: z
    .object({
      socket: z.string().min(1).max(1000).nullable().optional(),
      url: z.string().url().max(200).nullable().optional(),
      tokenFile: z.string().min(1).max(1000).nullable().optional(),
    })
    .default({}),
});
export type ShellConfig = z.infer<typeof shellConfigSchema>;

/** The Hub's identity statement as it arrives on the wire (docs/22 §5); checked before trusting. */
export const shellIdentityStatementSchema = z.object({
  v: z.literal(1),
  nonce: z.string().max(200),
  hubFingerprint: z.string().max(200),
  hubPublicKey: z.string().max(200),
  pinning: z.enum(['required', 'off']),
  certificates: z
    .array(
      z.object({
        kind: z.enum(['ca', 'leaf', 'mesh']),
        sha256: z.string().max(128),
        notAfter: z.string().max(64),
      }),
    )
    .max(50),
  issuedAt: z.string().max(64),
  signature: z.string().max(200),
});
