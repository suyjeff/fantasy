// The trade dock's trades: up to three deals open at once, each with its own step and roster tab, one of them
// expanded at a time. Kept pure, so the dock (components/TradeDock), its tests and anything that later reads the
// open trades (a comparison, say) move them the same way.
//
// Throwaway actions act at once and offer the way back, rather than asking first: discarding a trade, clearing its
// players, or starting a fourth trade, which replaces the one least recently touched.

import { dealActive, emptyDeal, type Deal } from './deal'

export const MAX_TRADES = 3

export type DockStep = 'pick' | 'review'

export type DockTrade = {
  /** Stable for the trade's life: keys, focus and undo find it by this. */
  id: string
  deal: Deal
  step: DockStep
  /** The roster tab showing. */
  view: number
  /** When it was last opened or edited, as a running count: the lowest is the one a fourth trade replaces. */
  touched: number
}

/** What the last throwaway action took, to put back. */
export type DockUndo =
  /** A trade closed with something in it: back where it stood in the list, open again if it was. */
  | { kind: 'discarded'; trade: DockTrade; index: number; wasOpen: boolean }
  /** A trade replaced by a new one, the limit reached: undoing drops the new one (`by`) and puts this back. */
  | { kind: 'replaced'; trade: DockTrade; index: number; by: string }
  /** A trade's players and FAAB taken out. */
  | { kind: 'cleared'; trade: DockTrade }

export type DockState = {
  trades: DockTrade[]
  /** The expanded trade; the rest are minimized. Null: all minimized, or none open. */
  open: string | null
  undo: DockUndo | null
  /** The discard notice is up (counted, so a second discard restarts its timer). */
  toast: number
  /** A minimized trade to focus once it shows (the one just minimized). */
  focus: string | null
  /** Running count behind ids and `touched`. */
  seq: number
}

export const emptyDock = (): DockState => ({ trades: [], open: null, undo: null, toast: 0, focus: null, seq: 0 })

/** Whether the dock is showing a trade, has only minimized ones, or none. */
export const dockMode = (s: DockState): 'open' | 'min' | 'closed' => (s.open && s.trades.some((t) => t.id === s.open) ? 'open' : s.trades.length ? 'min' : 'closed')

export const openTrade = (s: DockState): DockTrade | null => s.trades.find((t) => t.id === s.open) ?? null

/** The roster tab to start on: the first other team, or yours. */
const firstView = (deal: Deal, me: number) => deal.teams.find((t) => t !== me) ?? me

const sameDeal = (a: Deal, b: Deal) => JSON.stringify(a) === JSON.stringify(b)

const touch = (s: DockState, id: string): DockState => {
  const seq = s.seq + 1
  return { ...s, seq, trades: s.trades.map((t) => (t.id === id ? { ...t, touched: seq } : t)) }
}

/**
 * Start a trade: with this deal, or a blank one. The same deal already open is brought up rather than doubled; a
 * trade with nothing in it yet is reused; past the limit, the trade least recently touched gives way (undoable).
 */
export const startTrade = (s: DockState, me: number, deal?: Deal, step?: DockStep): DockState => {
  const d = deal ?? emptyDeal([me])
  const st: DockStep = step ?? (dealActive(d) ? 'review' : 'pick')
  if (deal) {
    const same = s.trades.find((t) => sameDeal(t.deal, deal))
    if (same) return expand({ ...s, trades: s.trades.map((t) => (t.id === same.id ? { ...t, step: st } : t)) }, same.id)
  }
  const seq = s.seq + 1
  const fresh = (id: string): DockTrade => ({ id, deal: d, step: st, view: firstView(d, me), touched: seq })
  // A spent replace or clear goes with the next start; a discarded trade stays restorable.
  const undo = s.undo?.kind === 'discarded' ? s.undo : null
  const base = { ...s, seq, focus: null, toast: 0, undo }
  // A blank start brings up an empty trade as it stands (its partner kept); a deal fills it.
  const idle = s.trades.find((t) => !dealActive(t.deal))
  if (idle) return { ...base, open: idle.id, trades: s.trades.map((t) => (t.id === idle.id ? (deal ? { ...fresh(t.id) } : { ...t, touched: seq }) : t)) }
  if (s.trades.length < MAX_TRADES) {
    const t = fresh(`t${seq}`)
    return { ...base, open: t.id, trades: [...s.trades, t] }
  }
  const index = s.trades.reduce((lo, t, i) => (t.touched < s.trades[lo].touched ? i : lo), 0)
  const t = fresh(`t${seq}`)
  return { ...base, open: t.id, trades: s.trades.map((x, i) => (i === index ? t : x)), undo: { kind: 'replaced', trade: s.trades[index], index, by: t.id } }
}

/** Bring up a trade already in the dock; the one open before minimizes. */
export const expand = (s: DockState, id: string): DockState => (s.trades.some((t) => t.id === id) ? { ...touch(s, id), open: id, focus: null, toast: 0 } : s)

export const minimize = (s: DockState): DockState => (s.open ? { ...s, focus: s.open, open: null } : s)

/** Close a trade. One with something in it can come back from the notice that follows. */
export const discard = (s: DockState, id: string): DockState => {
  const index = s.trades.findIndex((t) => t.id === id)
  if (index < 0) return s
  const trade = s.trades[index]
  const trades = s.trades.filter((t) => t.id !== id)
  const open = s.open === id ? null : s.open
  if (!dealActive(trade.deal)) return { ...s, trades, open, focus: null, undo: s.undo?.kind === 'discarded' ? s.undo : null, toast: 0 }
  return { ...s, trades, open, focus: null, undo: { kind: 'discarded', trade, index, wasOpen: s.open === id }, toast: s.toast + 1 }
}

/**
 * Edit one trade. The edit settles that trade's replace or clear (its notice goes with it); a discarded trade stays
 * restorable while the trade offering it back is still empty.
 */
export const editTrade = (s: DockState, id: string, fn: (d: Deal) => Deal): DockState => {
  const t = s.trades.find((x) => x.id === id)
  if (!t) return s
  const deal = fn(t.deal)
  if (deal === t.deal) return s
  const u = s.undo
  const keep = !u ? null : u.kind === 'discarded' ? (dealActive(deal) && s.open === id ? null : u) : (u.kind === 'replaced' ? u.by : u.trade.id) === id ? null : u
  const seq = s.seq + 1
  return { ...s, seq, undo: keep, trades: s.trades.map((x) => (x.id === id ? { ...x, deal, touched: seq } : x)) }
}

export const setTradeStep = (s: DockState, id: string, step: DockStep): DockState => ({ ...s, trades: s.trades.map((t) => (t.id === id ? { ...t, step } : t)) })
export const setTradeView = (s: DockState, id: string, view: number): DockState => ({ ...s, trades: s.trades.map((t) => (t.id === id ? { ...t, view } : t)) })

/** Take every player and all FAAB out of a trade, undoably. */
export const clearTrade = (s: DockState, id: string): DockState => {
  const t = s.trades.find((x) => x.id === id)
  if (!t || !dealActive(t.deal)) return s
  return { ...s, undo: { kind: 'cleared', trade: t }, trades: s.trades.map((x) => (x.id === id ? { ...x, deal: { ...x.deal, moves: [], faab: [] } } : x)) }
}

/**
 * Put back what the last throwaway action took. A discarded trade comes back where it stood (open if it was, or
 * if it is being restored from inside an open, empty trade, in that trade's place); a replaced trade takes its
 * place back from the trade that replaced it; a cleared one gets its players back.
 */
export const undoDock = (s: DockState): DockState => {
  const u = s.undo
  if (!u) return s
  const done = { ...s, undo: null, toast: 0 }
  if (u.kind === 'cleared') return { ...done, trades: s.trades.map((t) => (t.id === u.trade.id ? { ...t, deal: u.trade.deal } : t)) }
  if (u.kind === 'replaced') {
    if (!s.trades.some((t) => t.id === u.by)) return done
    return { ...done, open: s.open === u.by ? u.trade.id : s.open, trades: s.trades.map((t) => (t.id === u.by ? u.trade : t)) }
  }
  // Restored from inside an empty trade: it takes that trade's place.
  const host = openTrade(s)
  if (host && !dealActive(host.deal)) return { ...done, open: u.trade.id, focus: null, trades: s.trades.map((t) => (t.id === host.id ? u.trade : t)) }
  // From the notice: back in its place, if there is room (an empty trade makes room).
  let trades = s.trades
  if (trades.length >= MAX_TRADES) {
    const idle = trades.find((t) => !dealActive(t.deal))
    if (!idle) return done
    trades = trades.filter((t) => t.id !== idle.id)
  }
  const at = Math.min(u.index, trades.length)
  trades = [...trades.slice(0, at), u.trade, ...trades.slice(at)]
  const reopen = u.wasOpen && !s.open
  return { ...done, trades, open: reopen ? u.trade.id : s.open, focus: reopen ? null : u.trade.id }
}

/** Let the notice go: a replace or clear is settled; a discarded trade stays restorable from an empty trade. */
export const dismissUndo = (s: DockState): DockState => ({ ...s, undo: s.undo?.kind === 'discarded' ? s.undo : null, toast: 0 })
