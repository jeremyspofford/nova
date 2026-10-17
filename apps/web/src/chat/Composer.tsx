// Composer (docs/04 §3, FR-018, FR-019, FR-021, FR-023, FR-024, FR-221): auto-growing input,
// Enter or Mod+Enter sends per `general.enterToSend`, Shift+Enter adds a line, attachments by
// button, drag-drop and paste with inline errors, the preset scale and model and reasoning
// pickers, and Send/Stop. While a reply runs the box stays usable: sending steers or queues per
// `general.followUp`, and Alt with the send key uses the other mode; queued messages wait in a
// strip above the box until their turn starts.
import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { REASONING_LEVELS, type InputMode, type ModelView } from '@nova/shared';
import { Button, Icon, IconButton, PresetScale, SelectField, Spinner } from '@nova/ui';
import type { Draft } from '../services.tsx';
import { bindingText } from '../keys.ts';
import { navigate } from '../router.ts';
import { checkFiles, formatBytes, toPending, type Rejection } from './attachments.ts';
import { modelGroups, type PresetStop } from './models.ts';

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
}: ComposerProps) {
  const own = useRef<HTMLTextAreaElement>(null);
  const textarea = inputRef ?? own;
  const fileInput = useRef<HTMLInputElement>(null);
  const canSend = (draft.text.trim().length > 0 || draft.attachments.length > 0) && !!model;

  useLayoutEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [draft.text, textarea]);

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
        onChange={(e) => onDraftChange({ ...draft, text: e.target.value })}
        onKeyDown={(e) => {
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
