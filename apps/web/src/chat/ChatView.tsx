// One chat (FR-017…FR-027, FR-221): loads the thread, follows its event stream, renders Markdown
// replies as they stream, and owns the composer. While a reply runs, new messages steer it or
// queue behind it (FR-019). Each message has actions (copy, edit, regenerate, branch, quote,
// delete) and a version navigator (FR-020); a branch shows the messages it inherits read-only.
// Find in chat marks matches in the rendered text (FR-025). A send never loses the user's input:
// on any failure the text and attachments go back into the composer with the reason.
// M3: replies show tool cards that update live and approval cards inline at the call that waits
// (FR-100); focus moves to a new approval and the announcer says so, and `?approval=<id>` scrolls
// to one. While an approval waits the chat shows Needs input (FR-215). Artifact cards open the
// Inspector (FR-038), and `@`-mentions go out with the message (FR-022).
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  EventEnvelope,
  InputMode,
  MentionCandidate,
  REASONING_LEVELS,
  ThreadDetail,
} from '@nova/shared';
import {
  Button,
  Dialog,
  EmptyState,
  Icon,
  Menu,
  Spinner,
  StatusChip,
  Switch,
  useToast,
  type MenuItem,
} from '@nova/ui';
import { ApiError, errorMessage } from '../api.ts';
import { isEditable } from '../hooks.ts';
import { chatPath, navigate } from '../router.ts';
import { useAnnounce, useServices, type Draft, type PendingAttachment } from '../services.tsx';
import { useSetting, useSettings } from '../settings.tsx';
import { modelLabel, useModels, useThreads } from '../stores.tsx';
import { readAsBase64 } from './attachments.ts';
import { Composer, useAttachmentIntake, type QueueItem } from './Composer.tsx';
import { FindBar } from './FindBar.tsx';
import { findMarks } from './find.tsx';
import { ApprovalCard } from './ApprovalCard.tsx';
import { MessageItem, type CallApproval, type MessageActions } from './MessageItem.tsx';
import { fallbackModel, presetStops } from './models.ts';
import { threadTitle } from './ThreadList.tsx';
import {
  awaitsUser,
  deletionIds,
  isStreaming,
  liveCallsByMessage,
  messageText,
  pendingApprovals,
  placeholder,
  type ClientApproval,
  type ClientMessage,
  type DisplayCall,
} from './thread-state.ts';
import { threadStatus } from './status.ts';
import { TOOL_STATUS_TEXT } from './ToolCard.tsx';
import { threadStateOf, useThreadFeed } from './useThreadFeed.ts';

const EMPTY_DRAFT: Draft = { text: '', attachments: [] };

/** Inspector panels a chat can ask the workspace to open. */
export type ChatPanel = 'side' | 'branches' | 'artifacts' | 'activity';

export interface ChatViewProps {
  threadId: string | null;
  /** Message to scroll to and highlight (from search). */
  messageId?: string | null;
  /** False while another mode or page is shown; the view stays mounted to keep its state. */
  active: boolean;
  /** A new chat that will be created as temporary (FR-027). */
  temporary?: boolean;
  /** Minimum gap between streaming progress announcements. */
  announceEveryMs?: number;
  /** Lets the app run "Stop generation", "Find in chat" and "Focus composer" on this view. */
  onControls?: (c: ChatControls | null) => void;
  onOpenPanel?: (panel: ChatPanel) => void;
  /** Approval to scroll to and focus (`/chat/<id>?approval=<approvalId>`). */
  approvalId?: string | null;
  /** Opens an artifact in the Inspector (FR-038). */
  onOpenArtifact?: (artifactId: string) => void;
}

export interface ChatControls {
  threadId: string | null;
  /** True for a temporary chat, which is deleted when the user leaves it (FR-027). */
  temporary: boolean;
  streaming: boolean;
  stop: () => void;
  focusComposer: () => void;
  openFind: () => void;
}

let tempSeq = 0;

export function ChatView({
  threadId,
  messageId,
  active,
  temporary = false,
  announceEveryMs = 4000,
  onControls,
  onOpenPanel,
  approvalId = null,
  onOpenArtifact,
}: ChatViewProps) {
  const { api, registry, memory, bus } = useServices();
  const threads = useThreads();
  const { models, presets } = useModels();
  const settings = useSettings();
  const enterToSend = useSetting('general.enterToSend').value;
  const defaultModel = useSetting('chat.defaultModel').value;
  const followUp = useSetting('general.followUp').value;
  const announce = useAnnounce();
  const toast = useToast();
  const known = threadId ? (threads.threads.find((t) => t.id === threadId) ?? null) : null;
  const progress = useRef({ last: 0, words: 0 });
  /** The approval card to focus, bumped when one appears or is asked for. */
  const [focusTarget, setFocusTarget] = useState<{ id: string; n: number } | null>(null);

  const onEvent = (env: EventEnvelope) => {
    const p = env.payload;
    // Panels showing this chat (artifacts, activity) follow the same events.
    if (env.name !== 'chat.delta' && env.name !== 'tool.call.progress') bus.emit(env);
    switch (env.name) {
      case 'turn.started':
        progress.current = { last: Date.now(), words: 0 };
        announce('Assistant is responding.');
        if (threadId) threads.upsertLocal({ id: threadId, state: 'streaming' });
        break;
      case 'turn.completed':
      case 'turn.interrupted':
        if (threadId) threads.upsertLocal({ id: threadId, state: 'idle' });
        break;
      case 'chat.delta':
        if (p.type === 'text_delta' && typeof p.text === 'string') {
          // Throttled progress for screen readers (docs/04 §4.4): never every token.
          const pr = progress.current;
          pr.words += p.text.split(/\s+/).filter(Boolean).length;
          const now = Date.now();
          if (now - pr.last >= announceEveryMs) {
            pr.last = now;
            announce(`Still responding, about ${pr.words} words so far.`);
          }
        }
        break;
      case 'chat.message.completed':
        if (p.status === 'complete') announce('Response complete.');
        else if (p.status === 'incomplete')
          announce('Response stopped. The partial reply is kept.');
        else if (p.status === 'error') announce('The response failed. Retry is available.');
        break;
      case 'chat.followup.started':
        announce('A queued message started.');
        break;
      case 'chat.branch.created':
        void threads.refresh();
        break;
      case 'thread.status.changed': {
        const ref = p.ref as { kind?: unknown; id?: unknown } | undefined;
        const next = threadStateOf(p.status);
        if (threadId && next && ref?.kind === 'thread' && ref.id === threadId)
          threads.upsertLocal({ id: threadId, state: next });
        break;
      }
      case 'tool.call.started':
        if (typeof p.tool === 'string' && p.tool) announce(`Running ${p.tool}.`);
        break;
      case 'tool.call.completed': {
        const st = p.status as keyof typeof TOOL_STATUS_TEXT;
        const name = typeof p.tool === 'string' && p.tool ? p.tool : 'The tool call';
        if (st in TOOL_STATUS_TEXT && st !== 'ok') announce(`${name}: ${TOOL_STATUS_TEXT[st]}.`);
        break;
      }
      case 'approval.requested': {
        if (typeof p.approvalId !== 'string') break;
        const what = typeof p.action === 'string' && p.action ? `: ${p.action}` : '';
        // Focus moves to the card (docs/04 §2.6) unless that would pull the user out of typing.
        const el = document.activeElement;
        const typing =
          isEditable(el) && !!(el as HTMLInputElement | HTMLTextAreaElement).value?.trim();
        if (typing) {
          announce(`Approval needed${what}. It is in the chat, above the message box.`);
        } else {
          announce(`Approval needed${what}.`);
          const aid = p.approvalId;
          setFocusTarget((f) => ({ id: aid, n: (f?.n ?? 0) + 1 }));
        }
        break;
      }
      default:
        break;
    }
  };

  const onLoaded = (detail: ThreadDetail, first: boolean) => {
    if (!threadId) return;
    if (!first) threads.upsertLocal(detail.thread);
    else if (detail.thread.unread)
      threads.update(threadId, { unread: false }).catch(() => undefined);
  };

  const { state, dispatch, refetch, refreshQueue, approvalsLoaded } = useThreadFeed(
    threadId,
    known,
    { onEvent, onLoaded },
  );
  const [draft, setDraftState] = useState<Draft>(
    () => memory.drafts.get(threadId ?? 'new') ?? EMPTY_DRAFT,
  );
  const [sendError, setSendError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [draftModel, setDraftModel] = useState<string | null>(null);
  const [draftReasoning, setDraftReasoning] = useState<ReasoningLevel | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ClientMessage | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const setDraft = useCallback(
    (d: Draft) => {
      memory.drafts.set(threadId ?? 'new', d);
      setDraftState(d);
    },
    [memory, threadId],
  );
  const intake = useAttachmentIntake(draft, setDraft);
  const streaming = isStreaming(state);
  const thread = state.thread;
  const isTemporary = thread ? thread.temporary : threadId === null && temporary;

  // ---- sending -----------------------------------------------------------------------------------

  const auto = fallbackModel(models, presets);
  const model = thread?.model ?? draftModel ?? defaultModel ?? auto?.ref ?? null;
  const reasoningLevel = thread?.reasoningLevel ?? draftReasoning;
  const stops = presetStops(models, presets);

  const restore = useCallback(
    (d: Draft, reason: string) => {
      // Put the text back unless the user already started typing something new.
      const current = memory.drafts.get(threadId ?? 'new') ?? EMPTY_DRAFT;
      if (!current.text && current.attachments.length === 0) setDraft(d);
      setSendError(reason);
    },
    [memory, setDraft, threadId],
  );

  const sendTo = useCallback(
    async (id: string, d: Draft, mode?: InputMode) => {
      const tempId = `local-${++tempSeq}`;
      dispatch({
        type: 'optimistic',
        message: {
          ...placeholder(tempId, id, 'user', null),
          parts: [
            ...(d.text ? [{ type: 'text' as const, text: d.text }] : []),
            ...d.attachments.map((a) => ({
              type: 'file' as const,
              attachmentId: '',
              name: a.name,
              mime: a.mime,
              size: a.size,
            })),
          ],
          ...(mode ? { expect: mode } : {}),
        },
      });
      stick.current = true;
      try {
        const res = await api.sendMessage(id, {
          text: d.text,
          attachments: d.attachments.length
            ? d.attachments.map((a) => ({ name: a.name, mime: a.mime, data: a.data }))
            : undefined,
          ...(mode ? { inputMode: mode } : {}),
          ...(d.mentions?.length
            ? { mentions: d.mentions.map(({ kind, ref }) => ({ kind, ref })) }
            : {}),
        });
        dispatch({ type: 'accepted', tempId, res });
        if (res.disposition === 'queued') {
          announce('Queued. It sends when the current reply finishes.');
          refreshQueue();
        } else if (res.disposition === 'steered') {
          announce('Sent. The running reply takes it into account at its next step.');
        } else {
          threads.upsertLocal({ id, state: 'streaming', updatedAt: new Date().toISOString() });
        }
      } catch (err) {
        dispatch({ type: 'send_failed', tempId });
        restore(
          d,
          err instanceof ApiError && err.status === 409
            ? 'A reply is still running in this chat. Stop it or wait, then send again. Your message is back in the box.'
            : `Message not sent: ${errorMessage(err)} Your message is back in the box.`,
        );
      }
    },
    [announce, api, dispatch, refreshQueue, restore, threads],
  );

  // A first message queued by "new chat" or onboarding is sent once this chat opens.
  useEffect(() => {
    if (!threadId) return;
    const queued = memory.pending.get(threadId);
    if (!queued) return;
    memory.pending.delete(threadId);
    // Sent exactly once when the chat opens; its optimistic bubble should render right away.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void sendTo(threadId, queued);
  }, [memory, sendTo, threadId]);

  const mentionSource = useCallback(
    (q: string): Promise<MentionCandidate[]> =>
      api.mentions(q, threadId ?? undefined).then((r) => r.items),
    [api, threadId],
  );

  const send = async (d: Draft, mode?: InputMode) => {
    setSendError(null);
    intake.clearErrors();
    setDraft(EMPTY_DRAFT);
    if (threadId) {
      await sendTo(threadId, d, mode);
      return;
    }
    try {
      const created = await api.createThread({
        mode: 'chat',
        title: titleFrom(d),
        model: model ?? undefined,
        reasoningLevel: draftReasoning ?? undefined,
        ...(temporary ? { temporary: true } : {}),
      });
      memory.pending.set(created.id, d);
      threads.upsertLocal(created);
      memory.drafts.delete('new');
      navigate(chatPath(created.id));
    } catch (err) {
      restore(d, `Could not start the chat: ${errorMessage(err)} Your message is back in the box.`);
    }
  };

  const stop = useCallback(() => {
    if (!threadId || stopping) return;
    setStopping(true);
    api
      .cancel(threadId)
      .then(
        () => refetch(),
        (err: unknown) => toast.show(`Could not stop: ${errorMessage(err)}`, { tone: 'error' }),
      )
      .finally(() => setStopping(false));
  }, [api, refetch, stopping, threadId, toast]);

  const cancelQueued = (queuedId: string) => {
    if (!threadId) return;
    api.cancelQueued(threadId, queuedId).then(
      () => {
        dispatch({ type: 'dequeued', queuedId });
        announce('Queued message cancelled.');
      },
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 404) {
          // It started (or was removed elsewhere) before the cancel arrived.
          dispatch({ type: 'dequeued', queuedId });
          toast.show('That message already started.', { tone: 'info' });
          refreshQueue();
          refetch();
        } else {
          toast.show(`Could not cancel the queued message: ${errorMessage(err)}`, {
            tone: 'error',
          });
        }
      },
    );
  };

  const retry = async (failed: ClientMessage) => {
    if (!threadId) return;
    const idx = state.messages.indexOf(failed);
    const lastUser = state.messages
      .slice(0, idx < 0 ? undefined : idx)
      .reverse()
      .find((m) => m.role === 'user');
    if (!lastUser) return;
    try {
      const attachments: PendingAttachment[] = [];
      for (const p of lastUser.parts) {
        if (p.type !== 'file' || !p.attachmentId) continue;
        const blob = await api.fetchAttachment(p.attachmentId);
        attachments.push({
          id: p.attachmentId,
          name: p.name,
          mime: p.mime,
          size: p.size,
          data: await readAsBase64(blob),
        });
      }
      await sendTo(threadId, { text: messageText(lastUser, undefined), attachments });
    } catch (err) {
      toast.show(`Retry failed: ${errorMessage(err)}`, { tone: 'error' });
    }
  };

  const changeModel = (ref: string) => {
    if (!threadId || !thread) {
      setDraftModel(ref);
      return;
    }
    const before = thread;
    dispatch({ type: 'thread', thread: { ...thread, model: ref } });
    threads.update(threadId, { model: ref }).then(
      (view) => dispatch({ type: 'thread', thread: view }),
      (err: unknown) => {
        dispatch({ type: 'thread', thread: before });
        toast.show(`Could not change the model: ${errorMessage(err)}`, { tone: 'error' });
      },
    );
  };

  const changeReasoning = (level: ReasoningLevel) => {
    if (!threadId || !thread) {
      setDraftReasoning(level);
      return;
    }
    dispatch({ type: 'thread', thread: { ...thread, reasoningLevel: level } });
    threads.update(threadId, { reasoningLevel: level }).then(
      (view) => dispatch({ type: 'thread', thread: view }),
      (err: unknown) =>
        toast.show(`Could not change the reasoning level: ${errorMessage(err)}`, { tone: 'error' }),
    );
  };

  const toggleMemory = () => {
    if (!threadId || !thread) return;
    const before = thread;
    const optOut = !thread.memoryOptOut;
    dispatch({ type: 'thread', thread: { ...thread, memoryOptOut: optOut } });
    threads.update(threadId, { memoryOptOut: optOut }).then(
      (view) => {
        dispatch({ type: 'thread', thread: view });
        toast.show(
          optOut ? 'This chat will not be used for memory.' : 'This chat can be used for memory.',
          { tone: 'success' },
        );
      },
      (err: unknown) => {
        dispatch({ type: 'thread', thread: before });
        toast.show(`Could not change memory use: ${errorMessage(err)}`, { tone: 'error' });
      },
    );
  };

  // ---- message actions (FR-020) ------------------------------------------------------------------

  const markStreaming = () => {
    stick.current = true;
    if (threadId)
      threads.upsertLocal({
        id: threadId,
        state: 'streaming',
        updatedAt: new Date().toISOString(),
      });
    refetch();
  };

  const copy = (text: string) => {
    const clip = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (!clip) {
      toast.show('Could not copy: the clipboard is not available here.', { tone: 'error' });
      return;
    }
    clip.writeText(text).then(
      () => toast.show('Copied.', { tone: 'success' }),
      () => toast.show('Could not copy: the browser blocked clipboard access.', { tone: 'error' }),
    );
  };

  const quote = (m: ClientMessage, text: string) => {
    // Quote the selected part of this message when there is one, else the whole message.
    const sel = window.getSelection?.();
    const article = document.getElementById(`msg-${m.id}`);
    const picked =
      sel && !sel.isCollapsed && article?.contains(sel.anchorNode) ? sel.toString() : '';
    const quoted = (picked.trim() || text.trim())
      .split('\n')
      .map((l) => (l ? `> ${l}` : '>'))
      .join('\n');
    const before = draft.text.replace(/\s+$/, '');
    const next = before ? `${before}\n\n${quoted}\n\n` : `${quoted}\n\n`;
    setDraft({ ...draft, text: next });
    queueMicrotask(() => {
      const el = input.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.length, next.length);
    });
  };

  const edit = async (m: ClientMessage, text: string): Promise<string | null> => {
    if (!threadId) return 'This chat is not saved yet.';
    try {
      const res = await api.editMessage(threadId, m.id, { text });
      const add: ClientMessage[] = [
        placeholder(res.userMessageId, threadId, 'user', res.turnId, {
          parts: [{ type: 'text', text }],
          parentId: m.parentId ?? null,
        }),
      ];
      if (res.assistantMessageId)
        add.push(placeholder(res.assistantMessageId, threadId, 'assistant', res.turnId));
      dispatch({ type: 'rewound', fromId: m.id, add });
      markStreaming();
      return null;
    } catch (err) {
      return err instanceof ApiError && err.status === 409
        ? 'A reply is still running. Wait for it to finish, then save again.'
        : `Could not save the edit: ${errorMessage(err)}`;
    }
  };

  const regenerate = async (m: ClientMessage, withModel?: string) => {
    if (!threadId) return;
    try {
      const res = await api.regenerate(threadId, m.id, withModel ? { model: withModel } : {});
      dispatch({
        type: 'rewound',
        fromId: m.id,
        add: res.assistantMessageId
          ? [
              placeholder(res.assistantMessageId, threadId, 'assistant', res.turnId, {
                model: withModel ?? null,
              }),
            ]
          : [],
      });
      markStreaming();
    } catch (err) {
      toast.show(`Could not regenerate: ${errorMessage(err)}`, { tone: 'error' });
    }
  };

  const branchFrom = async (m: ClientMessage) => {
    if (!threadId) return;
    try {
      const view = await api.branch(threadId, m.id);
      threads.upsertLocal(view);
      toast.show('Branch created.', { tone: 'success' });
      navigate(chatPath(view.id));
    } catch (err) {
      toast.show(`Could not branch: ${errorMessage(err)}`, { tone: 'error' });
    }
  };

  const remove = async (m: ClientMessage) => {
    if (!threadId) return;
    try {
      await api.deleteMessage(threadId, m.id);
      dispatch({ type: 'removed', ids: deletionIds(state.messages, m.id) });
      toast.show('Message deleted.', { tone: 'success' });
      refetch();
    } catch (err) {
      toast.show(`Could not delete the message: ${errorMessage(err)}`, { tone: 'error' });
    }
  };

  const selectVersion = (id: string) => {
    if (!threadId) return;
    api.selectVersion(threadId, id).then(
      (detail) => dispatch({ type: 'loaded', detail }),
      (err: unknown) =>
        toast.show(`Could not switch versions: ${errorMessage(err)}`, { tone: 'error' }),
    );
  };

  const regenerateModels = models
    .filter((m) => !m.disabledReason)
    .map((m) => ({ ref: m.ref, label: m.label }));

  const actionsFor = (m: ClientMessage, inherited: boolean): MessageActions => {
    const base: MessageActions = {
      onCopy: copy,
      onQuote: (text) => quote(m, text),
    };
    if (inherited || !threadId) return base;
    return {
      ...base,
      onEdit: m.role === 'user' ? (text) => edit(m, text) : undefined,
      onRegenerate:
        m.role === 'assistant' ? (withModel) => void regenerate(m, withModel) : undefined,
      regenerateModels,
      onBranch: () => void branchFrom(m),
      onDelete: () => setConfirmDelete(m),
      onSelectVersion: selectVersion,
    };
  };

  // ---- find in chat (FR-025) ---------------------------------------------------------------------

  const [find, setFind] = useState({ open: false, query: '', index: 0 });
  const [findCount, setFindCount] = useState(0);
  const findInput = useRef<HTMLInputElement>(null);
  const findOpener = useRef<HTMLElement | null>(null);

  const openFind = useCallback(() => {
    const field = findInput.current;
    if (field) {
      field.focus();
      field.select();
      return;
    }
    findOpener.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setFind((f) => ({ ...f, open: true, index: 0 }));
  }, []);

  useEffect(() => {
    if (!find.open) return;
    findInput.current?.focus();
    findInput.current?.select();
  }, [find.open]);

  const closeFind = () => {
    setFind((f) => ({ ...f, open: false }));
    const back = findOpener.current;
    findOpener.current = null;
    queueMicrotask(() => {
      if (back?.isConnected) back.focus();
      else input.current?.focus();
    });
  };

  // Count the rendered matches and mark the current one; replies stream, so matches move. The
  // count is measured from the DOM, so it is set here and only when it changes.
  useLayoutEffect(() => {
    const marks = find.open ? findMarks(log.current) : [];
    const current = marks.length ? Math.min(find.index, marks.length - 1) : -1;
    marks.forEach((el, i) => {
      if (i === current) el.setAttribute('data-current', 'true');
      else el.removeAttribute('data-current');
    });
    if (marks.length !== findCount) setFindCount(marks.length);
  }, [find.open, find.query, find.index, findCount, state.messages, state.streamed]);

  useEffect(() => {
    if (!find.open || !find.query.trim()) return;
    const marks = findMarks(log.current);
    const el = marks[Math.min(find.index, marks.length - 1)];
    if (!el) return;
    stick.current = false;
    el.scrollIntoView?.({ block: 'center' });
  }, [find.open, find.query, find.index, findCount]);

  const step = (by: number) => {
    if (findCount === 0) return;
    setFind((f) => ({
      ...f,
      index: (Math.min(f.index, findCount - 1) + by + findCount) % findCount,
    }));
  };

  // ---- controls for global commands --------------------------------------------------------------

  const focusComposer = useCallback(() => input.current?.focus(), []);
  useEffect(() => {
    if (!active || !onControls) return;
    onControls({ threadId, temporary: isTemporary, streaming, stop, focusComposer, openFind });
  }, [active, onControls, threadId, isTemporary, streaming, stop, focusComposer, openFind]);
  useEffect(() => {
    if (!onControls) return;
    return () => onControls(null);
  }, [onControls]);

  // ---- scrolling ---------------------------------------------------------------------------------

  const scrollKey = threadId ?? 'new';
  useLayoutEffect(() => {
    const el = log.current;
    if (!el || !active) return;
    const saved = memory.scroll.get(scrollKey);
    if (saved !== undefined) el.scrollTop = saved;
  }, [active, memory, scrollKey]);

  const lastText = state.messages.length
    ? (state.streamed[state.messages.at(-1)!.id]?.length ?? 0)
    : 0;
  useLayoutEffect(() => {
    const el = log.current;
    if (el && active && stick.current) el.scrollTop = el.scrollHeight;
  }, [active, state.messages.length, lastText]);

  useEffect(() => {
    if (!messageId || state.status !== 'ready') return;
    const el = document.getElementById(`msg-${messageId}`);
    if (!el) return;
    stick.current = false;
    el.scrollIntoView?.({ block: 'center' });
    el.focus();
    const on = setTimeout(() => setHighlight(messageId), 0);
    const off = setTimeout(() => setHighlight(null), 2500);
    return () => {
      clearTimeout(on);
      clearTimeout(off);
    };
  }, [messageId, state.status]);

  // ---- approvals (FR-100, FR-215) ---------------------------------------------------------------

  const pending = pendingApprovals(state);
  const needsInput = pending.length > 0;

  // The thread list shows Needs input while an approval waits, and the live state after.
  const sync = useRef({ threads, streaming, waiting: false });
  useLayoutEffect(() => {
    sync.current = { ...sync.current, threads, streaming };
  });
  useEffect(() => {
    if (!threadId) return;
    const s = sync.current;
    if (needsInput) {
      s.waiting = true;
      s.threads.upsertLocal({ id: threadId, state: 'waiting_approval' });
    } else if (s.waiting) {
      s.waiting = false;
      s.threads.upsertLocal({ id: threadId, state: s.streaming ? 'streaming' : 'idle' });
    }
  }, [needsInput, threadId]);

  // `?approval=<id>`: focus that card; fetch it when this chat's list does not have it.
  const linkedHere = !!approvalId && !!state.approvals[approvalId];
  const linkChecked = useRef<string | null>(null);
  useEffect(() => {
    if (!approvalId || !threadId || linkedHere || !approvalsLoaded) return;
    if (linkChecked.current === approvalId) return;
    linkChecked.current = approvalId;
    api.getApproval(approvalId).then(
      (view) => {
        if (view.threadId && view.threadId !== threadId) {
          navigate(`${chatPath(view.threadId)}?approval=${encodeURIComponent(view.id)}`, {
            replace: true,
          });
        } else if (view.status === 'pending') {
          dispatch({ type: 'approvals', items: [view] });
        } else {
          toast.show('That approval was already answered.', { tone: 'info' });
        }
      },
      () => toast.show('That approval no longer exists.', { tone: 'info' }),
    );
  }, [api, approvalId, approvalsLoaded, dispatch, linkedHere, threadId, toast]);

  const focusKeyFor = (id: string) =>
    (focusTarget?.id === id ? focusTarget.n : 0) + (approvalId === id ? 1 : 0);

  const approvalCard = (a: ClientApproval) => (
    <ApprovalCard
      key={a.id}
      approval={a}
      focusKey={focusKeyFor(a.id)}
      onChange={(view) => dispatch({ type: 'approvals', items: [view] })}
    />
  );

  const liveByMessage = liveCallsByMessage(state);
  const approvalByCall = new Map<string, ClientApproval>();
  for (const a of Object.values(state.approvals)) {
    if (!a.callId) continue;
    const prev = approvalByCall.get(a.callId);
    if (!prev || prev.createdAt <= a.createdAt) approvalByCall.set(a.callId, a);
  }
  const approvalFor = (call: DisplayCall): CallApproval | null => {
    const a =
      (call.approvalId ? state.approvals[call.approvalId] : undefined) ??
      approvalByCall.get(call.callId);
    if (!a) return null;
    return { node: approvalCard(a), status: awaitsUser(a) ? 'awaiting_approval' : undefined };
  };

  // ---- render ------------------------------------------------------------------------------------

  const title =
    thread?.title || (threadId ? 'Untitled chat' : isTemporary ? 'New temporary chat' : 'New chat');
  const status = thread ? (needsInput ? 'needs_input' : threadStatus(thread, streaming)) : null;
  const noModel = models.length === 0;
  const shown = state.messages.filter((m) => m.expect !== 'queue');
  // Approvals whose call is not on screen (no part or live call yet) still get a card.
  const shownCalls = new Set<string>();
  for (const m of shown) {
    for (const p of m.parts) if (p.type === 'tool_call') shownCalls.add(p.callId);
    for (const c of liveByMessage.get(m.id) ?? []) shownCalls.add(c.callId);
  }
  const orphans = pending.filter((a) => !a.callId || !shownCalls.has(a.callId));
  const queue: QueueItem[] = [
    ...state.queue.map((q) => ({ id: q.id, text: q.text, attachmentCount: q.attachmentCount })),
    ...state.messages
      .filter((m) => m.expect === 'queue')
      .map((m) => ({
        id: m.id,
        text: messageText(m, undefined),
        attachmentCount: m.parts.filter((p) => p.type === 'file').length,
        pending: true,
      })),
  ];
  const titleOf = (id: string) => {
    const t = threads.threads.find((x) => x.id === id);
    return t ? threadTitle(t) : 'the original chat';
  };
  const findQuery = find.open ? find.query : '';

  const menu: MenuItem[] = thread
    ? [
        { id: 'find', label: 'Find in chat', onSelect: openFind },
        ...(onOpenPanel
          ? [
              { id: 'side', label: 'Ask in a side chat', onSelect: () => onOpenPanel('side') },
              { id: 'branches', label: 'Show branches', onSelect: () => onOpenPanel('branches') },
              {
                id: 'artifacts',
                label: 'Show artifacts',
                onSelect: () => onOpenPanel('artifacts'),
              },
              { id: 'activity', label: 'Show activity', onSelect: () => onOpenPanel('activity') },
            ]
          : []),
        ...(thread.temporary
          ? []
          : [
              {
                id: 'memory',
                label: "Don't use for memory",
                checked: thread.memoryOptOut,
                onSelect: toggleMemory,
              },
            ]),
      ]
    : [];

  return (
    <section
      className="chat"
      aria-label={title}
      data-chat-view
      data-temporary={isTemporary || undefined}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault();
      }}
      onDrop={(e) => {
        const files = [...e.dataTransfer.files];
        if (!files.length) return;
        e.preventDefault();
        void intake.addFiles(files);
      }}
    >
      <header className="chat-header">
        <h1 className="chat-title">{title}</h1>
        {status ? <StatusChip status={status} /> : null}
        {thread?.parentThreadId && !thread.side ? (
          <span className="chat-flag">
            <Icon name="branch" /> Branch
          </span>
        ) : null}
        {thread?.memoryOptOut && !thread.temporary ? (
          <span className="chat-flag">Not used for memory</span>
        ) : null}
        <span className="chat-header-spacer" />
        {thread?.model ? (
          <span className="muted chat-model">{modelLabel(models, thread.model)}</span>
        ) : null}
        {!threadId ? (
          <span className="chat-temp-toggle">
            <Switch
              id="temporary-switch"
              label="Temporary chat"
              checked={temporary}
              onChange={(on) => navigate(on ? '/chat?temporary=1' : '/chat')}
            />
            <label htmlFor="temporary-switch">Temporary</label>
          </span>
        ) : null}
        {menu.length ? (
          <Menu label="Chat options" trigger={<Icon name="more" />} items={menu} />
        ) : null}
      </header>
      {isTemporary ? (
        <p className="temp-banner" role="note">
          <Icon name="clock" /> Temporary chat: not saved to memory or search, deleted when you
          leave
        </p>
      ) : null}
      {find.open ? (
        <FindBar
          query={find.query}
          onQuery={(q) => setFind((f) => ({ ...f, query: q, index: 0 }))}
          count={findCount}
          index={Math.min(find.index, Math.max(0, findCount - 1))}
          onNext={() => step(1)}
          onPrevious={() => step(-1)}
          onClose={closeFind}
          inputRef={findInput}
        />
      ) : null}
      <div
        ref={log}
        className="chat-log"
        role="log"
        aria-label="Messages"
        aria-live="off"
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget;
          memory.scroll.set(scrollKey, el.scrollTop);
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
      >
        {state.status === 'loading' ? (
          <p className="muted chat-loading">
            <Spinner label="Loading messages" /> Loading messages…
          </p>
        ) : null}
        {state.status === 'error' ? (
          <div className="chat-error" role="alert">
            <p>{state.loadError}</p>
            <Button onClick={() => navigate(chatPath(null))}>Start a new chat</Button>
          </div>
        ) : null}
        {state.status === 'ready' && shown.length === 0 ? (
          <EmptyState
            title={threadId ? 'No messages yet' : 'Start a conversation'}
            description={
              noModel
                ? 'Connect a model provider in Settings → Accounts to start chatting.'
                : 'Ask a question, paste text to work on, or attach a file.'
            }
            icon="chat"
            action={
              noModel ? (
                <Button onClick={() => navigate('/settings/accounts')}>Connect a provider</Button>
              ) : undefined
            }
          />
        ) : null}
        {shown.map((m, i) => {
          const inherited = !!thread && !m.local && m.threadId !== thread.id;
          const prev = shown[i - 1];
          const prevInherited = !!prev && !!thread && !prev.local && prev.threadId !== thread.id;
          return (
            <Fragment key={m.id}>
              {inherited && (!prev || prev.threadId !== m.threadId) ? (
                <p className="msg-divider">
                  <Icon name="branch" /> From{' '}
                  <a
                    href={chatPath(m.threadId, m.id)}
                    onClick={(e) => {
                      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                      e.preventDefault();
                      navigate(chatPath(m.threadId, m.id));
                    }}
                  >
                    {titleOf(m.threadId)}
                  </a>
                  <span className="muted"> (read-only here)</span>
                </p>
              ) : null}
              {!inherited && prevInherited ? (
                <p className="msg-divider">This branch continues here</p>
              ) : null}
              <MessageItem
                message={m}
                streamed={state.streamed[m.id]}
                reasoning={state.reasoning[m.id]}
                highlighted={highlight === m.id}
                attachmentUrl={api.attachmentUrl}
                onRetry={inherited ? undefined : () => void retry(m)}
                retryDisabled={streaming}
                modelName={m.model ? modelLabel(models, m.model) : null}
                find={findQuery}
                actions={actionsFor(m, inherited)}
                busy={streaming}
                liveCalls={liveByMessage.get(m.id)}
                approvalFor={approvalFor}
                onOpenArtifact={onOpenArtifact}
              />
            </Fragment>
          );
        })}
        {orphans.length ? (
          <div className="approval-orphans">{orphans.map(approvalCard)}</div>
        ) : null}
      </div>
      {needsInput ? (
        <p className="approval-pending" role="note">
          <Icon name="hand" />{' '}
          {pending.length === 1
            ? 'An approval is waiting for you.'
            : `${pending.length} approvals are waiting for you.`}{' '}
          <button
            type="button"
            className="link"
            onClick={() => {
              const first = pending[0];
              if (first) setFocusTarget((f) => ({ id: first.id, n: (f?.n ?? 0) + 1 }));
            }}
          >
            Go to {pending.length === 1 ? 'it' : 'the first'}
          </button>
        </p>
      ) : null}
      <Composer
        draft={draft}
        onDraftChange={(d) => {
          setDraft(d);
          if (sendError) setSendError(null);
        }}
        onSend={(d, mode) => void send(d, mode)}
        onStop={stop}
        streaming={streaming}
        stopping={stopping}
        followUp={followUp}
        queue={queue}
        onCancelQueued={cancelQueued}
        presets={stops}
        enterToSend={enterToSend}
        mac={registry.platform.mac}
        sendError={sendError}
        attachmentErrors={intake.errors}
        onAddFiles={(f) => void intake.addFiles(f)}
        onDismissAttachmentErrors={intake.clearErrors}
        models={models}
        model={model}
        onModelChange={changeModel}
        reasoningLevel={reasoningLevel}
        onReasoningChange={changeReasoning}
        inputRef={input}
        noModelHint={noModel ? 'Connect a model provider to start' : undefined}
        mentionSource={mentionSource}
      />
      {!threadId && defaultModel === null && auto && model === auto.ref ? (
        <p className="muted composer-note">
          Using {auto.label}.{' '}
          <button
            type="button"
            className="link"
            onClick={() => {
              settings.set('chat.defaultModel', auto.ref).catch(() => undefined);
            }}
          >
            Make it the default
          </button>
        </p>
      ) : null}
      <Dialog
        open={confirmDelete !== null}
        title="Delete this message?"
        description={
          confirmDelete?.role === 'user'
            ? 'The message and the reply to it leave this chat, the model’s context and search.'
            : 'The reply leaves this chat, the model’s context and search.'
        }
        onClose={() => setConfirmDelete(null)}
        fallbackFocus={() => input.current}
        footer={
          <>
            <Button onClick={() => setConfirmDelete(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                const m = confirmDelete;
                setConfirmDelete(null);
                if (m) void remove(m);
              }}
            >
              Delete
            </Button>
          </>
        }
      />
    </section>
  );
}

type ReasoningLevel = (typeof REASONING_LEVELS)[number];

function titleFrom(d: Draft): string | undefined {
  const line = d.text.trim().split('\n')[0]?.trim() ?? '';
  if (line) return line.length > 60 ? `${line.slice(0, 57)}…` : line;
  return d.attachments[0]?.name;
}
