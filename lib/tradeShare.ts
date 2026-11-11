// Sharing a trade as a picture and a link. The card is written for whoever is meant to read it: pitched to one
// partner, it carries only what the deal does for them, so an offer can be sent without showing your own hand; for
// the league, it is the trade itself and what it does for every team.
//
// Everything here is pure: what each block on the card would say, whether it may be shown and why not, and the card
// itself, built from only the blocks that are both allowed and switched on. The card is also exactly what the link
// stores (workers/grades/src/trade.ts), so nothing hidden on the picture travels with it, apart from the deal itself:
// the link opens the whole trade in the app (FAAB left off the picture included), where its teams are all named.
//
// In a pitch, a block is allowed only when it is good for the recipient: their lineup gain (and the week strip) when
// it is a gain, their playoff odds when they rise, a starting slot of theirs that gets better, consensus value that
// goes their way, FAAB they take in, and a buy-low player they get or a sell-high one they send. Your own gain, your
// ask, the odds they say yes, the model's tiers and signals never reach the card in any mode.

import type { Deal, DealRead } from './deal'
import type { Slot } from './lineup'
import { applyTrade, isWaiverFill, makeLineupEval, type Horizon, type WaiverFloor } from './trades'
import type { PlayerMap } from './types'
import { MAX_DEAL_PARTS, MAX_TRADE_META, parseTrade, tradeText } from '../workers/grades/src/tradeLink'

export type ShareBlockKey = 'lineup' | 'weeks' | 'odds' | 'need' | 'value' | 'faab' | 'momentum'
export const BLOCK_KEYS: ShareBlockKey[] = ['lineup', 'weeks', 'odds', 'need', 'value', 'faab', 'momentum']

/** Who the card is for: one partner, pitched to, or the whole league. */
export type Audience = { kind: 'pitch'; to: number } | { kind: 'league' }

export type ShareForm = { kind: 'buy-low' | 'sell-high'; name: string; text: string }

/** What is known about a deal for one recipient. In the league view only `read` and `deal` matter. */
export type ShareFacts = {
  deal: Deal
  read: DealRead
  /**
   * The recipient's playoff and title odds change (two-team deals), with their playoff odds after it when known:
   * undefined while simulating, null when there is none.
   */
  leverage?: { playoffs: number; title: number; after?: number } | null
  /** False when the sender is not in the deal: odds are simulated only for two-team trades they are in. */
  mine?: boolean
  /** The recipient's starting slot that improves most this week. */
  fill?: { slot: string; before: number; after: number } | null
  /** The recipient's consensus value in minus out, pts/wk; null when there are no consensus prices. */
  consensus?: number | null
  /** Recent form, by player: only the ones that read as buy-low or sell-high. */
  form: Record<string, ShareForm>
}

export type CardStat = { key: ShareBlockKey; label: string; value: string; unit: string | null; sub: string | null; tone: 'pos' | 'neg' | 'neutral' }

/** One block in the export menu: what it would show, and whether it may. */
export type BlockState = {
  key: ShareBlockKey
  /** The menu's name for it. */
  label: string
  available: boolean
  /** Why it is off the card, when it is ("their lineup gets worse"). */
  reason: string | null
  /** What it puts on the card, when available. */
  stats: CardStat[]
}

export const BLOCK_LABEL: Record<ShareBlockKey, string> = {
  lineup: 'Lineup gain',
  weeks: 'Week-by-week strip',
  odds: 'Playoff odds',
  need: 'Position filled',
  value: 'Consensus value',
  faab: 'FAAB received',
  momentum: 'Buy low / sell high',
}

/** Change in probability as signed points, one place: +4.1. */
const pts1 = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}`
/** A probability as a whole percentage, kept off 0 and 100 unless it is there: 48%. */
const pct0 = (p: number) => `${p > 0 && p < 0.005 ? '<1' : p < 1 && p > 0.995 ? '>99' : Math.round(p * 100)}%`

/** A gain this small reads as no change. */
const EDGE = 0.1
/** Playoff odds must move half a point to count. */
const ODDS_EDGE = 0.005

const sideOf = (read: DealRead, rid: number) => read.sides.find((s) => s.rosterId === rid) ?? null

/** Buy-low players the recipient takes in and sell-high ones they send: timing on their side. */
export const favourableForm = (facts: ShareFacts, rid: number) => {
  const side = sideOf(facts.read, rid)
  if (!side) return [] as { id: string; form: ShareForm }[]
  return [
    ...side.receives.filter((id) => facts.form[id]?.kind === 'buy-low').map((id) => ({ id, form: facts.form[id] })),
    ...side.sends.filter((id) => facts.form[id]?.kind === 'sell-high').map((id) => ({ id, form: facts.form[id] })),
  ]
}

/** Every block, for this audience: what it would show and whether it may be shown. */
export const shareBlocks = (audience: Audience, facts: ShareFacts, names: (rid: number) => string): BlockState[] => {
  const off = (key: ShareBlockKey, reason: string): BlockState => ({ key, label: BLOCK_LABEL[key], available: false, reason, stats: [] })
  const on = (key: ShareBlockKey, stats: CardStat[]): BlockState => ({ key, label: BLOCK_LABEL[key], available: true, reason: null, stats })

  if (audience.kind === 'league') {
    // The trade itself and every team's lineup change, as the league would see it: nothing is anyone's pitch.
    const sides = facts.read.sides.filter((s) => s.receives.length || s.sends.length || s.faab)
    const lineup = on(
      'lineup',
      sides.map((s) => ({ key: 'lineup', label: names(s.rosterId), value: pts1(s.lineup), unit: '/wk', sub: `lineup · better ${s.weeksBetter} of ${s.perWeek.length} wks`, tone: s.lineup > EDGE ? 'pos' : s.lineup < -EDGE ? 'neg' : 'neutral' })),
    )
    const pitchOnly = 'only in a pitch to one team'
    return [lineup, off('weeks', pitchOnly), off('odds', pitchOnly), off('need', pitchOnly), off('value', pitchOnly), off('faab', pitchOnly), off('momentum', pitchOnly)]
  }

  const rid = audience.to
  const side = sideOf(facts.read, rid)
  if (!side) return BLOCK_KEYS.map((k) => off(k, 'not in this trade'))
  const two = facts.deal.teams.length === 2
  const m = side.perWeek.length
  const out: BlockState[] = []

  // Their lineup, per week over the horizon, and how many of those weeks it is better: said only when most are.
  const gain = side.lineup > EDGE
  out.push(
    gain
      ? on('lineup', [{ key: 'lineup', label: 'Lineup', value: pts1(side.lineup), unit: 'pts/wk', sub: m > 1 && side.weeksBetter > m / 2 ? `better ${side.weeksBetter} of ${m} weeks` : null, tone: 'pos' }])
      : off('lineup', side.lineup < -EDGE ? 'their lineup gets worse' : 'their lineup barely moves'),
  )
  out.push(gain ? (m >= 2 ? on('weeks', []) : off('weeks', 'only one week left')) : off('weeks', 'shown only with a lineup gain'))

  // Playoff odds, from the same simulated seasons before and after: two teams only. The change is in percentage
  // points, written "pt" as the trade cards write it, and the odds themselves go underneath, so "+11.6" never reads
  // as fantasy points.
  const lev = facts.leverage
  if (!two || facts.mine === false) out.push(off('odds', 'odds are simulated only for two-team trades you’re in'))
  else if (lev === undefined) out.push(off('odds', 'still working out the odds'))
  else if (lev === null) out.push(off('odds', 'no season forecast for this league'))
  else if (lev.playoffs >= ODDS_EDGE) {
    const range = lev.after != null ? `${pct0(lev.after - lev.playoffs)} → ${pct0(lev.after)}` : null
    const title = lev.title >= 0.0005 ? `title ${pts1(lev.title * 100)} pt` : null
    out.push(on('odds', [{ key: 'odds', label: 'Playoff odds', value: pts1(lev.playoffs * 100), unit: 'pt', sub: [range, title].filter(Boolean).join(' · ') || null, tone: 'pos' }]))
  } else if (lev.title >= ODDS_EDGE) out.push(on('odds', [{ key: 'odds', label: 'Title odds', value: pts1(lev.title * 100), unit: 'pt', sub: null, tone: 'pos' }]))
  else out.push(off('odds', lev.playoffs <= -ODDS_EDGE ? 'their playoff odds drop' : 'their playoff odds hold steady'))

  const fill = facts.fill
  out.push(
    fill && fill.after - fill.before > 0.05
      ? on('need', [{ key: 'need', label: `Fills ${fill.slot}`, value: `${fill.before.toFixed(1)} → ${fill.after.toFixed(1)}`, unit: 'pts', sub: 'this week’s starter', tone: 'pos' }])
      : off('need', 'no starting spot of theirs improves'),
  )

  const value = facts.consensus
  out.push(
    value == null
      ? off('value', 'no consensus rankings')
      : value > EDGE
        ? on('value', [{ key: 'value', label: 'Consensus value', value: pts1(value), unit: '/wk', sub: 'by expert rankings', tone: 'pos' }])
        : off('value', value < -EDGE ? 'consensus favours your side' : 'consensus calls it even'),
  )

  out.push(side.faab > 0 ? on('faab', [{ key: 'faab', label: 'FAAB in', value: `$${side.faab}`, unit: null, sub: null, tone: 'pos' }]) : off('faab', side.faab < 0 ? 'they would pay FAAB' : 'no FAAB comes their way'))

  const timing = favourableForm(facts, rid)
  if (timing.length) {
    const buys = timing.filter((t) => t.form.kind === 'buy-low')
    const sells = timing.filter((t) => t.form.kind === 'sell-high')
    const word = buys.length && sells.length ? 'Buy low, sell high' : buys.length ? 'Buy low' : 'Sell high'
    const lead = timing[0].form
    out.push(on('momentum', [{ key: 'momentum', label: 'Timing', value: word, unit: null, sub: `${lead.name}: ${lead.text}`, tone: 'pos' }]))
  } else out.push(off('momentum', 'no buy-low or sell-high on their side'))

  return out
}

// ---- The card ----

export type CardPlayer = {
  id: string
  name: string
  pos: string
  team: string | null
  /** Expected points per week, when shown. */
  ppw: number | null
  /** Timing in the recipient's favour, when shown. */
  tag: 'buy low' | 'sell high' | null
  /** Who sends him, in a deal of three or more. */
  from: string | null
}
export type CardSide = {
  rosterId: number
  /** "Emillionaires get". */
  head: string
  avatar: string | null
  players: CardPlayer[]
  /** FAAB this side takes in, when shown. */
  faab: number
  /** The recipient's side, drawn first and marked. */
  focus: boolean
}
export type TradeCard = {
  v: 1
  kind: 'pitch' | 'league'
  league: string
  leagueId: string
  season: string
  week: number
  provider: 'sleeper' | 'espn'
  /** The recipient, in a pitch. */
  to: string | null
  /** The sender's team, when they chose to sign it. */
  from: string | null
  sides: CardSide[]
  stats: CardStat[]
  /** The recipient's lineup change week by week, when shown. */
  strip: { week: number; delta: number }[] | null
  /**
   * With the strip, the recipient's lineup change a week over those weeks, as the Lineup figure states it (near weeks
   * count for more, so it is not the plain average of the bars): the strip draws it as its dashed line.
   */
  net?: number | null
  note: string | null
  /** The whole deal, whatever the card shows, so the link opens the trade that was offered. */
  deal: { moves: [string, number, number][]; faab: [number, number, number][] }
}

export type ShareOptions = {
  audience: Audience
  /** Blocks switched on or off by hand; a block left out follows its default (on when allowed). */
  include: Partial<Record<ShareBlockKey, boolean>>
  ppw: boolean
  faab: boolean
  sender: boolean
  note: string
}

export const NOTE_MAX = 90

export type ShareContext = {
  league: string
  leagueId: string
  season: string
  week: number
  provider: 'sleeper' | 'espn'
  me: number
  teams: Record<number, { name: string; avatar: string | null }>
  players: Record<string, { name: string; pos: string; team: string | null } | undefined>
  /** Expected points per week, by player. */
  ppw: Record<string, number>
}

/** Whether a block is on: allowed, and not switched off by hand. A block that is not allowed is never on. */
export const blockOn = (b: BlockState, include: ShareOptions['include']) => b.available && include[b.key] !== false

/**
 * Whether per-week projections are on by default: always for the league; in a pitch, only when what the recipient
 * takes in projects at least as well as what they send, so the numbers never argue against the offer unasked.
 */
export const ppwDefault = (audience: Audience, read: DealRead, ppw: Record<string, number>) => {
  if (audience.kind === 'league') return true
  const side = sideOf(read, audience.to)
  if (!side) return false
  const sum = (ids: string[]) => ids.reduce((a, id) => a + (ppw[id] ?? 0), 0)
  return sum(side.receives) >= sum(side.sends)
}

/** A note as the card takes it: one line, no control characters, at most NOTE_MAX characters. */
export const cleanNote = (s: string) =>
  s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NOTE_MAX)

/** The card: the trade, and of the blocks only those that are allowed and on. */
export const buildCard = (ctx: ShareContext, facts: ShareFacts, blocks: BlockState[], opts: ShareOptions): TradeCard => {
  const { deal, read } = facts
  const pitch = opts.audience.kind === 'pitch' ? opts.audience.to : null
  const name = (rid: number) => ctx.teams[rid]?.name ?? `Team ${rid}`
  // Unsigned, a pitch names the sender nowhere; the league's view of a trade names every team in it.
  const anon = (rid: number) => !opts.sender && pitch != null && rid === ctx.me
  const on = new Map(blocks.map((b) => [b.key, blockOn(b, opts.include)]))
  const timing = pitch != null && on.get('momentum') ? new Map(favourableForm(facts, pitch).map((t) => [t.id, t.form.kind === 'buy-low' ? ('buy low' as const) : ('sell high' as const)])) : new Map()
  const many = deal.teams.length > 2

  // The recipient first, then the rest in the deal's order.
  const order = pitch != null ? [pitch, ...deal.teams.filter((t) => t !== pitch)] : [...deal.teams]
  const sides: CardSide[] = order
    .map((rid) => {
      const side = sideOf(read, rid)
      if (!side) return null
      let head = `${name(rid)} gets`
      if (anon(rid)) head = many ? 'Proposer gets' : `${name(pitch!)} sends`
      return {
        rosterId: rid,
        head,
        avatar: anon(rid) ? null : (ctx.teams[rid]?.avatar ?? null),
        players: side.receives.map((id) => {
          const p = ctx.players[id]
          const from = deal.moves.find((x) => x.player === id)?.from
          return {
            id,
            name: p?.name ?? id,
            pos: p?.pos ?? '',
            team: p?.team ?? null,
            ppw: opts.ppw && ctx.ppw[id] != null ? Math.round(ctx.ppw[id] * 10) / 10 : null,
            tag: timing.get(id) ?? null,
            from: many && from != null ? (anon(from) ? 'proposer' : name(from)) : null,
          }
        }),
        faab: opts.faab ? Math.max(0, deal.faab.filter((x) => x.to === rid).reduce((a, x) => a + x.dollars, 0)) : 0,
        focus: rid === pitch,
      }
    })
    // Every team in the deal has a side, even one whose only part is FAAB left off the card, so the picture and the
    // deal the link opens name the same teams.
    .filter((s): s is CardSide => !!s && (s.players.length > 0 || s.faab > 0 || deal.moves.some((m) => m.from === s.rosterId) || deal.faab.some((x) => (x.from === s.rosterId || x.to === s.rosterId) && x.dollars > 0)))

  const stats = blocks.filter((b) => on.get(b.key) && (opts.faab || b.key !== 'faab')).flatMap((b) => b.stats)
  const mine = pitch != null ? sideOf(read, pitch) : null
  const note = cleanNote(opts.note)
  return {
    v: 1,
    kind: pitch != null ? 'pitch' : 'league',
    league: ctx.league,
    leagueId: ctx.leagueId,
    season: ctx.season,
    week: ctx.week,
    provider: ctx.provider,
    to: pitch != null ? name(pitch) : null,
    from: opts.sender ? name(ctx.me) : null,
    sides,
    stats,
    strip: mine && on.get('weeks') ? mine.perWeek.map((w) => ({ week: w.week, delta: Math.round(w.delta * 10) / 10 })) : null,
    net: mine && on.get('weeks') ? Math.round(mine.lineup * 100) / 100 : null,
    note: note || null,
    // Always the whole deal, whatever the card shows: the link must open the trade that was offered.
    deal: {
      moves: deal.moves.map((m) => [m.player, m.from, m.to]),
      faab: deal.faab.filter((x) => x.dollars > 0).map((x) => [x.from, x.to, x.dollars]),
    },
  }
}

/** The words a link preview carries besides the picture: the worker writes the same from what it stores. */
export const cardText = (card: TradeCard) => tradeText(card)

/** The image's file name: the recipient, or the league, never the sender. */
export const cardFileName = (card: TradeCard, format: 'square' | 'og' | 'story') => {
  const who = (card.to ?? card.league).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'trade'
  return `trade-${who}-wk${card.week}${format === 'square' ? '' : `-${format}`}.png`
}

// ---- Where a starting slot gets better ----

/**
 * The recipient's starting slot that improves most in the first week, if any does by more than a twentieth of a
 * point: "RB2 7.0 → 8.5". A slot name used more than once is numbered.
 */
export const slotFill = (input: {
  slots: Slot[]
  players: PlayerMap
  horizon: Horizon
  floor: WaiverFloor
  capacity: number
  pts: Record<string, number>
  roster: string[]
  sends: string[]
  receives: string[]
}): ShareFacts['fill'] => {
  const { slots, players, horizon, floor, capacity, pts, roster, sends, receives } = input
  if (!horizon.length || !receives.length) return null
  const ev = makeLineupEval(slots, players, horizon[0].pts, floor)
  const week = horizon[0].pts
  const slotPts = (ids: string[]) => ev.assign(ids).assignments.map((p) => (p ? (isWaiverFill(p.id) ? p.pts : (week[p.id] ?? 0)) : 0))
  const before = slotPts(roster)
  const after = slotPts(applyTrade(roster, sends, receives, capacity, pts))
  let best: ShareFacts['fill'] = null
  let edge = 0.05
  for (let i = 0; i < after.length; i++) {
    const d = after[i] - (before[i] ?? 0)
    if (d > edge) {
      edge = d
      const same = slots.filter((s) => s.name === slots[i].name).length
      const nth = slots.slice(0, i + 1).filter((s) => s.name === slots[i].name).length
      best = { slot: same > 1 ? `${slots[i].name}${nth}` : slots[i].name, before: Math.round((before[i] ?? 0) * 10) / 10, after: Math.round(after[i] * 10) / 10 }
    }
  }
  return best
}

// ---- The deal in a link ----

/** A deal as a link carries it: `from.to.player` for each move and `from.to.$dollars` for each payment, comma-joined. */
export const encodeDeal = (d: { moves: [string, number, number][]; faab: [number, number, number][] }) =>
  [...d.moves.map(([p, f, t]) => `${f}.${t}.${p}`), ...d.faab.map(([f, t, dollars]) => `${f}.${t}.$${dollars}`)].join(',')

/** The deal back from a link, or null when it is not one (bad shape, too big, or moving nothing). */
export const decodeDeal = (s: string | null | undefined): Deal | null => parseTrade(s)

/**
 * What a link stores: the card's words and numbers as printed, and the deal for the app. Pictures stay behind; roster
 * and player ids go only as far as the deal the link opens already carries them, so the worker can check that the
 * deal is the one pictured. The title and description are not sent: the worker writes them from these fields.
 */
export const linkMeta = (card: TradeCard) => ({
    kind: card.kind,
    league: card.league.slice(0, 80),
    leagueId: card.leagueId,
    season: card.season,
    week: card.week,
    provider: card.provider,
    to: card.to?.slice(0, 60) ?? null,
    from: card.from?.slice(0, 60) ?? null,
    note: card.note,
    sides: card.sides.map((s) => ({
      rosterId: s.rosterId,
      head: s.head.slice(0, 80),
      focus: s.focus,
      faab: s.faab,
      players: s.players.map((p) => ({ id: p.id, name: p.name.slice(0, 60), pos: p.pos, team: p.team, ppw: p.ppw, tag: p.tag, from: p.from?.slice(0, 60) ?? null })),
    })),
    stats: card.stats.map((s) => ({ label: s.label.slice(0, 60), value: s.value, unit: s.unit, sub: s.sub?.slice(0, 90) ?? null, tone: s.tone })),
    strip: card.strip,
    net: card.strip ? (card.net ?? null) : null,
    trade: encodeDeal(card.deal),
})

/** Why a card cannot become a link, in words for the sender, or null when it can. The worker holds the same limits. */
export const linkProblem = (card: TradeCard): string | null => {
  const parts = card.deal.moves.length + card.deal.faab.length
  if (parts > MAX_DEAL_PARTS) return `This trade moves ${parts} players and payments, more than the ${MAX_DEAL_PARTS} a link can carry. Copy or download the image instead.`
  if (!parseTrade(encodeDeal(card.deal)) || JSON.stringify(linkMeta(card)).length > MAX_TRADE_META) return 'This trade can’t be put in a link. Copy or download the image instead.'
  return null
}
