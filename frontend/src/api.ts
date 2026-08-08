/** API client for the Nova backend.
 *
 * URLs are relative (same-origin) by default: the vite dev server proxies
 * /api to the backend, and the production `web` service (nginx) does the
 * same — one origin, so the PWA service worker and auth behave.
 */

const API_URL = import.meta.env.VITE_API_URL || '';

// ── auth: single admin token (NOVA_AUTH_TOKEN backend-side) ───────────────

export function getAuthToken(): string | null {
  return localStorage.getItem('nova.token');
}

export function setAuthToken(token: string | null) {
  if (token) localStorage.setItem('nova.token', token);
  else localStorage.removeItem('nova.token');
}

async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const token = getAuthToken();
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string> ?? {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const r = await fetch(input, { ...init, headers });
  if (r.status === 401) window.dispatchEvent(new Event('nova:unauthorized'));
  return r;
}

/** FastAPI's `detail` off a failed response, or null if there isn't one.
 *
 *  Never throws and never rejects: this runs on the error path, and an
 *  error handler that fails replaces a useful message with a confusing one.
 *  A 413 from nginx is HTML, not JSON, so the parse failure is expected
 *  rather than exceptional — that case gets its own sentence, because
 *  "Unprocessable Entity" tells the operator nothing about a size limit. */
async function errorDetail(r: Response): Promise<string | null> {
  if (r.status === 413) {
    return 'That file is too large for the server to accept (the limit is 32 MB per message).';
  }
  try {
    const body = await r.json();
    const d = body?.detail;
    if (typeof d === 'string' && d.trim()) return d;
    if (Array.isArray(d) && d.length) return d.map((e: { msg?: string }) => e.msg ?? String(e)).join('; ');
  } catch { /* not JSON — fall through to the caller's status-line default */ }
  return null;
}

/** Synthesize one sentence of speech; resolves to WAV bytes.
 *  `voice` overrides the saved setting (used to preview a candidate). */
export async function synthesizeSpeech(text: string, voice?: string): Promise<ArrayBuffer> {
  const r = await apiFetch(`${API_URL}/api/v1/voice/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(voice ? { text, voice } : { text }),
  });
  if (!r.ok) {
    const detail = await r.json().then(j => j.detail).catch(() => r.statusText);
    throw new Error(`TTS failed: ${detail}`);
  }
  return r.arrayBuffer();
}

// ── wake-word learning (phase 5a): labelled clips from ordinary use ────────

export interface WakeClip {
  id: string;
  label: 'positive' | 'false_fire' | 'near_miss';
  at: number;              // epoch seconds
  bytes: number;
  score?: number;
  threshold?: number;
  phrase?: string;
  speaker?: string;
  mic?: string;
  secs?: number;
}

export interface WakeClipListing {
  enabled: boolean;
  counts: Record<string, number>;
  bytes: number;
  total: number;
  clips: WakeClip[];
}

export async function uploadWakeClip(label: string, wav: Blob,
                                     meta: Record<string, string | number>): Promise<void> {
  const q = new URLSearchParams({ label, ...Object.fromEntries(
    Object.entries(meta).map(([k, v]) => [k, String(v)])) });
  const r = await apiFetch(`${API_URL}/api/v1/voice/wake-clip?${q}`, {
    method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav,
  });
  if (!r.ok) throw new Error(`wake clip rejected: ${r.status}`);
}

export async function listWakeClips(): Promise<WakeClipListing> {
  const r = await apiFetch(`${API_URL}/api/v1/voice/wake-clips`);
  if (!r.ok) throw new Error('could not load wake clips');
  return r.json();
}

/** Fetched as a blob, not linked: the audio route needs the auth header, so
 *  an <audio src> pointing at it would 401. */
export async function wakeClipAudio(id: string): Promise<string> {
  const r = await apiFetch(`${API_URL}/api/v1/voice/wake-clips/${id}/audio`);
  if (!r.ok) throw new Error('clip not found');
  return URL.createObjectURL(await r.blob());
}

export async function deleteWakeClip(id: string): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/voice/wake-clips/${id}`, { method: 'DELETE' });
  if (!r.ok) throw new Error('delete failed');
}

export async function deleteAllWakeClips(): Promise<number> {
  const r = await apiFetch(`${API_URL}/api/v1/voice/wake-clips`, { method: 'DELETE' });
  if (!r.ok) throw new Error('delete failed');
  return (await r.json()).deleted as number;
}

// ── slash commands: operator verbs that never reach a model ───────────────

export interface SlashCommand { name: string; summary: string; detail: string }

export async function listCommands(): Promise<SlashCommand[]> {
  const r = await apiFetch(`${API_URL}/api/v1/commands`);
  if (!r.ok) return [];
  return (await r.json()).commands as SlashCommand[];
}

export async function runCommand(name: string, arg = ''): Promise<string> {
  const r = await apiFetch(`${API_URL}/api/v1/commands/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ arg }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.detail || `/${name} failed`);
  return (body.message as string) || 'Done.';
}

/** Who transcribe recognized on a voice turn (docs/plans/speaker-id.md). */
export interface SpeakerMatch {
  profile_id: string;
  name: string;
  role: 'operator' | 'kid' | 'guest';
  confidence: number;
}

export interface TranscribeResult {
  text: string;
  /** the matched household member, or null (unknown / recognition off) */
  speaker: SpeakerMatch | null;
  /** true when recognition actually ran (enabled + someone enrolled) —
   *  distinguishes "unknown voice" from "not checking" */
  speaker_active: boolean;
}

/** Transcribe a recorded utterance; resolves to text + who was speaking. */
/** Tell the STT engine a clip is coming. Fire-and-forget by design: it exists
 *  only to move a model load OFF the path where the microphone is closed, so
 *  its own failure must cost nothing. Called when the wake word fires. */
export async function warmSpeech(): Promise<void> {
  try {
    await apiFetch(`${API_URL}/api/v1/voice/warm`, { method: 'POST' });
  } catch { /* the transcribe call will load it the slow way */ }
}

export async function transcribeSpeech(blob: Blob): Promise<TranscribeResult> {
  const r = await apiFetch(`${API_URL}/api/v1/voice/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'application/octet-stream' },
    body: blob,
    // A hard deadline, because the caller closes the microphone for the whole
    // round trip: an unbounded request turns a slow transcription into a
    // permanently deaf app that only a page reload recovers. 30 s is well past
    // a cold large-v3 load (~14 s measured) and well short of "gave up on it".
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) {
    const detail = await r.json().then(j => j.detail).catch(() => r.statusText);
    throw new Error(`Transcription failed: ${detail}`);
  }
  const j = await r.json();
  return { text: j.text ?? '', speaker: j.speaker ?? null,
           speaker_active: j.speaker_active ?? false };
}

// ── household voice profiles ───────────────────────────────────────────────

export interface UserProfile {
  id: string;
  name: string;
  role: 'operator' | 'kid' | 'guest';
  /** what they want to be called, and how to refer to them. Nullable on
   *  purpose — null is what makes Nova say she doesn't know rather than
   *  invent a reason for not knowing. */
  preferred_name: string | null;
  pronouns: string | null;
  persona_notes: string | null;
  enrolled: boolean;
  enrolled_clips: number;
  created_at: string | null;
  updated_at: string | null;
}

export async function listProfiles(): Promise<UserProfile[]> {
  const r = await apiFetch(`${API_URL}/api/v1/profiles`);
  if (!r.ok) throw new Error('Failed to load profiles');
  return (await r.json()).profiles;
}

export async function createProfile(
  name: string, role: string, personaNotes?: string,
): Promise<UserProfile> {
  const r = await apiFetch(`${API_URL}/api/v1/profiles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, role, persona_notes: personaNotes ?? null }),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'create failed');
  return r.json();
}

/** Edit a profile. This is the ONLY way to change a fact Nova already holds:
 *  remember_about_me fills blanks and refuses to overwrite, so correcting
 *  something is deliberately the operator's move, where the old value is
 *  visible next to the new one. */
export async function updateProfile(
  id: string, patch: Partial<Pick<UserProfile, 'name' | 'preferred_name' | 'pronouns' | 'persona_notes'>>,
): Promise<UserProfile> {
  const r = await apiFetch(`${API_URL}/api/v1/profiles/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'update failed');
  return r.json();
}

export async function deleteProfile(id: string): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/profiles/${id}`, { method: 'DELETE' });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'delete failed');
}

/** One enrollment clip: the audio is embedded server-side and DISCARDED. */
export async function enrollVoiceClip(profileId: string, blob: Blob): Promise<UserProfile> {
  const r = await apiFetch(
    `${API_URL}/api/v1/voice/enroll?profile_id=${encodeURIComponent(profileId)}`, {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'application/octet-stream' },
      body: blob,
    });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'enrollment failed');
  return (await r.json()).profile;
}

export interface VoiceHealth { status: string; detail?: string | null; voices: string[] }

/** Kokoro status + available voice ids (for the Settings voice picker). */
export async function getVoiceHealth(): Promise<VoiceHealth> {
  const r = await apiFetch(`${API_URL}/api/v1/voice/health`);
  if (!r.ok) throw new Error(`voice health failed: ${r.status}`);
  return r.json();
}

export type AuthState = 'ok' | 'locked' | 'offline';

/** 'ok' = authorized (or auth disabled), 'locked' = the token gate is up,
 *  'offline' = the backend did not answer at all.
 *
 *  The third case used to collapse into the first: App caught the network
 *  error and unlocked, so a backend that was simply DOWN rendered the whole
 *  app against a dead API — every surface then failing into its own silent
 *  `.catch(() => {})` and showing empty state. "Nova has nothing to say" and
 *  "Nova is not running" looked identical. */
export async function checkAuth(): Promise<AuthState> {
  try {
    const r = await apiFetch(`${API_URL}/api/v1/settings`);
    if (r.status === 401) return 'locked';
    // Not just a thrown fetch: when the backend is down, the thing in front
    // of it answers instead — vite's dev proxy and nginx both return 502
    // rather than refusing the connection, so `fetch` resolves happily and
    // only the STATUS says anything is wrong. Checked live: a dead upstream
    // rendered the whole app as if authorized until this line existed.
    return r.ok ? 'ok' : 'offline';
  } catch {
    return 'offline';
  }
}

/** The admin token from the server — only answers for already-trusted
 *  callers (this machine, or a device holding the token). Feeds the QR. */
export async function getServerToken(): Promise<string> {
  const r = await apiFetch(`${API_URL}/api/v1/auth/token`);
  if (!r.ok) return '';
  return (await r.json()).token ?? '';
}

export interface Activity {
  /** `degraded` = the turn ran, but something it needed was missing (memory
   *  unreadable, the reply not persisted). Pairs with the backend's
   *  honest-receipts change; harmless if that half is not deployed.
   *
   *  This union is documentation, not a gate: streamChat casts the SSE
   *  payload straight to this type, so a kind the backend adds tomorrow
   *  reaches the renderer with no build error. What keeps the UI honest about
   *  an unknown kind is activityLabel's default branch printing `detail`. */
  kind: 'tool_start' | 'tool_result' | 'dispatch' | 'narration' | 'capability' | 'agent_reply'
      | 'degraded' | 'narration_retry' | 'deferral_retry' | 'service_claim';
  name: string;
  agent?: string;
  detail?: string;
  /** Characters of already-streamed reply to unwind. A narration retry
   *  throws its draft away and rewrites the whole answer, so without this
   *  the client keeps text the server will never store — the reply renders
   *  twice, spliced mid-sentence. */
  retract?: number;
}

export type ChatEvent =
  /** Sent twice on a turn that reroutes: the opening frame carries all three
   *  fields, and a mid-turn model fallback sends a second one carrying ONLY
   *  the model it moved to. Every field is optional because that second frame
   *  really does omit two of them — typing them as present is what made a
   *  consumer overwrite the live trace id with undefined. */
  | { type: 'meta'; conversationId?: string; model?: string; traceId?: string }
  | { type: 'text'; text: string }
  /** A dispatched specialist thinking out loud. Separate from 'text' on
   *  purpose: this is never spoken and never persisted — it exists so a
   *  multi-minute dispatch stops looking frozen. */
  | { type: 'subText'; text: string; agent?: string }
  | { type: 'activity'; activity: Activity }
  | { type: 'error'; error: string }
  | { type: 'done' };

export async function* streamChat(message: string, conversationId?: string,
                                  source?: string, signal?: AbortSignal,
                                  attachments?: { kind: string; name: string; mime: string; data: string }[],
                                  speakerId?: string,
                                  /** ids of documents already kept by POST /attachments — records
                                   *  which turn carried them, so a stored document can be traced
                                   *  back to its conversation */
                                  attachmentIds?: string[],
                                  ): AsyncGenerator<ChatEvent> {
  const response = await apiFetch(`${API_URL}/api/v1/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, conversation_id: conversationId, source,
                           ...(speakerId ? { speaker: speakerId } : {}),
                           ...(attachments?.length ? { attachments } : {}),
                           ...(attachmentIds?.length ? { attachment_ids: attachmentIds } : {}) }),
    signal,
  });

  if (!response.ok || !response.body) {
    // The BODY is where the reason lives. This used to throw on the status
    // line alone, so every carefully-worded server refusal — "the PDF has 3
    // page(s) but no extractable text, it is most likely a scan" — reached
    // the operator as "422 Unprocessable Entity" and they had no way to
    // learn what to do differently.
    throw new Error(await errorDetail(response) ??
      `Chat request failed: ${response.status} ${response.statusText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const frames = buffer.split('\n\n');
      buffer = frames.pop() || '';

      for (const frame of frames) {
        const line = frame.trim();
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);

        if (data === '[DONE]') {
          yield { type: 'done' };
          return;
        }
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        if (parsed.meta) {
          const meta = parsed.meta as
            { conversation_id?: string; model?: string; trace_id?: string };
          yield { type: 'meta', conversationId: meta.conversation_id, model: meta.model,
                  traceId: meta.trace_id };
        } else if (typeof parsed.t === 'string') {
          yield { type: 'text', text: parsed.t };
        } else if (typeof parsed.sub === 'string') {
          yield { type: 'subText', text: parsed.sub, agent: parsed.agent as string | undefined };
        } else if (parsed.activity) {
          // shape-check before it reaches renderItem. This is the one frame
          // whose contents get destructured during render, so a malformed
          // one used to throw mid-render — and with no error boundary in the
          // tree that white-screened the entire app.
          const a = parsed.activity as Partial<Activity> | null;
          if (a && typeof a === 'object' && typeof a.kind === 'string') {
            yield { type: 'activity', activity: a as Activity };
          }
        } else if (typeof parsed.error === 'string') {
          yield { type: 'error', error: parsed.error };
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function getActiveConversation(): Promise<{ id: string; title: string | null }> {
  const r = await apiFetch(`${API_URL}/api/v1/conversations/active`);
  if (!r.ok) throw new Error('Failed to load conversation');
  return r.json();
}

/** One turn's ledger summary — feeds the duration chip on assistant messages. */
export interface TraceSummary {
  id: string;
  status: string;
  secs: number | null;
  tools: number;
  dispatches: number;
}

// ── attachments: documents that outlive the turn (roadmap #22b) ──────────

/** A document the operator handed over, kept. `display_name` is a LABEL —
 *  nothing resolves by it, because two documents routinely share a name.
 *  `text_source` says HOW the text was read and they are not equivalent:
 *  'mechanical' is the document's own text layer, 'ocr' is tesseract on
 *  pixels (wrong in specific ways), 'vision' is a model describing an image. */
export interface StoredAttachment {
  id: string;
  sha256: string;
  display_name: string;
  mime: string;
  bytes: number;
  kind: 'doc' | 'image' | 'text';
  text_source: 'mechanical' | 'ocr' | 'vision' | null;
  text_error: string | null;
  text_content?: string | null;
  has_text?: boolean;
  text_chars?: number | null;
  present?: boolean;
  message_id: string | null;
  created_at: string | null;
}

export interface AttachmentUsage {
  documents: number; bytes: number; missing: number;
  /** bytes on disk no row points at — measured by walking the store, because
   *  "no orphans" is only an invariant if something checks it */
  orphans: number; orphan_bytes: number;
  store_ok: boolean; store_error: string;
}

/** Keep the ORIGINAL bytes. Raw multipart, not base64 in the chat body:
 *  base64 inflates by 4/3 against the body limit, and more importantly this
 *  runs BEFORE the turn, so a turn that fails cannot destroy the only copy
 *  of a photographed document. */
export async function uploadAttachment(file: File, conversationId?: string):
    Promise<StoredAttachment> {
  const form = new FormData();
  form.append('file', file, file.name);
  if (conversationId) form.append('conversation_id', conversationId);
  const r = await apiFetch(`${API_URL}/api/v1/attachments`, { method: 'POST', body: form });
  if (!r.ok) throw new Error(await errorDetail(r) ?? `Upload failed: ${r.status}`);
  return r.json();
}

export async function listAttachments():
    Promise<{ attachments: StoredAttachment[]; usage: AttachmentUsage }> {
  const r = await apiFetch(`${API_URL}/api/v1/attachments`);
  if (!r.ok) throw new Error('Failed to load documents');
  return r.json();
}

export async function getAttachment(id: string): Promise<StoredAttachment> {
  const r = await apiFetch(`${API_URL}/api/v1/attachments/${id}`);
  if (!r.ok) throw new Error(await errorDetail(r) ?? 'Failed to load document');
  return r.json();
}

export async function deleteAttachment(id: string): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/attachments/${id}`, { method: 'DELETE' });
  if (!r.ok) throw new Error(await errorDetail(r) ?? 'Delete failed');
}

/** Downloading needs the auth header, so it cannot be a plain href — fetch
 *  the bytes and hand the browser a blob URL. */
export async function downloadAttachment(a: StoredAttachment): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/attachments/${a.id}/raw`);
  if (!r.ok) throw new Error(await errorDetail(r) ?? 'Download failed');
  const url = URL.createObjectURL(await r.blob());
  const el = document.createElement('a');
  el.href = url; el.download = a.display_name;
  el.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** An attachment on a chat turn. Outgoing: data = base64 for 'image' and
 *  'doc' (a PDF/.docx the SERVER extracts — the browser can't read those),
 *  or the file's text for 'text'. History rows carry only
 *  {kind, name, mime} — no binary. */
export interface ChatAttachment {
  kind: 'image' | 'text' | 'doc';
  name: string;
  mime: string;
  data?: string;
}

/** A notification as the transcript renders it (backend migration 125).
 *
 *  The chat item reads THIS, never a copy: the message row it hangs off
 *  carries no text of its own (the DB refuses one that does), so what the
 *  push was built from and what chat shows are the same record.
 *
 *  There is deliberately no `delivered` field. `state` is
 *  pending → accepted (a relay took it) → opened (a client rendered it), and
 *  `confirmed` is true for exactly one of those — acceptance by a transport
 *  is not receipt by a person. */
export interface ChatNotification {
  id: string;
  kind: string;
  title: string | null;
  body: string;
  /** Where the RAISER wanted a tap to go (an inbox, a page). The push's own
   *  link is the deep link to this notification; this is offered as a
   *  secondary link on the card. */
  click_url: string | null;
  tags: string[];
  source?: string | null;
  recommendation_id: string | null;
  state: 'pending' | 'accepted' | 'failed' | 'opened';
  confirmed: boolean;
  /** One line, rendered by the backend so the UI and the record cannot
   *  disagree about what happened to it. */
  delivery_label: string;
  provider?: string | null;
  error?: string | null;
  repeats?: number;
  created_at?: string | null;
  opened_at?: string | null;
}

export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'notification';
  content: string;
  created_at: string;
  /** Present on role='notification' rows — the hydrated record. */
  notification?: ChatNotification;
  tool_calls?: { kind: Activity['kind']; name: string; agent?: string } | null;
  trace?: TraceSummary | null;
  /** On role='tool' rows: the turn that ran it. Lets the transcript file an
   *  action under its own turn rather than under whichever message sits next
   *  to it. Null on rows written before tool rows were stamped. */
  trace_id?: string | null;
  attachments?: ChatAttachment[];
  speaker?: { id: string | null; name: string; role: string };
}

/** One page of a conversation, newest-last.
 *
 *  `hasMore` is why this is not a bare array any more: the window is finite,
 *  and a transcript that simply stops looks identical to one that started
 *  there. `oldest` is the cursor to pass back as `before` for the next page. */
export interface MessagePage {
  messages: StoredMessage[];
  has_more: boolean;
  oldest: string | null;
}

export async function getMessages(conversationId: string,
                                  before?: string | null): Promise<MessagePage> {
  const q = before ? `?before=${encodeURIComponent(before)}` : '';
  const r = await apiFetch(`${API_URL}/api/v1/conversations/${conversationId}/messages${q}`);
  if (!r.ok) throw new Error('Failed to load messages');
  return r.json();
}

/** One notification by the id a push carried. Answers even when the item is
 *  older than the transcript page in hand — which is the case the client
 *  cannot solve on its own. */
export async function getNotification(id: string): Promise<ChatNotification> {
  const r = await apiFetch(`${API_URL}/api/v1/notifications/${id}`);
  if (!r.ok) throw new Error(`Notification ${id} could not be loaded`);
  return r.json();
}

/** The most recent notifications, newest first.
 *
 *  The chat panel polls this so a notification that arrived through a channel
 *  with no client callback (ntfy, a webhook, or a push the browser never
 *  showed) still turns up in the transcript without a reload. */
export async function listNotifications(limit = 10): Promise<ChatNotification[]> {
  const r = await apiFetch(`${API_URL}/api/v1/notifications?limit=${limit}`);
  if (!r.ok) throw new Error('Failed to load notifications');
  return (await r.json()).notifications ?? [];
}

/** Tell the server this notification is ON SCREEN.
 *
 *  The only call in the app that may move a notification to `opened`, which
 *  is the only state meaning it reached a person. Everything upstream knows
 *  only that a relay accepted some bytes. */
export async function openNotification(id: string,
                                       via = 'chat'): Promise<ChatNotification> {
  const r = await apiFetch(`${API_URL}/api/v1/notifications/${id}/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ via }),
  });
  if (!r.ok) throw new Error(`Notification ${id} could not be marked open`);
  return r.json();
}

export interface TraceSpan {
  id: string;
  parent_span_id: string | null;
  seq: number;
  kind: 'stage' | 'llm_call' | 'tool' | 'dispatch';
  name: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  detail: Record<string, unknown>;
}

export interface TraceDetail {
  trace: {
    id: string;
    source: string;
    automation: string | null;
    conversation_id: string | null;
    model: string | null;
    status: string;
    error: string | null;
    started_at: string;
    finished_at: string | null;
  };
  spans: TraceSpan[];
}

/** The full turn ledger for one trace — the Turn Inspector's data source. */
export async function getTrace(id: string): Promise<TraceDetail> {
  const r = await apiFetch(`${API_URL}/api/v1/traces/${id}`);
  if (!r.ok) throw new Error('Failed to load trace');
  return r.json();
}

/** Recent turns across all sources — evals, chat, automations, compaction,
 *  heartbeat. */
export interface TraceListItem {
  id: string;
  /** Hand-maintained against the CHECK constraint in migration 050, so it is
   *  documentation and not a guarantee — a value missing from here reaches
   *  the UI as an unstyled badge. Anything keyed by it needs a fallback.
   *  `eval` is the busiest of the five by a wide margin (1625 rows against
   *  chat's 392). */
  source: 'eval' | 'chat' | 'automation' | 'compaction' | 'heartbeat';
  automation: string | null;
  model: string | null;
  status: string;
  started_at: string;
  secs: number | null;
  tools: number;
  dispatches: number;
  llm_calls: number;
  /** llm_call token sums for the whole trace. 0 with llm_calls > 0 means the
   *  spans carried no usage figures, not that the turn was free. */
  prompt_tokens: number;
  completion_tokens: number;
  tokens: number;
}

export interface TraceFilters {
  limit?: number;
  source?: string | null;
  status?: 'ok' | 'error' | 'cancelled' | null;
  window?: '1h' | '6h' | '24h' | '7d' | null;
}

export async function getTraces(filters: TraceFilters = {}): Promise<TraceListItem[]> {
  const q = new URLSearchParams();
  q.set('limit', String(filters.limit ?? 50));
  if (filters.source) q.set('source', filters.source);
  if (filters.status) q.set('status', filters.status);
  if (filters.window) q.set('window', filters.window);
  const r = await apiFetch(`${API_URL}/api/v1/traces?${q}`);
  if (!r.ok) throw new Error(await errorDetail(r) ?? 'Failed to load traces');
  return r.json();
}

// ── Action log (backend/app/activity_log.py) ──────────────────────────────
//
// "She cannot be silent on her actions." One chronological log of what she
// did and what she was refused, derived from the records the system already
// writes. The Turn Inspector answers "what happened inside THIS turn"; this
// answers "what has she been doing", which nothing did.

/** Outcomes are open on purpose. The backend derives them and can grow one
 *  (a new terminal coding state, say) without a frontend release — and the
 *  lesson from `TraceListItem.source` is that a closed union here becomes a
 *  literal "undefined" class string on the day it drifts. Anything keyed by
 *  this MUST have a fallback. */
export type ActionOutcome =
  | 'ok' | 'refused' | 'failed' | 'running' | 'stalled' | 'waiting' | 'skipped'
  | (string & {});

export interface ActionRow {
  id: string;
  /** null only on a meta row: a source the backend could not read at all. */
  at: string | null;
  kind: string;
  actor: string;
  /** plain language, derived from scopes.consequences / the tool's own description */
  title: string;
  outcome: ActionOutcome;
  /** the arguments that matter, already redacted and capped backend-side */
  detail: string;
  /** why it was refused or how it failed — short */
  reason: string | null;
  /** the same, long form, for the expanded row */
  reason_full: string | null;
  trace_id: string | null;
  graded: boolean;
  tool?: string | null;
  gate?: string | null;
  source?: string | null;
  state?: string | null;
  tainted_turn?: boolean;
}

export interface ActionLog {
  window: string;
  since: string;
  /** meta rows (a source that could not be read) come FIRST and are extra —
   *  they are not counted in `returned` and never fall off a full page. */
  rows: ActionRow[];
  /** activity rows on this page, excluding meta notices */
  returned: number;
  /** how many matched the filter in the WHOLE window — an aggregate query,
   *  not a tally of the page, so it does not move when `limit` does. */
  matched: number;
  limit: number;
  offset: number;
  /** the deepest `offset + limit` the backend will merge in order */
  max_span: number;
  /** false whenever this page is not the whole of what matched: rows past the
   *  limit, an offset past the newest, a capped source with rows newer than
   *  the cut, or a source that could not be read at all. The page SAYS so. */
  complete: boolean;
  /** sources that filled their per-source ceiling — paging/narrowing helps */
  capped_sources: string[];
  /** sources that THREW. Distinct from capped: "narrow the window" is useless
   *  advice for a source that crashed, and saying it was a lie. */
  unreadable_sources: string[];
  /** whole-window totals by outcome, from their own aggregate queries */
  counts: Record<string, number>;
  /** false when a counter could not answer — `counts` is then a floor */
  counts_complete: boolean;
  include_graded: boolean;
  problem_outcomes: string[];
}

export interface ActionFacets {
  window: string;
  windows: string[];
  agents: { name: string; count: number }[];
  kinds: string[];
  /** graded eval-replay tool calls set aside by the default filter, named
   *  rather than silently dropped */
  graded_excluded: number;
}

export async function getActionLog(params: {
  window?: string; limit?: number; offset?: number; agent?: string | null;
  outcome?: string | null; kinds?: string[] | null; graded?: boolean;
} = {}): Promise<ActionLog> {
  const q = new URLSearchParams();
  if (params.window) q.set('window', params.window);
  if (params.limit) q.set('limit', String(params.limit));
  if (params.offset) q.set('offset', String(params.offset));
  if (params.agent) q.set('agent', params.agent);
  if (params.outcome) q.set('outcome', params.outcome);
  if (params.kinds?.length) q.set('kinds', params.kinds.join(','));
  if (params.graded) q.set('graded', 'true');
  const r = await apiFetch(`${API_URL}/api/v1/activity/log?${q}`);
  if (!r.ok) throw new Error(await errorDetail(r) ?? 'Failed to load the action log');
  return r.json();
}

export async function getActionFacets(window = '24h', graded = false): Promise<ActionFacets> {
  const q = new URLSearchParams({ window });
  if (graded) q.set('graded', 'true');
  const r = await apiFetch(`${API_URL}/api/v1/activity/facets?${q}`);
  if (!r.ok) throw new Error(await errorDetail(r) ?? 'Failed to load filters');
  return r.json();
}

// ── Observability board (system monitoring + turn/cost rollups) ───────────

export interface GpuStat {
  name: string; mem_used_gb: number; mem_total_gb: number; util_pct: number; temp_c: number;
}
export interface ContainerStat {
  name: string; service: string; state: string;
  cpu_pct: number | null; mem_used_gb: number | null; mem_total_gb: number | null;
  /** docker's healthcheck verdict. null = the service declares no check,
   *  which is honestly different from passing one. */
  health?: 'healthy' | 'unhealthy' | 'starting' | null;
}
export interface SystemResources {
  instance: { id: string; label: string; leader: boolean };
  platform: string;
  cpu: { pct: number | null; cores: number | null; load1: number | null };
  mem: { used_gb: number | null; total_gb: number | null };
  gpu: { gpus: GpuStat[]; error?: string } | null;
  disk: {
    used_gb: number | null; total_gb: number | null;
    docker?: Record<string, number | null>;
    model_store?: { path: string; free_gb: number; total_gb: number };
  };
  containers: ContainerStat[];
  sampled_at: number;
}
export async function getSystemResources(): Promise<SystemResources> {
  const r = await apiFetch(`${API_URL}/api/v1/system/resources`);
  if (!r.ok) throw new Error('Failed to load system resources');
  return r.json();
}

export interface ServiceHealth {
  name: string; ok: boolean; ms?: number; optional?: boolean; detail?: string;
}
export async function getSystemHealth(): Promise<{ services: ServiceHealth[] }> {
  const r = await apiFetch(`${API_URL}/api/v1/system/health`);
  if (!r.ok) throw new Error('Failed to load system health');
  return r.json();
}

export interface ModelCost {
  model: string; turns: number; calls: number;
  prompt: number; completion: number; est_cost: number | null; priced: boolean;
}
export interface ObservabilitySummary {
  window: string; turns: number; errors: number; cancelled: number; error_rate: number;
  p50_secs: number | null; p95_secs: number | null;
  tokens: { prompt: number; completion: number; total: number };
  est_cost: number; cost_partial: boolean;
  by_model: ModelCost[];
  sources: Record<string, number>;
  /** Eval replays are excluded by default — a suite run 1944 times in 7d
   *  drowned the error rate the board exists to show (0.041 → 0.013). The
   *  count says what was set aside rather than pretending it never ran. */
  include_evals: boolean;
  eval_turns_excluded: number;
}
export async function getObservabilitySummary(
  window = '24h', includeEvals = false,
): Promise<ObservabilitySummary> {
  const q = includeEvals ? '&include_evals=true' : '';
  const r = await apiFetch(`${API_URL}/api/v1/observability/summary?window=${window}${q}`);
  if (!r.ok) throw new Error('Failed to load observability summary');
  return r.json();
}

// ── spend: the improve lane's ledger, ceilings and preflight ──────────────
//
// One card answers "why did no pass start" without reading backend logs:
// today's spend against the three ceilings, the escalating wall backoff as a
// time, and a read-only preview of the next heartbeat tick's gates.

export interface SpendCeilings {
  lane: string;
  max_passes: number;
  max_tokens: number;
  max_usd: number;
  updated_at: string | null;
  updated_by: string;
}

export interface SpendToday {
  lane: string;
  passes: number;
  attempts: number;
  entries: number;
  /** Ledger rows with no token figures. They sum as 0, so this count is the
   *  honesty flag: totals with unmetered > 0 are a floor, not a measurement. */
  unmetered: number;
  tokens_in: number;
  tokens_out: number;
  tokens: number;
  usd: number;
}

export interface SpendRefusal {
  id: string;
  run_id: string | null;
  goal_id: string | null;
  at: string;
  wall: string;
  reason: string | null;
  status: number | string | null;
  operator_note: string | null;
}

export interface SpendHold {
  held: boolean;
  wall: 'provider' | 'dirty_repo' | 'ceiling' | null;
  streak: number;
  since: string | null;
  cooldown_s: number | null;
  held_until: string | null;
  /** spend.active_wall's full sentence — the backend's words, never restated. */
  reason: string | null;
  /** Newest provider refusal ever, present even when the hold expired. */
  last_refusal: SpendRefusal | null;
}

export interface SpendCheck {
  check: 'goal' | 'busy' | 'wall' | 'ceiling' | 'host_repo';
  ok: boolean;
  note: string;
}

/** Read-only preview of the next heartbeat tick — nothing is charged. */
export interface SpendImprovePreview {
  would_start: boolean;
  reason: string;
  /** Always all five, in tick order. */
  checks: SpendCheck[];
}

export interface SpendGoal {
  id: string;
  title: string;
  status: string;
  actions_used: number;
  max_actions: number;
  activated_at: string | null;
  expires_at: string | null;
  refunds: number;
  last_refund_at: string | null;
  last_refund_reason: string | null;
}

export interface SpendEntry {
  id: string;
  day: string;
  lane: string;
  kind: 'coding_session' | 'sandbox_check' | 'review' | 'provider_refusal';
  model: string;
  tokens_in: number | null;
  tokens_out: number | null;
  usd: number | null;
  metered: boolean;
  session_id: string | null;
  run_id: string | null;
  goal_id: string | null;
  created_at: string;
  /** Only on kind=provider_refusal rows. */
  operator_note?: string | null;
  wall?: string;
  refusal_reason?: string | null;
}

export interface SpendOverview {
  lane: string;
  /** null with `ceilings_error` set when the row is unreadable — distinct
   *  from "no ceilings", which cannot happen on a migrated install. */
  ceilings: SpendCeilings | null;
  ceilings_error: string | null;
  today: SpendToday;
  hold: SpendHold;
  improve: SpendImprovePreview;
  goals: SpendGoal[];
  entries: SpendEntry[];
}

export async function getSpend(lane = 'improve', entriesLimit = 50): Promise<SpendOverview> {
  const r = await apiFetch(
    `${API_URL}/api/v1/spend?lane=${encodeURIComponent(lane)}&entries_limit=${entriesLimit}`);
  if (!r.ok) throw new Error(await errorDetail(r) ?? 'Failed to load spend');
  return r.json();
}

/** Raise or lower the lane's ceilings. Omitted keys stay unchanged; the
 *  backend refuses non-numbers, negatives and an empty patch (422). */
export async function patchSpendCeilings(patch: {
  lane?: string; max_passes?: number; max_tokens?: number; max_usd?: number;
}): Promise<SpendCeilings> {
  const r = await apiFetch(`${API_URL}/api/v1/spend/ceilings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(await errorDetail(r) ?? `Failed to set ceilings (${r.status})`);
  return r.json();
}

export interface SpendTokensRow {
  day: string;
  source: string;
  model: string;
  calls: number;
  /** Spans with NO token figures — they sum as 0, so the count is the
   *  honesty flag on this row's totals. */
  unmetered_calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  tokens: number;
}

export interface SpendTokensRollup {
  days: number;
  /** day DESC then prompt DESC; day×source×model grain over llm_call spans. */
  rows: SpendTokensRow[];
  totals: {
    calls: number; unmetered_calls: number;
    prompt_tokens: number; completion_tokens: number; tokens: number;
  };
  by_source: Record<string, { calls: number; prompt_tokens: number; completion_tokens: number }>;
}

export async function getSpendTokens(days = 7): Promise<SpendTokensRollup> {
  const r = await apiFetch(`${API_URL}/api/v1/spend/tokens?days=${days}`);
  if (!r.ok) throw new Error(await errorDetail(r) ?? 'Failed to load token rollup');
  return r.json();
}

export interface HistoryPoint {
  ts: number;
  cpu_pct: number | null; mem_used_gb: number | null; mem_total_gb: number | null;
  vram_used_gb: number | null; vram_total_gb: number | null;
  gpu_pct: number | null; gpu_temp_c: number | null;
  disk_used_gb: number | null; disk_total_gb: number | null;
}
export interface ResourceHistory {
  window: string; instance: string; bucket_secs: number; points: HistoryPoint[];
}
export async function getResourceHistory(
  window = '24h', instance?: string,
): Promise<ResourceHistory> {
  const q = instance ? `&instance=${encodeURIComponent(instance)}` : '';
  const r = await apiFetch(`${API_URL}/api/v1/system/resources/history?window=${window}${q}`);
  if (!r.ok) throw new Error('Failed to load resource history');
  return r.json();
}

export interface FleetInstance {
  id: string; label: string | null; self: boolean; leader: boolean;
  last_seen: number | null; stale: boolean;
  reaches: Record<string, { ok: boolean; ms?: number; detail?: string }>;
  cpu_pct?: number | null; mem_used_gb?: number | null; mem_total_gb?: number | null;
  vram_used_gb?: number | null; vram_total_gb?: number | null;
  disk_used_gb?: number | null; disk_total_gb?: number | null;
}
export async function getSystemFleet(): Promise<{ instances: FleetInstance[] }> {
  const r = await apiFetch(`${API_URL}/api/v1/system/fleet`);
  if (!r.ok) throw new Error('Failed to load fleet');
  return r.json();
}

export interface MonitorAlert {
  id: string; instance_id: string; label: string; kind: string;
  message: string; value: number | null; threshold: number | null;
  raised_at: number; cleared_at: number | null;
}
export async function getSystemAlerts(): Promise<{ active: MonitorAlert[]; recent: MonitorAlert[] }> {
  const r = await apiFetch(`${API_URL}/api/v1/system/alerts`);
  if (!r.ok) throw new Error('Failed to load alerts');
  return r.json();
}

export interface GraphNode {
  id: string;
  label: string;
  type: string;
  mtime: number;
  description?: string;
  tags?: string[];
  source_url?: string;
  learned?: string;
  enabled?: boolean;
  /** Automations only: run cadence — the universe view log-scales comet periods from it. */
  interval_minutes?: number | null;
}
export interface GraphEdge { source: string; target: string; kind: string }

export async function getMemoryGraph(): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const r = await apiFetch(`${API_URL}/api/v1/memory/graph`);
  if (!r.ok) throw new Error('Failed to load memory graph');
  return r.json();
}

export interface StorageInfo {
  host_path: string;
  container_path: string;
  writable: boolean;
  counts: Record<string, number>;
  models: {
    host_path: string | null;   // null => default docker-managed volumes
    relocated: boolean;
  };
}

export async function getStorageInfo(): Promise<StorageInfo> {
  const r = await apiFetch(`${API_URL}/api/v1/storage`);
  if (!r.ok) throw new Error('Failed to load storage info');
  return r.json();
}

export async function getBrainGraph(platform: boolean): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const r = await apiFetch(`${API_URL}/api/v1/brain/graph?platform=${platform}`);
  if (!r.ok) throw new Error('Failed to load brain graph');
  return r.json();
}

export interface SettingDef {
  key: string;
  type: 'number' | 'boolean' | 'string' | 'enum' | 'model';
  label: string;
  description: string;
  section: string;
  value: unknown;
  min?: number;
  max?: number;
  /** Slider granularity, from the backend's own definition of the setting.
   *  A count (max_dispatches_per_turn, tool_concurrency) declares step 1
   *  there; without it the slider fell back to (max-min)/20 and offered 2.8
   *  dispatches, which the backend int()s to 2 — and the stored default 3
   *  was off the notch grid, so once dragged it could never be chosen again. */
  step?: number;
  options?: string[];
  model_scope?: 'ollama' | 'any';
  allow_empty?: boolean;
}

export interface ModelInfo {
  id: string; provider: string; name: string;
  // Provider-supplied "what is this good for" facts, present when the provider's
  // /models endpoint returns them (OpenRouter does; most others just return ids).
  description?: string;
  context_length?: number;
  vision?: boolean;
  price_in?: number;   // USD per million prompt tokens
  price_out?: number;  // USD per million completion tokens
}

export async function getModels(full = false): Promise<ModelInfo[]> {
  const r = await apiFetch(`${API_URL}/api/v1/models${full ? '?full=true' : ''}`);
  if (!r.ok) throw new Error('Failed to load models');
  return r.json();
}

export async function getSettings(): Promise<SettingDef[]> {
  const r = await apiFetch(`${API_URL}/api/v1/settings`);
  if (!r.ok) throw new Error('Failed to load settings');
  return r.json();
}

export async function patchSettings(changes: Record<string, unknown>): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(changes),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Save failed');
}

export interface NotifyTestResult {
  ok: boolean;
  id?: string | null;
  error?: string;
  provider?: string;
}

/** Send a real test notification through the configured provider. */
export async function testNotification(): Promise<NotifyTestResult> {
  const r = await apiFetch(`${API_URL}/api/v1/notify/test`, { method: 'POST' });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Test failed');
  return r.json();
}

// ── web push: this device's subscription + the fleet's device list ────────

export async function getPushPubkey(): Promise<string> {
  const r = await apiFetch(`${API_URL}/api/v1/push/pubkey`);
  if (!r.ok) throw new Error('Failed to load push key');
  return (await r.json()).key;
}

export async function subscribePush(subscription: PushSubscription, label: string): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/push/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription: subscription.toJSON(), label }),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'subscribe failed');
}

export async function unsubscribePush(endpoint: string): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/push/unsubscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint }),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'unsubscribe failed');
}

export interface PushDevice {
  endpoint: string;
  endpoint_tail: string;
  label: string | null;
  created_at: number;
  last_used_at: number | null;
  failures: number;
}

export async function listPushDevices(): Promise<PushDevice[]> {
  const r = await apiFetch(`${API_URL}/api/v1/push/subscriptions`);
  if (!r.ok) throw new Error('Failed to load push devices');
  return (await r.json()).devices;
}

/** applicationServerKey wants raw bytes, the API hands out base64url.
 *  Built over an explicit ArrayBuffer so it satisfies BufferSource under
 *  TS 5.7's ArrayBufferLike split. */
export function urlB64ToUint8Array(b64: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export interface NotifyReachability {
  provider: string;
  enabled: boolean;
  checks: { label: string; ok: boolean | null; detail?: string }[];
  phone?: { server_url: string; topic: string } | null;
  note?: string;
}

/** Read-only diagnostic of the notification delivery path. */
export async function getNotifyReachability(): Promise<NotifyReachability> {
  const r = await apiFetch(`${API_URL}/api/v1/notify/reachability`);
  if (!r.ok) throw new Error('Failed to load reachability');
  return r.json();
}

export interface NotifyService {
  available: boolean;
  phone_url?: string;
  base_url?: string;
  ntfy?: { present: boolean; running: boolean; state: string };
  tailscale?: { present: boolean; running: boolean; state: string };
  tailnet_route?: boolean;
  op?: string | null;
  error?: string | null;
}

/** State of the self-hosted ntfy service (via the inference-control sidecar). */
export async function getNotifyService(): Promise<NotifyService> {
  const r = await apiFetch(`${API_URL}/api/v1/notify/service`);
  if (!r.ok) throw new Error('Failed to load notify service');
  return r.json();
}

export interface HomeAssistantStatus {
  present: boolean;
  running: boolean;
  state: string;
  url: string | null;
  op?: string | null;
  error?: string | null;
}

/** Is Home Assistant running, and where (roadmap #35). */
export async function getHomeAssistant(): Promise<HomeAssistantStatus> {
  const r = await apiFetch(`${API_URL}/api/v1/home-assistant`);
  if (!r.ok) throw new Error('Failed to load Home Assistant status');
  return r.json();
}

/** Start or stop Home Assistant. The same route Nova's approved plan uses —
 *  `actions.assert_routes_exist()` refuses to boot if it goes missing. */
export async function homeAssistantAction(action: 'up' | 'down'): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/home-assistant`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Action failed');
}

/** Start/stop the self-hosted ntfy service, or (re)apply just the tailnet
 *  route. 'up' also derives + applies the correct base URL so the phone stays
 *  in sync; 'expose' re-applies the :8443 route live (no ntfy restart). */
export async function notifyServiceAction(action: 'up' | 'down' | 'expose'): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/notify/service`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Action failed');
}

export interface BundledInferenceStatus {
  available: boolean;
  present?: boolean;
  running?: boolean;
  state?: string;
  op?: 'start' | 'stop' | 'relocate' | null;
  error?: string | null;
  api_ok?: boolean;
  models_dir?: string;   // '' = default docker volume
}

export async function getBundledInference(): Promise<BundledInferenceStatus> {
  const r = await apiFetch(`${API_URL}/api/v1/inference/bundled`);
  if (!r.ok) throw new Error('Failed to load bundled inference status');
  return r.json();
}

export async function setBundledInference(action: 'start' | 'stop'): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/inference/bundled`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? `${action} failed`);
}

/** A proactive recommendation card (distinct from model ModelRecommendation). */
export interface RecCard {
  id: string;
  kind: string;
  title: string;
  body: string;
  source: string;
  status: string;
  priority: number;
  created_at: string | null;
  decided_at: string | null;
  /** The typed plan, if the card carries one. Rendered from `action_plan`,
   *  never from these raw fields — the backend is the only thing allowed to
   *  say what Approve does, so the card and the executor cannot disagree. */
  action: Record<string, unknown> | null;
  action_plan: string | null;
  /** Whether an executor exists for this plan type yet. DERIVED from the
   *  backend's Spec table, so the button never promises more than the code
   *  can do. False until the phase-2 executors land. */
  action_executable: boolean;
  /** Echoed back on decide. A card whose plan changed since it was rendered
   *  is a 409, not a surprise execution. */
  action_digest: string | null;
  /** The backend's verdict from actually dialling the plan's endpoint. */
  action_state: 'none' | 'ready' | 'blocked';
  action_detail: string | null;
  action_checked_at: string | null;
  /** The tool list the preflight fetched — the descriptions that will land in
   *  the granted agent's prompt. Shown on the card BEFORE the click, because
   *  one-click grant is only honest if you saw them. */
  action_tools: { name: string; description: string }[] | null;
  /** The latest run of this card's action, once approved. */
  run: ActionRun | null;
}

export interface ActionRun {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  steps: { step: string; status: string; detail: string }[];
  result: {
    server_id?: string; name?: string; tools?: string[];
    granted?: Record<string, string[]>;
  } | null;
  error: string | null;
  created_at: string | null;
  finished_at: string | null;
}

/** Proactive cards Nova/automations raised. 'new' = the live banner queue. */
export async function getRecCards(status: 'new' | 'all' = 'new'): Promise<RecCard[]> {
  const r = await apiFetch(`${API_URL}/api/v1/recommendations?status=${status}`);
  if (!r.ok) throw new Error('Failed to load recommendations');
  return r.json();
}

/** `digest` is the plan the UI actually rendered. The backend compares it
 *  against the live row inside the same transaction that flips the status, so
 *  a plan rewritten between render and click is a 409 rather than a surprise
 *  execution. Omitting it on a card that has a plan fails closed. */
export async function decideRecCard(
  id: string, choice: 'approve' | 'later' | 'dismiss',
  digest?: string | null): Promise<RecCard> {
  const r = await apiFetch(`${API_URL}/api/v1/recommendations/${id}/decide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ choice, action_digest: digest ?? null }),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'decide failed');
  return r.json();
}

/** Re-queue a failed run. The card's `Run again` button. */
export async function rerunRecAction(id: string): Promise<RecCard> {
  const r = await apiFetch(`${API_URL}/api/v1/recommendations/${id}/run`,
                           { method: 'POST' });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'run failed');
  return r.json();
}

export interface PreflightResult {
  action_state: 'none' | 'ready' | 'blocked';
  action_detail: string | null;
  action_checked_at: string | null;
}

/** Re-dial the card's endpoint. The only path that sends the plan's headers. */
export async function preflightRecCard(id: string): Promise<PreflightResult> {
  const r = await apiFetch(`${API_URL}/api/v1/recommendations/${id}/preflight`,
                           { method: 'POST' });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'preflight failed');
  return r.json();
}


// ── secrets (docs/plans/secrets-management.md) ────────────────────────────
//
// The value NEVER comes back from the list — only `has_value`. Revealing is a
// separate POST (not GET: a credential must not land in a URL, a history or an
// access log), and there is no agent-facing path to any of this at all.

export interface SecretRow {
  name: string;
  source: string;
  ref: string | null;
  description: string;
  created_at: string | null;
  updated_at: string | null;
  last_used_at: string | null;
  has_value: boolean;
}

export async function listSecrets(): Promise<SecretRow[]> {
  const r = await apiFetch(`${API_URL}/api/v1/secrets`);
  if (!r.ok) throw new Error('Failed to load secrets');
  return (await r.json()).secrets;
}

export async function putSecret(
  name: string, value: string, description = ''): Promise<SecretRow> {
  const r = await apiFetch(`${API_URL}/api/v1/secrets/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value, description }),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'could not store it');
  return r.json();
}

export interface SecretSource {
  source: string; label: string; ref_example: string; available: boolean;
}

export async function secretSources(): Promise<SecretSource[]> {
  const r = await apiFetch(`${API_URL}/api/v1/secrets/sources`);
  if (!r.ok) return [];
  return (await r.json()).sources;
}

/** Point at a secret held elsewhere. No value is stored for this row —
 *  "reference, don't mirror". The backend FOLLOWS the reference before
 *  saving, so a typo fails while you are still looking at it. */
export async function putExternalSecret(
  name: string, source: string, ref: string, description = ''): Promise<SecretRow> {
  const r = await apiFetch(
    `${API_URL}/api/v1/secrets/${encodeURIComponent(name)}/external`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, ref, description }),
    });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'could not save it');
  return r.json();
}

export async function revealSecret(name: string): Promise<string> {
  const r = await apiFetch(
    `${API_URL}/api/v1/secrets/${encodeURIComponent(name)}/reveal`, { method: 'POST' });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'could not reveal it');
  return (await r.json()).value;
}

export async function secretUsage(name: string): Promise<string[]> {
  const r = await apiFetch(`${API_URL}/api/v1/secrets/${encodeURIComponent(name)}/usage`);
  if (!r.ok) return [];
  return (await r.json()).used_by;
}

export async function deleteSecret(name: string): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/secrets/${encodeURIComponent(name)}`,
                           { method: 'DELETE' });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'delete failed');
}

// ── ingestion queue (migration 041): the durable background ingest lane ──────

export type IngestStatus = 'queued' | 'running' | 'done' | 'skipped' | 'failed';

export interface IngestJob {
  id: string;
  url: string;
  title: string | null;
  source_key: string | null;
  status: IngestStatus;
  attempts: number;
  max_attempts?: number;
  orphans?: number;
  error: string | null;
  result_item_id?: string | null;
  enqueued_by?: string | null;
  enqueued_at: string;
  started_at: string | null;
  finished_at: string | null;
  dismissed_at?: string | null;
}

export interface IngestSummary {
  counts: Partial<Record<IngestStatus, number>>;
  jobs: IngestJob[];
  /** How many rows are hidden because the operator cleared them. Dismissal is
   *  a tombstone, not a delete — this is what makes "hidden" visible. */
  dismissed?: number;
}

/** Counts by status + the most-recently-touched jobs — the Ingestion panel's
 *  live poll. queued+running = work in flight; done/failed/skipped = the trail.
 *  Dismissed rows are excluded from both, which is what makes clearing one also
 *  clear the rail badge. */
export async function getIngestSummary(): Promise<IngestSummary> {
  const r = await apiFetch(`${API_URL}/api/v1/ingest/summary`);
  if (!r.ok) throw new Error('Failed to load ingestion status');
  return r.json();
}

/** Requeue a failed/skipped job so the worker tries it again. Also lifts a
 *  dismissal — an operator asking for a retry has plainly changed his mind. */
export async function retryIngestJob(id: string): Promise<IngestJob> {
  const r = await apiFetch(`${API_URL}/api/v1/ingest/jobs/${id}/retry`, { method: 'POST' });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Retry failed');
  return r.json();
}

/** Clear one finished row (done/failed/skipped) off the page. Queued and
 *  running jobs are refused by the backend — live work stays visible. */
export async function dismissIngestJob(id: string): Promise<IngestJob> {
  const r = await apiFetch(`${API_URL}/api/v1/ingest/jobs/${id}/dismiss`, { method: 'POST' });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Dismiss failed');
  return r.json();
}

/** Clear the whole finished trail at once. Returns how many rows went. */
export async function dismissFinishedIngestJobs(): Promise<{ dismissed: number }> {
  const r = await apiFetch(`${API_URL}/api/v1/ingest/jobs/dismiss-finished`, { method: 'POST' });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Clear failed');
  return r.json();
}

/** Undo a dismissal — the row returns in whatever state it was already in. */
export async function restoreIngestJob(id: string): Promise<IngestJob> {
  const r = await apiFetch(`${API_URL}/api/v1/ingest/jobs/${id}/restore`, { method: 'POST' });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Restore failed');
  return r.json();
}

/** The dismissed rows themselves, for the "show cleared" drawer. */
export async function getDismissedIngestJobs(): Promise<IngestJob[]> {
  const r = await apiFetch(`${API_URL}/api/v1/ingest/jobs?dismissed=only&limit=200`);
  if (!r.ok) throw new Error('Failed to load cleared items');
  return r.json();
}

export interface ModelsDirInfo {
  path: string | null;   // null = default docker volume
  relocated: boolean;
}

export async function getModelsDir(): Promise<ModelsDirInfo> {
  const r = await apiFetch(`${API_URL}/api/v1/inference/models-dir`);
  if (!r.ok) throw new Error('Failed to load model storage location');
  return r.json();
}

/** Relocate the bundled model store to an absolute host path (empty = reset to
 *  the default docker volume). The backend migrates + recreates ollama; poll
 *  bundled-inference status for the `relocate` op to finish. */
export async function setModelsDir(path: string): Promise<ModelsDirInfo> {
  const r = await apiFetch(`${API_URL}/api/v1/inference/models-dir`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'relocation failed');
  return r.json();
}

/** Calendar recurrence. Mirrors backend/app/schedules.py; null means the row
 *  still runs on `interval_minutes`, which every automation did before 107. */
export type Schedule =
  | { every: 'minutes'; n: number }
  | { every: 'hour'; n: number; minute: number }
  | { every: 'day'; at: string }
  | { every: 'week'; on: string[]; at: string }
  | { every: 'month'; day: number; at: string }
  | { every: 'once'; date: string; at: string };

/** A goal. Two kinds in one table: `authorises: false` is a tracked
 *  intention (an approved idea, or one he typed) that grants nothing;
 *  `true` is a standing pre-approval being drawn down — see migration 110. */
export interface Goal {
  id: string;
  title: string;
  description: string;
  target: string;
  status: string;
  approved_verbs: string[];
  authorises: boolean;
  actions_used: number;
  max_actions: number;
  expires_at: string | null;
  created_at: string;
  created_by: string | null;
  proposed_by: string | null;
  source_recommendation_id: string | null;
  sessions?: GoalSession[];
}

/** Coding work done under a goal — what came of it. */
export interface GoalSession {
  session_id: string;
  state: string;
  branch: string | null;
  commit: string | null;
  sandbox: string | null;
  review: string | null;
  created_at: string;
}

export async function getGoals(): Promise<Goal[]> {
  const r = await apiFetch(`${API_URL}/api/v1/goals`);
  if (!r.ok) throw new Error('Failed to load goals');
  return r.json();
}

export async function createGoal(body: { title: string; description?: string }): Promise<Goal> {
  const r = await apiFetch(`${API_URL}/api/v1/goals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || 'Failed to create goal');
  return r.json();
}

export async function patchGoal(id: string, body: Partial<Goal>): Promise<Goal> {
  const r = await apiFetch(`${API_URL}/api/v1/goals/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || 'Failed to save goal');
  return r.json();
}

export async function deleteGoal(id: string): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/goals/${id}`, { method: 'DELETE' });
  if (!r.ok) throw new Error('Failed to delete goal');
}

export interface Automation {
  id: string;
  name: string;
  description: string;
  instruction: string;
  agent_name: string;
  interval_minutes: number;
  schedule: Schedule | null;
  timeout_seconds: number | null;
  enabled: boolean;
  is_system: boolean;
  /** Set = mechanical: the scheduler runs backend code, no agent involved.
   *  Written only by migrations; the instruction text is documentation. */
  handler?: string | null;
  consecutive_failures: number;
  last_run_at: string | null;
  next_run_at: string | null;
  last_status: string | null;
  last_summary: string | null;
}

export async function getAutomations(): Promise<Automation[]> {
  const r = await apiFetch(`${API_URL}/api/v1/automations`);
  if (!r.ok) throw new Error('Failed to load automations');
  return r.json();
}

export interface AutomationRun {
  id: string;
  status: string;
  summary: string;
  started_at: string;
  duration_seconds: number;
}

export async function getAutomationRuns(id: string): Promise<AutomationRun[]> {
  const r = await apiFetch(`${API_URL}/api/v1/automations/${id}/runs`);
  if (!r.ok) throw new Error('Failed to load run history');
  return r.json();
}

export async function createAutomation(body: {
  name: string; instruction: string; agent_name: string;
  interval_minutes?: number; schedule?: Schedule;
}): Promise<Automation> {
  const r = await apiFetch(`${API_URL}/api/v1/automations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Create failed');
  return r.json();
}

export async function patchAutomation(id: string, body: Record<string, unknown>): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/automations/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('Update failed');
}

export async function deleteAutomation(id: string): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/automations/${id}`, { method: 'DELETE' });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Delete failed');
}

export interface Rule {
  id: string;
  name: string;
  description: string;
  pattern: string;
  target_tools: string[] | null;
  target_agents: string[] | null;
  action: 'block' | 'warn';
  enabled: boolean;
  is_system: boolean;
  hit_count: number;
  last_hit_at: string | null;
}

// ── operator consents (guarded destructive actions, roadmap #29) ─────────

export interface Consent {
  id: string;
  kind: string;
  subject: string;
  question: string;
  requested_by: string;
  conversation_id: string | null;
  status: string;
  chosen: string | null;
  created_at: string | null;
  /** Authoritative DB facts about the targeted rule — what approving
   *  actually touches. null = the rule no longer exists. */
  rule?: {
    description: string; pattern: string; action: string;
    target_tools: string[] | null; enabled: boolean;
    is_system: boolean; hit_count: number;
  } | null;
}

export async function getPendingConsents(conversationId?: string): Promise<Consent[]> {
  const q = conversationId ? `?conversation_id=${encodeURIComponent(conversationId)}` : '';
  const r = await apiFetch(`${API_URL}/api/v1/consents${q}`);
  if (!r.ok) throw new Error('Failed to load consents');
  return r.json();
}

export async function decideConsent(id: string, chosen: 'approve' | 'deny'): Promise<Consent> {
  const r = await apiFetch(`${API_URL}/api/v1/consents/${id}/decide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chosen }),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Decide failed');
  return r.json();
}

export async function getRules(): Promise<Rule[]> {
  const r = await apiFetch(`${API_URL}/api/v1/rules`);
  if (!r.ok) throw new Error('Failed to load rules');
  return r.json();
}

export async function createRule(body: {
  name: string; pattern: string; action: string; description?: string;
  target_tools?: string[] | null;
}): Promise<Rule> {
  const r = await apiFetch(`${API_URL}/api/v1/rules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Create failed');
  return r.json();
}

export async function patchRule(id: string, body: Record<string, unknown>): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/rules/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Update failed');
}

export async function deleteRule(id: string): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/rules/${id}`, { method: 'DELETE' });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Delete failed');
}

export interface AgentInfo {
  id: string;
  name: string;
  enabled: boolean;
  description: string;
  system_prompt: string;
  model: string;
  allowed_tools: string[] | null;
  routing_keywords: string[] | null;
  is_system: boolean;
  /** auto = whatever the model does on its own; on/off force it, and only
   *  apply to models the inference server reports as thinking-capable. */
  thinking?: 'auto' | 'on' | 'off';
  /** Operator-chosen standby when this agent's own model fails before the
   *  first byte. null = fall through to the install-wide local fallback,
   *  then the main agent's model. Never settable from a chat turn. */
  fallback_model?: string | null;
}

/** Capabilities the LOCAL inference server reports for a model, e.g.
 *  ['completion','tools','thinking']. Empty for cloud models — nothing here
 *  is inferred from a model's NAME. */
export async function getModelCapabilities(): Promise<Record<string, string[]>> {
  const r = await apiFetch(`${API_URL}/api/v1/models/capabilities`);
  if (!r.ok) return {};
  return (await r.json()) as Record<string, string[]>;
}

export async function getAgents(): Promise<AgentInfo[]> {
  const r = await apiFetch(`${API_URL}/api/v1/agents`);
  if (!r.ok) throw new Error('Failed to load agents');
  return r.json();
}

/** One link in an agent's standby order.
 *  `source` says where the link came from: the operator's per-agent choice,
 *  the install-wide setting, the main agent's model, or derived from the
 *  other tier. `why` is the backend's own sentence — never restate it here,
 *  because a copy in TypeScript starts lying the day the chain changes. */
export interface ChainLink {
  model: string;
  source: 'agent' | 'install' | 'main' | 'cross_tier';
  why: string;
}

export async function getAgentModelChains(): Promise<Record<string, ChainLink[]>> {
  const r = await apiFetch(`${API_URL}/api/v1/agents/model-chains`);
  if (!r.ok) throw new Error('Failed to load model chains');
  return r.json();
}

/** ── evals: testing a model against a suite of recorded incidents ──────
 *  Until now this existed only as an API and a CLI, so "how do I test a
 *  model" had no answer you could click. */

export interface EvalSuite {
  suite: string;
  agent: string;
  description: string;
  tasks: number;
  version: number;
  cost: { measured: boolean; note: string; median_seconds?: number };
}

export interface EvalVerdict {
  agent_name: string;
  model: string;
  suite: string;
  status: 'passed' | 'failed';
  tasks_passed: number;
  tasks_total: number;
  started_at: string;
  /** How many times each task ran. 1 is a draw, not a measurement. */
  repeat_count: number;
  /** null = recorded before the version was stored, so the suite is unknown. */
  suite_version: number | null;
}

export interface EvalRun {
  id: string;
  suite: string;
  agent_name: string;
  model: string;
  status: 'running' | 'passed' | 'failed' | 'error';
  tasks_passed: number | null;
  tasks_total: number | null;
  duration_s: number | null;
  error: string | null;
  repeat_count: number;
  suite_version: number | null;
  started_at: string;
}

/** One graded case. `intent` is the incident it came from, in prose — the
 *  most useful thing in the whole file and, until now, invisible outside the
 *  repo. `grades` is derived by the backend from the contract, never restated
 *  here. */
export interface EvalTask {
  id: string;
  title: string;
  intent: string;
  prompt: string;
  grades: string[];
}

export async function getEvalTasks(suite: string): Promise<EvalTask[]> {
  const r = await apiFetch(`${API_URL}/api/v1/evals/suites/${encodeURIComponent(suite)}/tasks`);
  if (!r.ok) throw new Error('Failed to load tasks');
  return (await r.json()).tasks;
}

export async function getEvalSuites(): Promise<{ suites: EvalSuite[]; verdicts: EvalVerdict[] }> {
  const r = await apiFetch(`${API_URL}/api/v1/evals/suites`);
  if (!r.ok) throw new Error('Failed to load eval suites');
  return r.json();
}

/** The runs page. `census` counts by status over agent+window and
 *  deliberately IGNORES the status filter — zeros are stated, never absent —
 *  so a page filtered to `failed` still says how many passed. */
export interface EvalRunsPage {
  runs: EvalRun[];
  census: Record<string, number>;
  window: string | null;
}

export async function getEvalRuns(limit = 8, opts: {
  agent?: string; status?: string; window?: '1h' | '6h' | '24h' | '7d';
} = {}): Promise<EvalRunsPage> {
  const q = new URLSearchParams({ limit: String(limit) });
  if (opts.agent) q.set('agent', opts.agent);
  if (opts.status) q.set('status', opts.status);
  if (opts.window) q.set('window', opts.window);
  const r = await apiFetch(`${API_URL}/api/v1/evals/runs?${q}`);
  if (!r.ok) throw new Error(await errorDetail(r) ?? 'Failed to load eval runs');
  return r.json();
}

/** One graded task inside a run — the per-task cursor migration 124 stores.
 *  `contract_failures` are the grader's own CheckResult lines, verbatim. */
export interface EvalRunTask {
  task: string;
  runs: number;
  runs_passed: number;
  passed: boolean;
  gradeable: boolean;
  duration_s: number | null;
  errors: string[];
  contract_failures: string[];
}

export async function getEvalRunDetail(id: string): Promise<EvalRun & { tasks: EvalRunTask[] }> {
  const r = await apiFetch(`${API_URL}/api/v1/evals/runs/${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error(await errorDetail(r) ?? 'Failed to load the run');
  return r.json();
}

/** "If you had to keep one local model, which one" — across suites, not one.
 *
 *  `basis` is the load-bearing field: the suites that can tell two models
 *  apart. A row is only `ranked` if it was measured across ALL of it, so a
 *  model measured once cannot outrank one measured eight times — an unranked
 *  row carries `covered` instead and its totals are 0. `leader` is null on a
 *  tie AND whenever nothing is comparable; the panel must render that as
 *  "not comparable yet", never as a default winner. */
export interface EvalStandings {
  min_repeat: number;
  installed: string[];
  basis: string[];
  comparable: boolean;
  table: {
    model: string;
    ranked: boolean;
    passed: number;
    total: number;
    pass_rate: number | null;
    suites: number;
    covered: string[];
  }[];
  missing: { suite: string; model: string }[];
  leader: string | null;
}

export async function getEvalStandings(): Promise<EvalStandings> {
  const r = await apiFetch(`${API_URL}/api/v1/evals/standings`);
  if (!r.ok) throw new Error('Failed to load standings');
  return r.json();
}

/** Start a run. 409 means one is already going — the backend allows one at a
 *  time, and the message says which. */
export async function startEvalRun(
  suite: string, model: string, repeat: number,
): Promise<EvalRun> {
  const r = await apiFetch(`${API_URL}/api/v1/evals/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ suite, model, repeat }),
  });
  if (!r.ok) {
    const detail = await r.json().catch(() => null);
    throw new Error(detail?.detail || `Failed to start (${r.status})`);
  }
  return r.json();
}

export async function patchAgent(id: string, body: Record<string, unknown>): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/agents/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Update failed');
}

export async function createAgent(body: {
  name: string; description: string; system_prompt: string; model: string;
  allowed_tools?: string[] | null; routing_keywords?: string[] | null;
}): Promise<{ id: string; name: string }> {
  const r = await apiFetch(`${API_URL}/api/v1/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Create failed');
  return r.json();
}

export async function deleteAgent(id: string): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/agents/${id}`, { method: 'DELETE' });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Delete failed');
}

export interface BuiltinToolInfo { name: string; description: string }
export interface DbToolInfo {
  id: string;
  name: string;
  description: string;
  execution_type: string;
  enabled: boolean;
  is_system: boolean;
  method?: string | null;
  url_template?: string | null;
}
export interface ToolsCatalog {
  builtins: BuiltinToolInfo[];
  db_tools: DbToolInfo[];
  allowed_hosts: string[];
}

export async function getTools(): Promise<ToolsCatalog> {
  const r = await apiFetch(`${API_URL}/api/v1/tools`);
  if (!r.ok) throw new Error('Failed to load tools');
  return r.json();
}

export async function createTool(body: {
  name: string; description: string; url_template: string; method?: string;
}): Promise<{ id: string; name: string }> {
  const r = await apiFetch(`${API_URL}/api/v1/tools`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Create failed');
  return r.json();
}

export async function patchTool(id: string, enabled: boolean): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/tools/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Update failed');
}

export async function deleteTool(id: string): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/tools/${id}`, { method: 'DELETE' });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Delete failed');
}

export interface SkillInfo {
  id: string;
  title: string;
  description: string;
  category: string | null;
  priority: number;
  updated: string;
}

export async function getSkills(): Promise<SkillInfo[]> {
  const r = await apiFetch(`${API_URL}/api/v1/skills`);
  if (!r.ok) throw new Error('Failed to load skills');
  return r.json();
}

export async function createSkill(body: {
  title: string; content: string; description?: string; category?: string;
}): Promise<{ id: string }> {
  const r = await apiFetch(`${API_URL}/api/v1/skills`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Create failed');
  return r.json();
}

export async function updateSkill(id: string, body: {
  title?: string; content?: string; description?: string;
}): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/skills/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Update failed');
}

export async function deleteSkill(id: string): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/skills/${id}`, { method: 'DELETE' });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Delete failed');
}

export interface MemoryItem {
  id: string;
  frontmatter: Record<string, string>;
  content: string;
}

// ── forgetting one journal entry (roadmap #22) ───────────────────────────
//
// Operator-only by construction: `delete_memory_item` refuses journals so a
// model can never erase its own history, which means this UI is the ONLY
// path that exists. An API with no surface would leave "forget that" true
// in principle and false in practice.

/** One entry in a day's journal. Addressed by `sha256`, NEVER by `stamp` —
 *  a single day routinely carries 43 entries under 15 distinct timestamps,
 *  so a removal keyed on the stamp would take unrelated turns with it. */
export interface JournalEntry {
  ordinal: number;
  stamp: string;
  text: string;
  sha256: string;
}

export async function getJournalEntries(date: string):
    Promise<{ doc_id: string; entries: JournalEntry[] }> {
  const r = await apiFetch(`${API_URL}/api/v1/memory/journal/${date}/entries`);
  if (!r.ok) throw new Error(await errorDetail(r) ?? 'Failed to load journal entries');
  return r.json();
}

export async function forgetJournalEntry(date: string, sha256: string, reason: string):
    Promise<{ forgotten: boolean; stamp: string; chars: number }> {
  const r = await apiFetch(`${API_URL}/api/v1/memory/journal/${date}/forget`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sha256, reason }),
  });
  if (!r.ok) throw new Error(await errorDetail(r) ?? 'Forget failed');
  return r.json();
}

// ── backups (roadmap #31) ────────────────────────────────────────────────

export interface BackupBundle {
  path: string; bytes: number; created_at: string; bundle_version: number;
  members: number; included: string[]; excluded: string[];
  readable: boolean; problem?: string | null; encrypted?: boolean;
  /** Which passphrase seals this file (truncated hash). A row whose
   *  fingerprint differs from the CURRENT one only opens with the
   *  passphrase recorded when it was made — rotation orphans silently
   *  without this. */
  passphrase_fingerprint?: string | null;
}

/** The passphrase story, never the passphrase. `state` is derived from the
 *  standing inbox card: 'confirmed' means the operator approved "I recorded
 *  it off-machine"; 'declined' means he dismissed the reminder and owns the
 *  risk; 'unset' means no passphrase exists yet (it is generated at the
 *  first encrypted backup). */
export interface BackupEncryption {
  state: 'unset' | 'unconfirmed' | 'confirmed' | 'declined' | 'unknown';
  source: string | null;
  fingerprint: string | null;
  card_id: string | null;
  secret_name?: string;
}

/** One persistent location and whether it is in the bundle. `reason` is
 *  always populated — a decision you cannot see is one you cannot argue
 *  with, and the point of this surface is that nobody reads "backup
 *  complete" as "everything is safe". */
export interface CoverageEntry {
  kind: string; name: string; disposition: string; reason: string;
  included: boolean;
}

/** The off-machine copy target (backups.offsite_dir). `newest_synced` is
 *  the fact that matters: the newest local bundle has arrived there. null =
 *  no local bundles to judge by. */
export interface BackupOffsite {
  configured: boolean; dir: string; ok: boolean; bundles: number;
  newest_synced: boolean | null; problem: string;
}

export interface BackupsResponse {
  bundles: BackupBundle[];
  store_ok: boolean;
  store_error: string;
  encryption: BackupEncryption;
  offsite: BackupOffsite;
  coverage: {
    entries: CoverageEntry[];
    refusals: { code: string; subject: string; detail: string }[];
    may_snapshot: boolean;
    included: string[];
  };
}

export async function getBackups(): Promise<BackupsResponse> {
  const r = await apiFetch(`${API_URL}/api/v1/backups`);
  if (!r.ok) throw new Error(await errorDetail(r) ?? 'Failed to load backups');
  return r.json();
}

export async function createBackup():
    Promise<{ path: string; bytes: number; members: { path: string; bytes: number }[] }> {
  const r = await apiFetch(`${API_URL}/api/v1/backups`, { method: 'POST' });
  if (!r.ok) throw new Error(await errorDetail(r) ?? 'Backup failed');
  return r.json();
}

export async function verifyBackup(name: string):
    Promise<{ scratch: string; tables: number; rows: number;
              missing_tables?: string[]; restored_ok: boolean;
              encrypted?: boolean; migration_refusal?: string }> {
  const r = await apiFetch(`${API_URL}/api/v1/backups/${encodeURIComponent(name)}/verify`,
                           { method: 'POST' });
  if (!r.ok) throw new Error(await errorDetail(r) ?? 'Verify failed');
  return r.json();
}

export async function getMemoryItem(id: string): Promise<MemoryItem> {
  const r = await apiFetch(`${API_URL}/api/v1/memory/item/${id}`);
  if (!r.ok) throw new Error('Memory item not found');
  return r.json();
}

export async function deleteMemoryItem(id: string): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/memory/item/${id}`, { method: 'DELETE' });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Delete failed');
}

// ── model recommendations ─────────────────────────────────────────────────

export interface HardwareInfo {
  ram_gb: number | null;
  cpu_cores: number | null;
  platform: 'wsl2' | 'docker-desktop' | 'linux';
  memory_note: string | null;
  memory_override_gb: number | null;
  sizing_ram_gb: number | null;
  nvidia_runtime: boolean | null;
  gpu_name: string | null;
  vram_total_gb: number | null;
  vram_observed_gb: number | null;
  unified_gpu: boolean;
  detected_at: string;
}

export interface ModelRecommendation {
  agent: string;
  is_system: boolean;
  profile: string;
  current_model: string;
  current_valid: boolean | null;
  /** the model is inherited (compaction with no override), not chosen */
  current_inherited?: boolean;
  /** present when this row writes a SETTINGS key rather than an agent row;
   *  lines the row up with the fitness advisory for the same key */
  setting?: string;
  status: 'keep' | 'switch' | 'no_fit';
  suggested_model: string | null;
  reason: string;
  alternates: { model: string; note: string }[];
}

/** A fact with a stated basis about a model bound to a ROLE (a settings key,
 *  not an agent row) — never a score. `smallest_installed` is the one that
 *  matters here: compaction seeds every later turn in a conversation, and
 *  nothing on screen said it was running on the least capable model in the
 *  house. The advisory existed on the backend with no consumer, so "apply
 *  all" could quietly patch compaction.model onto the 3B. */
export interface RoleFitness {
  setting: string;
  role: string;
  model: string | null;
  note?: string;
  findings: { severity: string; check: string; detail: string }[];
}

export async function getModelFitness(): Promise<{ roles: RoleFitness[] }> {
  const r = await apiFetch(`${API_URL}/api/v1/models/fitness`);
  if (!r.ok) throw new Error('Failed to load model fitness');
  return r.json();
}

export interface BudgetItem {
  model: string;
  agents: string[];
  pool: 'vram' | 'ram' | 'cloud';
  gb: number | null;
  source: 'probe' | 'estimate' | 'unknown';
  pinned: boolean;
}

export interface ModelBudget {
  items: BudgetItem[];
  vram_used_gb: number;
  vram_total_gb: number | null;
  ram_used_gb: number;
  ram_total_gb: number | null;
  vram_over: boolean;
  ram_over: boolean;
  unknown_count: number;
}

export type StackMode = 'hybrid' | 'local' | 'cloud';

export interface RecommendationsResponse {
  hardware: HardwareInfo;
  cloud_available: boolean;
  mode: StackMode;
  mode_note: string | null;
  curated_count: number;
  recommendations: ModelRecommendation[];
  budget: ModelBudget;
  catalog_freshness?: { age_days: number | null; stale: boolean };
}

export async function getModelBudget(): Promise<ModelBudget & { hardware: HardwareInfo }> {
  const r = await apiFetch(`${API_URL}/api/v1/models/budget`);
  if (!r.ok) throw new Error('Failed to load model budget');
  return r.json();
}

export async function getRecommendations(mode: StackMode = 'hybrid'): Promise<RecommendationsResponse> {
  const r = await apiFetch(`${API_URL}/api/v1/models/recommendations?mode=${mode}`);
  if (!r.ok) throw new Error('Failed to load recommendations');
  return r.json();
}

export interface ProbeResult {
  model: string;
  ok: boolean;
  tool_call_ok: boolean | null;
  agentic_ok?: boolean | null;
  ttft_ms: number | null;
  tok_s: number | null;
  gpu_active: boolean | null;
  vram_gb: number | null;
  error: string | null;
  ran_at: string;
}

export async function testModel(model: string): Promise<ProbeResult> {
  const r = await apiFetch(`${API_URL}/api/v1/models/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Probe failed');
  return r.json();
}

// The fixed "what is this good for" vocabulary (mirrors curated_models._USE_CASES).
export const USE_CASES = [
  'coding', 'agentic-tools', 'reasoning', 'writing', 'chat',
  'vision', 'long-context', 'multilingual', 'summarization',
] as const;

export interface CuratedModel {
  id: string;
  model: string;
  // 'ollama' (built-in local) or any registered provider slug
  provider: string;
  min_ram_gb: number | null;
  min_vram_gb: number | null;
  tool_tier: 'A' | 'B' | 'C';
  speed: 'fast' | 'medium' | 'slow';
  roles: string[];
  // "what is this good for" — filterable task-fit tags (see USE_CASES).
  use_cases: string[];
  notes: string;
  is_system: boolean;
  enabled: boolean;
  last_probe: ProbeResult | null;
  probed_at: string | null;
}

export async function getCuratedModels(): Promise<CuratedModel[]> {
  const r = await apiFetch(`${API_URL}/api/v1/models/curated`);
  if (!r.ok) throw new Error('Failed to load curated models');
  return r.json();
}

export async function createCuratedModel(body: Partial<CuratedModel>): Promise<CuratedModel> {
  const r = await apiFetch(`${API_URL}/api/v1/models/curated`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Create failed');
  return r.json();
}

export async function patchCuratedModel(id: string, body: Record<string, unknown>): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/models/curated/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Update failed');
}

export async function deleteCuratedModel(id: string): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/models/curated/${id}`, { method: 'DELETE' });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Delete failed');
}

// ── LLM providers (bring-your-own key / endpoint). The API never returns the
//    key — only key_set + the last-4 hint. ──────────────────────────────────
export interface Provider {
  id: string;
  slug: string;
  label: string;
  kind: string;
  base_url: string;
  extra_headers: Record<string, string>;
  catalog_path: string;
  needs_key: boolean;
  enabled: boolean;
  is_system: boolean;
  created_at: string | null;
  updated_at: string | null;
  key_set: boolean;
  key_hint: string;
  configured: boolean;
  // persistent reachability (stamped on save + a 60s backend loop)
  last_checked_at: string | null;
  last_seen_at: string | null;
  last_ok: boolean | null;
  last_error: string | null;
}

export interface ProviderPreset {
  slug: string;
  label: string;
  base_url: string;
  needs_key: boolean;
}

export interface ProviderTest { ok: boolean | null; error?: string; model_count?: number }

export async function getProviders(): Promise<Provider[]> {
  const r = await apiFetch(`${API_URL}/api/v1/providers`);
  if (!r.ok) throw new Error('Failed to load providers');
  return r.json();
}

export async function getProviderPresets(): Promise<ProviderPreset[]> {
  const r = await apiFetch(`${API_URL}/api/v1/providers/presets`);
  if (!r.ok) throw new Error('Failed to load provider presets');
  return r.json();
}

export async function createProvider(body: Record<string, unknown>): Promise<Provider> {
  const r = await apiFetch(`${API_URL}/api/v1/providers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Create failed');
  return r.json();
}

export async function patchProvider(id: string, body: Record<string, unknown>): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/providers/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Update failed');
}

export async function deleteProvider(id: string): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/providers/${id}`, { method: 'DELETE' });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Delete failed');
}

export async function testProvider(id: string): Promise<ProviderTest> {
  const r = await apiFetch(`${API_URL}/api/v1/providers/${id}/test`, { method: 'POST' });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Test failed');
  return r.json();
}

export interface McpTool {
  name: string;
  description: string;
  parameters_schema: Record<string, unknown>;
}

export interface McpServer {
  id: string;
  name: string;
  transport: 'http' | 'stdio';
  url: string | null;
  command: string | null;
  args: string[];
  headers: Record<string, string>;
  enabled: boolean;
  always_inject: boolean;
  tools_hash: string | null;
  status: 'connected' | 'error' | 'disabled';
  status_detail: string | null;
  last_seen: string | null;
}

export async function getMcpServers(): Promise<McpServer[]> {
  const r = await apiFetch(`${API_URL}/api/v1/mcp/servers`);
  if (!r.ok) throw new Error('Failed to load MCP servers');
  return r.json();
}

export async function getMcpServerTools(id: string): Promise<McpTool[]> {
  const r = await apiFetch(`${API_URL}/api/v1/mcp/servers/${id}/tools`);
  if (!r.ok) throw new Error('Failed to load MCP server tools');
  return r.json();
}

export async function createMcpServer(body: Partial<McpServer>): Promise<McpServer> {
  const r = await apiFetch(`${API_URL}/api/v1/mcp/servers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Create failed');
  return r.json();
}

export async function patchMcpServer(id: string, body: Record<string, unknown>): Promise<McpServer> {
  const r = await apiFetch(`${API_URL}/api/v1/mcp/servers/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Update failed');
  return r.json();
}

export async function deleteMcpServer(id: string): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/mcp/servers/${id}`, { method: 'DELETE' });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Delete failed');
}

export async function approveMcpServer(id: string): Promise<McpServer> {
  const r = await apiFetch(`${API_URL}/api/v1/mcp/servers/${id}/approve`, { method: 'POST' });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Approve failed');
  return r.json();
}

export async function uninstallModel(name: string): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/models/uninstall`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) throw new Error((await r.json()).detail ?? 'Uninstall failed');
}

export async function* pullModel(name: string): AsyncGenerator<Record<string, unknown>> {
  const r = await apiFetch(`${API_URL}/api/v1/models/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!r.ok || !r.body) throw new Error('Pull request failed');
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const f of frames) {
      const line = f.trim();
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') return;
      try { yield JSON.parse(data); } catch { /* skip */ }
    }
  }
}

// ── coding delegation (docs/plans/acp-coding-delegation.md phase 1) ────────
// Registering a repo and starting a session are OPERATOR actions in this
// phase; the builtin that lets Nova start one herself is phase 2.

export interface CoderWorkspace {
  id: string; name: string; git_url: string; default_branch: string;
  auth_secret: string | null; enabled: boolean;
}

export interface CoderSession {
  session_id: string; state: string; task: string;
  branch: string | null; commit: string | null; diffstat: string | null;
  error: string | null; workspace: string | null; created_at: string | null;
  elapsed_s?: number;
  // phase 3 review surface: what the adjudicator approved and refused
  commands?: string[];
  denials?: { why: string; tool: string }[];
  review?: string | null;
}

export async function coderStatus(): Promise<{ configured: boolean }> {
  const r = await apiFetch(`${API_URL}/api/v1/coder/status`);
  if (!r.ok) throw new Error('Failed to load coder status');
  return r.json();
}

export async function getCoderWorkspaces(): Promise<CoderWorkspace[]> {
  const r = await apiFetch(`${API_URL}/api/v1/coder/workspaces`);
  if (!r.ok) throw new Error('Failed to load workspaces');
  return (await r.json()).workspaces;
}

export async function addCoderWorkspace(body: {
  name: string; git_url: string; default_branch?: string;
}): Promise<CoderWorkspace> {
  const r = await apiFetch(`${API_URL}/api/v1/coder/workspaces`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail ?? 'Failed to add workspace');
  return r.json();
}

export async function deleteCoderWorkspace(name: string): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/coder/workspaces/${encodeURIComponent(name)}`,
                           { method: 'DELETE' });
  if (!r.ok) throw new Error('Failed to remove workspace');
}

export async function getCoderSessions(): Promise<CoderSession[]> {
  const r = await apiFetch(`${API_URL}/api/v1/coder/sessions`);
  if (!r.ok) throw new Error('Failed to load sessions');
  return (await r.json()).sessions;
}

export async function startCoderSession(body: {
  workspace: string; task: string; mode?: string; budget_s?: number;
}): Promise<{ session_id: string; branch: string }> {
  const r = await apiFetch(`${API_URL}/api/v1/coder/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail ?? 'Failed to start session');
  return r.json();
}

export async function killCoderSession(id: string): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/coder/sessions/${id}/kill`, { method: 'POST' });
  if (!r.ok) throw new Error('Failed to stop session');
}

// ── guests (docs/plans/public-access-and-guests.md §3, migration 118) ──────
//
// Two audiences behind one client. The `guest*` calls are what a guest link's
// own page uses; the `*Guest*` calls are the operator's minting console and
// are refused (403) to a guest token by the backend's default-deny route
// gate — nothing here is what makes that true, which is the point.

export interface GuestSessionRow {
  id: string;
  label: string;
  created_by: string;
  created_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  last_seen: string | null;
  allowed_models: string[];
  selected_model: string | null;
  live?: boolean;
  /** Present ONLY in the mint response. There is no endpoint that can show
   *  it again — the backend stores a sha256 and nothing else. */
  token?: string;
}

/** What this guest link is, read from the session rather than from anything
 *  the browser holds — so the page cannot show a longer expiry or a wider
 *  model list than the backend will enforce. */
export async function guestSession(): Promise<{
  label: string; expires_at: string | null;
  allowed_models: string[]; model: string;
}> {
  const r = await apiFetch(`${API_URL}/api/v1/guest/session`);
  if (!r.ok) throw new Error(await errorDetail(r) ?? 'this link is not valid');
  return r.json();
}

/** Switch between the models this session was granted. A model outside the
 *  allowlist is refused server-side; there is deliberately no client-side
 *  filter doing the real work. */
export async function pickGuestModel(model: string): Promise<{ model: string }> {
  const r = await apiFetch(`${API_URL}/api/v1/guest/model`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  });
  if (!r.ok) throw new Error(await errorDetail(r) ?? 'that model is not available here');
  return r.json();
}

export async function listGuests(): Promise<GuestSessionRow[]> {
  const r = await apiFetch(`${API_URL}/api/v1/guests`);
  if (!r.ok) throw new Error('Failed to load guest links');
  return (await r.json()).guests;
}

export async function mintGuest(label: string, minutes: number,
                                allowedModels: string[]): Promise<GuestSessionRow> {
  const r = await apiFetch(`${API_URL}/api/v1/guests`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label, minutes, allowed_models: allowedModels }),
  });
  if (!r.ok) throw new Error(await errorDetail(r) ?? 'could not create the link');
  return r.json();
}

/** Revoke access AND wipe the guest's sandbox memory. The backend re-reads
 *  the directory afterwards and 500s if the files survived, so a resolved
 *  promise here means the wipe was verified — not merely attempted. */
export async function revokeGuest(id: string): Promise<GuestSessionRow> {
  const r = await apiFetch(`${API_URL}/api/v1/guests/${id}/revoke`, { method: 'POST' });
  if (!r.ok) throw new Error(await errorDetail(r) ?? 'revoke failed');
  return r.json();
}

/** Delete outright: the session row, their conversation, and their notes. */
export async function deleteGuest(id: string): Promise<void> {
  const r = await apiFetch(`${API_URL}/api/v1/guests/${id}`, { method: 'DELETE' });
  if (!r.ok) throw new Error(await errorDetail(r) ?? 'delete failed');
}
