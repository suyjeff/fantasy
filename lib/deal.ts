// A trade of any shape: two teams or several, players moving in every direction, FAAB moving with them. Each team
// is priced the way the two-team scorer prices one (lib/trades): its best lineup week by week before and
// after, with the extra bodies cut; trade value as managers price players (lib/currency); and FAAB at a
// discounted, uncertain value.
//
// FAAB in a trade. Managers rarely price waiver money like players: it buys optionality, not points. So a dollar
// counts at a fraction of what it buys on the wire (lib/faab), lower still for a team flush with budget and
// higher for one nearly out, which might actually need it. The fraction itself is a guess, so FAAB carries a
// range, from half to one and a half times the middle estimate, and the totals carry it through.

import type { Analysis } from './analysis'
import { faabTradeValue, FAAB_TRADE_CAP, type Faab } from './faab'
import { tradeValue } from './currency'
import { applyTrade, makeHorizonEval, wmean, type Horizon, type TradeTeam, type WaiverFloor } from './trades'
import type { Slot } from './lineup'
import type { PlayerMap } from './types'

export type DealMove = { player: string; from: number; to: number }
export type DealFaab = { from: number; to: number; dollars: number }
export type Deal = { teams: number[]; moves: DealMove[]; faab: DealFaab[] }

export const emptyDeal = (teams: number[]): Deal => ({ teams, moves: [], faab: [] })

export type DealSide = {
  rosterId: number
  receives: string[]
  sends: string[]
  /** Net FAAB in, in dollars (negative: paid out). */
  faab: number
  /** Points per week added to the best lineup, averaged over the horizon, and by week. */
  lineup: number
  perWeek: { week: number; delta: number }[]
  weeksBetter: number
  /** Trade value in minus out, as managers price players (their own drafted players dear, streamers cheap). */
  value: number
  /** What the FAAB is worth to this team, pts/wk: low, middle and high. */
  faabValue: { low: number; mid: number; high: number }
  /** Lineup plus FAAB at its middle value: the number to read first. */
  net: { low: number; mid: number; high: number }
  /** Players this team would cut to stay under the roster limit. */
  cuts: string[]
  /** Roster too big even after cuts, or a player who is not on the team sending him. */
  problems: string[]
}

export type DealRead = { sides: DealSide[]; valid: boolean; weeks: number[] }

/** How much a team cares about FAAB, from 0.35 (flush) to 0.85 (nearly out): the share of its waiver value it counts. */
export const faabCare = (f: Faab, rosterId: number) => {
  const left = (f.remaining[rosterId] ?? 0) / Math.max(1, f.budget)
  return Math.min(0.85, Math.max(0.35, 0.85 - 0.5 * left))
}

export type DealInput = {
  slots: Slot[]
  players: PlayerMap
  horizon: Horizon
  floor: WaiverFloor
  capacity: number
  pts: Record<string, number>
  /** What each player fetches in a trade (currency.ts tradeMarket). */
  tradeMarket: Record<string, number>
  rosters: Record<number, string[]>
  currency?: Analysis['currency']
  faab?: Faab | null
}

/** Price every team in a deal. */
export const readDeal = (deal: Deal, input: DealInput): DealRead => {
  const { slots, players, horizon, floor, capacity, pts, tradeMarket: market, rosters, currency, faab } = input
  const ev = makeHorizonEval(slots, players, horizon, floor)
  const weeks = horizon.map((h) => h.week)
  const sides = deal.teams.map((rid): DealSide => {
    const roster = rosters[rid] ?? []
    const receives = deal.moves.filter((m) => m.to === rid).map((m) => m.player)
    const sends = deal.moves.filter((m) => m.from === rid).map((m) => m.player)
    const problems: string[] = []
    for (const id of sends) if (!roster.includes(id)) problems.push(`${players[id]?.name ?? id} is not on this roster`)
    const after = applyTrade(roster, sends, receives, capacity, pts)
    const cuts = roster.filter((id) => !sends.includes(id) && !after.includes(id))
    const base = ev.perWeek(roster)
    const next = ev.perWeek(after)
    const perWeek = weeks.map((week, i) => ({ week, delta: Math.round((next[i] - base[i]) * 100) / 100 }))
    const lineup =
      Math.round(
        wmean(
          perWeek.map((w) => w.delta),
          ev.weights,
        ) * 100,
      ) / 100
    const dollars = deal.faab.reduce((a, x) => a + (x.to === rid ? x.dollars : 0) - (x.from === rid ? x.dollars : 0), 0)
    // Each transfer moves on its own, so what a team sends must be in its budget, whatever it also receives.
    const sent = deal.faab.reduce((a, x) => a + (x.from === rid ? x.dollars : 0), 0)
    if (faab && sent > (faab.remaining[rid] ?? 0)) problems.push(`only $${faab.remaining[rid] ?? 0} of FAAB left`)
    const care = faab ? faabCare(faab, rid) / 0.6 : 0
    const mid = faab && dollars ? Math.sign(dollars) * Math.min(FAAB_TRADE_CAP, faabTradeValue(faab, Math.abs(dollars)) * care) : 0
    const faabValue = { low: mid * (mid >= 0 ? 0.5 : 1.5), mid, high: mid * (mid >= 0 ? 1.5 : 0.5) }
    return {
      rosterId: rid,
      receives,
      sends,
      faab: dollars,
      lineup,
      perWeek,
      weeksBetter: perWeek.filter((w) => w.delta > 0.05).length,
      value: Math.round((tradeValue(receives, market, currency, true) - tradeValue(sends, market, currency, false)) * 100) / 100,
      faabValue,
      net: { low: lineup + faabValue.low, mid: lineup + faabValue.mid, high: lineup + faabValue.high },
      cuts,
      problems,
    }
  })
  const valid = (deal.moves.length > 0 || deal.faab.some((x) => x.dollars > 0)) && sides.every((s) => !s.problems.length)
  return { sides, valid, weeks }
}

/**
 * Every move and payment runs between two teams still in the deal, and nobody trades with themselves. A $0 payment
 * stays: it is a destination picked before the amount (setDealFaab), and moves nothing until a figure goes in.
 */
export const tidyDeal = (deal: Deal): Deal => ({
  ...deal,
  moves: deal.moves.filter((m) => m.from !== m.to && deal.teams.includes(m.from) && deal.teams.includes(m.to)),
  faab: deal.faab.filter((x) => x.from !== x.to && deal.teams.includes(x.from) && deal.teams.includes(x.to)),
})

/**
 * One spelling per deal, whatever order its teams, players and payments went in, so the same trade built twice is
 * recognised as the same (the dock and the comparison both match deals by it). A $0 payment (a destination picked
 * before the amount) moves nothing and is left out.
 */
export const dealKey = (d: Deal): string => {
  const teams = [...d.teams].sort((a, b) => a - b)
  const moves = d.moves.map((m) => `${m.player}:${m.from}>${m.to}`).sort()
  const faab = d.faab
    .filter((x) => x.dollars > 0)
    .map((x) => `${x.from}>${x.to}:${x.dollars}`)
    .sort()
  return `${teams.join(',')}|${moves.join(',')}|${faab.join(',')}`
}

/** Rosters by team, from the analysis (only its teams, so a caller can key on those alone). */
export const rostersOf = (analysis: Pick<Analysis, 'teams'>) => Object.fromEntries(analysis.teams.map((t: TradeTeam) => [t.rosterId, t.players])) as Record<number, string[]>

// ---- Editing a deal ----
// The builder's edits, kept pure so the dock, the inline pickers and the tests all move a deal the same way.

/** A two-team deal from a suggested trade: what you give goes to them, what you get comes to you. */
export const dealFromIdea = (me: number, partner: number, give: string[], get: string[]): Deal => ({
  teams: [me, partner],
  moves: [...give.map((player) => ({ player, from: me, to: partner })), ...get.map((player) => ({ player, from: partner, to: me }))],
  faab: [],
})

/**
 * Put a player in the deal, or take him out if he is in it. A new one leaves the team that has him: one of yours goes
 * to the first partner, anyone else's comes to you (or, in a deal you are not in, to the first other team).
 */
export const togglePlayer = (deal: Deal, id: string, rosters: Record<number, string[]>, me: number): Deal => {
  if (deal.moves.some((m) => m.player === id)) return { ...deal, moves: deal.moves.filter((m) => m.player !== id) }
  const from = deal.teams.find((t) => rosters[t]?.includes(id))
  if (from == null) return deal
  const others = deal.teams.filter((t) => t !== from)
  if (!others.length) return deal
  const to = from === me ? others[0] : others.includes(me) ? me : others[0]
  return { ...deal, moves: [...deal.moves, { player: id, from, to }] }
}

/** Send a player somewhere else in a three- or four-team deal. */
export const redirectPlayer = (deal: Deal, id: string, to: number): Deal => ({ ...deal, moves: deal.moves.map((m) => (m.player === id && m.from !== to ? { ...m, to } : m)) })

/**
 * Each team sends at most one FAAB payment. Picking its destination before the amount is remembered as a $0 payment,
 * so the choice survives until a figure goes in.
 */
export const setDealFaab = (deal: Deal, from: number, dollars: number, to?: number): Deal => {
  const rest = deal.faab.filter((x) => x.from !== from)
  const dest = to ?? deal.faab.find((x) => x.from === from)?.to ?? deal.teams.find((t) => t !== from)
  if (dest == null) return deal
  return { ...deal, faab: dollars > 0 || to != null ? [...rest, { from, to: dest, dollars }] : rest }
}

export const addDealTeam = (deal: Deal, id: number): Deal => (deal.teams.includes(id) ? deal : tidyDeal({ ...deal, teams: [...deal.teams, id] }))
export const removeDealTeam = (deal: Deal, id: number): Deal => tidyDeal({ ...deal, teams: deal.teams.filter((t) => t !== id) })

/** Whether anything moves yet: a player, or some FAAB. */
export const dealActive = (deal: Deal) => deal.moves.length > 0 || deal.faab.some((x) => x.dollars > 0)

const signed = (v: number) => (Math.abs(v) < 0.05 ? '0.0' : `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}`)

/**
 * The deal in one short line, for the minimized builder: "You ⇄ Team X · 2 for 1 · +3.1/wk". Two teams count what you
 * send against what you get; a bigger deal counts the players moving. `lineup` is your lineup gain per week, when priced.
 */
export const dealSummary = (deal: Deal, me: number, name: (rosterId: number) => string, lineup?: number | null): string => {
  const partners = deal.teams.filter((t) => t !== me)
  if (!partners.length) return 'Pick a partner'
  const head = `You ⇄ ${partners.map(name).join(' + ')}`
  if (!dealActive(deal)) return `${head} · pick players`
  const parts = [head]
  if (partners.length === 1) {
    const out = deal.moves.filter((m) => m.from === me).length
    const back = deal.moves.filter((m) => m.to === me).length
    if (out || back) parts.push(`${out} for ${back}`)
  } else parts.push(`${deal.moves.length} player${deal.moves.length === 1 ? '' : 's'}`)
  const paid = deal.faab.reduce((a, x) => a + (x.to === me ? x.dollars : 0) - (x.from === me ? x.dollars : 0), 0)
  if (paid) parts.push(`${paid > 0 ? '+' : '−'}$${Math.abs(paid)}`)
  if (lineup != null && Number.isFinite(lineup)) parts.push(`${signed(lineup)}/wk`)
  return parts.join(' · ')
}
