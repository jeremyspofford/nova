// The marketplace (FR-049, FR-012, FR-199; docs/14 §5, docs/08 §7, docs/26 §3; docs/04 §1: a
// top-level surface at /marketplace): tabs for Plugins, Skills, Themes, Pets and MCP servers, plus
// what is installed and the catalogs; search across the catalogs; a card per item (name, author,
// version, Verified or Unverified, what it can do, installed version and Update), its details
// (screenshots, changelog, hooks, sub-agent roles, browser extensions, app screens, a local rating)
// and the install flow (InstallDialog). Managed policy that forbids unverified items or kinds is
// said plainly at the top. Owner-only: a member sees the owner-only notice. Lists follow the
// marketplace events.
import { useCallback, useEffect, useId, useState } from 'react';
import type {
  MarketCatalogView,
  MarketItemKind,
  MarketItemView,
  MarketRatingView,
} from '@nova/shared';
import { Button, EmptyState, Icon, Spinner, Tabs, useToast } from '@nova/ui';
import { useHubStream } from '../hub-events.ts';
import { navigate } from '../router.ts';
import { useAnnounce } from '../services.tsx';
import { VerifiedBadge } from '../settings/badges.tsx';
import { useSettings } from '../settings.tsx';
import { MemberGate } from '../team/role.tsx';
import { useMarketApi, type MarketApi } from './api-m8.ts';
import { CatalogsTab } from './CatalogsTab.tsx';
import {
  MARKET_TABS,
  MARKET_TEXT,
  PERMISSION_ICON,
  TAB_KIND,
  TAB_LABEL,
  marketErrorMessage,
  marketPublisherText,
  marketTabPath,
  parseMarketTab,
  type MarketTab,
} from './format.ts';
import { InstallDialog, type InstallTarget } from './InstallDialog.tsx';
import { InstalledTab, RemoveDialog, type RemoveTarget } from './InstalledTab.tsx';
import { ItemDetails } from './ItemDetails.tsx';
import { ManagedNote } from '../managed/ManagedNote.tsx';
import { POLICY_TEXT, unverifiedForbidden, useRestrictions } from './policy.tsx';
import './market.css';

/** Events after which the lists are read again. */
export const MARKET_EVENTS = [
  'market.installed',
  'market.updated',
  'market.removed',
  'settings.changed',
] as const;

const CATALOG_KEYS = new Set(['plugins.catalogs', 'plugins.trustedPublishers']);

export function MarketplacePage({ tab }: { tab: string | null }) {
  return (
    <MemberGate ownerOnly what={MARKET_TEXT.title}>
      <MarketBody tab={parseMarketTab(tab)} />
    </MemberGate>
  );
}

function MarketBody({ tab }: { tab: MarketTab }) {
  const market = useMarketApi();
  const settings = useSettings();
  const restrictions = useRestrictions();
  const kinds = settings.get('market.allowedKinds');
  const [q, setQ] = useState('');
  const [catalogs, setCatalogs] = useState<MarketCatalogView[] | null>(null);
  const [catalogsAttempt, setCatalogsAttempt] = useState(0);
  const reloadCatalogs = useCallback(() => setCatalogsAttempt((n) => n + 1), []);
  useEffect(() => {
    if (!market) return;
    let alive = true;
    market.listMarketCatalogs().then(
      ({ items }) => alive && setCatalogs(items),
      () => alive && setCatalogs([]),
    );
    return () => {
      alive = false;
    };
  }, [market, catalogsAttempt]);
  useHubStream(['settings.changed'], (env) => {
    if (typeof env.payload.key === 'string' && CATALOG_KEYS.has(env.payload.key)) reloadCatalogs();
  });

  if (!market)
    return (
      <div className="market-page">
        <h2>{MARKET_TEXT.title}</h2>
        <p className="muted">{MARKET_TEXT.loadFailed}</p>
      </div>
    );

  const panel = (t: MarketTab) => {
    if (t !== tab) return null;
    const kind = TAB_KIND[t];
    if (kind)
      return (
        <KindTab
          market={market}
          kind={kind}
          q={q}
          catalogs={catalogs ?? []}
          off={!kinds.value.includes(kind)}
        />
      );
    if (t === 'installed') return <InstalledTab market={market} />;
    return <CatalogsTab market={market} catalogs={catalogs} onChanged={reloadCatalogs} />;
  };
  const items = MARKET_TABS.map((t) => ({ id: t, label: TAB_LABEL[t], panel: panel(t) }));

  return (
    <div className="market-page">
      <header className="market-head">
        <h2>{MARKET_TEXT.title}</h2>
        <p className="muted">{MARKET_TEXT.intro}</p>
        {TAB_KIND[tab] ? (
          <div className="market-search">
            <label className="nv-vh" htmlFor="market-search">
              {MARKET_TEXT.search}
            </label>
            <input
              id="market-search"
              className="nv-input"
              type="search"
              placeholder={MARKET_TEXT.searchPlaceholder}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
        ) : null}
        {unverifiedForbidden(restrictions.layers) ? (
          <p className="market-policy">
            <Icon name="shield" /> <span>{POLICY_TEXT.unverifiedOff}</span>{' '}
            <ManagedNote setting="restrict.unverifiedInstalls" />
          </p>
        ) : null}
        {restrictions.failClosed ? (
          <p className="market-policy" role="note">
            <Icon name="alert" /> <span>{POLICY_TEXT.failClosed}</span>
          </p>
        ) : null}
      </header>
      <Tabs
        label={MARKET_TEXT.tabs}
        items={items}
        value={tab}
        onChange={(id) => navigate(marketTabPath(parseMarketTab(id)))}
        className="market-tabs"
      />
    </div>
  );
}

// ---- a kind's tab: search results as cards ---------------------------------------------------

function KindTab({
  market,
  kind,
  q,
  catalogs,
  off,
}: {
  market: MarketApi;
  kind: MarketItemKind;
  q: string;
  catalogs: MarketCatalogView[];
  /** Installing this kind is turned off (Catalogs → Install rules, or managed policy). */
  off: boolean;
}) {
  const toast = useToast();
  const announce = useAnnounce();
  const settings = useSettings();
  const kinds = settings.get('market.allowedKinds');
  const [items, setItems] = useState<MarketItemView[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState(q);
  const [details, setDetails] = useState<MarketItemView | null>(null);
  const [installing, setInstalling] = useState<InstallTarget | null>(null);
  const [removing, setRemoving] = useState<RemoveTarget | null>(null);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  // Search after a short pause in typing.
  useEffect(() => {
    const t = setTimeout(() => setQuery(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    let alive = true;
    market.searchMarket({ q: query.trim() || undefined, kind }).then(
      ({ items: list }) => {
        if (!alive) return;
        setItems(list);
        setError(null);
      },
      (err: unknown) => alive && setError(err),
    );
    return () => {
      alive = false;
    };
  }, [market, kind, query, attempt]);
  useHubStream(MARKET_EVENTS, (env) => {
    if (env.name !== 'settings.changed' || CATALOG_KEYS.has(String(env.payload.key))) reload();
  });

  const names = new Map(catalogs.map((c) => [c.id, c.name]));
  const done = (msg: string) => {
    toast.show(msg, { tone: 'success' });
    announce(msg);
    reload();
  };

  let body;
  if (error)
    body = (
      <div role="alert" className="ws-error">
        <p>{marketErrorMessage(error, MARKET_TEXT.loadFailed)}</p>
        <Button onClick={reload}>{MARKET_TEXT.retry}</Button>
      </div>
    );
  else if (items === null) body = <Spinner label={MARKET_TEXT.loading} />;
  else if (items.length === 0)
    body = (
      <EmptyState
        title={
          query.trim() ? MARKET_TEXT.noMatch({ query: query.trim() }) : MARKET_TEXT.empty({ kind })
        }
        level={3}
      />
    );
  else
    body = (
      <ul className="market-cards" aria-label={TAB_LABEL[kindTab(kind)]}>
        {items.map((it) => (
          <ItemCard
            key={`${it.catalogId}/${it.id}`}
            item={it}
            catalogName={names.get(it.catalogId) ?? it.catalogId}
            screenshot={
              it.screenshots > 0
                ? market.marketScreenshotUrl(it.catalogId, it.kind, it.id, 0)
                : null
            }
            off={off}
            onDetails={() => setDetails(it)}
            onInstall={() =>
              setInstalling({ catalogId: it.catalogId, kind: it.kind, id: it.id, name: it.name })
            }
            onRemove={() => setRemoving({ kind: it.kind, id: it.id, name: it.name })}
          />
        ))}
      </ul>
    );

  return (
    <div className="market-tab">
      {off ? (
        <p className="market-policy" role="note">
          <Icon name="stop" /> <span>{MARKET_TEXT.kindOff({ kind })}</span>{' '}
          {kinds.locked ? <ManagedNote setting="market.allowedKinds" /> : null}
        </p>
      ) : null}
      {kind === 'pet' ? <p className="muted">{MARKET_TEXT.petsHint}</p> : null}
      {kind === 'theme' ? <p className="muted">{MARKET_TEXT.themesHint}</p> : null}
      {body}
      {details ? (
        <ItemDetails
          market={market}
          item={details}
          catalogName={names.get(details.catalogId) ?? details.catalogId}
          off={off}
          onClose={() => setDetails(null)}
          onInstall={() => {
            setDetails(null);
            setInstalling({
              catalogId: details.catalogId,
              kind: details.kind,
              id: details.id,
              name: details.name,
            });
          }}
          onRemove={() => {
            setDetails(null);
            setRemoving({ kind: details.kind, id: details.id, name: details.name });
          }}
          onRated={reload}
        />
      ) : null}
      {installing ? (
        <InstallDialog
          market={market}
          target={installing}
          onClose={() => setInstalling(null)}
          onInstalled={(view, update) => {
            setInstalling(null);
            done(
              update
                ? MARKET_TEXT.updatedToast({ name: view.name })
                : MARKET_TEXT.installedToast({ name: view.name }),
            );
          }}
        />
      ) : null}
      {removing ? (
        <RemoveDialog
          market={market}
          target={removing}
          onClose={() => setRemoving(null)}
          onRemoved={() => {
            setRemoving(null);
            done(MARKET_TEXT.removed({ name: removing.name }));
          }}
        />
      ) : null}
    </div>
  );
}

function kindTab(kind: MarketItemKind): MarketTab {
  return (Object.keys(TAB_KIND) as MarketTab[]).find((t) => TAB_KIND[t] === kind) ?? 'plugins';
}

// ---- a card ----------------------------------------------------------------------------------

/** Up to five stars, as text and visually (never color alone). */
export function Stars({ rating }: { rating: MarketRatingView | null }) {
  if (!rating) return <span className="muted">{MARKET_TEXT.unrated}</span>;
  return (
    <span className="market-stars" title={MARKET_TEXT.stars({ n: rating.stars })}>
      <span aria-hidden="true">
        {'★'.repeat(rating.stars)}
        {'☆'.repeat(5 - rating.stars)}
      </span>
      <span className="nv-vh">{MARKET_TEXT.stars({ n: rating.stars })}</span>
    </span>
  );
}

function ItemCard({
  item: it,
  catalogName,
  screenshot,
  off,
  onDetails,
  onInstall,
  onRemove,
}: {
  item: MarketItemView;
  catalogName: string;
  /** The first screenshot's URL, when the item has one. */
  screenshot: string | null;
  off: boolean;
  onDetails: () => void;
  onInstall: () => void;
  onRemove: () => void;
}) {
  const headingId = useId();
  const installed = it.installedVersion !== null;
  return (
    <li className="ws-card market-card" aria-labelledby={headingId} data-item={it.id}>
      <div className="market-card-head">
        <h3 id={headingId} className="market-card-title" dir="auto">
          {it.name}
        </h3>
        <VerifiedBadge verified={it.verified} />
      </div>
      <p className="ws-row-meta">
        {/* The item's own author only, when its catalog names one. */}
        {it.author ? <span dir="auto">{MARKET_TEXT.by({ author: it.author })}</span> : null}
        {/* Who signed: named only for a key the owner trusts (never the catalog's claim). */}
        {it.publisher ? <span>{marketPublisherText(it.publisher)}</span> : null}
        <span>{MARKET_TEXT.version({ version: it.version })}</span>
        <span className="muted" dir="auto">
          {catalogName}
        </span>
        <Stars rating={it.rating} />
      </p>
      {screenshot ? (
        <img
          className="market-thumb"
          src={screenshot}
          alt={MARKET_TEXT.screenshot({ n: 1, name: it.name })}
          loading="lazy"
        />
      ) : null}
      {it.description ? (
        <p className="market-desc" dir="auto">
          {it.description}
        </p>
      ) : null}
      {it.permissions.length ? (
        <ul className="market-perms" aria-label={MARKET_TEXT.canAccessOf({ name: it.name })}>
          {it.permissions.map((l) => (
            <li key={l.key}>
              <Icon name={PERMISSION_ICON[l.kind]} />
              <span>{l.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {installed ? (
        <p className="market-installed">
          <Icon name="check" />{' '}
          {MARKET_TEXT.installedVersion({ version: it.installedVersion ?? it.version })}
        </p>
      ) : null}
      <div className="row ws-row-actions">
        <Button
          variant="ghost"
          onClick={onDetails}
          aria-label={MARKET_TEXT.detailsOf({ name: it.name })}
        >
          {MARKET_TEXT.details}
        </Button>
        {!installed ? (
          <Button
            variant="primary"
            disabled={off}
            onClick={onInstall}
            aria-label={MARKET_TEXT.installOf({ name: it.name })}
          >
            {MARKET_TEXT.install}
          </Button>
        ) : it.updateAvailable ? (
          <Button
            variant="primary"
            disabled={off}
            onClick={onInstall}
            aria-label={MARKET_TEXT.updateOf({ name: it.name })}
          >
            {MARKET_TEXT.updateTo({ version: it.version })}
          </Button>
        ) : null}
        {installed ? (
          <Button
            variant="ghost"
            onClick={onRemove}
            aria-label={MARKET_TEXT.removeOf({ name: it.name })}
          >
            {MARKET_TEXT.remove}
          </Button>
        ) : null}
      </div>
    </li>
  );
}
