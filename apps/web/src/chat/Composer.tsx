// Composer (docs/04 §3, FR-018, FR-019, FR-021, FR-023, FR-024, FR-221): auto-growing input,
// Enter or Mod+Enter sends per `general.enterToSend`, Shift+Enter adds a line, attachments by
// button, drag-drop and paste with inline errors, the preset scale and model and reasoning
// pickers, and Send/Stop. While a reply runs the box stays usable: sending steers or queues per
// `general.followUp`, and Alt with the send key uses the other mode; queued messages wait in a
// strip above the box until their turn starts. Typing `@` (or the mention button) opens a fuzzy,
// grouped popover of files, folders, MCP servers and tools (FR-022); a choice becomes a removable
// chip that goes out with the message. The box is an ARIA combobox while the popover is open:
// arrows move, Enter or Tab chooses, Escape closes. M4: `/` at the start opens the same kind of
// list for skills and plugin commands and a choice inserts `/name ` (FR-046); after a reply, up to
// three suggested follow-ups sit above an empty box, and Tab or Right arrow takes the first
// (FR-028).
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import {
  REASONING_LEVELS,
  type InputMode,
  type MentionCandidate,
  type ModelView,
  type SlashCommandView,
} from '@nova/shared';
import { Button, Icon, IconButton, PresetScale, SelectField, Spinner } from '@nova/ui';
import { useAnnounce, type Draft, type MentionChip } from '../services.tsx';
import { bindingText } from '../keys.ts';
import { navigate } from '../router.ts';
import { checkFiles, formatBytes, toPending, type Rejection } from './attachments.ts';
import {
  MAX_MENTIONS,
  MENTION_ICON,
  filterMentions,
  groupMentions,
  mentionAt,
  rankMentions,
} from './mentions.ts';
import { modelGroups, type PresetStop } from './models.ts';
import { applySlash, filterSlash, slashAt } from './slash.ts';

/** A follow-up waiting for the running turn; `pending` until the Hub confirms it. */
export interface QueueItem {
  id: string;
  text: string;
  attachmentCount: number;
  pending?: boolean;
}

export function otherMode(mode: InputMode): InputMode {
  return mode === 'steer' ? 'queue' : 'steer';
}

const MODE_LABEL: Record<InputMode, string> = { steer: 'Steer', queue: 'Queue' };

/** Reads accepted files into the draft and collects per-file errors. */
export function useAttachmentIntake(draft: Draft, setDraft: (d: Draft) => void) {
  const [errors, setErrors] = useState<Rejection[]>([]);
  const latest = useRef(draft);
  useLayoutEffect(() => {
    latest.current = draft;
  });

  const addFiles = useCallback(
    async (files: readonly File[]) => {
      if (files.length === 0) return;
      const { accepted, rejected } = checkFiles(files, latest.current.attachments.length);
      const read = await Promise.allSettled(accepted.map((a) => toPending(a.file, a.mime)));
      const failed: Rejection[] = [];
      const added = read.flatMap((r, i) => {
        if (r.status === 'fulfilled') return [r.value];
        const name = accepted[i]?.file.name ?? 'A file';
        failed.push({ name, reason: `${name} could not be read.` });
        return [];
      });
      setErrors([...rejected, ...failed]);
      if (added.length) {
        const d = latest.current;
        setDraft({ ...d, attachments: [...d.attachments, ...added] });
      }
    },
    [setDraft],
  );

  return { errors, addFiles, clearErrors: () => setErrors([]) };
}

export interface ComposerProps {
  draft: Draft;
  onDraftChange: (d: Draft) => void;
  /** `mode` is set while a reply runs: steer it, or queue behind it (FR-019). */
  onSend: (d: Draft, mode?: InputMode) => void;
  onStop: () => void;
  streaming: boolean;
  stopping: boolean;
  /** What a send does while a reply runs (`general.followUp`). */
  followUp?: InputMode;
  queue?: QueueItem[];
  onCancelQueued?: (id: string) => void;
  /** Enabled presets, faster to smarter, for the preset scale (FR-221). */
  presets?: PresetStop[];
  enterToSend: 'enter' | 'mod+enter';
  mac: boolean;
  /** Why the last send failed; the text is back in the box. */
  sendError: string | null;
  attachmentErrors: Rejection[];
  onAddFiles: (files: readonly File[]) => void;
  onDismissAttachmentErrors: () => void;
  models: ModelView[];
  model: string | null;
  onModelChange: (ref: string) => void;
  reasoningLevel: string | null;
  onReasoningChange: (level: (typeof REASONING_LEVELS)[number]) => void;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  /** Shown instead of the input's placeholder while no model is available. */
  noModelHint?: string;
  /** Looks up `@`-mention candidates (FR-022); without it, `@` is plain text. */
  mentionSource?: (query: string) => Promise<MentionCandidate[]>;
  /** Lists the slash commands (FR-046); without it, `/` is plain text. */
  slashSource?: () => Promise<SlashCommandView[]>;
  /** Suggested follow-ups for an empty box after a reply (FR-028). */
  suggestions?: string[];
  /** Turns suggestions off (the `chat.suggestions` setting). */
  onTurnOffSuggestions?: () => void;
}

export function Composer({
  draft,
  onDraftChange,
  onSend,
  onStop,
  streaming,
  stopping,
  followUp = 'queue',
  queue = [],
  onCancelQueued,
  presets = [],
  enterToSend,
  mac,
  sendError,
  attachmentErrors,
  onAddFiles,
  onDismissAttachmentErrors,
  models,
  model,
  onModelChange,
  reasoningLevel,
  onReasoningChange,
  inputRef,
  noModelHint,
  mentionSource,
  slashSource,
  suggestions = [],
  onTurnOffSuggestions,
}: ComposerProps) {
  const own = useRef<HTMLTextAreaElement>(null);
  const textarea = inputRef ?? own;
  const fileInput = useRef<HTMLInputElement>(null);
  const mentions = draft.mentions ?? [];
  const canSend =
    (draft.text.trim().length > 0 || draft.attachments.length > 0 || mentions.length > 0) &&
    !!model;

  useLayoutEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [draft.text, textarea]);
  const mention = useMentions(draft, onDraftChange, textarea, mentionSource);
  const slash = useSlash(draft, onDraftChange, textarea, slashSource);
  const empty = !draft.text && draft.attachments.length === 0 && mentions.length === 0;
  const suggested = empty && !streaming ? suggestions.slice(0, 3) : [];
  const accept = (text: string) => {
    onDraftChange({ ...draft, text });
    queueMicrotask(() => {
      const el = textarea.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(text.length, text.length);
    });
  };

  const send = (alternate = false) => {
    if (!canSend) return;
    if (streaming) onSend(draft, alternate ? otherMode(followUp) : followUp);
    else onSend(draft);
  };

  const sendKey = enterToSend === 'enter' ? 'Enter' : bindingText('mod+enter', mac);
  const altKey =
    enterToSend === 'enter' ? bindingText('alt+enter', mac) : bindingText('mod+alt+enter', mac);
  const selected = models.find((m) => m.ref === model);
  const groups = modelGroups(models);
  const onScale = presets.some((p) => p.ref === model) ? model : null;
  const sendLabel = streaming ? MODE_LABEL[followUp] : 'Send';
  const sendHint = streaming
    ? followUp === 'queue'
      ? `Queue: sends when the reply finishes. ${altKey} steers the reply instead.`
      : `Steer: the reply takes this into account at its next step. ${altKey} queues it instead.`
    : undefined;

  return (
    <form
      className="composer"
      aria-label="Message composer"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      {sendError ? (
        <p className="composer-error" role="alert">
          <Icon name="alert" /> {sendError}
        </p>
      ) : null}
      {attachmentErrors.length ? (
        <div className="composer-error" role="alert">
          <ul>
            {attachmentErrors.map((r, i) => (
              <li key={`${r.name}-${i}`}>{r.reason}</li>
            ))}
          </ul>
          <Button variant="ghost" onClick={onDismissAttachmentErrors}>
            Dismiss
          </Button>
        </div>
      ) : null}
      {queue.length ? (
        <section className="queue-strip" aria-label="Queued messages">
          <span className="queue-title">Queued: {queue.length}</span>
          <ul className="queue-items">
            {queue.map((q) => {
              const label =
                q.text.trim() ||
                `${q.attachmentCount} ${q.attachmentCount === 1 ? 'attachment' : 'attachments'}`;
              return (
                <li key={q.id} className="queue-item">
                  <span className="queue-text">{label}</span>
                  {q.pending ? (
                    <Spinner label="Queuing" />
                  ) : (
                    <Button
                      variant="ghost"
                      aria-label={`Cancel queued message: ${label.slice(0, 80)}`}
                      onClick={() => onCancelQueued?.(q.id)}
                    >
                      Cancel
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {draft.attachments.length ? (
        <ul className="chips" aria-label="Attachments">
          {draft.attachments.map((a) => (
            <li key={a.id} className="chip">
              <Icon name="file" />
              <span className="chip-name">{a.name}</span>
              <span className="muted">{formatBytes(a.size)}</span>
              <IconButton
                label={`Remove ${a.name}`}
                icon={<Icon name="close" />}
                variant="ghost"
                onClick={() =>
                  onDraftChange({
                    ...draft,
                    attachments: draft.attachments.filter((x) => x.id !== a.id),
                  })
                }
              />
            </li>
          ))}
        </ul>
      ) : null}
      {mentions.length ? (
        <ul className="chips" aria-label="Mentions">
          {mentions.map((m) => (
            <li key={m.ref} className="chip mention-chip" data-kind={m.kind}>
              <Icon name={MENTION_ICON[m.kind]} />
              <span className="chip-name" title={m.ref}>
                {m.label}
              </span>
              <IconButton
                label={`Remove mention ${m.label}`}
                icon={<Icon name="close" />}
                variant="ghost"
                onClick={() => {
                  onDraftChange({ ...draft, mentions: mentions.filter((x) => x.ref !== m.ref) });
                  textarea.current?.focus();
                }}
              />
            </li>
          ))}
        </ul>
      ) : null}
      {suggested.length ? (
        <div className="composer-suggestions">
          <ul className="suggestions" aria-label="Suggested follow-ups">
            {suggested.map((t, i) => (
              <li key={`${i}-${t}`}>
                <button type="button" className="suggestion" title={t} onClick={() => accept(t)}>
                  {t}
                </button>
              </li>
            ))}
            {onTurnOffSuggestions ? (
              <li>
                <IconButton
                  label="Turn off suggested follow-ups"
                  icon={<Icon name="close" />}
                  variant="ghost"
                  onClick={onTurnOffSuggestions}
                />
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
      {mention.popover}
      {slash.popover}
      <label htmlFor="composer-input" className="nv-vh">
        Message
      </label>
      <textarea
        id="composer-input"
        ref={textarea}
        className="composer-input"
        rows={1}
        value={draft.text}
        placeholder={noModelHint ?? 'Message Nova'}
        aria-describedby="composer-help"
        onChange={(e) => {
          onDraftChange({ ...draft, text: e.target.value });
          mention.track(e.target.value, e.target.selectionStart);
          slash.track(e.target.value, e.target.selectionStart);
        }}
        onSelect={(e) => {
          mention.track(e.currentTarget.value, e.currentTarget.selectionStart);
          slash.track(e.currentTarget.value, e.currentTarget.selectionStart);
        }}
        onFocus={() => {
          mention.setFocused(true);
          slash.setFocused(true);
        }}
        onBlur={() => {
          mention.setFocused(false);
          slash.setFocused(false);
        }}
        {...(slash.open ? slash.inputProps : mention.inputProps)}
        onKeyDown={(e) => {
          if (slash.onKeyDown(e)) return;
          if (mention.onKeyDown(e)) return;
          const plain = !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey;
          const first = suggested[0];
          if (first && plain && (e.key === 'Tab' || e.key === 'ArrowRight')) {
            e.preventDefault();
            accept(first);
            return;
          }
          if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
          const mod = mac ? e.metaKey : e.ctrlKey;
          const sends = enterToSend === 'enter' ? !e.shiftKey && !mod : mod;
          if (sends) {
            e.preventDefault();
            send(e.altKey);
          }
        }}
        onPaste={(e) => {
          const files = [...e.clipboardData.files];
          if (files.length) {
            e.preventDefault();
            onAddFiles(files);
          }
        }}
      />
      <span id="composer-help" className="nv-vh">
        {enterToSend === 'enter'
          ? 'Enter sends, Shift+Enter adds a line.'
          : `${sendKey} sends, Enter adds a line.`}{' '}
        Escape stops a reply.
        {suggested.length ? ' Tab or Right arrow takes the first suggested follow-up.' : ''}
        {streaming
          ? ` While the reply runs, ${sendKey} ${followUp === 'queue' ? 'queues your message' : 'steers the reply'} and ${altKey} ${followUp === 'queue' ? 'steers the reply' : 'queues your message'}.`
          : ''}
      </span>
      <div className="composer-bar">
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          data-testid="file-input"
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            onAddFiles(files);
          }}
        />
        <IconButton
          label="Attach files"
          icon={<Icon name="attach" />}
          variant="ghost"
          onClick={() => fileInput.current?.click()}
        />
        {mentionSource ? (
          <IconButton
            label="Mention a file, folder, tool or server"
            icon={<Icon name="at" />}
            variant="ghost"
            onClick={mention.insertAt}
          />
        ) : null}
        {slashSource ? (
          <IconButton
            label="Use a slash command"
            icon={<Icon name="slash" />}
            variant="ghost"
            onClick={slash.insertSlash}
          />
        ) : null}
        <span className="composer-spacer" />
        {presets.length ? (
          <PresetScale
            className="composer-presets"
            label="Model preset"
            value={onScale}
            onChange={onModelChange}
            options={presets.map((p) => ({
              value: p.ref,
              label: p.label,
              ...(p.description ? { description: p.description } : {}),
            }))}
          >
            <a
              href="/settings/models"
              className="link composer-advanced"
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                navigate('/settings/models');
              }}
            >
              Advanced…
            </a>
          </PresetScale>
        ) : null}
        {models.length ? (
          <SelectField
            className="composer-model"
            label="Model"
            hideLabel
            value={model ?? ''}
            onChange={onModelChange}
            groups={groups}
          />
        ) : null}
        {selected?.reasoning ? (
          <SelectField
            className="composer-reasoning"
            label="Reasoning level"
            hideLabel
            value={reasoningLevel ?? 'medium'}
            onChange={(v) => onReasoningChange(v as (typeof REASONING_LEVELS)[number])}
            options={REASONING_LEVELS.map((l) => ({ value: l, label: `Reasoning: ${l}` }))}
          />
        ) : null}
        {streaming ? (
          <Button
            variant="default"
            onClick={onStop}
            disabled={stopping}
            aria-keyshortcuts="Escape"
            className="composer-stop"
          >
            {stopping ? <Spinner /> : <Icon name="stop" />}
            {stopping ? 'Stopping…' : 'Stop'}
          </Button>
        ) : null}
        <Button
          type="submit"
          variant="primary"
          disabled={!canSend}
          className="composer-send"
          data-mode={streaming ? followUp : undefined}
          title={sendHint}
        >
          <Icon name={streaming && followUp === 'steer' ? 'forward' : 'send'} />
          {sendLabel}
        </Button>
      </div>
    </form>
  );
}

// ---- @-mentions (FR-022) -------------------------------------------------------------------------

interface MentionResults {
  query: string;
  items: MentionCandidate[];
  failed: boolean;
}

function useMentions(
  draft: Draft,
  onDraftChange: (d: Draft) => void,
  textarea: RefObject<HTMLTextAreaElement | null>,
  source: ((query: string) => Promise<MentionCandidate[]>) | undefined,
) {
  const listId = useId();
  const announce = useAnnounce();
  const [caret, setCaret] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const [results, setResults] = useState<MentionResults | null>(null);

  const token = source && focused && caret !== null ? mentionAt(draft.text, caret) : null;
  const open = !!token && token.start !== dismissedAt;
  const query = token?.query ?? '';

  useEffect(() => {
    if (!open || !source) return;
    let alive = true;
    const t = setTimeout(() => {
      source(query).then(
        (items) => {
          if (alive) setResults({ query, items, failed: false });
        },
        () => {
          if (alive) setResults({ query, items: [], failed: true });
        },
      );
    }, 80);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [open, query, source]);

  // While the Hub's answer for this query is on its way, filter the last answer.
  const fresh = results?.query === query;
  const ranked = !results
    ? []
    : fresh
      ? rankMentions(results.items, query)
      : filterMentions(results.items, query);
  const groups = groupMentions(ranked);
  const options = groups.flatMap((g) => g.items);
  const current = options.length ? Math.min(active, options.length - 1) : -1;
  const optionId = (i: number) => `${listId}-opt-${i}`;

  const track = (text: string, at: number | null) => {
    setCaret(at);
    const next = at === null ? null : mentionAt(text, at);
    if (!next || next.start !== token?.start || next.query !== token.query) setActive(0);
    if (!next) setDismissedAt(null);
  };

  const place = (at: number) => {
    setCaret(at);
    queueMicrotask(() => {
      const el = textarea.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(at, at);
    });
  };

  const choose = (c: MentionCandidate) => {
    if (!token) return;
    const text = draft.text.slice(0, token.start) + draft.text.slice(token.end);
    const list = draft.mentions ?? [];
    const exists = list.some((m) => m.ref === c.ref);
    if (!exists && list.length >= MAX_MENTIONS) {
      announce(`A message can mention at most ${MAX_MENTIONS} items.`);
      return;
    }
    const chip: MentionChip = { kind: c.kind, ref: c.ref, label: c.label };
    onDraftChange({ ...draft, text, mentions: exists ? list : [...list, chip] });
    setResults(null);
    place(token.start);
    announce(`Mentioned ${c.label}.`);
  };

  const insertAt = () => {
    const el = textarea.current;
    const pos = el?.selectionStart ?? draft.text.length;
    const before = draft.text.slice(0, pos);
    const insert = before && !/\s$/.test(before) ? ' @' : '@';
    const text = before + insert + draft.text.slice(pos);
    onDraftChange({ ...draft, text });
    setDismissedAt(null);
    setActive(0);
    setFocused(true);
    place(pos + insert.length);
  };

  /** Handles popover keys; true when the key was used. */
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || !token) return false;
    if (e.key === 'Escape') {
      // Escape closes the popover only; it must not also stop a running reply.
      e.preventDefault();
      e.stopPropagation();
      setDismissedAt(token.start);
      return true;
    }
    if (!options.length) {
      // While suggestions load, Enter waits for them instead of sending a half-typed mention.
      if (e.key === 'Enter' && !fresh) {
        e.preventDefault();
        return true;
      }
      return false;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const by = e.key === 'ArrowDown' ? 1 : -1;
      setActive((current + by + options.length) % options.length);
      return true;
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      const c = options[current];
      if (c) choose(c);
      return true;
    }
    return false;
  };

  const inputProps = source
    ? {
        'aria-autocomplete': 'list' as const,
        ...(open
          ? {
              role: 'combobox',
              'aria-expanded': true,
              'aria-controls': listId,
              'aria-activedescendant': current >= 0 ? optionId(current) : undefined,
            }
          : {}),
      }
    : {};

  let n = 0;
  const popover = open ? (
    <div className="mention-popover">
      <div id={listId} role="listbox" aria-label="Mention suggestions" className="mention-list">
        {groups.map((g) => (
          <div key={g.kind} role="group" aria-labelledby={`${listId}-${g.kind}`}>
            <div id={`${listId}-${g.kind}`} role="presentation" className="mention-group">
              {g.label}
            </div>
            {g.items.map((c) => {
              const i = n++;
              return (
                <div
                  key={`${c.kind}:${c.ref}`}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === current}
                  className="mention-option"
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(c)}
                >
                  <Icon name={MENTION_ICON[c.kind]} />
                  <span className="mention-label">{c.label}</span>
                  {c.detail ? <span className="muted mention-detail">{c.detail}</span> : null}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <p className="muted mention-status" role="status">
        {results?.failed && fresh
          ? 'Suggestions are unavailable right now.'
          : !fresh && !options.length
            ? 'Searching…'
            : options.length
              ? `${options.length} ${options.length === 1 ? 'suggestion' : 'suggestions'}`
              : 'No matches'}
      </p>
    </div>
  ) : null;

  return { track, setFocused, onKeyDown, inputProps, popover, insertAt };
}

// ---- slash commands (FR-046) ---------------------------------------------------------------------

interface SlashResults {
  items: SlashCommandView[];
  failed: boolean;
}

function useSlash(
  draft: Draft,
  onDraftChange: (d: Draft) => void,
  textarea: RefObject<HTMLTextAreaElement | null>,
  source: (() => Promise<SlashCommandView[]>) | undefined,
) {
  const listId = useId();
  const announce = useAnnounce();
  const [caret, setCaret] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  const [results, setResults] = useState<SlashResults | null>(null);

  const token = source && focused && caret !== null ? slashAt(draft.text, caret) : null;
  const open = !!token && !dismissed;

  // The list is fetched each time the popover opens, so new skills show up without a reload.
  useEffect(() => {
    if (!open || !source) return;
    let alive = true;
    source().then(
      (items) => {
        if (alive) setResults({ items, failed: false });
      },
      () => {
        if (alive) setResults({ items: [], failed: true });
      },
    );
    return () => {
      alive = false;
    };
  }, [open, source]);

  const options = open && results ? filterSlash(results.items, token.query) : [];
  const current = options.length ? Math.min(active, options.length - 1) : -1;
  const optionId = (i: number) => `${listId}-opt-${i}`;

  const track = (text: string, at: number | null) => {
    setCaret(at);
    const next = at === null ? null : slashAt(text, at);
    if (!next || next.query !== token?.query) setActive(0);
    if (!next) setDismissed(false);
  };

  const place = (at: number) => {
    setCaret(at);
    queueMicrotask(() => {
      const el = textarea.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(at, at);
    });
  };

  const choose = (c: SlashCommandView) => {
    if (!token) return;
    const r = applySlash(draft.text, c.name, token.end);
    onDraftChange({ ...draft, text: r.text });
    place(r.caret);
    announce(`Command /${c.name}.`);
  };

  const insertSlash = () => {
    const text = draft.text.startsWith('/') ? draft.text : `/${draft.text}`;
    if (text !== draft.text) onDraftChange({ ...draft, text });
    setDismissed(false);
    setActive(0);
    setFocused(true);
    place(1);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || !token) return false;
    if (e.key === 'Escape') {
      // Escape closes the list only; it must not also stop a running reply.
      e.preventDefault();
      e.stopPropagation();
      setDismissed(true);
      return true;
    }
    if (!results) {
      // While the list loads, Enter waits for it instead of sending a half-typed command.
      if (e.key === 'Enter') {
        e.preventDefault();
        return true;
      }
      return false;
    }
    if (!options.length) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const by = e.key === 'ArrowDown' ? 1 : -1;
      setActive((current + by + options.length) % options.length);
      return true;
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      const c = options[current];
      if (c) choose(c);
      return true;
    }
    return false;
  };

  const inputProps = open
    ? {
        role: 'combobox',
        'aria-autocomplete': 'list' as const,
        'aria-expanded': true,
        'aria-controls': listId,
        'aria-activedescendant': current >= 0 ? optionId(current) : undefined,
      }
    : {};

  const popover = open ? (
    <div className="mention-popover">
      <div id={listId} role="listbox" aria-label="Slash commands" className="mention-list">
        {options.map((c, i) => (
          <div
            key={c.skillId}
            id={optionId(i)}
            role="option"
            aria-selected={i === current}
            className="mention-option"
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => setActive(i)}
            onClick={() => choose(c)}
          >
            <Icon name="slash" />
            <span className="mention-label slash-name">/{c.name}</span>
            <span className="muted mention-detail">{c.description}</span>
          </div>
        ))}
      </div>
      <p className="muted mention-status" role="status">
        {!results
          ? 'Loading commands…'
          : results.failed
            ? 'Commands are unavailable right now.'
            : options.length
              ? `${options.length} ${options.length === 1 ? 'command' : 'commands'}`
              : 'No matching commands'}
      </p>
    </div>
  ) : null;

  return { open, track, setFocused, onKeyDown, inputProps, popover, insertSlash };
}
