// The local browser fallback's offer in a conversation (FR-209, docs/11 §4.6): when a site blocks
// an agent's own browser and the agent has a connected computer, the Hub asks the user through
// the request broker, a `user_input` request with fixed choices (ADR-096: continue on the computer
// with a clean profile, in the user's own browser through the extension when the bridge can serve
// the site, or not now), marked by its payload's `context` (`kind: 'browser.fallback'`, the site,
// the computer, the cause and the choices by id). The request is correlated with the browser call
// that was refused, so the
// chat's question card (which follows `ask_user` calls) and the thread's standalone questions (no
// call behind them) both pass it by; `FallbackOffers` shows a thread's pending offers above the
// composer, each choice with what it means. Only the signed-in user answers; the first answer wins
// on any device. The question is the Hub's text, shown as plain text. Focus never lands on an
// answer button by itself.
import { useEffect, useId, useState } from 'react';
import type { ServerRequestView } from '@nova/shared';
import { Button, Icon, StatusChip, useToast } from '@nova/ui';
import { ApiError } from '../api.ts';
import { useServices } from '../services.tsx';
import { useHubEvents } from '../spaces/events.ts';
import { useDebounced } from '../work/events.ts';
import { followLink } from '../work/nav.tsx';
import { REQUEST_EVENTS } from './events.ts';
import {
  CAUSE_TEXT,
  SETTINGS_BROWSER_PATH,
  browserDeviceError,
  parseFallbackOffer,
  stampOf,
  type FallbackChoiceId,
  type FallbackOffer,
} from './format.ts';
import './browserdevice.css';

/** Whether a request is the fallback's offer (and still waits for an answer). */
export function isFallbackOffer(r: ServerRequestView): boolean {
  return r.status === 'pending' && parseFallbackOffer(r) !== null;
}

/** What each choice does, in words (the Hub's choice text stays the button's name). */
export function choiceHints(
  o: Pick<FallbackOffer, 'device' | 'site'>,
): Record<FallbackChoiceId, string> {
  const { device, site } = o;
  return {
    clean: `Opens a new, empty browser profile on ${device}: none of your sign-ins, and it reaches only ${site} and its subdomains. It stops when the agent leaves ${site}, and the profile is deleted.`,
    extension: `Uses your own browser on ${device} through the Nova extension, signed in as you. The agent acts only in a tab it opens or one you shared, on ${site}, and stops when it leaves the site.`,
    decline: `The agent’s own browser stays blocked on ${site}. Nothing is remembered, so it may ask again.`,
  };
}

/** What the toast says after an answer. */
function answeredText(o: FallbackOffer, id: FallbackChoiceId): string {
  if (id === 'clean') return `The agent continues ${o.site} on ${o.device} with a clean profile.`;
  if (id === 'extension') return `The agent continues ${o.site} in your browser on ${o.device}.`;
  return `The agent does not continue ${o.site} on ${o.device}.`;
}

export function FallbackOfferCard({
  request,
  onAnswered,
}: {
  request: ServerRequestView;
  /** Called after an answer was sent, or when it turned out answered or expired elsewhere. */
  onAnswered: () => void;
}) {
  const { api } = useServices();
  const toast = useToast();
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const offer = parseFallbackOffer(request);
  if (!offer) return null;
  const hints = choiceHints(offer);
  const { device, site } = offer;

  const answer = async (choice: { id: FallbackChoiceId; label: string }) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // The answer is the choice's label, as the Hub offered it.
      await api.respondRequest(request.id, { choice: choice.label });
      toast.show(answeredText(offer, choice.id), { tone: 'success' });
      onAnswered();
    } catch (err) {
      // The card leaves the list on a refetch, so these outcomes are told by a toast.
      if (err instanceof ApiError && err.status === 409) {
        toast.show('This was already answered on another device.', { tone: 'info' });
        onAnswered();
      } else if (err instanceof ApiError && err.status === 410) {
        toast.show('This offer expired before your answer arrived.', { tone: 'info' });
        onAnswered();
      } else setError(browserDeviceError(err, 'Could not send the answer.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="bdv-offer" aria-labelledby={`${id}-title`}>
      <div className="bdv-offer-head">
        <h4 id={`${id}-title`} className="bdv-offer-title">
          Continue {site} on {device}?
        </h4>
        <StatusChip status="needs_input" />
      </div>
      <p className="muted bdv-offer-meta">Asked because {CAUSE_TEXT[offer.cause]}.</p>
      {offer.question ? <p className="bdv-offer-question">{offer.question}</p> : null}
      <ul className="bdv-choices" aria-label="Choices">
        {offer.choices.map((c) => (
          <li key={c.id} className="bdv-choice">
            <Button
              disabled={busy}
              aria-describedby={`${id}-${c.id}`}
              onClick={() => void answer(c)}
            >
              {c.label}
            </Button>
            <span id={`${id}-${c.id}`} className="nv-field-hint">
              {hints[c.id]}
            </span>
          </li>
        ))}
      </ul>
      <p className="muted bdv-offer-meta">
        <Icon name="clock" /> Waiting until {stampOf(request.expiresAt)}. A choice to continue is
        remembered for {site} on {device} until you revoke it in{' '}
        <a href={SETTINGS_BROWSER_PATH} onClick={(e) => followLink(e, SETTINGS_BROWSER_PATH)}>
          Settings → Browser
        </a>
        .
      </p>
      {error ? (
        <p role="alert" className="nv-field-error">
          {error}
        </p>
      ) : null}
    </article>
  );
}

/** A thread's pending fallback offers, refetched on request events. */
export function FallbackOffers({ threadId }: { threadId: string }) {
  const { api } = useServices();
  const [items, setItems] = useState<ServerRequestView[]>([]);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let alive = true;
    api.listRequests('pending').then(
      ({ items: list }) =>
        alive &&
        setItems(list.filter((r) => r.correlation.threadId === threadId && isFallbackOffer(r))),
      // The offers are extra here: a failed read leaves the conversation working.
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [api, threadId, version]);
  const reload = useDebounced(() => setVersion((v) => v + 1), 100);
  useHubEvents(REQUEST_EVENTS, () => reload());
  if (!items.length) return null;
  return (
    <div className="bdv-offers stack" aria-live="polite">
      {items.map((r) => (
        <FallbackOfferCard key={r.id} request={r} onAnswered={() => setVersion((v) => v + 1)} />
      ))}
    </div>
  );
}
