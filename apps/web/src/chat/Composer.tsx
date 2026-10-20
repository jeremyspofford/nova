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
  type ReactNode,
  type RefObject,
} from 'react';
import {
  REASONING_LEVELS,
  type InputMode,
  type MentionCandidate,
  type ModelView,
  type SlashCommandView,
} from '@nova/shared';
import { defineMessages } from '@nova/i18n';
import {
  Button,
  Icon,
  IconButton,
  PresetScale,
  SelectField,
  Spinner,
  spokenKey,
  spokenKeys,
} from '@nova/ui';
import { useAnnounce, type Draft, type MentionChip } from '../services.tsx';
import { formatBinding } from '../keys.ts';
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

export const COMPOSER_TEXT = defineMessages('chat.composer', {
  mode: { steer: 'Steer', queue: 'Queue' },
  send: 'Send',
  queueHint: 'Queue: sends when the reply finishes. {key} steers the reply instead.',
  steerHint: 'Steer: the reply takes this into account at its next step. {key} queues it instead.',
  composer: 'Message composer',
  waitingForModels: 'Waiting for the model list. Your message sends as soon as it has loaded.',
  dontSend: "Don't send",
  noModel:
    'No model is available, so this cannot be sent yet. Connect a model provider in Settings → Accounts; your message stays here.',
  dismiss: 'Dismiss',
  queued: 'Queued messages',
  queuedCount: 'Queued: {n}',
  attachments: '{n, plural, one {# attachment} other {# attachments}}',
  queuing: 'Queuing',
  cancelQueued: 'Cancel queued message: {message}',
  cancel: 'Cancel',
  attachmentsList: 'Attachments',
  remove: 'Remove {name}',
  mentions: 'Mentions',
  removeMention: 'Remove mention {name}',
  suggestions: 'Suggested follow-ups',
  turnOffSuggestions: 'Turn off suggested follow-ups',
  message: 'Message',
  placeholder: 'Message Nova',
  help: {
    enter: 'Enter sends, Shift+Enter adds a line.',
    mod: '{key} sends, Enter adds a line.',
    escape: 'Escape stops a reply.',
    suggestion: 'Tab or Right arrow takes the first suggested follow-up.',
    whileQueue: 'While the reply runs, {key} queues your message and {altKey} steers the reply.',
    whileSteer: 'While the reply runs, {key} steers the reply and {altKey} queues your message.',
  },
  attach: 'Attach files',
  mention: 'Mention a file, folder, tool or server',
  slash: 'Use a slash command',
  preset: 'Model preset',
  advanced: 'Advanced…',
  model: 'Model',
  reasoning: 'Reasoning level',
  reasoningLevel:
    '{level, select, off {Reasoning: off} minimal {Reasoning: minimal} low {Reasoning: low} medium {Reasoning: medium} high {Reasoning: high} xhigh {Reasoning: extra high} max {Reasoning: max} other {Reasoning: {level}}}',
  stopping: 'Stopping…',
  stop: 'Stop',
  unreadable: '{name} could not be read.',
  aFile: 'A file',
  tooManyMentions:
    '{max, plural, one {A message can mention at most # item.} other {A message can mention at most # items.}}',
  mentioned: 'Mentioned {name}.',
  mentionList: 'Mention suggestions',
  mentionsUnavailable: 'Suggestions are unavailable right now.',
  searching: 'Searching…',
  suggestionCount: '{n, plural, one {# suggestion} other {# suggestions}}',
  noMatches: 'No matches',
  command: 'Command /{name}.',
  commands: 'Slash commands',
  loadingCommands: 'Loading commands…',
  commandsUnavailable: 'Commands are unavailable right now.',
  commandCount: '{n, plural, one {# command} other {# commands}}',
  noCommands: 'No matching commands',
});

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
        const name = accepted[i]?.file.name ?? COMPOSER_TEXT.aFile;
        failed.push({ name, reason: COMPOSER_TEXT.unreadable({ name }) });
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
  /**
   * The model list is still loading: a send made now waits, visibly, and goes once a model is
   * known (pressing Enter never drops typed text silently).
   */
  modelLoading?: boolean;
  /** Looks up `@`-mention candidates (FR-022); without it, `@` is plain text. */
  mentionSource?: (query: string) => Promise<MentionCandidate[]>;
  /** Lists the slash commands (FR-046); without it, `/` is plain text. */
  slashSource?: () => Promise<SlashCommandView[]>;
  /** Suggested follow-ups for an empty box after a reply (FR-028). */
  suggestions?: string[];
  /** Turns suggestions off (the `chat.suggestions` setting). */
  onTurnOffSuggestions?: () => void;
  /** M5: an extra control before Stop and Send, e.g. a Code session's permission mode. */
  accessory?: ReactNode;
  /** M7: more actions in the left cluster, e.g. Generate image (FR-030). */
  actions?: ReactNode;
  /** M5: prefix of the box's element ids, so an embedded chat does not reuse the main one's. */
  idBase?: string;
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
  modelLoading = false,
  mentionSource,
  slashSource,
  suggestions = [],
  onTurnOffSuggestions,
  accessory,
  actions,
  idBase = 'composer',
}: ComposerProps) {
  const own = useRef<HTMLTextAreaElement>(null);
  const textarea = inputRef ?? own;
  const fileInput = useRef<HTMLInputElement>(null);
  const mentions = draft.mentions ?? [];
  const hasContent =
    draft.text.trim().length > 0 || draft.attachments.length > 0 || mentions.length > 0;
  const canSend = hasContent && (!!model || modelLoading);
  /** A send made before any model was known, waiting for the model list. */
  const [held, setHeld] = useState<{ alternate: boolean } | null>(null);
  /** A send pressed with no model at all: say why instead of ignoring it. */
  const [noModelTried, setNoModelTried] = useState(false);

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

  const deliver = (alternate: boolean) => {
    if (streaming) onSend(draft, alternate ? otherMode(followUp) : followUp);
    else onSend(draft);
  };
  const send = (alternate = false) => {
    if (!hasContent) return;
    if (!model) {
      if (modelLoading) setHeld({ alternate });
      else setNoModelTried(true);
      return;
    }
    setHeld(null);
    setNoModelTried(false);
    deliver(alternate);
  };
  const deliverRef = useRef({ deliver, hasContent });
  useLayoutEffect(() => {
    deliverRef.current = { deliver, hasContent };
  });
  // The model list arrived: a held send goes now, with what the box holds; when it ended with no
  // model at all, the send is released and the reason shown instead.
  useEffect(() => {
    if (!held) return;
    if (model) {
      // Sent once, as the user asked before the list arrived; the prop change is the trigger.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHeld(null);
      if (deliverRef.current.hasContent) deliverRef.current.deliver(held.alternate);
    } else if (!modelLoading) {
      setHeld(null);
      setNoModelTried(true);
    }
  }, [held, model, modelLoading]);

  // Key names in words, in the active locale ("Alt plus Enter").
  const sendBinding = enterToSend === 'enter' ? 'enter' : 'mod+enter';
  const altBinding = enterToSend === 'enter' ? 'alt+enter' : 'mod+alt+enter';
  // Key names in words for the screen-reader help ("Alt plus Enter"), and as caps with the
  // modifiers named in the active locale for the tooltip ("Alt+Enter").
  const keys = (binding: string) => spokenKeys(formatBinding(binding, mac));
  const caps = (binding: string) =>
    formatBinding(binding, mac)
      .map(spokenKey)
      .join(mac ? '' : '+');
  const sendKey = keys(sendBinding);
  const altKey = keys(altBinding);
  const selected = models.find((m) => m.ref === model);
  const groups = modelGroups(models);
  const onScale = presets.some((p) => p.ref === model) ? model : null;
  const sendLabel = streaming ? COMPOSER_TEXT.mode[followUp] : COMPOSER_TEXT.send;
  const sendHint = streaming
    ? followUp === 'queue'
      ? COMPOSER_TEXT.queueHint({ key: caps(altBinding) })
      : COMPOSER_TEXT.steerHint({ key: caps(altBinding) })
    : undefined;
  const help = [
    enterToSend === 'enter' ? COMPOSER_TEXT.help.enter : COMPOSER_TEXT.help.mod({ key: sendKey }),
    COMPOSER_TEXT.help.escape,
    ...(suggested.length ? [COMPOSER_TEXT.help.suggestion] : []),
    ...(streaming
      ? [
          followUp === 'queue'
            ? COMPOSER_TEXT.help.whileQueue({ key: sendKey, altKey })
            : COMPOSER_TEXT.help.whileSteer({ key: sendKey, altKey }),
        ]
      : []),
  ].join(' ');

  return (
    <form
      className="composer"
      aria-label={COMPOSER_TEXT.composer}
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
      {held && !model ? (
        <p className="composer-note composer-held" role="status">
          <Spinner /> {COMPOSER_TEXT.waitingForModels}{' '}
          <button type="button" className="link" onClick={() => setHeld(null)}>
            {COMPOSER_TEXT.dontSend}
          </button>
        </p>
      ) : null}
      {noModelTried && !model && !held ? (
        <p className="composer-error" role="alert">
          <Icon name="alert" /> {COMPOSER_TEXT.noModel}
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
            {COMPOSER_TEXT.dismiss}
          </Button>
        </div>
      ) : null}
      {queue.length ? (
        <section className="queue-strip" aria-label={COMPOSER_TEXT.queued}>
          <span className="queue-title">{COMPOSER_TEXT.queuedCount({ n: queue.length })}</span>
          <ul className="queue-items">
            {queue.map((q) => {
              const label = q.text.trim() || COMPOSER_TEXT.attachments({ n: q.attachmentCount });
              return (
                <li key={q.id} className="queue-item">
                  <span className="queue-text" dir="auto">
                    {label}
                  </span>
                  {q.pending ? (
                    <Spinner label={COMPOSER_TEXT.queuing} />
                  ) : (
                    <Button
                      variant="ghost"
                      aria-label={COMPOSER_TEXT.cancelQueued({ message: label.slice(0, 80) })}
                      onClick={() => onCancelQueued?.(q.id)}
                    >
                      {COMPOSER_TEXT.cancel}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {draft.attachments.length ? (
        <ul className="chips" aria-label={COMPOSER_TEXT.attachmentsList}>
          {draft.attachments.map((a) => (
            <li key={a.id} className="chip">
              <Icon name="file" />
              <span className="chip-name">{a.name}</span>
              <span className="muted">{formatBytes(a.size)}</span>
              <IconButton
                label={COMPOSER_TEXT.remove({ name: a.name })}
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
        <ul className="chips" aria-label={COMPOSER_TEXT.mentions}>
          {mentions.map((m) => (
            <li key={m.ref} className="chip mention-chip" data-kind={m.kind}>
              <Icon name={MENTION_ICON[m.kind]} />
              <span className="chip-name" title={m.ref}>
                {m.label}
              </span>
              <IconButton
                label={COMPOSER_TEXT.removeMention({ name: m.label })}
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
          <ul className="suggestions" aria-label={COMPOSER_TEXT.suggestions}>
            {suggested.map((t, i) => (
              <li key={`${i}-${t}`}>
                <button
                  type="button"
                  className="suggestion"
                  title={t}
                  dir="auto"
                  onClick={() => accept(t)}
                >
                  {t}
                </button>
              </li>
            ))}
            {onTurnOffSuggestions ? (
              <li>
                <IconButton
                  label={COMPOSER_TEXT.turnOffSuggestions}
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
      <label htmlFor={`${idBase}-input`} className="nv-vh">
        {COMPOSER_TEXT.message}
      </label>
      <textarea
        id={`${idBase}-input`}
        ref={textarea}
        className="composer-input"
        dir="auto"
        rows={1}
        value={draft.text}
        placeholder={noModelHint ?? COMPOSER_TEXT.placeholder}
        aria-describedby={`${idBase}-help`}
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
      <span id={`${idBase}-help`} className="nv-vh">
        {help}
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
          label={COMPOSER_TEXT.attach}
          icon={<Icon name="attach" />}
          variant="ghost"
          onClick={() => fileInput.current?.click()}
        />
        {mentionSource ? (
          <IconButton
            label={COMPOSER_TEXT.mention}
            icon={<Icon name="at" />}
            variant="ghost"
            onClick={mention.insertAt}
          />
        ) : null}
        {slashSource ? (
          <IconButton
            label={COMPOSER_TEXT.slash}
            icon={<Icon name="slash" />}
            variant="ghost"
            onClick={slash.insertSlash}
          />
        ) : null}
        {actions}
        <span className="composer-spacer" />
        {presets.length ? (
          <PresetScale
            className="composer-presets"
            label={COMPOSER_TEXT.preset}
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
              {COMPOSER_TEXT.advanced}
            </a>
          </PresetScale>
        ) : null}
        {models.length ? (
          <SelectField
            className="composer-model"
            label={COMPOSER_TEXT.model}
            hideLabel
            value={model ?? ''}
            onChange={onModelChange}
            groups={groups}
          />
        ) : null}
        {selected?.reasoning ? (
          <SelectField
            className="composer-reasoning"
            label={COMPOSER_TEXT.reasoning}
            hideLabel
            value={reasoningLevel ?? 'medium'}
            onChange={(v) => onReasoningChange(v as (typeof REASONING_LEVELS)[number])}
            options={REASONING_LEVELS.map((l) => ({
              value: l,
              label: COMPOSER_TEXT.reasoningLevel({ level: l }),
            }))}
          />
        ) : null}
        {accessory}
        {streaming ? (
          <Button
            variant="default"
            onClick={onStop}
            disabled={stopping}
            aria-keyshortcuts="Escape"
            className="composer-stop"
          >
            {stopping ? <Spinner /> : <Icon name="stop" />}
            {stopping ? COMPOSER_TEXT.stopping : COMPOSER_TEXT.stop}
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
      announce(COMPOSER_TEXT.tooManyMentions({ max: MAX_MENTIONS }));
      return;
    }
    const chip: MentionChip = { kind: c.kind, ref: c.ref, label: c.label };
    onDraftChange({ ...draft, text, mentions: exists ? list : [...list, chip] });
    setResults(null);
    place(token.start);
    announce(COMPOSER_TEXT.mentioned({ name: c.label }));
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
      <div
        id={listId}
        role="listbox"
        aria-label={COMPOSER_TEXT.mentionList}
        className="mention-list"
      >
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
          ? COMPOSER_TEXT.mentionsUnavailable
          : !fresh && !options.length
            ? COMPOSER_TEXT.searching
            : options.length
              ? COMPOSER_TEXT.suggestionCount({ n: options.length })
              : COMPOSER_TEXT.noMatches}
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
    announce(COMPOSER_TEXT.command({ name: c.name }));
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
      <div id={listId} role="listbox" aria-label={COMPOSER_TEXT.commands} className="mention-list">
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
          ? COMPOSER_TEXT.loadingCommands
          : results.failed
            ? COMPOSER_TEXT.commandsUnavailable
            : options.length
              ? COMPOSER_TEXT.commandCount({ n: options.length })
              : COMPOSER_TEXT.noCommands}
      </p>
    </div>
  ) : null;

  return { open, track, setFocused, onKeyDown, inputProps, popover, insertSlash };
}
