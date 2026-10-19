// M8 Hub client calls of the marketplace (FR-049, FR-012; docs/14 §5, docs/08 §7; ADR-097 D2, D4),
// in the conventions of src/api.ts: catalogs, search, an item's card and details, screenshots, the
// install preview (the item's own permissions, its verdict, the permission diff of an update),
// install and update, removal, local ratings, and installed pets with their frames. Every route is
// the Hub owner's. `createApi` spreads `marketApi(call)` into the client; `useMarketApi` reads the
// calls from the services object, or null for a client without them.
import type { z } from 'zod';
import type {
  ManagedPolicyView,
  MarketCatalogView,
  MarketInstallView,
  MarketItemDetail,
  MarketItemKind,
  MarketItemView,
  MarketPetView,
  MarketPreview,
  MarketRatingView,
  marketInstallSchema,
} from '@nova/shared';
import type { HubCall } from '../devices/api.ts';
import { useServices } from '../services.tsx';

const V1 = '/api/v1';
const M = `${V1}/market`;
const enc = encodeURIComponent;
const item = (catalogId: string, kind: MarketItemKind, id: string) =>
  `${M}/items/${enc(catalogId)}/${kind}/${enc(id)}`;

export type MarketInstallRequest = z.input<typeof marketInstallSchema>;

export interface MarketSearch {
  q?: string;
  kind?: MarketItemKind;
  catalogId?: string;
}

function query(q: MarketSearch): string {
  const p = new URLSearchParams();
  if (q.q) p.set('q', q.q);
  if (q.kind) p.set('kind', q.kind);
  if (q.catalogId) p.set('catalogId', q.catalogId);
  const s = p.toString();
  return s ? `?${s}` : '';
}

export function marketApi(call: HubCall) {
  return {
    listMarketCatalogs: () => call<{ items: MarketCatalogView[] }>('GET', `${M}/catalogs`),
    searchMarket: (q: MarketSearch = {}) =>
      call<{ items: MarketItemView[] }>('GET', `${M}/items${query(q)}`),
    getMarketItem: (catalogId: string, kind: MarketItemKind, id: string) =>
      call<MarketItemDetail>('GET', item(catalogId, kind, id)),
    /** An image URL for `<img>` (same origin, the session cookie applies). */
    marketScreenshotUrl: (catalogId: string, kind: MarketItemKind, id: string, n: number) =>
      `${item(catalogId, kind, id)}/screenshots/${n}`,
    /** Fetch and check the item and say what installing it would do; nothing is installed. */
    previewMarketItem: (body: {
      catalogId: string;
      kind: MarketItemKind;
      id: string;
      version?: string;
    }) => call<MarketPreview>('POST', `${M}/preview`, body),
    /** Unverified items need `confirmSideload`; an update that adds permissions `acceptPermissions`. */
    installMarketItem: (body: MarketInstallRequest) =>
      call<MarketInstallView>('POST', `${M}/install`, body),
    listMarketInstalled: () => call<{ items: MarketInstallView[] }>('GET', `${M}/installed`),
    removeMarketItem: (kind: MarketItemKind, id: string) =>
      call<{ ok: true }>('DELETE', `${M}/installed/${kind}/${enc(id)}`),
    /** Ratings stay on the Hub: nothing is sent anywhere. */
    listMarketRatings: () => call<{ items: MarketRatingView[] }>('GET', `${M}/ratings`),
    rateMarketItem: (body: {
      kind: MarketItemKind;
      itemId: string;
      stars: number;
      review?: string;
    }) => call<MarketRatingView>('PUT', `${M}/ratings`, body),
    unrateMarketItem: (kind: MarketItemKind, id: string) =>
      call<{ ok: true }>('DELETE', `${M}/ratings/${kind}/${enc(id)}`),
    /** Installed pets (FR-012), for Appearance and the companion. */
    listMarketPets: () => call<{ items: MarketPetView[] }>('GET', `${M}/pets`),
    /** A pet frame's image URL. */
    marketPetFrameUrl: (petId: string, frame: string) =>
      `${M}/pets/${enc(petId)}/files/${frame.split('/').map(enc).join('/')}`,
    /** What managed policy applies and where it comes from (for "Managed by your organization"). */
    marketPolicySources: () => call<ManagedPolicyView>('GET', `${V1}/managed`),
  };
}

export type MarketApi = ReturnType<typeof marketApi>;

/** The marketplace calls of the app's client, or null when it has none of them. */
export function useMarketApi(): MarketApi | null {
  const api = useServices().api as unknown as Partial<MarketApi>;
  return typeof api.searchMarket === 'function' && typeof api.listMarketPets === 'function'
    ? (api as MarketApi)
    : null;
}
