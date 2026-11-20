// The assistant's tools. Each one calls the app's own engines on the league already loaded in the browser and hands
// the model a compact text result (names and short numbers, no raw dumps), plus cards and actions for the UI. The
// model explains; these decide. Every number the assistant may say comes out of here.
import { acceptRead } from '../behavior'
import { readDeal, rostersOf, type Deal } from '../deal'
import { suggestBid } from '../faab'
import { leverageOf, leverageRun, lockKey, phi, type SimTeam } from '../forecast'
import { optimalLineup, type LineupPlayer } from '../lineup'
import { formText } from '../momentum'
import { dropCandidates } from '../moves'
import { loadNews } from '../news'
import { simInputFor } from '../playoffSim'
import { scoutTeam } from '../scout'
import { formFactors } from '../momentum'
import { runSim } from '../simRunner'
import { describeStanding } from '../currency'
import { pairSwaps } from '../swaps'
import { applyTrade, findTargets, findTrades, scoreTrade, DEFAULT_TRADE_CONFIG, SUGGESTED_TRADE_CONFIG, type TradeIdea, type TradeTarget } from '../trades'
import { planWaivers } from '../waivers'
import { streakText } from '../power'
import { nameOf, teamName, type AsgmLeague } from './league'
import {
  allowedFor,
  beats,
  currentWeek,
  depthLabels,
  expOf,
  gameOf,
  matchupText,
  memo,
  money,
  opponentIn,
  pct,
  projOf,
  r1,
  rangeOf,
  recentGames,
  resolvePlayer,
  resolveTeam,
  signed,
  statusText,
  tagOf,
  totalsFor,
} from './resolve'
import type { AsgmAction, AsgmCard } from './types'

// ---------------------------------------------------------------------------------------------------------------
// Shapes

/** JSON Schema, the subset every provider accepts (OpenAI, Anthropic, Gemini): no unions, no additionalProperties. */
export type Schema = {
  type: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array'
  description?: string
  properties?: Record<string, Schema>
  required?: string[]
  items?: Schema
  enum?: string[]
}

export type ToolOut = { text: string; cards?: AsgmCard[]; actions?: AsgmAction[]; detail?: string }
export type Args = Record<string, unknown>
export type ToolDef = {
  name: string
  description: string
  params: Schema
  /** Present tense, shown while it runs: "Running 4,000 playoff sims". */
  label: (args: Args, lg: AsgmLeague) => string
  run: (args: Args, lg: AsgmLeague, signal?: AbortSignal) => ToolOut | Promise<ToolOut>
}

const S = (description: string): Schema => ({ type: 'string', description })
const N = (description: string): Schema => ({ type: 'integer', description })
const LIST = (description: string): Schema => ({ type: 'array', description, items: { type: 'string' } })
const obj = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: 'object', properties, required })

const TEAM_ARG = S('Team or manager name, or "me" (default).')
const WEEK_ARG = N('NFL week (default: this week).')

class ToolError extends Error {}
const fail = (msg: string): never => {
  throw new ToolError(msg)
}
const must = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => (r.ok === true ? (r as { value: T }).value : fail((r as { error: string }).error))
const list = (x: unknown): string[] => (Array.isArray(x) ? x.map(String) : typeof x === 'string' && x.trim() ? x.split(/\s*[,;]\s*|\s+and\s+/i) : [])
const num = (x: unknown): number | null => (x == null || x === '' ? null : Number.isFinite(Number(x)) ? Number(x) : null)

const weekArg = (lg: AsgmLeague, x: unknown) => {
  const w = num(x) ?? currentWeek(lg)
  if (w < 1 || w > 18) fail(`week ${w} is outside the season`)
  return Math.round(w)
}

/** A usage line from games a while back says so: a player who has not played since week 4 has no recent role. */
const staleUsage = (lg: AsgmLeague, lastWeek: number) => {
  const latest = lg.data.regularWeeks[lg.data.regularWeeks.length - 1] ?? lastWeek
  return lastWeek && latest - lastWeek >= 2 ? ` (his last game was week ${lastWeek})` : ''
}
/** "Waiver Wolves'" and "Gridiron Gang's". */
const poss = (name: string) => (/s$/i.test(name) ? `${name}'` : `${name}'s`)
const posOf = (lg: AsgmLeague, id: string) => lg.data.players[id]?.pos ?? '?'
const lname = (lg: AsgmLeague, id: string) => nameOf(lg, id)
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
const lp = (lg: AsgmLeague, ids: string[], pts: (id: string) => number): LineupPlayer[] =>
  ids.filter((id) => lg.data.players[id]).map((id) => ({ id, fpos: lg.data.players[id].fpos?.length ? lg.data.players[id].fpos : [lg.data.players[id].pos], pts: pts(id) }))
const slotName = (s: string) => s.replace('SUPER_FLEX', 'SF')
const weeksText = (ws: number[]) => (ws.length ? (ws.length > 2 && ws[ws.length - 1] - ws[0] === ws.length - 1 ? `${ws[0]}–${ws[ws.length - 1]}` : ws.join(', ')) : 'none')
const MY = (lg: AsgmLeague) => (lg.myRosterId != null ? lg.myRosterId : fail('this league has no team of yours loaded; name a team'))
const noHorizon = (lg: AsgmLeague) => (!lg.data.horizon.length ? fail('the app has no projections for the weeks ahead right now (season over or the feed is down)') : null)

/** Projection used for lineup calls in a week: Sleeper's, else the model's expectation when Sleeper has none. */
export const weekPts = (lg: AsgmLeague, week: number) => {
  const hasSleeper = (lg.data.projectionWeek === week && !!lg.data.projections) || !!lg.data.projectionsByWeek[week]
  return (id: string) => (hasSleeper ? projOf(lg, id, week) : (expOf(lg, id, week) ?? 0))
}

/** The standings order: wins, then ties, then points for. */
export const standingRows = (lg: AsgmLeague) => [...lg.analysis.seasons].sort((x, y) => y.wins + 0.5 * y.ties - (x.wins + 0.5 * x.ties) || y.pf - x.pf)
/** A team's place in the standings, 1 = first. */
export const standingOf = (lg: AsgmLeague, rid: number) => standingRows(lg).findIndex((s) => s.rosterId === rid) + 1
export const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`
const recordOf = (lg: AsgmLeague, rid: number) => {
  const s = lg.analysis.seasonById[rid]
  return s ? `${s.wins}-${s.losses}${s.ties ? `-${s.ties}` : ''}` : '–'
}

/** One player's line for a week: projection, range, expectation when it differs, matchup, status. */
const playerWeekLine = (lg: AsgmLeague, id: string, week: number, opts: { label?: string } = {}) => {
  const proj = weekPts(lg, week)(id)
  const { low, high } = rangeOf(lg, id, proj)
  const exp = expOf(lg, id, week)
  const parts = [`${opts.label ? `${opts.label} ` : ''}${lname(lg, id)} (${posOf(lg, id)} ${lg.data.players[id]?.team ?? 'FA'})`, `proj ${r1(proj)}`]
  if (proj > 0) parts.push(`range ${r1(low)}–${r1(high)}`)
  if (exp != null && Math.abs(exp - proj) >= 1.5) parts.push(`model exp ${r1(exp)}`)
  const m = matchupText(lg, id, week)
  if (m) parts.push(m)
  const st = statusText(lg, id, week)
  if (st) parts.push(st)
  return parts.join(' · ')
}

// ---------------------------------------------------------------------------------------------------------------
// Trade plumbing (the same inputs the Trades page gives the engines, for any team)

const tradeInput = (lg: AsgmLeague, rid: number) => {
  const { data, analysis } = lg
  const me = analysis.teamById[rid] ?? fail('no such team')
  return {
    slots: analysis.slots,
    players: data.players,
    horizon: data.horizon,
    pts: analysis.horizon.perWeek,
    me: { rosterId: rid, players: me.players },
    capacity: analysis.capacity,
    market: analysis.market,
    tradeMarket: analysis.tradeMarket,
    currency: analysis.currency,
    floor: analysis.horizonReplacement,
    form: formFactors(analysis.form),
    perceived: lg.models.perceived,
  }
}

const tradeIdeas = (lg: AsgmLeague, rid: number): TradeIdea[] =>
  memo(lg, `ideas:${rid}`, () => {
    const base = tradeInput(lg, rid)
    const others = lg.analysis.teams.filter((t) => t.rosterId !== rid).map((t) => ({ rosterId: t.rosterId, players: t.players }))
    return findTrades({ ...base, others, config: { ...DEFAULT_TRADE_CONFIG, ...SUGGESTED_TRADE_CONFIG } })
  })

const readIdea = (lg: AsgmLeague, idea: TradeIdea, me: number) => {
  const faab = lg.data.tradeFaab ? lg.models.faab : null
  return acceptRead(idea, me, lg.models.behavior, lg.models.perceived, lg.analysis.currency, faab, lg.models.momentum)
}

const scoreIdea = (lg: AsgmLeague, me: number, partner: number, give: string[], get: string[]) => {
  const base = tradeInput(lg, me)
  return scoreTrade({ ...base, partner: { rosterId: partner, players: lg.analysis.teamById[partner]?.players ?? [] }, give, get })
}

/** Free agents who would start for a team, with what they add (search.waiverTargets, for any team). */
const faTargets = (lg: AsgmLeague, rid: number, ids?: string[]): TradeTarget[] => {
  const { data, analysis } = lg
  const perWeek = analysis.horizon.perWeek
  const pool =
    ids ??
    Object.keys(perWeek)
      .filter((id) => data.players[id] && analysis.rosteredBy[id] == null)
      .sort((a, b) => perWeek[b] - perWeek[a])
      .slice(0, 150)
  const base = tradeInput(lg, rid)
  return findTargets({ ...base, others: [], rosteredBy: analysis.rosteredBy, freeAgents: pool, limit: ids ? ids.length : 40 })
}

const dealOf = (me: number, partner: number, give: string[], get: string[], faabToThem = 0): Deal => ({
  teams: [me, partner],
  moves: [...give.map((player) => ({ player, from: me, to: partner })), ...get.map((player) => ({ player, from: partner, to: me }))],
  faab: faabToThem > 0 ? [{ from: me, to: partner, dollars: faabToThem }] : faabToThem < 0 ? [{ from: partner, to: me, dollars: -faabToThem }] : [],
})

const simOf = (lg: AsgmLeague) => lg.models.forecast

/** A trade's effect on both teams' playoff odds: the forecast's seasons replayed with the rosters swapped. */
const tradeLeverage = async (lg: AsgmLeague, me: number, partner: number, give: string[], get: string[], signal?: AbortSignal) => {
  const f = simOf(lg)
  if (!f) return null
  const pts = lg.analysis.horizon.perWeek
  const cap = lg.analysis.capacity
  const mine = lg.analysis.teamById[me].players
  const theirs = lg.analysis.teamById[partner].players
  const trade = { me, partner, myRoster: applyTrade(mine, give, get, cap, pts), theirRoster: applyTrade(theirs, get, give, cap, pts) }
  const run = leverageRun(lg.models.forecastInput, f, trade)
  if (!run) return null
  const post = await runSim(run, { urgent: true, signal })
  return post ? leverageOf(f, trade, post) : null
}

// ---------------------------------------------------------------------------------------------------------------
// The tools

const lineupTool: ToolDef = {
  name: 'lineup',
  description: "Best lineup for a team and week vs the one set: each player's projection, range, opponent and defense rank, injury, byes; the changes to make; close calls with the odds the bench player outscores the starter.",
  params: obj({ team: TEAM_ARG, week: WEEK_ARG }),
  label: (a, lg) => `Optimizing the week ${num(a.week) ?? currentWeek(lg)} lineup`,
  run: (a, lg) => {
    const rid = must(resolveTeam(lg, a.team))
    const week = weekArg(lg, a.week)
    const team = lg.analysis.teamById[rid]
    const slots = lg.analysis.slots
    const pts = weekPts(lg, week)
    if (!team.players.some((id) => pts(id) > 0)) fail(`no projections for week ${week} yet`)
    const set = (team.roster.starters ?? []).map((id) => (id && id !== '0' ? id : null))
    const setTotal = sum(set.map((id) => (id ? pts(id) : 0)))
    const best = optimalLineup(slots, lp(lg, team.players, pts))
    const plan = pairSwaps(slots, set, best.assignments)
    const bestIds = new Set(best.assignments.filter(Boolean).map((p) => p!.id))
    const labels = depthLabels(lg, rid, week)
    const out: string[] = []
    const opp = opponentIn(lg, rid, week)
    out.push(`${teamName(lg, rid)}, week ${week}${opp != null ? ` vs ${teamName(lg, opp)}` : ''}. As set: ${r1(setTotal)} projected. Best: ${r1(best.total)} (${signed(best.total - setTotal)}).`)
    out.push(`Set lineup (who starts now): ${set.map((id, i) => `${slotName(slots[i]?.name ?? '?')} ${id ? `${lname(lg, id)} ${r1(pts(id))}` : 'EMPTY'}`).join(', ')}.`)
    out.push('Best lineup:')
    best.assignments.forEach((p, i) => out.push(`- ${slotName(slots[i].name)}: ${p ? playerWeekLine(lg, p.id, week, { label: labels[p.id] ? `[${labels[p.id]}]` : '' }) : 'EMPTY (nobody eligible)'}`))
    const bench = team.players.filter((id) => !bestIds.has(id) && lg.data.players[id]).sort((a, b) => pts(b) - pts(a))
    out.push('Bench:')
    for (const id of bench.slice(0, 8)) out.push(`- ${playerWeekLine(lg, id, week, { label: labels[id] ? `[${labels[id]}]` : '' })}`)
    const changes = plan.swaps.map((s) => ({ out: s.out ?? '', in: s.in, slot: slotName(slots[s.slot].name), gain: r1(pts(s.in) - (s.out ? pts(s.out) : 0)) }))
    if (changes.length) out.push(`Changes: ${changes.map((c) => `start ${lname(lg, c.in)} over ${c.out ? lname(lg, c.out) : 'the empty slot'} at ${c.slot} (${signed(c.gain)})`).join('; ')}.`)
    else if (plan.unplaced.length) out.push(`Changes: move players between slots so ${plan.unplaced.map((u) => lname(lg, u.id)).join(', ')} start.`)
    else out.push(`Changes: none, the lineup as set is the best one. Call for ${teamName(lg, rid)}${rid === lg.myRosterId ? ' (you)' : ''}: lineup is set, no changes; give the closest call, do not list every starter.`)
    // Close calls: each starting slot's best eligible bench player, smallest margin first.
    const calls: { s: string; b: string; margin: number; p: number }[] = []
    best.assignments.forEach((p, i) => {
      if (!p) return
      const alt = bench.find((id) => (lg.data.players[id]?.fpos ?? []).some((pos) => slots[i].eligible.includes(pos)))
      if (!alt) return
      const ps = pts(p.id)
      const pb = pts(alt)
      const prob = beats(pb, rangeOf(lg, alt, pb).sd, ps, rangeOf(lg, p.id, ps).sd)
      if (ps - pb < 3.5 || prob > 0.35) calls.push({ s: p.id, b: alt, margin: ps - pb, p: prob })
    })
    const seen = new Set<string>()
    const close = calls.sort((x, y) => x.margin - y.margin).filter((c) => (seen.has(c.s + c.b) ? false : (seen.add(c.s + c.b), true))).slice(0, 3)
    if (close.length)
      out.push(`Close calls: ${close.map((c) => `${lname(lg, c.s)} over ${lname(lg, c.b)} by ${r1(c.margin)} (${lname(lg, c.b)} outscores him ${pct(c.p)} of the time)`).join('; ')}.`)
    const dead = best.assignments.filter((p) => p && !(p.pts > 0)).map((p) => lname(lg, p!.id))
    if (dead.length) out.push(`Holes: ${dead.join(', ')} project 0 (bye or out) and nobody on the bench can fill in; see waivers.`)
    if (week !== currentWeek(lg)) out.push(`Note: week ${week} is ahead; "as set" is today's lineup and projections can still move.`)
    // The decision lines go right under the header, before the lists: what to change, then the closest calls.
    const lead = out.filter((l) => /^(Changes|Close calls|Holes):/.test(l))
    const rest = out.filter((l) => !/^(Changes|Close calls|Holes):/.test(l))
    out.splice(0, out.length, ...rest.slice(0, 2), ...lead, ...rest.slice(2))
    const card: AsgmCard = { kind: 'lineup', title: `Week ${week} lineup`, rosterId: rid, week, changes: changes.filter((c) => c.out), total: { before: r1(setTotal), after: r1(best.total) } }
    return { text: out.join('\n'), cards: [card], detail: changes.length ? `${changes.length} change${changes.length === 1 ? '' : 's'}` : 'lineup is set' }
  },
}

const startSitTool: ToolDef = {
  name: 'start_sit',
  description: 'Start/sit between 2–6 players in one week: projections, ranges, odds each outscores the next, matchup, implied team total, injury, last 3 games, snap/touch trend. "my RB2" works.',
  params: obj({ players: LIST('Player names or "my RB2".'), week: WEEK_ARG }, ['players']),
  label: (a) => `Comparing ${list(a.players).slice(0, 3).join(', ')}`,
  run: (a, lg) => {
    const ids = [...new Set(list(a.players).map((x) => must(resolvePlayer(lg, x))))]
    if (ids.length < 2) fail('name at least two players')
    const week = weekArg(lg, a.week)
    const pts = weekPts(lg, week)
    const totals = totalsFor(lg, week)
    const rows = ids.map((id) => {
      const p = pts(id)
      return { id, p, sd: rangeOf(lg, id, p).sd }
    })
    rows.sort((x, y) => y.p - x.p)
    const out = [`Week ${week}, by projection:`]
    for (const r of rows) {
      const pl = lg.data.players[r.id]
      const bits = [playerWeekLine(lg, r.id, week)]
      const tt = pl?.team ? totals[pl.team] : null
      if (tt) bits.push(`team implied ${r1(tt.pts)} pts${tt.source === 'market' ? ' (betting lines)' : ''}`)
      const rec = recentGames(lg, r.id, 3).filter((g) => g.pts != null || g.proj != null)
      if (rec.length) bits.push(`last ${rec.length}: ${rec.map((g) => (g.pts == null || (!g.pts && g.proj == null) ? 'DNP' : `${r1(g.pts)}${g.proj != null ? `/${r1(g.proj)}` : ''}`)).join(', ')} (scored/proj)`)
      const u = lg.data.usage[r.id]
      if (u && u.games >= 2) bits.push(`snaps ${pct(u.snaps)} season, ${pct(u.recentSnaps)} last 2 games; touches+targets ${r1(u.opps)}/g, ${r1(u.recentOpps)} last 2${staleUsage(lg, u.lastWeek)}`)
      const f = lg.analysis.form[r.id]
      if (f) bits.push(formText(f))
      out.push(`- ${bits.join(' · ')} · ${tagOf(lg, r.id)}`)
    }
    for (let i = 0; i + 1 < rows.length; i++) {
      const x = rows[i]
      const y = rows[i + 1]
      out.push(`${lname(lg, x.id)} outscores ${lname(lg, y.id)} ${pct(beats(x.p, x.sd, y.p, y.sd))} of the time (${signed(x.p - y.p)} projected).`)
    }
    const top = rows[0]
    const gap = top.p - rows[1].p
    // Players on one roster: whether the best lineup starts them all anyway, which makes it no choice at all.
    const owners = [...new Set(ids.map((id) => lg.analysis.rosteredBy[id]))]
    if (owners.length === 1 && owners[0] != null) {
      const team = lg.analysis.teamById[owners[0]]
      const best = optimalLineup(lg.analysis.slots, lp(lg, team.players, pts))
      const seat = new Map(best.assignments.map((p, i) => [p?.id, slotName(lg.analysis.slots[i].name)] as [string | undefined, string]))
      const starting = ids.filter((id) => seat.has(id))
      if (starting.length === ids.length) {
        out.push(`All of them start in ${poss(teamName(lg, owners[0]))} best week ${week} lineup (${ids.map((id) => `${lname(lg, id)} at ${seat.get(id)}`).join(', ')}). Call: start ${ids.length === 2 ? 'both' : 'all of them'}; which one sits in the flex slot changes nothing.`)
        return { text: out.join('\n'), cards: startSitCards(lg, rows, week) }
      }
      else if (starting.length) out.push(`Best week ${week} lineup starts ${starting.map((id) => `${lname(lg, id)} (${seat.get(id)})`).join(', ')}; sits ${ids.filter((id) => !seat.has(id)).map((id) => lname(lg, id)).join(', ')}.`)
    }
    out.push(gap < 0.5 ? `Call: near coin flip on projection; lean on range and matchup above.` : `Call by the numbers: start ${lname(lg, top.id)}.`)
    return { text: out.join('\n'), cards: startSitCards(lg, rows, week) }
  },
}

const startSitCards = (lg: AsgmLeague, rows: { id: string; p: number }[], week: number): AsgmCard[] => [
  { kind: 'players', title: `Week ${week} start/sit`, rows: rows.map((r, i) => ({ id: r.id, value: `${r1(r.p)} proj`, note: matchupText(lg, r.id, week) || undefined, tone: i === 0 ? 'good' : 'neutral' })) },
  { kind: 'compare', title: rows.map((r) => lname(lg, r.id)).join(' vs '), ids: rows.slice(0, 4).map((r) => r.id) },
]

/** Rank at his position by the model's rest-of-season value. */
const modelPosRank = (lg: AsgmLeague, id: string) =>
  memo(lg, 'posrank', () => {
    const out: Record<string, number> = {}
    const byPos: Record<string, string[]> = {}
    for (const pid of Object.keys(lg.analysis.market)) {
      const pos = lg.data.players[pid]?.pos
      if (pos) (byPos[pos] ??= []).push(pid)
    }
    for (const ids of Object.values(byPos)) ids.sort((a, b) => lg.analysis.market[b] - lg.analysis.market[a]).forEach((pid, i) => (out[pid] = i + 1))
    return out
  })[id]

/** One line per horizon week: opponent, defense rank vs his position, expectation. */
const scheduleLine = (lg: AsgmLeague, id: string, weeks: number[]) => {
  const pl = lg.data.players[id]
  const allowed = allowedFor(lg, pl?.pos ?? '')
  return weeks
    .map((w) => {
      const g = gameOf(lg, pl?.team, w)
      const e = expOf(lg, id, w)
      const po = lg.data.playoffWeeks.includes(w) ? '*' : ''
      if (g.bye) return `w${w}${po} BYE`
      const rk = g.opp && allowed[g.opp] ? ` #${allowed[g.opp].rank}` : ''
      return `w${w}${po} ${g.home === false ? '@' : ''}${g.opp ?? '?'}${rk} ${e != null ? r1(e) : '–'}`
    })
    .join(' | ')
}

const playerTool: ToolDef = {
  name: 'player',
  description: "One player: owner, status, this week's projection and matchup, rest-of-season expectation and value, model vs FantasyPros rank, trade price, buy-low/sell-high form, usage trend, role notes, schedule incl. playoff weeks.",
  params: obj({ player: S('Player name or "my WR1".') }, ['player']),
  label: (a) => `Reading ${String(a.player ?? 'the player')}'s profile`,
  run: (a, lg) => {
    const id = must(resolvePlayer(lg, a.player))
    const { data, analysis } = lg
    const pl = data.players[id]
    const week = currentWeek(lg)
    const out: string[] = []
    const rid = analysis.rosteredBy[id]
    const label = rid != null ? depthLabels(lg, rid)[id] : null
    out.push(`${pl.name}: ${pl.pos}, ${pl.team ?? 'no NFL team'}${pl.age ? `, age ${pl.age}` : ''}${pl.exp != null ? `, ${pl.exp} yrs exp` : ''}. ${rid == null ? 'Free agent' : rid === lg.myRosterId ? `Yours (${label})` : `On ${teamName(lg, rid)} (their ${label})`}.`)
    const st = statusText(lg, id)
    if (st) out.push(`Status: ${st}.`)
    if (pl.depth) out.push(`Depth chart: ${pl.pos}${pl.depth}.`)
    if (data.horizon.length) out.push(`This week: ${playerWeekLine(lg, id, week)}.`)
    const perWeek = analysis.horizon.perWeek[id]
    const active = analysis.horizon.perActive[id]
    const ctx = data.context[id]
    if (perWeek != null) out.push(`Rest of season (weeks ${weeksText(data.horizon.map((h) => h.week))}): ${r1(perWeek)} pts/wk expected (${r1(active)} in weeks he plays)${ctx ? `, chance he plays a given week ${pct(ctx.play)}` : ''}.`)
    const v = analysis.market[id]
    const mr = modelPosRank(lg, id)
    const ecr = data.consensus?.byId[id]
    const val: string[] = []
    if (v != null) val.push(`value ${signed(v)} pts/wk over replacement (model ${pl.pos}${mr ?? '?'})`)
    if (ecr?.posRank != null) val.push(`FantasyPros ROS ${pl.pos}${Math.round(ecr.posRank)}${ecr.rank != null ? ` (#${Math.round(ecr.rank)} overall)` : ''}${ecr.weekRank != null ? `, this week ${pl.pos}${Math.round(ecr.weekRank)}` : ''}`)
    const price = analysis.tradeMarket[id]
    if (price != null) val.push(`trade price ${r1(price)}`)
    const stg = analysis.currency.standing?.[id]
    if (stg) val.push(`reads as ${describeStanding(stg)}`)
    if (val.length) out.push(`Value: ${val.join('; ')}.`)
    if (ecr?.posRank != null && mr != null && Math.abs(ecr.posRank - mr) >= 6) out.push(ecr.posRank < mr ? 'Experts rank him well above the projections: the room will pay more than the model thinks he is worth (sell-high lean).' : 'The projections like him more than the experts: likely cheaper to buy than he should be.')
    const pv = analysis.values[id]
    if (pv && pv.games) out.push(`Season: ${pv.games} games, ${r1(pv.ppg)} ppg (floor ${r1(pv.floor)}, ceiling ${r1(pv.ceiling)}).`)
    const rec = recentGames(lg, id, 4).filter((g) => g.pts != null || g.proj != null)
    if (rec.length) out.push(`Recent (scored/proj): ${rec.map((g) => `w${g.week} ${g.pts == null || (!g.pts && g.proj == null) ? 'DNP' : `${r1(g.pts)}/${g.proj == null ? '–' : r1(g.proj)}`}`).join(', ')}.`)
    const f = analysis.form[id]
    if (f) out.push(`Form: ${f.kind} (${formText(f)}); the room moves his price ${signed((f.factor - 1) * 100, 0)}%.`)
    const u = data.usage[id]
    if (u && u.games >= 2) out.push(`Usage: snaps ${pct(u.snaps)} season, ${pct(u.recentSnaps)} last 2 games; touches+targets ${r1(u.opps)}/g season, ${r1(u.recentOpps)} last 2, last game ${r1(u.lastOpps)}${staleUsage(lg, u.lastWeek)}.`)
    for (const n of ctx?.notes ?? []) {
      if (n.kind === 'bump') out.push(`Role bump: +${r1(n.pts)} pts/wk from absences of ${n.from.map((x) => lname(lg, x)).join(', ')}.`)
      if (n.kind === 'temporary') out.push(`Temporary role: ${r1(n.during)}/wk while ${n.behind.map((x) => lname(lg, x)).join(', ')} out (weeks ${weeksText(n.weeks)}), ${r1(n.after)} after.`)
      if (n.kind === 'returns') out.push(n.week ? `Projected back week ${n.week}.` : 'Not projected to play again in the horizon.')
      if (n.kind === 'history') out.push(`Injury history: played ${n.played} of ${n.games} games.`)
      if (n.kind === 'playoffs') out.push(`Playoff weeks ${weeksText(n.weeks)}: projections ${signed(n.vsNormal * 100, 0)}% vs his normal.`)
    }
    if (data.horizon.length && data.schedule) out.push(`Schedule (week opp #defense-rank-vs-${pl.pos} [1=softest] exp; * = fantasy playoffs): ${scheduleLine(lg, id, data.horizon.map((h) => h.week))}`)
    const trend = data.trending.find((t) => t.player_id === id)
    if (trend) out.push(`Sleeper adds in the last day: ${trend.count.toLocaleString('en-US')}.`)
    const newest = Object.values(data.players).reduce((m, p) => Math.max(m, p.newsAt ?? 0), 0)
    if (pl.newsAt && newest && newest - pl.newsAt < 2 * 86400_000) out.push('Sleeper flagged fresh news on him in the last two days (use the news tool for the story).')
    if (data.draft?.rank[id]) out.push(`League draft: pick ${data.draft.rank[id]}.`)
    return {
      text: out.join('\n'),
      cards: [{ kind: 'players', title: pl.name, rows: [{ id, value: perWeek != null ? `${r1(perWeek)}/wk ROS` : undefined, note: [st, matchupText(lg, id, week)].filter(Boolean).join(' · ') || undefined }] }],
      actions: [{ kind: 'openPlayer', id, label: `Open ${pl.name}` }],
    }
  },
}

const SPANS = ['week', 'next4', 'ros', 'playoffs'] as const
const compareTool: ToolDef = {
  name: 'compare_players',
  description: "2–4 players side by side over a span (week, next4, ros, playoffs): weekly expectation, opponents and defense ranks, schedule softness, byes, value, ranks. For 'softer playoff schedule' or 'better rest of season'.",
  params: obj({ players: LIST('2–4 player names.'), span: { type: 'string', enum: [...SPANS], description: 'Default ros.' } }, ['players']),
  label: (a) => `Comparing ${list(a.players).slice(0, 4).join(' vs ')}`,
  run: (a, lg) => {
    noHorizon(lg)
    const ids = [...new Set(list(a.players).map((x) => must(resolvePlayer(lg, x))))].slice(0, 4)
    if (ids.length < 2) fail('name at least two players')
    const span = (SPANS as readonly string[]).includes(String(a.span)) ? (String(a.span) as (typeof SPANS)[number]) : 'ros'
    const all = lg.data.horizon.map((h) => h.week)
    const weeks = span === 'week' ? all.slice(0, 1) : span === 'next4' ? all.slice(0, 4) : span === 'playoffs' ? all.filter((w) => lg.data.playoffWeeks.includes(w)) : all
    if (!weeks.length) fail(span === 'playoffs' ? 'the projections do not reach the fantasy playoffs (the app is set to a shorter horizon)' : 'no weeks in that span')
    const out = [`Span: ${span}, weeks ${weeksText(weeks)}${span === 'playoffs' ? ' (fantasy playoffs)' : ''}. Weekly line: week, opponent, that defense's rank in fantasy points allowed to his position (#1 = gives up the most, softest), his expected points.`]
    const rows = ids.map((id) => {
      const pl = lg.data.players[id]
      const allowed = allowedFor(lg, pl.pos)
      const exps = weeks.map((w) => expOf(lg, id, w) ?? 0)
      const games = weeks.map((w) => gameOf(lg, pl.team, w))
      const idx = games.filter((g) => g.opp && allowed[g.opp]).map((g) => allowed[g.opp!].index)
      const soft = idx.length ? sum(idx) / idx.length : null
      const ranks = games.filter((g) => g.opp && allowed[g.opp]).map((g) => allowed[g.opp!].rank)
      return { id, total: sum(exps), avg: sum(exps) / weeks.length, soft, avgRank: ranks.length ? sum(ranks) / ranks.length : null, byes: weeks.filter((_, i) => games[i].bye) }
    })
    rows.sort((x, y) => y.total - x.total)
    for (const r of rows) {
      const pl = lg.data.players[r.id]
      const ecr = lg.data.consensus?.byId[r.id]
      const bits = [
        `${pl.name} (${tagOf(lg, r.id)})`,
        `${r1(r.avg)} exp/wk, ${r1(r.total)} total`,
        // The word first: an average rank "#21" reads as good to a model unless it is told #1 is the softest.
        r.soft != null ? `schedule ${r.soft >= 1.03 ? 'softer than average' : r.soft <= 0.97 ? 'tougher than average' : 'about average'} (${signed((r.soft - 1) * 100, 0)}% pts allowed vs avg; avg defense rank #${r1(r.avgRank)} vs ${pl.pos}, #1 = softest)` : 'schedule: no defense data',
        r.byes.length ? `bye week ${r.byes.join(', ')}` : '',
        `value ${signed(lg.analysis.market[r.id] ?? 0)}/wk`,
        ecr?.posRank != null ? `ECR ${pl.pos}${Math.round(ecr.posRank)}` : '',
        lg.analysis.form[r.id] ? `${lg.analysis.form[r.id].kind}` : '',
        statusText(lg, r.id),
      ].filter(Boolean)
      out.push(`- ${bits.join(' · ')}`)
      out.push(`  ${scheduleLine(lg, r.id, weeks)}`)
    }
    const bySoft = [...rows].filter((r) => r.soft != null).sort((x, y) => y.soft! - x.soft!)
    if (bySoft.length >= 2) {
      const [a, b] = bySoft
      out.push(
        a.soft! - b.soft! < 0.03
          ? `Schedules: about even (${bySoft.map((r) => `${lname(lg, r.id)} ${signed((r.soft! - 1) * 100, 0)}%`).join(', ')} pts allowed vs average).`
          : `Softer schedule: ${lname(lg, a.id)} (${signed((a.soft! - 1) * 100, 0)}% vs ${signed((b.soft! - 1) * 100, 0)}% pts allowed vs average).`,
      )
    }
    out.push(`Higher expectation over the span: ${lname(lg, rows[0].id)} (${signed(rows[0].total - rows[1].total)} pts over ${weeks.length} week${weeks.length === 1 ? '' : 's'}).`)
    return { text: out.join('\n'), cards: [{ kind: 'compare', title: `${rows.map((r) => lname(lg, r.id)).join(' vs ')} · ${span}`, ids: rows.map((r) => r.id) }] }
  },
}

const newsTool: ToolDef = {
  name: 'news',
  description: 'Latest headlines (ESPN) and injury designation for up to 4 players.',
  params: obj({ players: LIST('Player names.') }, ['players']),
  label: (a) => `Pulling news on ${list(a.players).slice(0, 3).join(', ')}`,
  run: async (a, lg, signal) => {
    const ids = [...new Set(list(a.players).map((x) => must(resolvePlayer(lg, x))))].slice(0, 4)
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), 7000))
    let news: Awaited<ReturnType<typeof loadNews>> | null = null
    try {
      news = await Promise.race([loadNews(ids, lg.data.players), timeout])
    } catch {
      news = null
    }
    if (signal?.aborted) fail('stopped')
    const out: string[] = []
    for (const id of ids) {
      const st = statusText(lg, id)
      const items = (news?.[id] ?? []).slice(0, 2)
      out.push(`${lname(lg, id)}: ${st || 'no injury designation'}.`)
      if (!lg.data.players[id]?.espnId) out.push('- the app has no news feed for him (no ESPN id); only the designation above is known.')
      else if (items.length) for (const n of items) out.push(`- ${new Date(n.at).toISOString().slice(0, 10)} ${n.headline}${n.body ? `: ${n.body.slice(0, 220)}${n.body.length > 220 ? '…' : ''}` : ''}`)
      else out.push(news ? '- no stories in the last week.' : '- the news feed could not be reached; only the designation above is known.')
    }
    return { text: out.join('\n') }
  },
}

/** Both teams' odds before and after, as rows for the odds card. */
const oddsRows = (lg: AsgmLeague, rows: { rid: number; before: SimTeam | undefined; after: SimTeam | undefined }[], key: 'playoffs' | 'title' = 'playoffs') =>
  rows.map((r) => ({ label: `${teamName(lg, r.rid)}${r.rid === lg.myRosterId ? ' (you)' : ''}`, before: r.before?.[key], after: r.after?.[key] ?? 0 }))

const evaluateTool: ToolDef = {
  name: 'evaluate_trade',
  description: "Price a 2-team trade for both sides: lineup change per week, trade value, accept odds with reasons, FAAB sweetener, cuts, and both teams' playoff/title odds before and after. Partner inferred from the players you get.",
  params: obj(
    {
      give: LIST('Players you send.'),
      get: LIST('Players you receive.'),
      partner: S('Other team, if not clear from the players.'),
      team: S('The sending team if not the asking manager.'),
      faab: N('FAAB dollars you add (negative: they add).'),
    },
    ['give', 'get'],
  ),
  label: () => 'Pricing the trade and running 4,000 season sims',
  run: async (a, lg, signal) => {
    noHorizon(lg)
    const me = must(resolveTeam(lg, a.team))
    const give = list(a.give).map((x) => must(resolvePlayer(lg, x, { rosterId: me })))
    const get = list(a.get).map((x) => must(resolvePlayer(lg, x)))
    if (!give.length && !get.length) fail('name the players in the deal')
    const owners = [...new Set(get.map((id) => lg.analysis.rosteredBy[id]))]
    let partner = a.partner ? must(resolveTeam(lg, a.partner)) : (owners[0] ?? null)
    if (owners.some((o) => o == null)) fail(`${get.filter((id) => lg.analysis.rosteredBy[id] == null).map((id) => lname(lg, id)).join(', ')} is a free agent: use waivers, not a trade`)
    if (owners.length > 1) fail(`the players you get are on different teams (${owners.map((o) => teamName(lg, o)).join(', ')}); price one partner at a time`)
    // A named partner must be the team that has the players: the deal is priced on real rosters, never a guess.
    if (a.partner && owners.length === 1 && partner !== owners[0])
      fail(`${get.map((id) => lname(lg, id)).join(', ')} ${get.length === 1 ? 'is' : 'are'} on ${teamName(lg, owners[0])}, not ${teamName(lg, partner)}; trade with ${teamName(lg, owners[0])}, or name players ${teamName(lg, partner)} has`)
    if (partner == null) fail('name the team you are trading with')
    partner = partner as number
    if (partner === me) fail('that is your own team')
    const notMine = give.filter((id) => lg.analysis.rosteredBy[id] !== me)
    if (notMine.length) fail(`${notMine.map((id) => lname(lg, id)).join(', ')} is not on ${teamName(lg, me)}`)
    const dollars = Math.round(num(a.faab) ?? 0)
    if (dollars && !lg.data.tradeFaab) fail('this league cannot trade FAAB')
    return priceDeal(lg, me, partner, give, get, dollars, signal)
  },
}

const priceDeal = async (lg: AsgmLeague, me: number, partner: number, give: string[], get: string[], dollars: number, signal?: AbortSignal): Promise<ToolOut> => {
  const { data, analysis, models } = lg
  const deal = dealOf(me, partner, give, get, dollars)
  const read = readDeal(deal, {
    slots: analysis.slots,
    players: data.players,
    horizon: data.horizon,
    floor: analysis.horizonReplacement,
    capacity: analysis.capacity,
    pts: analysis.horizon.perWeek,
    tradeMarket: analysis.tradeMarket,
    rosters: rostersOf(analysis),
    currency: analysis.currency,
    faab: data.tradeFaab ? models.faab : null,
  })
  const mine = read.sides.find((s) => s.rosterId === me)!
  const theirs = read.sides.find((s) => s.rosterId === partner)!
  const idea = scoreIdea(lg, me, partner, give, get)
  const acc = idea ? readIdea(lg, { ...idea, faab: dollars || undefined }, me) : null
  const lev = await tradeLeverage(lg, me, partner, give, get, signal)
  const per = (ids: string[]) =>
    ids.map((id) => `${lname(lg, id)} (${posOf(lg, id)}, ${r1(analysis.horizon.perWeek[id] ?? 0)}/wk ROS${statusText(lg, id) ? `, ${statusText(lg, id)}` : ''})`).join(', ') || 'nothing'
  const out: string[] = []
  out.push(`${teamName(lg, me)} sends ${per(give)}${dollars > 0 ? ` + $${dollars} FAAB` : ''}; gets ${per(get)}${dollars < 0 ? ` + $${-dollars} FAAB` : ''} from ${teamName(lg, partner)}.`)
  const side = (s: typeof mine, who: string) =>
    `${who} lineup: ${signed(s.lineup)} pts/wk over weeks ${weeksText(read.weeks)} (better in ${s.weeksBetter} of ${read.weeks.length}; by week ${s.perWeek.map((w) => signed(w.delta)).join(' ')})${s.cuts.length ? `; must cut ${s.cuts.map((c) => lname(lg, c)).join(', ')}` : ''}.`
  out.push(side(mine, `${teamName(lg, me)}`))
  out.push(side(theirs, `${teamName(lg, partner)}`))
  out.push(`Trade value as managers price it (reputation counted): ${teamName(lg, me)} ${signed(mine.value)}, ${teamName(lg, partner)} ${signed(theirs.value)}.`)
  if (acc) {
    out.push(`Accept odds: ${acc.index}/100 (${acc.band})${acc.tier !== 'fair' ? `, deal reads as ${acc.tier}` : ''}${acc.capped ? ' (capped by how lopsided it reads)' : ''}.`)
    if (acc.signals.length) out.push(`Why: ${acc.signals.map((s) => `${s.tone === 'pos' ? '+' : s.tone === 'neg' ? '−' : '·'} ${s.text}`).join('; ')}.`)
    if (acc.faab) out.push(`FAAB fix: adding $${acc.faab} evens it in their eyes.`)
  }
  if (lev) {
    const pr = (x: number) => `${signed(x * 100, 0)} pts`
    out.push(
      `Playoff odds: ${teamName(lg, me)} ${pct(lev.after.me.playoffs - lev.me.playoffs)}→${pct(lev.after.me.playoffs)} (${pr(lev.me.playoffs)}), title ${pct(lev.after.me.title - lev.me.title)}→${pct(lev.after.me.title)}; ${teamName(lg, partner)} ${pct(lev.after.partner.playoffs - lev.partner.playoffs)}→${pct(lev.after.partner.playoffs)} (${pr(lev.partner.playoffs)}).`,
    )
  } else out.push('Playoff odds: no season simulation available (no projections ahead).')
  // The call for the asking side, from the same numbers: lineup points first, then the odds, then whether they bite.
  const odds = lev ? ` and ${signed(lev.me.playoffs * 100, 0)} pts of playoff odds` : ''
  const call =
    mine.lineup < -0.3
      ? `don't make this trade. It costs ${teamName(lg, me)} ${signed(mine.lineup)} pts/wk${odds}${acc && acc.index >= 50 ? `; ${teamName(lg, partner)} would take it (${acc.index}/100), which is the problem` : ''}.`
      : mine.lineup > 0.3
        ? acc && acc.index < 35
          ? `worth offering (${signed(mine.lineup)} pts/wk${odds}), but they are unlikely to accept (${acc.index}/100).`
          : `do it: ${signed(mine.lineup)} pts/wk${odds}${acc ? `, ${acc.index}/100 they accept` : ''}.`
        : `a wash on lineup points (${signed(mine.lineup)} pts/wk${odds}): decide on value and need.`
  // First, so it is read first: the verdict for the side asking, whatever the question's wording ("would they take").
  out.unshift(`Call for ${teamName(lg, me)}${me === lg.myRosterId ? ' (you)' : ''}: ${call}`)
  const deadline = Number(data.league.settings?.trade_deadline ?? 0)
  if (deadline && currentWeek(lg) > deadline) out.push(`Warning: the league's trade deadline (week ${deadline}) has passed.`)
  if (!read.valid) out.push(`Problems: ${read.sides.flatMap((s) => s.problems).join('; ')}.`)
  const verdict = `${signed(mine.lineup)} pts/wk for you${acc ? `, ${acc.index}% they accept (${acc.band})` : ''}`
  const cards: AsgmCard[] = [{ kind: 'trade', title: 'Trade', deal, verdict }]
  const f = models.forecast
  if (lev && f) {
    cards.push({
      kind: 'odds',
      title: 'Playoff odds with the trade',
      rows: oddsRows(lg, [
        { rid: me, before: f.sim[me], after: lev.after.me },
        { rid: partner, before: f.sim[partner], after: lev.after.partner },
      ]),
    })
  }
  return { text: out.join('\n'), cards, actions: [{ kind: 'openTrade', deal, label: 'Open in trade builder' }], detail: acc ? `${acc.index}% accept` : undefined }
}

const findTradesTool: ToolDef = {
  name: 'find_trades',
  description: 'Search trades for you, ranked by lineup gain and accept odds. Filter by position needed, a target to acquire, a player of yours to sell, or a partner.',
  params: obj({
    position: S('Position to add: QB, RB, WR, TE.'),
    target: S('A player to acquire.'),
    sell: S('A player of yours to move.'),
    partner: S('Only deals with this team.'),
  }),
  label: (a) => (a.target ? `Building offers for ${a.target}` : a.sell ? `Shopping ${a.sell}` : `Searching trades${a.position ? ` for a ${String(a.position).toUpperCase()}` : ''} across the league`),
  run: (a, lg) => {
    noHorizon(lg)
    const me = MY(lg)
    const deadline = Number(lg.data.league.settings?.trade_deadline ?? 0)
    const pos = a.position ? String(a.position).toUpperCase() : null
    const target = a.target ? must(resolvePlayer(lg, a.target)) : null
    const sell = a.sell ? must(resolvePlayer(lg, a.sell, { rosterId: me })) : null
    const partner = a.partner ? must(resolveTeam(lg, a.partner)) : target ? (lg.analysis.rosteredBy[target] ?? null) : null
    if (target && lg.analysis.rosteredBy[target] == null) fail(`${lname(lg, target)} is a free agent: use waivers`)
    if (target && lg.analysis.rosteredBy[target] === me) fail(`${lname(lg, target)} is already yours`)
    if (sell && lg.analysis.rosteredBy[sell] !== me) fail(`${lname(lg, sell)} is not on your roster`)
    let ideas = tradeIdeas(lg, me).filter(
      (i) =>
        (partner == null || i.partnerId === partner) &&
        (!target || i.get.includes(target)) &&
        (!sell || i.give.includes(sell)) &&
        (!pos || i.get.some((id) => posOf(lg, id) === pos)),
    )
    let built = false
    // A named target or sale: price the plausible packages around him directly too, beside what the search found.
    if (target || sell) {
      const mine = lg.analysis.teamById[me].players.filter((id) => !['K', 'DEF'].includes(posOf(lg, id)) && id !== target)
      const price = (id: string) => lg.analysis.tradeMarket[id] ?? 0
      const cands: TradeIdea[] = []
      if (target) {
        const p = lg.analysis.rosteredBy[target]!
        const pool = mine.sort((x, y) => price(y) - price(x)).slice(0, 10)
        const packs = [...pool.map((x) => [x]), ...pool.flatMap((x, i) => pool.slice(i + 1).map((y) => [x, y]))]
        for (const give of packs) {
          const idea = scoreIdea(lg, me, p, give, [target])
          if (idea) cands.push(idea)
        }
      } else if (sell) {
        for (const t of lg.analysis.teams) {
          if (t.rosterId === me || (partner != null && t.rosterId !== partner)) continue
          const theirs = t.players.filter((id) => !['K', 'DEF'].includes(posOf(lg, id)) && (!pos || posOf(lg, id) === pos))
          for (const get of theirs) {
            const idea = scoreIdea(lg, me, t.rosterId, [sell], [get])
            if (idea) cands.push(idea)
          }
        }
      }
      const known = new Set(ideas.map((i) => `${i.partnerId}|${[...i.give].sort()}|${[...i.get].sort()}`))
      const extra = cands.filter((i) => i.myGain > -0.5 && !known.has(`${i.partnerId}|${[...i.give].sort()}|${[...i.get].sort()}`))
      built = extra.length > 0
      ideas = [...ideas, ...extra]
    }
    const scored = ideas.map((idea) => ({ idea, acc: readIdea(lg, idea, me) }))
    // A named player: the deals they would take first, then the one that costs your lineup least. Otherwise gain × odds.
    if (target || sell) scored.sort((x, y) => (y.acc.index >= 35 ? 1 : 0) - (x.acc.index >= 35 ? 1 : 0) || y.idea.myGain - x.idea.myGain)
    else scored.sort((x, y) => (y.acc.index / 100) * Math.max(0.1, y.idea.myGain + 0.5) - (x.acc.index / 100) * Math.max(0.1, x.idea.myGain + 0.5))
    const top = scored.filter((s) => s.acc.tier === 'fair' || s.acc.tier === 'overpay').slice(0, 4)
    const out: string[] = []
    if (deadline && currentWeek(lg) > deadline) out.push(`Warning: the trade deadline (week ${deadline}) has passed; these are for reference.`)
    if (!top.length) {
      out.push(`No trade found${target ? ` for ${lname(lg, target)}` : ''}${sell ? ` moving ${lname(lg, sell)}` : ''}${pos ? ` at ${pos}` : ''} that helps your lineup and reads as fair to the other side.`)
      return { text: out.join('\n') }
    }
    out.push(`${ideas.length} deals priced${built ? ' (the trade search plus packages built around him)' : ' from the trade search'}; best ${top.length}, ${target || sell ? 'deals they would likely take first (accept 35+), then by your lineup gain' : 'by your gain × accept odds'}:`)
    top.forEach(({ idea, acc }, i) => {
      out.push(
        `${i + 1}. With ${teamName(lg, idea.partnerId)}: give ${idea.give.map((id) => `${lname(lg, id)} (${posOf(lg, id)})`).join(' + ')}; get ${idea.get.map((id) => `${lname(lg, id)} (${posOf(lg, id)})`).join(' + ')}. You ${signed(idea.myGain)} pts/wk (better ${idea.weeksBetter}/${idea.weeks} wks), them ${signed(idea.theirGain)}. Accept ${acc.index}/100 (${acc.band})${acc.faab ? `, add $${acc.faab} FAAB to even it` : ''}. ${acc.signals.slice(0, 2).map((s) => s.text).join('; ')}`,
      )
    })
    out.push('Use evaluate_trade on one for playoff-odds impact.')
    const deals = top.slice(0, 2).map(({ idea }) => dealOf(me, idea.partnerId, idea.give, idea.get))
    return {
      text: out.join('\n'),
      cards: deals.map((deal, i) => ({ kind: 'trade' as const, title: i === 0 ? 'Best offer' : 'Also worth sending', deal, verdict: `${signed(top[i].idea.myGain)} pts/wk for you, ${top[i].acc.index}% accept` })),
      actions: [{ kind: 'openTrade', deal: deals[0], label: 'Open in trade builder' }],
      detail: `${top.length} offer${top.length === 1 ? '' : 's'}`,
    }
  },
}

const bidLine = (lg: AsgmLeague, me: number, id: string, gain: number, budget?: number | null) => {
  const f = lg.models.faab
  if (!f) return null
  const ff = budget != null ? { ...f, remaining: { ...f.remaining, [me]: budget } } : f
  const trend = lg.data.trending.find((t) => t.player_id === id)?.count ?? 0
  return suggestBid(ff, me, { gain, value: lg.analysis.market[id] ?? 0, trending: trend, pos: posOf(lg, id) })
}

const faabSummary = (lg: AsgmLeague, me: number, budget?: number | null) => {
  const f = lg.models.faab
  if (!f) return null
  const mine = budget ?? f.remaining[me] ?? 0
  const others = Object.entries(f.remaining).filter(([r]) => Number(r) !== me).map(([r, v]) => ({ r: Number(r), v })).sort((x, y) => y.v - x.v)
  const richer = others.filter((o) => o.v > mine).length
  return `FAAB: you have $${mine} of $${f.budget}; ${richer ? `${richer} team${richer === 1 ? ' has' : 's have'} more (top: ${others.slice(0, 3).map((o) => `${teamName(lg, o.r)} $${o.v}`).join(', ')})` : 'most in the league'}. League winning bids: median $${f.going.p50}, top 25% $${f.going.p75}+, top 10% $${f.going.p90}+, max $${f.going.max} (${f.going.n} bids, ${f.going.source}). About $${Math.round(f.rate)} per pt/wk of value. ${f.weeksLeft} regular-season weeks left.`
}

const waiversTool: ToolDef = {
  name: 'waivers',
  description: "Your waiver plan: free agents who upgrade your lineup (gain, drop, FAAB bid and league price), this week's QB/TE/K/DEF streams, stashes, handcuffs, FAAB standings. Optional position.",
  params: obj({ position: S('Only this position: QB, RB, WR, TE, K, DEF.') }),
  label: (a) => `Scanning the waiver wire${a.position ? ` for ${String(a.position).toUpperCase()}` : ''}`,
  run: (a, lg) => {
    noHorizon(lg)
    const me = MY(lg)
    const { data, analysis, models } = lg
    const pos = a.position ? String(a.position).toUpperCase().replace('DST', 'DEF') : null
    const targets = faTargets(lg, me)
    const drops = dropCandidates(analysis, me, models.perceived)
    const startable = [...new Set(analysis.slots.flatMap((s) => s.eligible))]
    const starts: Record<string, number> = {}
    for (const s of analysis.slots) if (s.eligible.length === 1) starts[s.eligible[0]] = (starts[s.eligible[0]] ?? 0) + 1
    const trending = Object.fromEntries(data.trending.map((t) => [t.player_id, t.count]))
    const plan = planWaivers({
      targets,
      players: data.players,
      rosteredBy: analysis.rosteredBy,
      myPlayers: analysis.teamById[me].players,
      myStarters: (analysis.needs[me]?.slots.map((s) => s.starter).filter(Boolean) as string[]) ?? [],
      drops,
      weekPts: data.horizon[0]?.pts ?? {},
      perWeek: analysis.horizon.perWeek,
      value: analysis.market,
      trending,
      startable,
      starts,
    })
    const week = currentWeek(lg)
    const keep = (id: string) => !pos || posOf(lg, id) === pos
    const out: string[] = []
    const fs = faabSummary(lg, me)
    if (fs) out.push(fs)
    else out.push(`Waivers: ${data.league.settings?.waiver_type === 2 ? 'FAAB' : 'priority order (no FAAB)'}.`)
    const rows: Extract<AsgmCard, { kind: 'waivers' }>['rows'] = []
    const ups = plan.upgrades.filter((u) => keep(u.id))
    out.push(ups.length ? 'Lineup upgrades (rest of season):' : `No free agent${pos ? ` at ${pos}` : ''} upgrades your lineup by a real margin.`)
    for (const u of ups) {
      const b = bidLine(lg, me, u.id, u.gain)
      out.push(
        `- Add ${lname(lg, u.id)} (${tagOf(lg, u.id)}): ${signed(u.gain)} pts/wk${u.slot ? ` at ${slotName(u.slot)}` : ''}; drop ${u.drop ? lname(lg, u.drop) : 'nobody needed'}${b ? `; bid $${b.bid} (league pays $${b.low}–${b.high}, ${b.tier})` : ''}. ${matchupText(lg, u.id, week)}${u.alts.length ? `. Alternatives: ${u.alts.map((x) => `${lname(lg, x.id)} ${signed(x.add)}`).join(', ')}` : ''}`,
      )
      rows.push({ add: u.id, drop: u.drop ?? undefined, bid: b?.bid, note: `${signed(u.gain)} pts/wk` })
    }
    const streams = plan.streams.filter((s) => keep(s.id))
    if (streams.length) {
      out.push(`Week ${week} streams:`)
      for (const s of streams) {
        out.push(`- ${s.pos}: ${lname(lg, s.id)} exp ${r1(s.proj)} vs your ${s.vs ? `${lname(lg, s.vs)} ${r1(expOf(lg, s.vs, week) ?? 0)}` : 'empty spot'} (${signed(s.gain)}); ${matchupText(lg, s.id, week)}${s.drop ? `; drop ${lname(lg, s.drop)}` : ''}${s.alts.length ? `; next: ${s.alts.map((x) => `${lname(lg, x.id)} ${r1(x.proj)}`).join(', ')}` : ''}`)
        rows.push({ add: s.id, drop: s.drop ?? undefined, bid: models.faab ? models.faab.minBid || 0 : undefined, note: `week ${week} stream` })
      }
    }
    const stashes = plan.stashes.filter((s) => keep(s.id)).slice(0, 4)
    if (stashes.length) out.push(`Stashes: ${stashes.map((s) => `${lname(lg, s.id)} (${s.pos}, value ${signed(s.value)}${s.trend ? `, ${s.trend.toLocaleString('en-US')} adds/day` : ''})`).join('; ')}.`)
    const cuffs = plan.handcuffs.filter((h) => keep(h.id))
    if (cuffs.length) out.push(`Handcuffs: ${cuffs.map((h) => `${lname(lg, h.id)} behind your ${lname(lg, h.starter)}`).join('; ')}.`)
    if (pos) {
      // The best at the position by this week and by the rest of the season, whether or not they start for you.
      const fa = Object.keys(analysis.horizon.perWeek).filter((id) => analysis.rosteredBy[id] == null && posOf(lg, id) === pos)
      const byWeek = [...fa].sort((x, y) => projOf(lg, y, week) - projOf(lg, x, week)).slice(0, 5)
      out.push(`Top free-agent ${pos}s this week: ${byWeek.map((id) => `${lname(lg, id)} ${r1(projOf(lg, id, week))} ${matchupText(lg, id, week)}`).join('; ')}.`)
      const byRos = [...fa].sort((x, y) => analysis.horizon.perWeek[y] - analysis.horizon.perWeek[x]).slice(0, 5)
      out.push(`Top free-agent ${pos}s rest of season: ${byRos.map((id) => `${lname(lg, id)} ${r1(analysis.horizon.perWeek[id])}/wk`).join('; ')}.`)
    }
    if (drops.length) out.push(`Your drop order: ${drops.slice(0, 4).map((id) => lname(lg, id)).join(', ')}.`)
    return {
      text: out.join('\n'),
      cards: rows.length ? [{ kind: 'waivers', title: pos ? `${pos} waiver plan` : 'Waiver plan', rows: rows.slice(0, 6) }] : [],
      actions: [{ kind: 'goto', view: 'waivers', label: 'Open waivers' }],
      detail: `${ups.length} upgrade${ups.length === 1 ? '' : 's'}`,
    }
  },
}

const faabTool: ToolDef = {
  name: 'faab_bid',
  description: "Bid on one free agent: the app's bid, the league's price range, his gain to you, rival budgets, comparable winning bids. budget overrides what you have left.",
  params: obj({ player: S('The free agent.'), budget: N('Dollars you have left, if different from the app.') }, ['player']),
  label: (a) => `Pricing a FAAB bid on ${String(a.player ?? '')}`,
  run: (a, lg) => {
    noHorizon(lg)
    const me = MY(lg)
    const id = must(resolvePlayer(lg, a.player))
    const f = lg.models.faab
    if (!f) fail(`this league does not use FAAB (waiver type ${lg.data.league.settings?.waiver_type ?? '?'}): claims go by priority, so there is no bid to set`)
    const owner = lg.analysis.rosteredBy[id]
    if (owner != null) fail(`${lname(lg, id)} is on ${teamName(lg, owner)}, not on waivers`)
    const budget = num(a.budget)
    const gain = faTargets(lg, me, [id]).find((t) => t.id === id)?.add ?? 0
    const b = bidLine(lg, me, id, gain, budget)!
    const out = [faabSummary(lg, me, budget)!]
    out.push(`${lname(lg, id)} (${tagOf(lg, id)}): adds ${signed(gain)} pts/wk to your lineup; value ${signed(lg.analysis.market[id] ?? 0)} pts/wk over replacement; ${r1(lg.analysis.horizon.perWeek[id] ?? 0)} exp/wk ROS.`)
    out.push(`Bid: $${b.bid} (${b.tier}). League price for this value: $${b.low}–${b.high}.`)
    out.push(`Reasons: ${b.reasons.map((r) => r.text).join('; ')}.`)
    const mine = budget ?? f.remaining[me] ?? 0
    if (mine > 0) out.push(`That is ${pct(b.bid / mine)} of what you have left.`)
    const v = lg.analysis.market[id] ?? 0
    const pos = posOf(lg, id)
    const comps = f.bids
      .filter((x) => x.season === lg.data.league.season && posOf(lg, x.player) === pos && Math.abs((lg.analysis.market[x.player] ?? -9) - v) <= 1.5)
      .sort((x, y) => y.week - x.week)
      .slice(0, 4)
    if (comps.length) out.push(`Comparable wins this season: ${comps.map((c) => `${lname(lg, c.player)} $${c.bid} (w${c.week}, ${teamName(lg, c.rosterId)})`).join('; ')}.`)
    return { text: out.join('\n'), cards: [{ kind: 'waivers', title: `Bid on ${lname(lg, id)}`, rows: [{ add: id, bid: b.bid, note: `$${b.low}–${b.high} league price` }] }] }
  },
}

const LOCK_ARG: Schema = {
  type: 'array',
  description: 'Assumed results, e.g. [{"week":12,"winner":"me"}] or {"week":12,"loser":"me"}.',
  items: { type: 'object', properties: { week: N('Week of the game.'), winner: S('Team that wins.'), loser: S('Team that loses.') }, required: ['week'] } as unknown as Schema,
}

const oddsTool: ToolDef = {
  name: 'playoff_odds',
  description: "Season sims: every team's record, playoff/bye/title odds, likely seed, clinch; your odds if you win vs lose this week; what-ifs with assumed results or winning out.",
  params: obj({ team: TEAM_ARG, what_if: LOCK_ARG, win_out: { type: 'boolean', description: 'Team wins every game left.' } }),
  label: () => 'Running 4,000 playoff sims',
  run: async (a, lg, signal) => {
    const f = lg.models.forecast ?? fail('no season simulation: the app needs projections ahead and a season still to play')
    const rid = must(resolveTeam(lg, a.team))
    const input = lg.models.forecastInput
    const sched = f.simInput.schedule
    const locks: Record<string, number> = {}
    const locked: string[] = []
    const want = Array.isArray(a.what_if) ? (a.what_if as Args[]) : []
    for (const w of want) {
      const week = num(w.week) ?? fail('each what-if needs a week')
      const win = w.winner != null ? must(resolveTeam(lg, w.winner)) : null
      const lose = w.loser != null ? must(resolveTeam(lg, w.loser)) : null
      const who = win ?? lose ?? fail('each what-if needs a winner or a loser')
      const g = sched.find((x) => x.week === week && (x.a === who || x.b === who)) ?? fail(`${teamName(lg, who)} has no regular-season game left in week ${week}`)
      const winner = win ?? (g.a === who ? g.b : g.a)
      locks[lockKey(g)] = winner
      locked.push(`w${week} ${teamName(lg, winner)} beats ${teamName(lg, winner === g.a ? g.b : g.a)}`)
    }
    if (a.win_out) for (const g of sched.filter((x) => x.a === rid || x.b === rid)) locks[lockKey(g)] = rid
    if (a.win_out) locked.push(`${teamName(lg, rid)} wins out`)
    const scen = Object.keys(locks).length ? await runSim(simInputFor(input, f, { locks }), { urgent: true, signal }) : null
    if (signal?.aborted) fail('stopped')
    // This week's stakes for the team: its game won, then lost, on the same seasons.
    const next = f.nextWeek.find((g) => g.a === rid || g.b === rid)
    let stakes: { win: SimTeam; loss: SimTeam } | null = null
    if (next && !Object.keys(locks).length) {
      const k = lockKey(next)
      const opp = next.a === rid ? next.b : next.a
      const [w, l] = await Promise.all([runSim({ ...f.simInput, locks: { [k]: rid } }, { urgent: true, signal }), runSim({ ...f.simInput, locks: { [k]: opp } }, { urgent: true, signal })])
      if (w && l) stakes = { win: w[rid], loss: l[rid] }
    }
    const sim = scen ?? f.sim
    const seasons = lg.analysis.seasonById
    const teams = [...lg.analysis.teams].sort((x, y) => (sim[y.rosterId]?.playoffs ?? 0) - (sim[x.rosterId]?.playoffs ?? 0))
    const slots = Number(lg.data.league.settings?.playoff_teams ?? 0)
    const out: string[] = []
    out.push(`${f.sims.toLocaleString('en-US')} simulated seasons. ${slots} teams make the playoffs (weeks ${weeksText(lg.data.playoffWeeks)}); ${lg.data.futureWeeks.length} regular-season weeks left.${locked.length ? ` Assuming: ${locked.join('; ')}.` : ''}`)
    out.push('Team | record | proj wins | playoffs | bye | title | most likely seed')
    for (const t of teams) {
      const s = sim[t.rosterId]
      const se = seasons[t.rosterId]
      if (!s) continue
      const seed = s.seeds.reduce((best, p, i) => (i > 0 && p > (s.seeds[best] ?? 0) ? i : best), 1)
      const base = scen ? f.sim[t.rosterId] : null
      out.push(
        `${t.name}${t.rosterId === lg.myRosterId ? ' (you)' : ''} | ${se ? `${se.wins}-${se.losses}${se.ties ? `-${se.ties}` : ''}` : '–'} | ${r1(s.wins)} | ${s.clinch === 'in' ? 'CLINCHED' : s.clinch === 'out' ? 'ELIMINATED' : pct(s.playoffs)}${base ? ` (was ${pct(base.playoffs)})` : ''} | ${pct(s.bye)} | ${pct(s.title)} | ${seed}`,
      )
    }
    if (stakes && next) {
      const opp = next.a === rid ? next.b : next.a
      const pWin = next.a === rid ? next.pA : 1 - next.pA
      out.push(`This week (${next.week}) vs ${teamName(lg, opp)}: ${pct(pWin)} to win. Win → playoffs ${pct(stakes.win.playoffs)}, title ${pct(stakes.win.title)}; loss → playoffs ${pct(stakes.loss.playoffs)}, title ${pct(stakes.loss.title)}.`)
    }
    const rows = scen
      ? teams.filter((t) => Math.abs((sim[t.rosterId]?.playoffs ?? 0) - (f.sim[t.rosterId]?.playoffs ?? 0)) >= 0.01 || t.rosterId === rid).slice(0, 6).map((t) => ({ rid: t.rosterId, before: f.sim[t.rosterId], after: sim[t.rosterId] }))
      : teams.slice(0, Math.max(slots + 2, 6)).map((t) => ({ rid: t.rosterId, before: undefined, after: sim[t.rosterId] }))
    return {
      text: out.join('\n'),
      cards: [{ kind: 'odds', title: scen ? 'Playoff odds, what-if' : 'Playoff odds', rows: oddsRows(lg, rows) }],
      actions: [{ kind: 'goto', view: 'playoffs', label: 'Open the playoff simulator' }],
      detail: `${pct(sim[rid]?.playoffs)} playoffs`,
    }
  },
}

/** A team's fantasy game in a week: the opponent, both best lineups, and the win chance the app shows. Throws a ToolError when there is none. */
export const matchupOf = (lg: AsgmLeague, rid: number, week: number) => {
  const opp = opponentIn(lg, rid, week) ?? fail(`${teamName(lg, rid)} has no matchup in week ${week}${lg.data.playoffWeeks.includes(week) ? ' yet (playoff pairings are set by the bracket)' : ''}`)
  const pts = weekPts(lg, week)
  const side = (r: number) => {
    const team = lg.analysis.teamById[r]
    const best = optimalLineup(lg.analysis.slots, lp(lg, team.players, pts))
    const ids = best.assignments.filter(Boolean).map((p) => p!.id)
    const sd = Math.sqrt(sum(ids.map((id) => rangeOf(lg, id, pts(id)).sd ** 2)))
    return { r, total: best.total, ids, sd }
  }
  const A = side(rid)
  const B = side(opp)
  if (!(A.total > 0) && !(B.total > 0)) fail(`no projections for week ${week} yet`)
  const f = lg.models.forecast
  const nw = f?.nextWeek.find((g) => g.week === week && (g.a === rid || g.b === rid))
  const pWin = nw ? (nw.a === rid ? nw.pA : 1 - nw.pA) : f ? phi((f.mean(rid, week) - f.mean(opp, week)) / (f.sigma * Math.SQRT2)) : phi((A.total - B.total) / Math.max(1, Math.sqrt(A.sd ** 2 + B.sd ** 2)))
  return { opp, A, B, pWin, model: !!(nw || f) }
}

const matchupTool: ToolDef = {
  name: 'matchup',
  description: 'A fantasy matchup for a week: both projected lineups, win probability, biggest swings, injuries, byes.',
  params: obj({ team: TEAM_ARG, week: WEEK_ARG }),
  label: (a, lg) => `Previewing the week ${num(a.week) ?? currentWeek(lg)} matchup`,
  run: (a, lg) => {
    const rid = must(resolveTeam(lg, a.team))
    const week = weekArg(lg, a.week)
    const m = matchupOf(lg, rid, week)
    const { opp, A, B, pWin, model } = m
    const pts = weekPts(lg, week)
    const out: string[] = []
    out.push(`Week ${week}: ${teamName(lg, rid)} ${r1(A.total)} vs ${teamName(lg, opp)} ${r1(B.total)} (best lineups, Sleeper projections). ${teamName(lg, rid)} wins ${pct(pWin)}${model ? ' (season model, incl. lineup habits)' : ''}.`)
    for (const s of [A, B]) {
      out.push(`${teamName(lg, s.r)} starters:`)
      for (const id of s.ids) out.push(`- ${playerWeekLine(lg, id, week)}`)
    }
    for (const s of [A, B]) {
      const holes = s.ids.filter((id) => !(pts(id) > 0)).map((id) => lname(lg, id))
      if (holes.length) out.push(`${teamName(lg, s.r)} has a hole: ${holes.join(', ')} project 0 (bye or out).`)
    }
    const swing = [...A.ids, ...B.ids].map((id) => ({ id, sd: rangeOf(lg, id, pts(id)).sd })).sort((x, y) => y.sd - x.sd).slice(0, 4)
    out.push(`Biggest swings (widest ranges): ${swing.map((x) => `${lname(lg, x.id)} ±${r1(x.sd)}`).join(', ')}.`)
    return { text: out.join('\n'), actions: [{ kind: 'openTeam', rosterId: opp, label: `Open ${teamName(lg, opp)}` }], detail: `${pct(pWin)} to win` }
  },
}

const standingsTool: ToolDef = {
  name: 'standings',
  description: 'League table: record, PF/PA, power rank, Elo, playoff odds, streak, luck, remaining schedule strength.',
  params: obj({}),
  label: () => 'Reading the standings and power ranks',
  run: (_a, lg) => {
    const { analysis, models } = lg
    const sim = models.forecast?.sim
    const rows = standingRows(lg)
    const out = ['Rank | team | W-L | PF | PA | power rank (score) | Elo | playoffs | streak | luck (wins) | remaining SOS (avg opp power score)']
    rows.forEach((s, i) => {
      const p = analysis.powerById[s.rosterId]
      out.push(
        `${i + 1} | ${teamName(lg, s.rosterId)}${s.rosterId === lg.myRosterId ? ' (you)' : ''} | ${s.wins}-${s.losses}${s.ties ? `-${s.ties}` : ''} | ${r1(s.pf)} | ${r1(s.pa)} | #${p?.rank ?? '–'} (${r1(p?.score)}) | ${Math.round(models.eloRated[s.rosterId] ?? 0)} | ${sim ? pct(sim[s.rosterId]?.playoffs) : '–'} | ${s.streak || '–'} | ${signed(s.luck)} | ${p?.sos != null ? r1(p.sos) : '–'}`,
      )
    })
    return { text: out.join('\n'), actions: [{ kind: 'goto', view: 'power', label: 'Open power ranks' }] }
  },
}

const teamTool: ToolDef = {
  name: 'team',
  description: 'Any team: record, standing, power, odds, FAAB, roster (starters by slot vs league average, bench), biggest need, strengths/weaknesses, byes ahead, remaining opponents, trading habits and mood.',
  params: obj({ team: TEAM_ARG }),
  label: (a) => `Scouting ${a.team ? String(a.team) : 'your team'}`,
  run: (a, lg) => {
    const rid = must(resolveTeam(lg, a.team))
    const { data, analysis, models } = lg
    const t = analysis.teamById[rid]
    const s = analysis.seasonById[rid]
    const p = analysis.powerById[rid]
    const out: string[] = []
    const sim = models.forecast?.sim[rid]
    out.push(`${t.name}${rid === lg.myRosterId ? ' (you)' : ''}: ${s ? `${s.wins}-${s.losses}${s.ties ? `-${s.ties}` : ''} (${ordinal(standingOf(lg, rid))} of ${analysis.teams.length}), PF ${r1(s.pf)}, PA ${r1(s.pa)}` : ''}; power #${p?.rank ?? '–'}; ${sim ? `playoffs ${pct(sim.playoffs)}, title ${pct(sim.title)}` : 'no odds'}${models.faab ? `; FAAB $${models.faab.remaining[rid] ?? 0}` : ''}; manager ${t.owner}.`)
    const need = analysis.needs[rid]
    if (need) {
      out.push(`Lineup ahead: ${r1(need.lineup)} pts/wk. Slots (starter, pts/wk vs league avg):`)
      for (const sl of need.slots) out.push(`- ${slotName(sl.slot)}: ${sl.starter ? lname(lg, sl.starter) : 'waiver-level fill (nobody on the roster beats the wire here)'} ${r1(sl.pts)} vs ${r1(sl.leagueAvg)} (${signed(sl.gap)})`)
      if (need.worstPos) out.push(`Biggest need: ${need.worstPos} (a league-average starter there adds ${signed(need.byPos[need.worstPos] ?? 0)} pts/wk).`)
    }
    const starters = new Set(need?.slots.map((x) => x.starter).filter(Boolean))
    const bench = t.players.filter((id) => !starters.has(id) && data.players[id]).sort((x, y) => (analysis.horizon.perWeek[y] ?? 0) - (analysis.horizon.perWeek[x] ?? 0))
    if (bench.length) out.push(`Bench: ${bench.map((id) => `${lname(lg, id)} (${posOf(lg, id)} ${r1(analysis.horizon.perWeek[id] ?? 0)}/wk${data.players[id].injury ? `, ${data.players[id].injury}` : ''})`).join(', ')}.`)
    try {
      const sc = scoutTeam(data, analysis, models, rid)
      if (sc.strengths.length) out.push(`Strengths: ${sc.strengths.slice(0, 3).map((f) => `${f.label} ${signed(f.value)}${f.unit} (${f.detail})`).join('; ')}.`)
      if (sc.weaknesses.length) out.push(`Weaknesses: ${sc.weaknesses.slice(0, 3).map((f) => `${f.label} ${signed(f.value)}${f.unit} (${f.detail})`).join('; ')}.`)
    } catch {
      // A scouting fact that cannot be read leaves the rest of the report standing.
    }
    // Byes ahead: weeks where a starter's NFL team is off.
    const byes: string[] = []
    for (const h of data.horizon) {
      const off = [...starters].filter((id) => gameOf(lg, data.players[id!]?.team, h.week).bye)
      if (off.length) byes.push(`w${h.week}: ${off.map((id) => lname(lg, id!)).join(', ')}`)
    }
    if (byes.length) out.push(`Starters on bye: ${byes.join('; ')}.`)
    const opps = data.futureWeeks.map((w) => ({ w, o: opponentIn(lg, rid, w) })).filter((x) => x.o != null)
    if (opps.length) out.push(`Remaining opponents: ${opps.map((x) => `w${x.w} ${teamName(lg, x.o)} (power #${analysis.powerById[x.o!]?.rank ?? '–'})`).join(', ')}.`)
    const b = models.behavior.teams[rid]
    const mood = models.momentum.teams[rid]
    if (b) {
      const partners = Object.entries(b.partners).filter(([, n]) => n > 0).map(([r, n]) => `${teamName(lg, Number(r))} ×${n}`)
      out.push(`Manager: ${b.moves} adds this season (activity ${pct(b.engagement)} percentile), ${b.trades} trades this season, ${b.tradesLast} last${partners.length ? `; traded with ${partners.join(', ')}` : ''}${mood?.text ? `; ${mood.text}` : ''}${s?.streak ? `; streak ${s.streak}` : ''}.`)
    }
    return {
      text: out.join('\n'),
      cards: [{ kind: 'players', title: `${t.name} core`, rows: (need?.slots ?? []).filter((x) => x.starter).slice(0, 6).map((x) => ({ id: x.starter!, value: `${r1(x.pts)}/wk`, tone: x.gap >= 1 ? 'good' : x.gap <= -1 ? 'bad' : 'neutral', note: `${slotName(x.slot)} ${signed(x.gap)} vs avg` })) }],
      actions: [{ kind: 'openTeam', rosterId: rid, label: `Open ${t.name}` }],
    }
  },
}

const tradeValuesTool: ToolDef = {
  name: 'trade_values',
  description: "Sell-high/buy-low: model value ahead vs what the room pays, plus recent form, for a team (default you) or 'league' at a position.",
  params: obj({ team: S('A team, "me", or "league" for every other team. Default: me.'), position: S('QB, RB, WR or TE. Default: all.') }),
  label: (a) => `Reading trade values${a.position ? ` at ${String(a.position).toUpperCase()}` : ''}`,
  run: (a, lg) => {
    noHorizon(lg)
    const { data, analysis, models } = lg
    const pos = a.position ? String(a.position).toUpperCase() : null
    const league = typeof a.team === 'string' && /^(league|all|everyone|others?)$/i.test(a.team.trim())
    const rid = league ? null : must(resolveTeam(lg, a.team))
    const pool = (rid != null ? analysis.teamById[rid].players : Object.keys(analysis.rosteredBy).filter((id) => analysis.rosteredBy[id] !== lg.myRosterId)).filter(
      (id) => data.players[id] && !['K', 'DEF'].includes(posOf(lg, id)) && (!pos || posOf(lg, id) === pos),
    )
    const room = models.perceived ?? analysis.tradeMarket
    const rows = pool
      .map((id) => {
        const model = analysis.market[id] ?? 0
        const price = room[id] ?? analysis.tradeMarket[id] ?? 0
        const f = analysis.form[id]
        const formAdj = f ? Math.max(0, price) * (f.factor - 1) : 0
        // Positive: the room pays more than the weeks ahead are worth. That is the sale.
        return { id, model, price, gap: price + formAdj - model, f }
      })
      .filter((r) => r.model > 0.2 || r.price > 0.5)
      .sort((x, y) => y.gap - x.gap)
    if (!rows.length) fail('no players with a value to read there')
    const out = [`${rid != null ? teamName(lg, rid) : 'Other teams'}${pos ? `, ${pos}s` : ''}: model value = pts/wk over replacement ahead; room price = ${models.perceived ? 'FantasyPros consensus priced on the same scale' : 'trade price (no consensus loaded)'}; gap = room − model (+ form).`]
    const line = (r: (typeof rows)[number]) => {
      const pv = analysis.values[r.id]
      const ecr = data.consensus?.byId[r.id]
      return `- ${lname(lg, r.id)} (${posOf(lg, r.id)}${rid == null ? `, ${teamName(lg, analysis.rosteredBy[r.id])}` : ''}): model ${signed(r.model)}, room ${signed(r.price)}, gap ${signed(r.gap)}${ecr?.posRank != null ? ` · ECR ${posOf(lg, r.id)}${Math.round(ecr.posRank)} vs model ${posOf(lg, r.id)}${modelPosRank(lg, r.id) ?? '?'}` : ''}${pv?.games ? ` · season ${r1(pv.ppg)} ppg vs ${r1(analysis.horizon.perActive[r.id] ?? 0)} exp ahead` : ''}${r.f ? ` · ${r.f.kind}: ${formText(r.f)}` : ''}${statusText(lg, r.id) ? ` · ${statusText(lg, r.id)}` : ''}`
    }
    const out_ = (id: string) => /^(IR|Out|PUP|Sus|Doubtful)/i.test(lg.data.players[id]?.injury ?? '')
    const sellScore = (r: (typeof rows)[number]) => r.gap + (r.f?.kind === 'sell-high' ? 1 : 0)
    const buyScore = (r: (typeof rows)[number]) => -r.gap + (r.f?.kind === 'buy-low' ? 1 : 0)
    const sells = rows.filter((r) => r.gap > 0.3 || r.f?.kind === 'sell-high').sort((x, y) => sellScore(y) - sellScore(x)).slice(0, 4)
    const buys = rows.filter((r) => r.gap < -0.3 || r.f?.kind === 'buy-low').sort((x, y) => buyScore(y) - buyScore(x)).slice(0, 4)
    out.push(sells.length ? 'Sell-high (room pays more than the model sees ahead):' : 'No clear sell-high: nobody here is priced above his outlook.')
    sells.forEach((r) => out.push(line(r)))
    out.push(buys.length ? 'Buy-low / hold (model sees more than the room pays):' : 'No clear buy-low here.')
    buys.forEach((r) => out.push(line(r)))
    const sell = sells.find((r) => !out_(r.id))
    const buy = buys.find((r) => !out_(r.id))
    if (rid != null && rid === lg.myRosterId) out.push(`Call: ${sell ? `sell ${lname(lg, sell.id)} (room pays ${signed(sell.gap)} over his outlook${sell.f?.kind === 'sell-high' ? ', off a spike week' : ''})` : 'nobody healthy is priced above his outlook'}${buy ? `; hold ${lname(lg, buy.id)}, the room underrates him` : ''}.`)
    else if (buy) out.push(`Call: target ${lname(lg, buy.id)} on ${teamName(lg, lg.analysis.rosteredBy[buy.id])} (model sees ${signed(-buy.gap)} pts/wk more than the room pays).`)
    return {
      text: out.join('\n'),
      cards: [{ kind: 'players', title: 'Sell-high and buy-low', rows: [...sells.map((r) => ({ id: r.id, value: signed(r.gap), note: 'sell high', tone: 'good' as const })), ...buys.map((r) => ({ id: r.id, value: signed(r.gap), note: 'buy low', tone: 'neutral' as const }))].slice(0, 6) }],
    }
  },
}

const rankingsTool: ToolDef = {
  name: 'rankings',
  description: "Rank a position by this week's projection, rest of season, or points scored this season (league leaders), among free agents, rostered or all, with owners.",
  params: obj({
    position: S('QB, RB, WR, TE, K, DEF, or FLEX.'),
    basis: { type: 'string', enum: ['week', 'ros', 'season'], description: 'week (default), ros, or season (points scored so far: league leaders).' },
    week: WEEK_ARG,
    pool: { type: 'string', enum: ['available', 'rostered', 'all'], description: 'Default all.' },
    limit: N('How many, default 10, at most 20.'),
  }, ['position']),
  label: (a) => `Ranking ${String(a.position ?? '').toUpperCase()}s`,
  run: (a, lg) => {
    const { data, analysis } = lg
    const raw = String(a.position ?? '').toUpperCase().replace('DST', 'DEF')
    const flex = analysis.slots.find((s) => s.name === 'FLEX')?.eligible ?? ['RB', 'WR', 'TE']
    const ok = raw === 'FLEX' ? (p: string) => flex.includes(p) : (p: string) => p === raw
    const basis = a.basis === 'ros' ? 'ros' : a.basis === 'season' ? 'season' : 'week'
    const week = weekArg(lg, a.week)
    const pool = ['available', 'rostered'].includes(String(a.pool)) ? String(a.pool) : 'all'
    const limit = Math.min(20, Math.max(1, num(a.limit) ?? 10))
    const seasonPts = (id: string) => (analysis.values[id]?.games ? analysis.values[id].ppg * analysis.values[id].games : 0)
    const score = (id: string) => (basis === 'ros' ? (analysis.horizon.perWeek[id] ?? 0) : basis === 'season' ? seasonPts(id) : weekPts(lg, week)(id))
    const ids = Object.keys(data.players)
      .filter((id) => ok(data.players[id].pos) && (pool === 'all' || (pool === 'available') === (analysis.rosteredBy[id] == null)) && score(id) > 0)
      .sort((x, y) => score(y) - score(x))
      .slice(0, limit)
    if (!ids.length) fail(`no ${raw} with a projection there`)
    const what = basis === 'ros' ? 'rest-of-season expectation (pts/wk)' : basis === 'season' ? 'points scored this season (league scoring)' : `week ${week} projection`
    const out = [`${raw} by ${what}, ${pool}:`]
    ids.forEach((id, i) =>
      out.push(
        `${i + 1}. ${lname(lg, id)} (${tagOf(lg, id)}) ${r1(score(id))}${basis === 'season' ? ` (${r1(analysis.values[id]?.ppg)} ppg, ${analysis.values[id]?.games ?? 0} games)` : ''}${basis === 'week' ? ` ${matchupText(lg, id, week)}` : ''}${statusText(lg, id) ? ` · ${statusText(lg, id)}` : ''}`,
      ),
    )
    const title = basis === 'ros' ? 'rest of season' : basis === 'season' ? 'season leaders' : `week ${week}`
    return { text: out.join('\n'), cards: [{ kind: 'players', title: `${raw} ${title}`, rows: ids.slice(0, 8).map((id) => ({ id, value: r1(score(id)).toFixed(1) })) }] }
  },
}

const leagueNeedsTool: ToolDef = {
  name: 'league_needs',
  description: "Every team's needs: pts/wk a league-average starter at a position would add to each lineup. Who needs a QB/RB/WR/TE most.",
  params: obj({ position: S('QB, RB, WR or TE. Default: all.') }),
  label: (a) => `Reading every team's needs${a.position ? ` at ${String(a.position).toUpperCase()}` : ''}`,
  run: (a, lg) => {
    noHorizon(lg)
    const { analysis } = lg
    const pos = a.position ? String(a.position).toUpperCase() : null
    if (pos && !['QB', 'RB', 'WR', 'TE'].includes(pos)) fail('position must be QB, RB, WR or TE')
    const teams = analysis.teams.filter((t) => analysis.needs[t.rosterId])
    if (!teams.length) fail('no lineup projections to read needs from')
    const you = (rid: number) => (rid === lg.myRosterId ? ' (you)' : '')
    const out: string[] = []
    if (pos) {
      const rows = teams.map((t) => ({ rid: t.rosterId, gain: analysis.needs[t.rosterId].byPos[pos] ?? 0 })).sort((x, y) => y.gain - x.gain)
      out.push(`Who needs a ${pos} most (pts/wk a league-average ${pos} starter adds; 0 = no gain):`)
      rows.forEach((r, i) => {
        const starters = analysis.needs[r.rid].slots.filter((x) => x.starter && posOf(lg, x.starter) === pos).map((x) => `${lname(lg, x.starter!)} ${r1(x.pts)}/wk`)
        out.push(`${i + 1}. ${teamName(lg, r.rid)}${you(r.rid)} ${signed(r.gain)} · ${pos} starters: ${starters.join(', ') || 'none'} · biggest need ${analysis.needs[r.rid].worstPos ?? '–'}`)
      })
    } else {
      out.push("Each team's biggest need (pts/wk a league-average starter adds there), then the other positions:")
      for (const t of teams) {
        const n = analysis.needs[t.rosterId]
        const others = Object.entries(n.byPos).filter(([p]) => ['QB', 'RB', 'WR', 'TE'].includes(p)).sort((x, y) => y[1] - x[1]).map(([p, g]) => `${p} ${signed(g)}`)
        out.push(`- ${t.name}${you(t.rosterId)}: ${n.worstPos ?? 'no clear need'} · ${others.join(', ')}`)
      }
    }
    return { text: out.join('\n'), detail: pos ? `${pos} needs` : 'needs by team' }
  },
}

const scheduleTool: ToolDef = {
  name: 'schedule',
  description: "A team's season week by week: results and scores so far, opponents left (power rank), and head-to-head with another team this season and last.",
  params: obj({ team: TEAM_ARG, vs: S('Optional: another team, for head-to-head.') }),
  label: (a, lg) => `Reading ${a.team ? String(a.team) : 'your'} schedule${a.vs ? ` vs ${String(a.vs)}` : ''}`,
  run: (a, lg) => {
    const rid = must(resolveTeam(lg, a.team))
    const vs = a.vs != null && a.vs !== '' ? must(resolveTeam(lg, a.vs)) : null
    const { data, analysis } = lg
    const game = (ms: { roster_id: number; matchup_id: number | null; points?: number | null }[] | undefined, r: number) => {
      const m = ms?.find((x) => x.roster_id === r)
      if (!m || m.matchup_id == null) return null
      const o = ms!.find((x) => x.matchup_id === m.matchup_id && x.roster_id !== r)
      return o ? { opp: o.roster_id, pf: m.points ?? 0, pa: o.points ?? 0 } : null
    }
    const out = [`${teamName(lg, rid)}${rid === lg.myRosterId ? ' (you)' : ''}: ${recordOf(lg, rid)}, ${ordinal(standingOf(lg, rid))} in the standings.`]
    const played = data.regularWeeks.map((w) => ({ w, g: game(data.matchupsByWeek[w], rid) })).filter((x) => x.g)
    const res = (g: { pf: number; pa: number }) => (g.pf > g.pa ? 'W' : g.pf < g.pa ? 'L' : 'T')
    if (played.length) out.push(`Results: ${played.map(({ w, g }) => `w${w} ${res(g!)} ${r1(g!.pf)}–${r1(g!.pa)} vs ${teamName(lg, g!.opp)}`).join('; ')}.`)
    const left = data.futureWeeks.map((w) => ({ w, o: opponentIn(lg, rid, w) })).filter((x) => x.o != null)
    if (left.length) out.push(`Left: ${left.map((x) => `w${x.w} ${teamName(lg, x.o)} (${recordOf(lg, x.o!)}, power #${analysis.powerById[x.o!]?.rank ?? '–'})`).join('; ')}.`)
    if (data.playoffWeeks.length) out.push(`Fantasy playoffs: weeks ${weeksText(data.playoffWeeks)}, ${data.league.settings?.playoff_teams ?? '?'} teams.`)
    if (vs != null) {
      const now = played.filter(({ g }) => g!.opp === vs)
      const h = data.history
      const back: Record<number, number> = {}
      for (const [old, cur] of Object.entries(h?.rosterMap ?? {})) back[cur] = Number(old)
      const then = h && back[rid] != null && back[vs] != null ? h.weeks.map((w) => ({ w, g: game(h.matchupsByWeek[w], back[rid]) })).filter((x) => x.g && x.g.opp === back[vs]) : []
      const line = (xs: typeof now) => xs.map(({ w, g }) => `w${w} ${res(g!)} ${r1(g!.pf)}–${r1(g!.pa)}`).join(', ')
      const wl = (xs: typeof now) => `${xs.filter(({ g }) => g!.pf > g!.pa).length}-${xs.filter(({ g }) => g!.pf < g!.pa).length}`
      out.push(`Head-to-head with ${teamName(lg, vs)}: this season ${now.length ? `${wl(now)} (${line(now)})` : 'not played yet'}${left.some((x) => x.o === vs) ? `; they meet again week ${left.filter((x) => x.o === vs).map((x) => x.w).join(', ')}` : ''}${h ? `; ${h.season}: ${then.length ? `${wl(then)} (${line(then)})` : 'did not meet'}` : ''}.`)
    }
    return { text: out.join('\n'), actions: [{ kind: 'openTeam', rosterId: rid, label: `Open ${teamName(lg, rid)}` }] }
  },
}

const transactionsTool: ToolDef = {
  name: 'transactions',
  description: 'Recent league moves, newest first: trades (players, FAAB), waiver claims with bids, free-agent adds and drops. For the league or one team.',
  params: obj({ team: S('A team, or leave out for the whole league.'), type: { type: 'string', enum: ['trade', 'waiver', 'all'], description: 'Default all.' }, limit: N('How many, default 12, at most 25.') }),
  label: (a) => `Reading ${a.type === 'trade' ? 'trades' : 'transactions'}${a.team ? ` for ${String(a.team)}` : ''}`,
  run: (a, lg) => {
    const rid = a.team != null && a.team !== '' && !/^(league|all|everyone)$/i.test(String(a.team).trim()) ? must(resolveTeam(lg, a.team)) : null
    const type = a.type === 'trade' ? 'trade' : a.type === 'waiver' ? 'waiver' : 'all'
    const limit = Math.min(25, Math.max(1, num(a.limit) ?? 12))
    const txs = lg.data.transactions
      .filter((t) => t.status === 'complete' && (rid == null || t.roster_ids.includes(rid)) && (type === 'all' || (type === 'trade' ? t.type === 'trade' : t.type === 'waiver')))
      .sort((x, y) => (y.processed ?? y.created) - (x.processed ?? x.created))
    if (!txs.length) return { text: `No ${type === 'all' ? 'transactions' : `${type}s`} ${rid != null ? `for ${teamName(lg, rid)} ` : ''}this season in the app's data.` }
    const names = (ids: string[]) => ids.map((id) => lname(lg, id)).join(', ')
    const out = [`${type === 'trade' ? 'Trades' : 'Transactions'}${rid != null ? ` involving ${teamName(lg, rid)}` : ''}, newest first (${txs.length} this season):`]
    for (const t of txs.slice(0, limit)) {
      const adds = Object.entries(t.adds ?? {})
      const drops = Object.entries(t.drops ?? {})
      if (t.type === 'trade') {
        const sides = t.roster_ids.map((r) => {
          const got = adds.filter(([, to]) => to === r).map(([id]) => id)
          const cash = (t.faab ?? []).filter((f) => f.receiver === r).reduce((s, f) => s + f.amount, 0)
          return `${teamName(lg, r)} gets ${got.length ? names(got) : 'no players'}${cash ? ` + $${cash} FAAB` : ''}`
        })
        out.push(`- w${t.leg} trade: ${sides.join('; ')}${t.picks ? ` (+${t.picks} draft pick${t.picks === 1 ? '' : 's'})` : ''}.`)
      } else {
        const r = t.roster_ids[0]
        const add = adds.map(([id]) => id)
        const drop = drops.map(([id]) => id)
        out.push(`- w${t.leg} ${t.type === 'waiver' ? 'waiver claim' : t.type === 'free_agent' ? 'free-agent move' : t.type}: ${teamName(lg, r)}${add.length ? ` adds ${names(add)}${t.bid ? ` ($${t.bid})` : ''}` : ''}${drop.length ? `${add.length ? ',' : ''} drops ${names(drop)}` : ''}.`)
      }
    }
    return { text: out.join('\n'), detail: `${Math.min(limit, txs.length)} of ${txs.length}` }
  },
}

export const TOOLS: ToolDef[] = [
  lineupTool,
  startSitTool,
  playerTool,
  compareTool,
  newsTool,
  evaluateTool,
  findTradesTool,
  waiversTool,
  faabTool,
  oddsTool,
  matchupTool,
  standingsTool,
  teamTool,
  tradeValuesTool,
  rankingsTool,
  leagueNeedsTool,
  scheduleTool,
  transactionsTool,
]
export const TOOL_BY_NAME: Record<string, ToolDef> = Object.fromEntries(TOOLS.map((t) => [t.name, t]))

/** Run one tool, turning a bad argument or a missing feed into a result the model can read and recover from. */
export const runTool = async (name: string, args: Args, lg: AsgmLeague, signal?: AbortSignal): Promise<ToolOut & { ok: boolean }> => {
  const tool = TOOL_BY_NAME[name]
  if (!tool) return { ok: false, text: `Error: no tool named ${name}. Tools: ${TOOLS.map((t) => t.name).join(', ')}.` }
  try {
    const out = await tool.run(args ?? {}, lg, signal)
    // Names that end in a period ("Jr.", "Sr.") must not end a sentence twice.
    return { ok: true, ...out, text: out.text.replace(/\.\.(?=\s|$)/g, '.') }
  } catch (e) {
    const msg = e instanceof ToolError ? e.message : `the ${name} tool failed (${(e as Error)?.message ?? e})`
    return { ok: false, text: `Error: ${msg}.` }
  }
}

/** A tool's step label, safe on any arguments. */
export const toolLabel = (name: string, args: Args, lg: AsgmLeague) => {
  try {
    return TOOL_BY_NAME[name]?.label(args ?? {}, lg) ?? `Running ${name}`
  } catch {
    return `Running ${name}`
  }
}

export { priceDeal, streakText, ToolError, recordOf }
