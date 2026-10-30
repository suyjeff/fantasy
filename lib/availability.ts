// Who can be had: every player's standing in this league (yours, another team's, on waivers, free), and the
// filters and sorts the free-agent browser and the Players page share.

import type { PlayerMap, SleeperTransaction, TrimmedPlayer } from './types'

const DAY = 24 * 3600_000

export type Availability =
  | { kind: 'mine'; rosterId: number }
  | { kind: 'team'; rosterId: number }
  /** Dropped lately and still on waivers: a claim, not a free pickup, until `clears`. */
  | { kind: 'waivers'; clears: number }
  | { kind: 'fa' }

/**
 * Players on waivers now, each with when he clears: anyone dropped within the league's waiver period and not picked
 * up since. Trades move players between rosters without sending them to waivers, so their drops do not count.
 * Sleeper's API has no waiver flag of its own; this is the rule it applies, read off the league's transactions.
 */
export const waiverClears = (transactions: SleeperTransaction[], rosteredBy: Record<string, number>, clearDays: number, now: number): Record<string, number> => {
  const out: Record<string, number> = {}
  if (!(clearDays > 0)) return out
  const since = now - clearDays * DAY
  for (const t of transactions) {
    if (t.type === 'trade' || t.status !== 'complete' || !t.drops || t.created < since) continue
    for (const id of Object.keys(t.drops)) {
      // Picked up again since (by anyone, the same team included): rostered, not on waivers.
      if (rosteredBy[id] != null) continue
      const clears = t.created + clearDays * DAY
      if (clears > now) out[id] = Math.max(out[id] ?? 0, clears)
    }
  }
  return out
}

/** The league's waiver period in days: Sleeper's `waiver_clear_days`, two when the league does not say. */
export const clearDaysOf = (settings: Record<string, unknown> | undefined) => {
  const v = settings?.waiver_clear_days
  return typeof v === 'number' && v >= 0 ? v : 2
}

export const availabilityOf = (id: string, rosteredBy: Record<string, number>, myRosterId: number | null, waivers: Record<string, number>): Availability => {
  const r = rosteredBy[id]
  if (r != null) return r === myRosterId ? { kind: 'mine', rosterId: r } : { kind: 'team', rosterId: r }
  return waivers[id] != null ? { kind: 'waivers', clears: waivers[id] } : { kind: 'fa' }
}

export type OwnFilter = 'all' | 'available' | 'rostered' | 'mine'

/** Available means anyone you can add: a free agent now, or a waiver claim. */
export const matchesOwn = (a: Availability, f: OwnFilter) =>
  f === 'all' ? true : f === 'available' ? a.kind === 'fa' || a.kind === 'waivers' : f === 'rostered' ? a.kind === 'mine' || a.kind === 'team' : a.kind === 'mine'

export const POS_FILTERS = ['ALL', 'QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'FLEX'] as const
export type PosFilter = (typeof POS_FILTERS)[number]

/** FLEX takes whatever this league's flex slot takes (running backs, receivers and tight ends in most). */
export const matchesPos = (p: Pick<TrimmedPlayer, 'pos' | 'fpos'>, f: PosFilter, flex: string[] = ['RB', 'WR', 'TE']) => {
  if (f === 'ALL') return true
  const fpos = p.fpos?.length ? p.fpos : [p.pos]
  if (f === 'FLEX') return fpos.some((x) => flex.includes(x))
  return p.pos === f || fpos.includes(f)
}

/** Name or NFL team, case and accents aside; every word must match somewhere ("det qb" finds Detroit's). */
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
export const matchesQuery = (p: Pick<TrimmedPlayer, 'name' | 'team' | 'pos'>, q: string) => {
  const words = fold(q).split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const hay = `${fold(p.name)} ${fold(p.team ?? '')} ${p.pos.toLowerCase()}`
  return words.every((w) => hay.includes(w))
}

/** This week's projection, rest-of-season value, Sleeper adds in the last day, gain to your lineup. */
export type FaSort = 'week' | 'value' | 'trend' | 'gain'

/** The numbers a sort reads. Missing numbers sort last, whichever way. */
export type FaMetrics = {
  week: Record<string, number>
  value: Record<string, number>
  trend: Record<string, number>
  gain: Record<string, number>
}

/** Best first by the chosen number, then by rest-of-season value, then by name, so equal rows hold still between renders. */
export const sortPlayers = (ids: string[], sort: FaSort, m: FaMetrics, players: PlayerMap) => {
  // Best first, with a missing number below every real one.
  const desc = (x: number | undefined, y: number | undefined) => {
    const hx = x != null && !Number.isNaN(x)
    const hy = y != null && !Number.isNaN(y)
    return hx && hy ? y! - x! : hx ? -1 : hy ? 1 : 0
  }
  return [...ids].sort(
    (a, b) => desc(m[sort][a], m[sort][b]) || desc(m.value[a], m.value[b]) || (players[a]?.name ?? a).localeCompare(players[b]?.name ?? b),
  )
}

/**
 * The browsable pool: every player at a fantasy position who is on an NFL team or a fantasy roster, filtered by
 * position, standing and a search. Players with no numbers stay in (they sort to the end), so nobody is missing.
 */
export const filterPlayers = (input: {
  players: PlayerMap
  pool?: string[]
  pos: PosFilter
  own: OwnFilter
  query: string
  flex?: string[]
  /** Positions this league starts; a player at none of them (a kick returner in a league with no IDP) is left out. */
  positions?: string[]
  /** Anyone failing this is left out unless a search names him: the long tail with no projection at all. */
  relevant?: (id: string) => boolean
  status: (id: string) => Availability
}) => {
  const { players, pos, own, query, flex, positions, relevant, status } = input
  const searching = !!query.trim()
  const ids = input.pool ?? Object.keys(players)
  const out: string[] = []
  for (const id of ids) {
    const p = players[id]
    if (!p) continue
    if (positions && !(p.fpos?.length ? p.fpos : [p.pos]).some((x) => positions.includes(x))) continue
    if (!matchesPos(p, pos, flex)) continue
    const a = status(id)
    if (!matchesOwn(a, own)) continue
    // Free agents off every NFL roster (retired, unsigned) only clutter the list; anyone rostered here stays.
    if (!p.team && a.kind !== 'mine' && a.kind !== 'team') continue
    if (!matchesQuery(p, query)) continue
    if (!searching && relevant && a.kind !== 'mine' && a.kind !== 'team' && !relevant(id)) continue
    out.push(id)
  }
  return out
}

/** "clears Thu" for a waiver chip, in the viewer's own week. */
export const clearsLabel = (clears: number, now = Date.now()) => {
  if (new Date(clears).toDateString() === new Date(now).toDateString()) return 'clears today'
  return `clears ${new Date(clears).toLocaleDateString(undefined, { weekday: 'short' })}`
}
