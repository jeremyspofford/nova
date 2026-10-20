// Temporary chats (FR-027) are deleted when the user leaves them: opening another chat or a new
// one deletes the one left behind, asking first only when a reply was still streaming (the
// navigation has already happened, so "Go back" returns to it). Closing the tab deletes it on a
// best-effort basis; the Hub's `chat.temporaryTtlHours` sweeper removes anything left over.
import { useCallback, useEffect, useRef, useState } from 'react';
import { defineMessages } from '@nova/i18n';
import { Button, Dialog, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { chatPath, navigate } from '../router.ts';
import { useServices } from '../services.tsx';
import { useThreads } from '../stores.tsx';

export const TEMPORARY_TEXT = defineMessages('chat.temporary', {
  deleteFailed: 'Could not delete the temporary chat: {reason} It is removed automatically later.',
  confirmTitle: 'Delete the temporary chat?',
  confirmBody:
    'A reply was still streaming when you left it. Deleting stops the reply and removes the chat.',
  goBack: 'Go back to it',
  delete: 'Delete chat',
});

export interface TemporaryReport {
  threadId: string | null;
  temporary: boolean;
  streaming: boolean;
}

export function useTemporaryChats(currentId: string | null) {
  const { api } = useServices();
  const threads = useThreads();
  const toast = useToast();
  // Temporary chats seen in this session, with whether a reply was streaming when last reported.
  const seen = useRef(new Map<string, boolean>());
  const [confirm, setConfirm] = useState<string | null>(null);

  const report = useCallback((c: TemporaryReport | null) => {
    if (!c?.threadId) return;
    if (c.temporary) seen.current.set(c.threadId, c.streaming);
    else seen.current.delete(c.threadId);
  }, []);

  const discard = useCallback(
    (id: string, stopFirst = false) => {
      const stopped = stopFirst ? api.cancel(id).catch(() => undefined) : Promise.resolve();
      void stopped
        .then(() => threads.remove(id))
        .catch((err: unknown) =>
          toast.show(TEMPORARY_TEXT.deleteFailed({ reason: errorMessage(err) }), {
            tone: 'error',
          }),
        );
    },
    [api, threads, toast],
  );
  const discardRef = useRef(discard);
  useEffect(() => {
    discardRef.current = discard;
  });

  useEffect(() => {
    for (const [id, streaming] of [...seen.current]) {
      if (id === currentId) continue;
      seen.current.delete(id);
      // The prompt appears only after the user already left (see the header comment).
      if (streaming) setConfirm(id);
      else discardRef.current(id);
    }
  }, [currentId]);

  useEffect(() => {
    const streamingNow = () => currentId !== null && seen.current.get(currentId) === true;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (streamingNow()) e.preventDefault();
    };
    const onPageHide = () => {
      if (currentId !== null && seen.current.has(currentId))
        api.deleteThread(currentId).catch(() => undefined);
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [api, currentId]);

  const goBack = () => {
    const id = confirm;
    setConfirm(null);
    if (id) navigate(chatPath(id));
  };

  const dialog = (
    <Dialog
      open={confirm !== null}
      title={TEMPORARY_TEXT.confirmTitle}
      description={TEMPORARY_TEXT.confirmBody}
      onClose={goBack}
      footer={
        <>
          <Button onClick={goBack}>{TEMPORARY_TEXT.goBack}</Button>
          <Button
            variant="danger"
            onClick={() => {
              const id = confirm;
              setConfirm(null);
              if (id) discard(id, true);
            }}
          >
            {TEMPORARY_TEXT.delete}
          </Button>
        </>
      }
    />
  );

  return { report, dialog };
}
