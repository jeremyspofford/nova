// A marketplace item's details (FR-049; docs/14 §5 card details, docs/26 §3 "view details"): who
// made it and who signed it, Verified or Unverified, what it can do, screenshots, the changelog,
// what a plugin brings (hooks with their events, sub-agent roles, browser extensions, app
// screens), its versions and homepage, and the owner's own rating, which stays on the Hub. Install,
// Update and Remove start from here too.
import { useEffect, useId, useState } from 'react';
import { defineMessages, fmt } from '@nova/i18n';
import type { MarketItemDetail, MarketItemView } from '@nova/shared';
import { Button, Dialog, Icon, RadioGroup, Spinner, useToast } from '@nova/ui';
import { VerifiedBadge } from '../settings/badges.tsx';
import { HOOK_EVENT_TEXT } from '../settings/plugin-text.ts';
import type { MarketApi } from './api-m8.ts';
import {
  KIND_TEXT,
  MARKET_TEXT,
  PUBLISHER_TEXT,
  entryPointText,
  marketErrorMessage,
  marketPublisherText,
} from './format.ts';
import { MarketPermissions } from './InstallDialog.tsx';

const eventText = (event: string) =>
  (HOOK_EVENT_TEXT as Record<string, string | undefined>)[event] ?? event;

/** The rating's choices, read at render so they follow the active locale. */
const starOptions = () =>
  [1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: MARKET_TEXT.stars({ n }) }));

/** Names, versions and roles as the catalog lists them, joined the active locale's way. */
const joined = (items: readonly string[]) => fmt.list(items, { type: 'unit', style: 'short' });

export function ItemDetails({
  market,
  item,
  catalogName,
  off,
  onClose,
  onInstall,
  onRemove,
  onRated,
}: {
  market: MarketApi;
  item: MarketItemView;
  catalogName: string;
  /** Installing this kind is turned off. */
  off: boolean;
  onClose: () => void;
  onInstall: () => void;
  onRemove: () => void;
  onRated: () => void;
}) {
  const [detail, setDetail] = useState<MarketItemDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    market.getMarketItem(item.catalogId, item.kind, item.id).then(
      (d) => alive && setDetail(d),
      (err: unknown) => alive && setError(marketErrorMessage(err, MARKET_TEXT.loadFailed)),
    );
    return () => {
      alive = false;
    };
  }, [market, item.catalogId, item.kind, item.id]);

  const view = detail ?? item;
  const installed = view.installedVersion !== null;
  return (
    <Dialog
      open
      title={item.name}
      description={item.description ?? undefined}
      onClose={onClose}
      className="ws-wide-dialog"
      footer={
        <>
          <Button onClick={onClose}>{MARKET_TEXT.close}</Button>
          {installed ? (
            <Button
              variant="ghost"
              onClick={onRemove}
              aria-label={MARKET_TEXT.removeOf({ name: item.name })}
            >
              {MARKET_TEXT.remove}
            </Button>
          ) : null}
          {!installed || view.updateAvailable ? (
            <Button variant="primary" disabled={off} onClick={onInstall}>
              {installed ? MARKET_TEXT.updateTo({ version: view.version }) : MARKET_TEXT.install}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="stack">
        <p className="ws-row-meta">
          <VerifiedBadge verified={view.verified} />
          <span>{KIND_TEXT[view.kind].one}</span>
          <code className="ws-code-inline">{view.id}</code>
        </p>
        <dl className="ws-dl">
          {view.author ? (
            <>
              <dt>{DETAIL_TEXT.author}</dt>
              <dd dir="auto">{view.author}</dd>
            </>
          ) : null}
          {view.publisher ? (
            <>
              <dt>{PUBLISHER_TEXT.label}</dt>
              <dd>{marketPublisherText(view.publisher)}</dd>
            </>
          ) : null}
          <dt>{MARKET_TEXT.catalog}</dt>
          <dd dir="auto">{catalogName}</dd>
          <dt>{MARKET_TEXT.versions}</dt>
          <dd>{detail ? joined(detail.versions) : view.version}</dd>
          {view.installedVersion ? (
            <>
              <dt>{DETAIL_TEXT.installed}</dt>
              <dd>{view.installedVersion}</dd>
            </>
          ) : null}
          {detail?.commit ? (
            <>
              <dt>{DETAIL_TEXT.commit}</dt>
              <dd>
                <code className="ws-code-inline">{detail.commit}</code>
              </dd>
            </>
          ) : null}
          {view.homepage ? (
            <>
              <dt>{MARKET_TEXT.homepage}</dt>
              <dd>
                <a href={view.homepage} target="_blank" rel="noopener noreferrer" dir="ltr">
                  {view.homepage} <Icon name="external" />
                </a>
              </dd>
            </>
          ) : null}
        </dl>

        <section aria-labelledby="item-can">
          <h3 id="item-can" className="ws-subhead">
            {MARKET_TEXT.canAccess}
          </h3>
          <MarketPermissions lines={view.permissions} label={MARKET_TEXT.canAccess} />
          <p className="muted">{DETAIL_TEXT.catalogSays}</p>
        </section>

        {error ? (
          <p role="alert" className="nv-field-error">
            {error}
          </p>
        ) : !detail ? (
          <Spinner label={MARKET_TEXT.loading} />
        ) : (
          <>
            {detail.screenshots > 0 ? (
              <section aria-labelledby="item-shots">
                <h3 id="item-shots" className="ws-subhead">
                  {MARKET_TEXT.screenshots}
                </h3>
                <div className="market-shots">
                  {Array.from({ length: Math.min(detail.screenshots, 8) }, (_, n) => (
                    <img
                      key={n}
                      src={market.marketScreenshotUrl(detail.catalogId, detail.kind, detail.id, n)}
                      alt={MARKET_TEXT.screenshot({ n: n + 1, name: detail.name })}
                      loading="lazy"
                    />
                  ))}
                </div>
              </section>
            ) : null}
            <Components detail={detail} />
            <section aria-labelledby="item-changelog">
              <h3 id="item-changelog" className="ws-subhead">
                {MARKET_TEXT.changelog}
              </h3>
              {detail.changelog.length ? (
                <ul className="ws-plain-list">
                  {detail.changelog.map((c) => (
                    <li key={c.version} dir="auto">
                      <strong>{c.version}</strong>
                      {c.date ? <span className="muted"> ({c.date})</span> : null}: {c.notes}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">{MARKET_TEXT.noChangelog}</p>
              )}
            </section>
            <Rating market={market} detail={detail} onRated={onRated} />
          </>
        )}
      </div>
    </Dialog>
  );
}

const DETAIL_TEXT = defineMessages('market.itemDetails', {
  author: 'Author',
  installed: 'Installed',
  commit: 'Commit',
  catalogSays: 'As the catalog lists it. The install screen shows what the item itself declares.',
});

function Components({ detail }: { detail: MarketItemDetail }) {
  const c = detail.components;
  if (!c.hooks.length && !c.roles.length && !c.browserExtensions.length && !c.uiEntryPoints.length)
    return null;
  return (
    <section aria-labelledby="item-brings">
      <h3 id="item-brings" className="ws-subhead">
        {MARKET_TEXT.brings}
      </h3>
      <dl className="ws-dl">
        {c.hooks.length ? (
          <>
            <dt>{MARKET_TEXT.hooks}</dt>
            <dd>
              <ul className="ws-plain-list">
                {c.hooks.map((h) => (
                  <li key={h.id}>
                    <code className="ws-code-inline">{h.id}</code>: {eventText(h.event)}
                  </li>
                ))}
              </ul>
            </dd>
          </>
        ) : null}
        {c.roles.length ? (
          <>
            <dt>{MARKET_TEXT.roles}</dt>
            <dd>{joined(c.roles)}</dd>
          </>
        ) : null}
        {c.browserExtensions.length ? (
          <>
            <dt>{MARKET_TEXT.browserExtensions}</dt>
            <dd>{joined(c.browserExtensions)}</dd>
          </>
        ) : null}
        {c.uiEntryPoints.length ? (
          <>
            <dt>{MARKET_TEXT.entryPoints}</dt>
            <dd>
              {joined(c.uiEntryPoints.map((e) => entryPointText(e.title ?? detail.name, e.kind)))}
            </dd>
          </>
        ) : null}
      </dl>
    </section>
  );
}

/** The owner's own rating of the item; it stays on the Hub. */
function Rating({
  market,
  detail,
  onRated,
}: {
  market: MarketApi;
  detail: MarketItemDetail;
  onRated: () => void;
}) {
  const toast = useToast();
  const headingId = useId();
  const [stars, setStars] = useState(detail.rating ? String(detail.rating.stars) : '');
  const [review, setReview] = useState(detail.rating?.review ?? '');
  const [rated, setRated] = useState(detail.rating !== null);
  const [busy, setBusy] = useState(false);
  const save = () => {
    const n = Number(stars);
    if (!n) return;
    setBusy(true);
    market
      .rateMarketItem({
        kind: detail.kind,
        itemId: detail.id,
        stars: n,
        ...(review.trim() ? { review: review.trim() } : {}),
      })
      .then(
        () => {
          setBusy(false);
          setRated(true);
          toast.show(MARKET_TEXT.rated, { tone: 'success' });
          onRated();
        },
        (err: unknown) => {
          setBusy(false);
          toast.show(marketErrorMessage(err, MARKET_TEXT.rateFailed), { tone: 'error' });
        },
      );
  };
  const clear = () => {
    setBusy(true);
    market.unrateMarketItem(detail.kind, detail.id).then(
      () => {
        setBusy(false);
        setRated(false);
        setStars('');
        setReview('');
        toast.show(MARKET_TEXT.ratingCleared, { tone: 'success' });
        onRated();
      },
      (err: unknown) => {
        setBusy(false);
        toast.show(marketErrorMessage(err, MARKET_TEXT.rateFailed), { tone: 'error' });
      },
    );
  };
  return (
    <section aria-labelledby={headingId} className="market-rating">
      <h3 id={headingId} className="ws-subhead">
        {MARKET_TEXT.rating}
      </h3>
      <p className="muted">{MARKET_TEXT.ratingHint}</p>
      <RadioGroup
        legend={MARKET_TEXT.rating}
        name={`stars-${detail.kind}-${detail.id}`}
        value={stars}
        options={starOptions()}
        onChange={setStars}
        className="market-stars-input"
      />
      <div className="nv-field">
        <label className="nv-field-label" htmlFor={`${headingId}-review`}>
          {MARKET_TEXT.review}
        </label>
        <textarea
          id={`${headingId}-review`}
          className="nv-input ws-textarea"
          rows={2}
          maxLength={2000}
          value={review}
          onChange={(e) => setReview(e.target.value)}
        />
      </div>
      <div className="row">
        <Button onClick={save} disabled={busy || !stars}>
          {MARKET_TEXT.rate}
        </Button>
        {rated ? (
          <Button variant="ghost" onClick={clear} disabled={busy}>
            {MARKET_TEXT.clearRating}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
