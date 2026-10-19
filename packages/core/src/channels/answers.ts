// Approvals in a channel (FR-100, docs/13 §4): the prompt posted when a channel turn waits for an
// approval, and the replies that answer it. The decisions are the card's own (allow once, allow
// for the session, deny and continue, deny and stop); "Always allow" and hand-off need the full
// card in a Nova client. `confirm_at_action` and `handoff_required` approvals are never answered
// from a channel (FR-189); their prompt says to open Nova. Neither is a Hub-only card
// (`answerIn: 'hub'`, M7.5: firmware, boot, out-of-band, decommission; docs/23 §6.3), whatever its
// tier: every channel path refuses it with `hub_only`.
import type {
  ApprovalAnswerIn,
  ApprovalDecisionKind,
  ApprovalView,
  ConfirmationTier,
} from '@nova/shared';

export type ChannelDecision = Extract<
  ApprovalDecisionKind,
  'allow_once' | 'allow_session' | 'deny_continue' | 'deny_stop'
>;

export interface ChannelAnswer {
  decision: ChannelDecision;
  /** The approval's short code, when the reply named one. */
  code: string | null;
  reason: string | null;
}

/** The short code a channel reply names an approval by: the end of its id (the random part). */
export function approvalCode(approvalId: string): string {
  return approvalId.replace(/-/g, '').slice(-6).toLowerCase();
}

const ANSWER =
  /^\s*(allow|approve|deny|reject)(?:\s+(once|session|for\s+(?:this\s+)?session|and\s+stop|stop))?(?:\s+#?([0-9a-f]{4,12}))?(?:\s*[:-]\s*(.{1,500}))?\s*$/i;

/** A reply that answers an approval, or null for any other message. */
export function parseAnswer(text: string): ChannelAnswer | null {
  const m = ANSWER.exec(text);
  if (!m) return null;
  const verb = m[1]!.toLowerCase();
  const mod = (m[2] ?? '').toLowerCase().replace(/\s+/g, ' ');
  const allow = verb === 'allow' || verb === 'approve';
  let decision: ChannelDecision;
  if (allow) {
    if (mod.includes('stop')) return null;
    decision = mod.includes('session') ? 'allow_session' : 'allow_once';
  } else {
    if (mod.includes('session') || mod === 'once') return null;
    decision = mod.includes('stop') ? 'deny_stop' : 'deny_continue';
  }
  return { decision, code: m[3]?.toLowerCase() ?? null, reason: m[4]?.trim() || null };
}

/**
 * Only pre-approvable approvals can be answered from a channel (docs/13 §4, FR-189), and never a
 * Hub-only one.
 */
export function answerableFromChannel(
  tier: ConfirmationTier,
  answerIn: ApprovalAnswerIn | null = null,
): boolean {
  return answerIn !== 'hub' && tier === 'pre_approvable';
}

/** What a channel says about a Hub-only card (prompt and refusal). */
export const HUB_ONLY_TEXT =
  'This one can only be answered in Nova itself: open the web or desktop app to decide.';

const LABELS: Partial<Record<ApprovalDecisionKind, string>> = {
  allow_once: 'allow',
  allow_session: 'allow session',
  deny_continue: 'deny',
  deny_stop: 'deny and stop',
};

/**
 * The message posted to the channel for a pending approval. In a shared conversation the action
 * and its reason stay in Nova (they can name private files, hosts or people); only the code is
 * posted.
 */
export function approvalPrompt(
  a: Pick<ApprovalView, 'id' | 'action' | 'reason' | 'tier' | 'options' | 'answerIn'>,
  opts: { shared?: boolean } = {},
): string {
  const code = approvalCode(a.id);
  const head = opts.shared
    ? `Approval needed for an action (${code}); the details are in Nova.`
    : `Approval needed: ${a.action}`;
  const why = a.reason && !opts.shared ? `\n${a.reason}` : '';
  if (a.answerIn === 'hub') return `${head}${why}\n${HUB_ONLY_TEXT}`;
  if (!answerableFromChannel(a.tier))
    return `${head}${why}\nThis one can only be answered in Nova: open the app to decide.`;
  const replies = a.options
    .map((o) => LABELS[o])
    .filter((l): l is string => !!l)
    .map((l) => `"${l} ${code}"`);
  return `${head}${why}\nReply ${replies.join(', ')}.`;
}

/**
 * The approval email's text (the adapter adds the signed link when there is one). Without a link
 * (a shared conversation, a sender who is not the owner) it says to open Nova.
 */
export function approvalEmailText(
  a: Pick<ApprovalView, 'id' | 'action' | 'reason' | 'answerIn'>,
  opts: { shared?: boolean; link: boolean },
): string {
  const code = approvalCode(a.id);
  const head = opts.shared
    ? `Approval needed for an action (${code}); the details are in Nova.`
    : `Approval needed: ${a.action}`;
  const why = a.reason && !opts.shared ? `\n${a.reason}` : '';
  if (a.answerIn === 'hub') return `${head}${why}\n${HUB_ONLY_TEXT}`;
  return opts.link
    ? `${head}${why}`
    : `${head}${why}\nThis one can only be answered in Nova: open the app to decide.`;
}

export function answeredText(decision: ChannelDecision): string {
  switch (decision) {
    case 'allow_once':
      return 'Allowed once.';
    case 'allow_session':
      return 'Allowed for this session.';
    case 'deny_continue':
      return 'Denied.';
    case 'deny_stop':
      return 'Denied; the agent stops.';
  }
}
