// What quick chat and attach window send (FR-008, FR-214): a message to the chat open in the last
// used window, or to a new chat. Window captures go as two attachments, the image and the text,
// with the user's note (or a plain line naming the window) as the message.
import type { ShellCaptureAttachRequest, ShellQuickSendRequest } from '@nova/shared';
import { draftAttachments, type CaptureDraft } from './capture/index.ts';
import type { HubClient } from './hub-client.ts';
import { CAPTURE_TEXT } from './text.ts';

export interface SentView {
  threadId: string;
  path: string;
  disposition: string;
}

async function targetThread(
  client: HubClient,
  target: 'current' | 'new',
  currentThreadId: string | null,
): Promise<string> {
  if (target === 'current' && currentThreadId) return currentThreadId;
  return (await client.createThread()).id;
}

export async function quickSend(
  client: HubClient,
  req: ShellQuickSendRequest,
  currentThreadId: string | null,
): Promise<SentView> {
  const threadId = await targetThread(client, req.target, currentThreadId);
  const res = await client.send(threadId, { text: req.text });
  return { threadId, path: `/chat/${encodeURIComponent(threadId)}`, disposition: res.disposition };
}

export async function sendCapture(
  client: HubClient,
  draft: CaptureDraft,
  req: ShellCaptureAttachRequest,
  currentThreadId: string | null,
): Promise<SentView> {
  const attachments = draftAttachments(draft, { image: req.includeImage, text: req.includeText });
  if (attachments.length === 0) throw new Error(CAPTURE_TEXT.nothingLeft);
  const threadId = await targetThread(client, req.target, currentThreadId);
  const note = req.note.trim();
  const res = await client.send(threadId, {
    text: note || CAPTURE_TEXT.attachedWindow({ title: draft.windowTitle || draft.appName }),
    attachments,
  });
  return { threadId, path: `/chat/${encodeURIComponent(threadId)}`, disposition: res.disposition };
}

/** A sender is one of the shell's own pages: a file under its renderer folder. */
export function isLocalSender(frameUrl: string, rendererDirUrl: string): boolean {
  const base = rendererDirUrl.endsWith('/') ? rendererDirUrl : `${rendererDirUrl}/`;
  try {
    const u = new URL(frameUrl);
    return u.protocol === 'file:' && u.href.startsWith(base);
  } catch {
    return false;
  }
}

/**
 * A sender is the Hub's web UI: the top frame of a Hub window whose real origin is the Hub's. The
 * frame's origin, not its URL: a document the Hub serves sandboxed (a site preview, an app UI)
 * has the Hub's URL but the opaque origin "null".
 */
export function isHubSender(
  frameOrigin: string,
  hubOrigin: string | null,
  topFrame: boolean,
): boolean {
  return topFrame && hubOrigin !== null && frameOrigin !== 'null' && frameOrigin === hubOrigin;
}
