// What the last week or two does to a trade conversation, which a season-long model deliberately ignores.
//
// Two habits, both about how people react to recent results rather than what the results mean:
//
//   Form. A good player with a bad game is priced off that game for a week or so: his manager is
//   frustrated with him and the room reads the box score. A spike does the reverse. When the player's
//   outlook has not moved (healthy, same role, the model still expects what it expected), that gap is a
//   price to buy at or sell into. It has to be a real gap: well outside the position's normal weekly
//   swing around a projection, not a quiet week.
//
//   Urgency. A team on a losing streak, especially one sliding toward the playoff line, is the one
//   looking to shake things up; a team that keeps winning has little reason to touch its roster.
//
// Both are small, bounded nudges to the trade read (lib/behavior) and to which suggestions surface
// (lib/trades), never a reason on their own.

import type { PlayerContext, Usage } from './context'
import { ROLE_SWING } from './context'
import { lastName } from './names'
import { streakOf, type TeamSeason } from './power'
import type { PlayerMap } from './types'
import type { WeekPoints } from './war'

export type FormKind = 'buy-low' | 'sell-high'

export type PlayerForm = {
  kind: FormKind
  /** Last name, for a short reason. */
  name: string
  /** Points per game in the window, and what was expected of him going in (pre-game projection). */
  actual: number
  expected: number
  /** Games the read rests on: the last, or the last two when both went the same way. */
  games: number
  /** The gap in the position's weekly standard deviations, per game read. */
  z: number
  /** What the room's price for him moves by: below 1 for a buy-low, above 1 for a sell-high. */
  factor: number
}

/**
 * Thresholds. The gap must clear `zBuy` (or `zSell`) standard deviations of the position's weekly miss
 * around a projection AND be large in proportion (the game at most 60% of the projection, or at least
 * 160%), so a 9-point quarterback miss on a 25-point projection is not a down week. Spikes take the
 * higher bar because weekly scoring is skewed upward: big games are commoner than equally bad ones.
 *
 * The price moves by `base` at the threshold and `perZ` per further standard deviation, capped at
 * `cap`: judgement, kept small enough that a deal still has to be fair on its own.
 */
export const FORM = {
  zBuy: 1.25,
  zSell: 1.5,
  ratioBuy: 0.6,
  ratioSell: 1.6,
  /** Projection a player must have carried into the game: a "down week" for a bench body is just a week. */
  minExpected: 6,
  /** A second game counts toward the read when it misses the same way by this much. */
  zSecond: 0.75,
  /** The outlook holds: the model's rest-of-season expectation is at least this share of the pre-game one. */
  holdLow: 0.8,
  /** A spike the model has followed up (expectation now this much higher) reads as a new role, not luck. */
  holdHigh: 1.25,
  base: 0.06,
  perZ: 0.04,
  cap: 0.15,
}

/**
 * How far a player's week typically lands from his projection, points, by position: the noise a gap has
 * to clear. A fallback for leagues too young to measure their own (see `residualSd`).
 */
export const DEFAULT_RESIDUAL_SD: Record<string, number> = { QB: 7.5, RB: 7, WR: 7, TE: 5.5 }
const PRIOR_SAMPLES = 40

/** Injury designations that make a down week a health story rather than a price. Any tag at all counts. */
export const injuredTag = (injury: string | null | undefined) => !!injury && injury.trim() !== ''

/**
 * Each position's weekly miss around the pre-game projection, measured on this league's completed weeks
 * among players projected for something (5+), shrunk toward the default by a 40-game prior so a thin
 * early-season sample does not swing the bar.
 */
export const residualSd = (
  weeks: number[],
  weekPoints: WeekPoints,
  projections: Record<number, Record<string, number>>,
  players: PlayerMap,
): Record<string, number> => {
  const sums: Record<string, { n: number; ss: number }> = {}
  for (const w of weeks) {
    const proj = projections[w]
    const pts = weekPoints[w]
    if (!proj || !pts) continue
    for (const id of Object.keys(proj)) {
      const pos = players[id]?.pos
      if (!pos || DEFAULT_RESIDUAL_SD[pos] == null || proj[id] < 5 || !(pts[id] > 0)) continue
      const s = (sums[pos] ??= { n: 0, ss: 0 })
      s.n++
      s.ss += (pts[id] - proj[id]) ** 2
    }
  }
  const out: Record<string, number> = {}
  for (const pos of Object.keys(DEFAULT_RESIDUAL_SD)) {
    const d = DEFAULT_RESIDUAL_SD[pos]
    const s = sums[pos] ?? { n: 0, ss: 0 }
    out[pos] = Math.round(Math.sqrt((s.ss + PRIOR_SAMPLES * d * d) / (s.n + PRIOR_SAMPLES)) * 100) / 100
  }
  return out
}

export type FormInput = {
  name: string
  pos: string
  /** His most recent games, latest first: points scored and the pre-game projection. Byes and games he missed left out. */
  recent: { week: number; actual: number; expected: number }[]
  /** The model's expectation per game he plays, over the weeks ahead (horizon perActive). */
  forward: number | null | undefined
  injury?: string | null
  /** Chance he plays in a given week ahead (lib/context). */
  play?: number | null
  usage?: Usage | null
  /** The position's weekly miss around a projection. */
  sd: number
}

const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d

/**
 * Is this player a buy-low or a sell-high right now? Only on clear evidence: a gap well past the position's
 * noise, a player who was expected to matter, healthy now, the model's outlook for him unmoved, and no sign
 * in his usage that the role changed (fewer touches in a dud, more in a spike).
 */
export const classifyForm = (input: FormInput): PlayerForm | null => {
  const { recent, sd } = input
  const last = recent[0]
  if (!last || sd <= 0 || last.expected < FORM.minExpected) return null
  if (injuredTag(input.injury) || (input.play != null && input.play < 0.8)) return null
  const z1 = (last.actual - last.expected) / sd
  let kind: FormKind
  if (z1 <= -FORM.zBuy && last.actual <= FORM.ratioBuy * last.expected) kind = 'buy-low'
  else if (z1 >= FORM.zSell && last.actual >= FORM.ratioSell * last.expected) kind = 'sell-high'
  else return null

  // The outlook holds. A model that has marked him down after a dud saw something (an injury, a demotion); one
  // that has marked him up after a spike has seen a new role. Neither is a market mistake.
  const forward = input.forward ?? null
  if (forward == null) return null
  if (kind === 'buy-low' && forward < FORM.holdLow * last.expected) return null
  if (kind === 'sell-high' && forward > FORM.holdHigh * last.expected) return null

  // His usage in that game, where the stats have it: a dud on far fewer touches is a role (or an in-game
  // injury), a spike on far more is one too.
  const u = input.usage
  if (u && u.lastWeek === last.week && u.games >= 3) {
    const swing = u.lastOpps - u.priorOpps
    if (kind === 'buy-low' && swing <= -ROLE_SWING && u.lastOpps < (2 / 3) * u.priorOpps) return null
    if (kind === 'sell-high' && swing >= ROLE_SWING && u.lastOpps > 1.5 * u.priorOpps) return null
  }

  // A second game the same way makes the read firmer; the two are then judged together.
  const sign = kind === 'buy-low' ? -1 : 1
  const prev = recent[1]
  let window = [last]
  if (prev && prev.expected > 0 && (sign * (prev.actual - prev.expected)) / sd >= FORM.zSecond) window = [last, prev]
  const actual = window.reduce((a, g) => a + g.actual, 0) / window.length
  const expected = window.reduce((a, g) => a + g.expected, 0) / window.length
  const z = Math.abs(actual - expected) / (sd / Math.sqrt(window.length))
  const bar = kind === 'buy-low' ? FORM.zBuy : FORM.zSell
  const move = Math.min(FORM.cap, FORM.base + FORM.perZ * Math.max(0, z - bar))
  return {
    kind,
    name: input.name,
    actual: round(actual, 1),
    expected: round(expected, 1),
    games: window.length,
    z: round(z),
    factor: round(kind === 'buy-low' ? 1 - move : 1 + move, 3),
  }
}

/** "down week: 4.2 vs 14.0 expected", or "2 big weeks: 24.1/g vs 12.0 expected". */
export const formText = (f: PlayerForm) => {
  const what = f.kind === 'buy-low' ? 'down' : 'big'
  return f.games > 1
    ? `${f.games} ${what} weeks: ${f.actual.toFixed(1)}/g vs ${f.expected.toFixed(1)} expected`
    : `${what} week: ${f.actual.toFixed(1)} vs ${f.expected.toFixed(1)} expected`
}

/** "Burden" for Luther Burden III, "Cooper" for Omar Cooper Jr. (lives in names.ts, where the trade read also uses it). */
export { lastName }

/**
 * Every player's form read from the league's completed weeks. Nothing when the points are a proxy (last
 * season's) or there are no pre-game projections to measure a week against.
 */
export const playerForms = (input: {
  players: PlayerMap
  weeks: number[]
  weekPoints: WeekPoints
  projections: Record<number, Record<string, number>>
  forward: Record<string, number>
  context?: Record<string, PlayerContext>
  usage?: Record<string, Usage>
  /** False when `weekPoints` are not this season's games. */
  current: boolean
}): Record<string, PlayerForm> => {
  const out: Record<string, PlayerForm> = {}
  const weeks = [...input.weeks].sort((a, b) => a - b)
  if (!input.current || !weeks.length) return out
  const sd = residualSd(weeks, input.weekPoints, input.projections, input.players)
  // Only the last three weeks can hold the two most recent games; anything older is not "recent".
  const window = weeks.slice(-3).reverse()
  const lastWeek = window[0]
  const candidates = new Set(Object.keys(input.projections[lastWeek] ?? {}))
  for (const w of window.slice(1)) for (const id of Object.keys(input.projections[w] ?? {})) candidates.add(id)
  for (const id of candidates) {
    const p = input.players[id]
    if (!p || sd[p.pos] == null) continue
    const recent: FormInput['recent'] = []
    for (const w of window) {
      const expected = input.projections[w]?.[id] ?? 0
      const actual = input.weekPoints[w]?.[id]
      // A bye, or a game he sat out (no line, or a flat zero): no read on how he played.
      if (expected <= 0 || actual == null || actual <= 0) continue
      recent.push({ week: w, actual, expected })
      if (recent.length === 2) break
    }
    // The read is about his latest game. If that was weeks ago, the moment has passed.
    if (!recent.length || recent[0].week < window[Math.min(1, window.length - 1)]) continue
    const f = classifyForm({
      name: lastName(p.name),
      pos: p.pos,
      recent,
      forward: input.forward[id],
      injury: p.injury,
      play: input.context?.[id]?.play,
      usage: input.usage?.[id],
      sd: sd[p.pos],
    })
    if (f) out[id] = f
  }
  return out
}

// ---------- Team urgency ----------

export type TeamMood = {
  rosterId: number
  streak: number
  /**
   * How much the manager wants to make a move: up to 1 for a long losing run on the playoff line, down to
   * about −0.6 for a long winning run with the playoffs in hand. Zero is business as usual.
   */
  urgency: number
  /** Playoff odds the read was taken against, when there is a forecast. */
  playoffs: number | null
  bubble: boolean
  text: string | null
}

/** Playoff odds that count as on the bubble: the season still turns on the next few weeks. */
export const BUBBLE = { low: 0.15, high: 0.85 }

/**
 * A manager's appetite for a deal from the run they are on. Losing two straight starts it, four or more
 * maxes it; it bites hardest on the bubble, less for a team safely in, and less again for one already out
 * of it (a lost season makes some managers active and most of them absent). Winning three straight
 * starts complacency, which is stronger for a team whose spot is safe. Only while there are regular-season
 * games left to save.
 */
export const teamMood = (rosterId: number, streak: number, playoffs: number | null, weeksLeft: number, clinch?: 'in' | 'out' | null): TeamMood => {
  const bubble = playoffs != null && clinch == null && playoffs >= BUBBLE.low && playoffs <= BUBBLE.high
  let urgency = 0
  if (weeksLeft > 0 && streak <= -2) {
    const run = Math.min(1, (-streak - 1) / 3)
    const stakes = clinch === 'out' || (playoffs != null && playoffs < 0.03) ? 0.4 : playoffs == null ? 0.8 : bubble ? 1 : playoffs > BUBBLE.high ? 0.6 : 0.8
    urgency = run * stakes
  } else if (weeksLeft > 0 && streak >= 3) {
    const run = Math.min(1, (streak - 2) / 2)
    const safe = clinch === 'in' || (playoffs != null && playoffs > BUBBLE.high)
    urgency = -0.6 * run * (safe ? 1 : 0.6)
  }
  urgency = Math.round(urgency * 100) / 100
  let text: string | null = null
  if (urgency > 0) {
    const lost = `lost ${-streak} straight`
    text = urgency >= 0.5 ? `${lost}${bubble ? ' on the bubble' : ''}, looking to shake things up` : `${lost}${bubble ? ' on the bubble' : ''}, may be open to a move`
  } else if (urgency < 0) text = `won ${streak} straight, little reason to change`
  return { rosterId, streak, urgency, playoffs, bubble, text }
}

/** Every team's mood, from the season so far and the forecast's playoff odds when there is one. */
export const teamMoods = (
  seasons: TeamSeason[],
  odds: Record<number, { playoffs: number; clinch?: 'in' | 'out' | null }> | null | undefined,
  weeksLeft: number,
): Record<number, TeamMood> => {
  const out: Record<number, TeamMood> = {}
  for (const s of seasons) {
    const o = odds?.[s.rosterId]
    out[s.rosterId] = teamMood(s.rosterId, streakOf(s.weeks.map((w) => w.result)), o ? o.playoffs : null, weeksLeft, o?.clinch ?? null)
  }
  return out
}

/** What the trade read and the search take from all this. */
export type Momentum = {
  form: Record<string, PlayerForm>
  teams: Record<number, TeamMood>
  /** The trade price the form factors scale when there is no consensus to read (analysis.tradeMarket). */
  market: Record<string, number>
}

/** Price factors by player, for the search. */
export const formFactors = (form: Record<string, PlayerForm>): Record<string, number> =>
  Object.fromEntries(Object.entries(form).map(([id, f]) => [id, f.factor]))
