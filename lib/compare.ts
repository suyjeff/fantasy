// The trade comparison: up to four deals side by side, to answer "which of these should I make?". Kept pure, so the
// comparison (components/TradeCompare), the builder's "Add to compare" and the tests all move the set the same way.
//
// What is kept is the deals, never their figures: a comparison opened next week prices them on next week's data. A
// deal whose players have since moved (a trade, a cut) is out of date, and says so, rather than being priced as if
// they had not.

import { dealActive, dealKey, type Deal, type DealFaab, type DealMove } from './deal'

export const MAX_COMPARE = 4

export type CompareItem = {
  /** Stable for the item's life: keys and the builder's link to it find it by this. */
  id: string
  deal: Deal
  /**
   * Its colour and letter (0 is A), kept while it is in the comparison: removing or moving another never repaints
   * it. A new item takes the lowest slot free.
   */
  slot: number
  /** When it was added, in ms. */
  at: number
}

export type CompareSet = CompareItem[]

export const SLOT_LETTERS = ['A', 'B', 'C', 'D'] as const
export const slotLetter = (slot: number) => SLOT_LETTERS[slot] ?? '?'

/** The storage key, per league: another league's comparison means nothing here. */
export const compareKey = (league: string) => `ff:compare:${league}`

export const findDeal = (set: CompareSet, deal: Deal): CompareItem | null => {
  const k = dealKey(deal)
  return set.find((i) => dealKey(i.deal) === k) ?? null
}

const freeSlot = (set: CompareSet) => {
  for (let s = 0; s < MAX_COMPARE; s++) if (!set.some((i) => i.slot === s)) return s
  return -1
}

export type AddResult = {
  set: CompareSet
  item: CompareItem | null
  status: 'added' | 'present' | 'full' | 'empty'
}

/** Add a deal. The same deal already in is left where it is; a full comparison takes nothing more. */
export const addCompare = (set: CompareSet, deal: Deal, now = Date.now()): AddResult => {
  if (!dealActive(deal) || deal.teams.length < 2) return { set, item: null, status: 'empty' }
  const same = findDeal(set, deal)
  if (same) return { set, item: same, status: 'present' }
  const slot = freeSlot(set)
  if (set.length >= MAX_COMPARE || slot < 0) return { set, item: null, status: 'full' }
  const item: CompareItem = {
    id: `c${now.toString(36)}${slot}`,
    deal,
    slot,
    at: now,
  }
  return { set: [...set, item], item, status: 'added' }
}

export const removeCompare = (set: CompareSet, id: string): CompareSet => set.filter((i) => i.id !== id)

/** Move an item one place left (-1) or right (1). Its slot, so its colour and letter, goes with it. */
export const moveCompare = (set: CompareSet, id: string, by: -1 | 1): CompareSet => {
  const i = set.findIndex((x) => x.id === id)
  const j = i + by
  if (i < 0 || j < 0 || j >= set.length) return set
  const out = [...set]
  ;[out[i], out[j]] = [out[j], out[i]]
  return out
}

/**
 * Put a changed deal in an item's place (the builder's "Update compare"), keeping its column and colour. Changed into
 * a deal another item already holds, the two are one: this item goes, the other stays.
 */
export const replaceCompare = (set: CompareSet, id: string, deal: Deal): CompareSet => {
  const it = set.find((i) => i.id === id)
  if (!it || !dealActive(deal)) return set
  const k = dealKey(deal)
  if (dealKey(it.deal) === k) return set
  if (set.some((i) => i.id !== id && dealKey(i.deal) === k)) return removeCompare(set, id)
  return set.map((i) => (i.id === id ? { ...i, deal } : i))
}

/**
 * The moves a deal can no longer make: a player who is not on the team sending him any more (traded, cut), or a move
 * to or from a team that has left the league. Empty for a deal that still stands.
 */
export const staleMoves = (deal: Deal, rosters: Record<number, string[]>): DealMove[] =>
  deal.moves.filter((m) => !(m.to in rosters) || !(rosters[m.from] ?? []).includes(m.player))

/**
 * The payments a deal can no longer make: every one from a team now paying more in all than it has left (its budget
 * spent on waivers since), or to or from a team that has left the league. Budgets unknown (no FAAB in this league, or
 * not read): only the teams are checked.
 */
export const staleFaab = (deal: Deal, rosters: Record<number, string[]>, remaining?: Record<number, number> | null): DealFaab[] => {
  const pays = deal.faab.filter((x) => x.dollars > 0)
  const owed = new Map<number, number>()
  for (const x of pays) owed.set(x.from, (owed.get(x.from) ?? 0) + x.dollars)
  const short = (team: number) => remaining?.[team] != null && owed.get(team)! > remaining[team]
  return pays.filter((x) => !(x.from in rosters) || !(x.to in rosters) || short(x.from))
}

// ---- Storage ----

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

const asDeal = (x: unknown): Deal | null => {
  if (!x || typeof x !== 'object') return null
  const d = x as Record<string, unknown>
  if (!Array.isArray(d.teams) || !d.teams.every(isNum)) return null
  if (!Array.isArray(d.moves) || !Array.isArray(d.faab)) return null
  const moves = d.moves.filter((m): m is DealMove => !!m && typeof m === 'object' && typeof m.player === 'string' && isNum(m.from) && isNum(m.to))
  const faab = d.faab.filter((f): f is Deal['faab'][number] => !!f && typeof f === 'object' && isNum(f.from) && isNum(f.to) && isNum(f.dollars))
  return { teams: d.teams as number[], moves, faab }
}

/** What was stored, read defensively: anything malformed is dropped, duplicates merge, slots never collide. */
export const parseCompare = (raw: string | null | undefined): CompareSet => {
  if (!raw) return []
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return []
  }
  const items = data && typeof data === 'object' && Array.isArray((data as { items?: unknown }).items) ? (data as { items: unknown[] }).items : []
  let out: CompareSet = []
  for (const x of items) {
    if (!x || typeof x !== 'object') continue
    const r = x as Record<string, unknown>
    const deal = asDeal(r.deal)
    if (!deal || !dealActive(deal) || out.length >= MAX_COMPARE || findDeal(out, deal)) continue
    const want = isNum(r.slot) && r.slot >= 0 && r.slot < MAX_COMPARE && !out.some((i) => i.slot === r.slot) ? r.slot : freeSlot(out)
    const id = typeof r.id === 'string' && r.id && !out.some((i) => i.id === r.id) ? r.id : `c${out.length}${want}`
    out = [...out, { id, deal, slot: want, at: isNum(r.at) ? r.at : 0 }]
  }
  return out
}

export const serializeCompare = (set: CompareSet) => JSON.stringify({ v: 1, items: set })

// ---- Reading the comparison ----

/**
 * Which of a row's values are best: the highest (or, `better: 'low'`, the lowest), every one within `tie` of it. None
 * when fewer than two values are known, or when they all tie, so a mark always tells the columns apart.
 */
export const bestOf = (values: (number | null | undefined)[], better: 'high' | 'low' = 'high', tie = 0.05): number[] => {
  const known = values.map((v, i) => [v, i] as const).filter((x): x is readonly [number, number] => isNum(x[0]))
  if (known.length < 2) return []
  const sign = better === 'high' ? 1 : -1
  const top = Math.max(...known.map(([v]) => sign * v))
  const best = known.filter(([v]) => top - sign * v <= tie).map(([, i]) => i)
  return best.length === known.length ? [] : best
}

export type VerdictCol = {
  /** "Trade A". */
  label: string
  /** Points per week for your lineup (with the FAAB, when FAAB moves); null while unpriced. */
  lineup: number | null
  /** Every other team saying yes; null while unknown. */
  odds: number | null
  /** Change in your playoff odds, 0 to 1 scale; null or undefined when not simulated. */
  playoffs?: number | null
  /** Out of date or otherwise not a trade that can be made: left out of the verdict. */
  out?: boolean
  /**
   * Why `lineup` will never come, where it will not (rather than not yet): 'season', no weeks left to project;
   * 'yours', the deal leaves your team out. Left out of the verdict's comparisons.
   */
  unpriced?: 'season' | 'yours'
}

const names = (cols: VerdictCol[], idx: number[]) => {
  const ls = idx.map((i) => cols[i].label)
  if (ls.length === 1) return ls[0]
  // "Trades A and B": the word once, then the letters.
  const letters = ls.map((l) => l.replace(/^Trade /, ''))
  return `Trades ${letters.slice(0, -1).join(', ')} and ${letters[letters.length - 1]}`
}
const verb = (idx: number[], one: string, many: string) => (idx.length === 1 ? one : many)
const signed = (v: number, d = 1) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}`
const pctOf = (p: number) => `${Math.round(p * 100)}%`

/**
 * The comparison in a sentence, read first: which trade does most for your lineup, which is likeliest to be accepted,
 * and (when it is a third trade) which does most for your playoff odds. "Trade B adds the most this season (+3.1/wk);
 * Trade A is likeliest to be accepted (41%)."
 */
export const verdictText = (cols: VerdictCol[]): string => {
  const live = cols.map((c, i) => [c, i] as const).filter(([c]) => !c.out)
  if (!cols.length) return ''
  if (!live.length) return cols.length === 1 ? `${cols[0].label} is out of date: open it to fix it, or remove it.` : 'Every trade here is out of date: open one to fix it, or remove them.'
  const priced = live.filter(([c]) => c.lineup != null)
  if (!priced.length) {
    // Still coming for one at least: say so. Otherwise none of them can be priced, and saying "Pricing…" would never end.
    if (live.some(([c]) => !c.unpriced)) return 'Pricing…'
    const one = live.length === 1
    if (live.some(([c]) => c.unpriced === 'season')) return `There are no weeks left to project, so ${one ? 'this trade' : 'these trades'} cannot be priced for your lineup.`
    return one ? `${live[0][0].label} leaves your team out, so there is no lineup of yours to price it on.` : 'None of these trades includes your team, so there is no lineup of yours to price them on.'
  }
  if (cols.length === 1) {
    const c = cols[0]
    const odds = c.odds != null ? `, ${pctOf(c.odds)} to be accepted` : ''
    return `${c.label}: ${signed(c.lineup!)}/wk for your lineup${odds}. Add another trade to compare it with.`
  }
  // Best by each measure, among the trades that can be made. Ties within 0.1/wk (or 2 points of odds) share it.
  const pick = (get: (c: VerdictCol) => number | null | undefined, tie: number) => {
    const vals = cols.map((c) => (c.out || c.unpriced ? null : get(c)))
    const known = vals.filter(isNum)
    if (!known.length) return { idx: [] as number[], top: null as number | null }
    const top = Math.max(...known)
    return {
      idx: vals.map((v, i) => (isNum(v) && top - v <= tie ? i : -1)).filter((i) => i >= 0),
      top,
    }
  }
  const gain = pick((c) => c.lineup, 0.1)
  const yes = pick((c) => c.odds, 0.02)
  const po = pick((c) => c.playoffs, 0.0025)
  const parts: string[] = []
  // The trades the measures compare: those that can be made and priced.
  const all = live.filter(([c]) => !c.unpriced).length
  if (gain.top != null && gain.top <= 0.05) parts.push(`None of these makes your lineup better; ${names(cols, gain.idx)} ${verb(gain.idx, 'costs', 'cost')} it least (${signed(gain.top)}/wk)`)
  else if (gain.top != null)
    parts.push(
      gain.idx.length === all && all > 1
        ? `${names(cols, gain.idx)} add about the same this season (${signed(gain.top)}/wk)`
        : `${names(cols, gain.idx)} ${verb(gain.idx, 'adds', 'add')} the most this season (${signed(gain.top)}/wk)`,
    )
  const sameAs = (a: number[], b: number[]) => a.length === b.length && a.every((i) => b.includes(i))
  if (yes.top != null && yes.idx.length < all) {
    if (sameAs(yes.idx, gain.idx) && parts.length) parts[0] += ` and ${verb(yes.idx, 'is', 'are')} likeliest to be accepted (${pctOf(yes.top)})`
    else parts.push(`${names(cols, yes.idx)} ${verb(yes.idx, 'is', 'are')} likeliest to be accepted (${pctOf(yes.top)})`)
  }
  // The playoff odds only when they point to a trade the other two do not name, and the change is worth a mention.
  if (po.top != null && po.top >= 0.005 && po.idx.length < all && !po.idx.some((i) => gain.idx.includes(i) || yes.idx.includes(i)))
    parts.push(`${names(cols, po.idx)} ${verb(po.idx, 'does', 'do')} most for your playoff odds (${signed(po.top * 100)}pt)`)
  return `${parts.join('; ')}.`
}
