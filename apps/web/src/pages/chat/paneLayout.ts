/**
 * The split view's layout, as pure functions (chat sessions, 2026-10-07).
 *
 * A layout is an ordered row of panes. One of them is ALWAYS the main pane
 * (`MAIN_SLOT`): it is the one the URL drives (`/chat?session=&thread=`), so
 * the phone, a reload, a shared link and the iOS back gesture all keep
 * working exactly as they did with one pane. The others carry their own
 * location here and are remembered per browser (a convenience — losing it
 * loses a layout, never a conversation).
 *
 * Kept free of React so the rules — where a dropped session goes, what
 * closing the main pane means, the cap — are tested without rendering.
 */
import { MAIN_SLOT } from '../../stores/chat-store'
import type { ChatLocation } from './ChatPage'

/** Past four, each pane is narrower than a phone on a laptop screen. */
export const MAX_PANES = 4

export interface Pane extends ChatLocation {
  id: string
}

export interface Layout {
  /** Pane ids, left to right. Always contains MAIN_SLOT. */
  order: string[]
  /** Every pane but the main one — its location is the URL's. */
  extra: Record<string, Pane>
  /** Relative widths; a pane with none is 1. */
  weights: Record<string, number>
  focused: string
}

export type DropZone = 'left' | 'right' | 'center'

export function singlePane(): Layout {
  return { order: [MAIN_SLOT], extra: {}, weights: {}, focused: MAIN_SLOT }
}

/** A stored layout, made safe: anything malformed is the single pane. */
export function sanitize(raw: unknown): Layout {
  if (!raw || typeof raw !== 'object') return singlePane()
  const r = raw as Partial<Layout>
  const extra: Record<string, Pane> = {}
  for (const [id, pane] of Object.entries(r.extra ?? {})) {
    if (id === MAIN_SLOT || !pane || typeof pane !== 'object') continue
    const p = pane as Partial<Pane>
    extra[id] = {
      id,
      sessionId: typeof p.sessionId === 'string' ? p.sessionId : null,
      threadId: typeof p.threadId === 'string' ? p.threadId : null,
    }
  }
  const order = (Array.isArray(r.order) ? r.order : []).filter(
    (id, i, all): id is string =>
      typeof id === 'string' && (id === MAIN_SLOT || id in extra) && all.indexOf(id) === i,
  )
  if (!order.includes(MAIN_SLOT)) order.unshift(MAIN_SLOT)
  const kept = order.slice(0, MAX_PANES)
  if (!kept.includes(MAIN_SLOT)) kept[kept.length - 1] = MAIN_SLOT
  for (const id of Object.keys(extra)) if (!kept.includes(id)) delete extra[id]
  const weights: Record<string, number> = {}
  for (const [id, w] of Object.entries(r.weights ?? {})) {
    if (kept.includes(id) && typeof w === 'number' && Number.isFinite(w) && w > 0) weights[id] = w
  }
  const focused = typeof r.focused === 'string' && kept.includes(r.focused) ? r.focused : MAIN_SLOT
  return { order: kept, extra, weights, focused }
}

/** Put a new pane beside `target`. Past the cap, nothing changes. */
export function insertPane(
  layout: Layout,
  pane: Pane,
  target: string,
  side: 'left' | 'right',
): Layout {
  if (layout.order.length >= MAX_PANES || pane.id === MAIN_SLOT) return layout
  const at = layout.order.indexOf(target)
  const index = at === -1 ? layout.order.length : side === 'left' ? at : at + 1
  const order = [...layout.order]
  order.splice(index, 0, pane.id)
  return { ...layout, order, extra: { ...layout.extra, [pane.id]: pane }, focused: pane.id }
}

/** Take a side pane out. The main pane is never removed here — closing it
 *  is `closeMain`, because its content has to come from somewhere. */
export function removePane(layout: Layout, id: string): Layout {
  if (id === MAIN_SLOT || !(id in layout.extra)) return layout
  const order = layout.order.filter(p => p !== id)
  const extra = { ...layout.extra }
  delete extra[id]
  const weights = { ...layout.weights }
  delete weights[id]
  const focused = layout.focused === id ? nearest(layout.order, id) : layout.focused
  return { ...layout, order, extra, weights, focused }
}

function nearest(order: string[], id: string): string {
  const i = order.indexOf(id)
  return order[i + 1] ?? order[i - 1] ?? MAIN_SLOT
}

/**
 * Close the main pane. With nothing beside it there is nothing to close
 * (null). Otherwise the pane NEXT to it hands its location over — the main
 * pane takes that location (it becomes the URL) and that side pane goes, so
 * what was on screen stays on screen, one pane fewer.
 */
export function closeMain(
  layout: Layout,
): { layout: Layout; location: ChatLocation; removed: string } | null {
  // The pane immediately to its right, else to its left.
  const main = layout.order.indexOf(MAIN_SLOT)
  const donorId = layout.order[main + 1] ?? layout.order[main - 1]
  if (donorId === undefined) return null
  const donor = layout.extra[donorId]
  const next = removePane(layout, donorId)
  // The main pane stands where the donor stood, so the row does not jump.
  const order = layout.order
    .map(id => (id === donorId ? MAIN_SLOT : id === MAIN_SLOT ? null : id))
    .filter((id): id is string => id !== null)
  return {
    layout: { ...next, order, focused: MAIN_SLOT },
    location: { sessionId: donor.sessionId, threadId: donor.threadId },
    removed: donorId,
  }
}

export function setLocation(layout: Layout, id: string, location: ChatLocation): Layout {
  const pane = layout.extra[id]
  if (!pane) return layout
  if (pane.sessionId === location.sessionId && pane.threadId === location.threadId) return layout
  return { ...layout, extra: { ...layout.extra, [id]: { ...pane, ...location } } }
}

/** Move the divider between `left` and the pane after it by `fraction` of
 *  their combined width. Neither side goes below a sixth of the pair. */
export function resize(layout: Layout, left: string, fraction: number): Layout {
  const i = layout.order.indexOf(left)
  const right = layout.order[i + 1]
  if (i === -1 || right === undefined || !Number.isFinite(fraction)) return layout
  const wl = layout.weights[left] ?? 1
  const wr = layout.weights[right] ?? 1
  const total = wl + wr
  const min = total / 6
  const nl = Math.min(Math.max(wl + fraction * total, min), total - min)
  return { ...layout, weights: { ...layout.weights, [left]: nl, [right]: total - nl } }
}
