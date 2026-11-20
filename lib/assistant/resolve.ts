// Reading the model's words back into the league: players and teams by name, and the shared week-level numbers every
// tool reads (projections, ranges, matchups, byes). Everything here is a pure read of the league already loaded.
import { phi } from '../forecast'
import { normName, lastName } from '../names'
import { positionCV } from '../slate'
import type { TrimmedPlayer } from '../types'
import { impliedTotals, pointsAllowed, type Allowed, type StreamPos, type TeamTotal } from '../waivers'
import type { AsgmLeague } from './league'

export const r1 = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? 0 : Math.round(x * 10) / 10)
export const pct = (p: number | null | undefined) => (p == null || !Number.isFinite(p) ? '–' : p >= 0.995 ? '>99%' : p > 0 && p < 0.005 ? '<1%' : `${Math.round(p * 100)}%`)
/** +1.2 / −0.4; anything that rounds to zero reads +0.0, never −0.0. */
export const signed = (x: number, d = 1) => {
  const v = Number((x ?? 0).toFixed(d))
  return `${v >= 0 || Object.is(v, -0) ? '+' : '−'}${Math.abs(v).toFixed(d)}`
}
export const money = (x: number) => `$${Math.round(x)}`

/** A memo on the league for anything that costs more than a lookup. */
export const memo = <T>(lg: AsgmLeague, key: string, build: () => T): T => {
  if (lg.memo.has(key)) return lg.memo.get(key) as T
  const v = build()
  lg.memo.set(key, v)
  return v
}

const SKILL = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DEF'])
const POS_WORD: Record<string, string> = { qb: 'QB', rb: 'RB', wr: 'WR', te: 'TE', k: 'K', pk: 'K', kicker: 'K', def: 'DEF', dst: 'DEF', 'd/st': 'DEF', defense: 'DEF' }

export type Resolved<T> = { ok: true; value: T } | { ok: false; error: string }

/** The current week the app plans for: the first week of the horizon, else the NFL week. */
export const currentWeek = (lg: AsgmLeague) => lg.data.horizon[0]?.week ?? lg.data.projectionWeek ?? lg.data.futureWeeks[0] ?? lg.data.state.week

/** Sleeper's projection for a week in league scoring: what "projected" means in the app. */
export const projOf = (lg: AsgmLeague, id: string, week: number) => {
  const { data } = lg
  if (data.projectionWeek === week && data.projections) return data.projections[id] ?? 0
  return data.projectionsByWeek[week]?.[id] ?? 0
}

/** The model's expectation for a week: the projection with injury odds, roles and (this week) prop lines folded in. */
export const expOf = (lg: AsgmLeague, id: string, week: number) => lg.data.horizon.find((h) => h.week === week)?.pts[id] ?? null

/** Week-to-week spread by position, measured on this league's season. */
export const cvOf = (lg: AsgmLeague) => memo(lg, 'cv', () => positionCV(lg.data.weekPoints, lg.data.valueWeeks, lg.data.players))

/** 20th to 80th percentile game around a projection. */
export const rangeOf = (lg: AsgmLeague, id: string, proj: number) => {
  const pos = lg.data.players[id]?.pos ?? 'WR'
  const sd = (cvOf(lg)[pos] ?? 0.65) * Math.max(1, proj)
  return { sd, low: Math.max(0, proj - 0.8416 * sd), high: proj + 0.8416 * sd }
}

/** P(a outscores b) for two projections with their spreads. */
export const beats = (pa: number, sda: number, pb: number, sdb: number) => phi((pa - pb) / Math.max(1, Math.sqrt(sda * sda + sdb * sdb)))

/** Fantasy points each NFL defense has allowed to a position this season, ranked (1 = softest). */
export const allowedFor = (lg: AsgmLeague, pos: string): Record<string, Allowed> => {
  if (!SKILL.has(pos)) return {}
  const own = !lg.data.pointsSource.startsWith('proxy')
  return memo(lg, `allowed:${pos}`, () => (own ? pointsAllowed(lg.data.weekPoints, lg.data.valueWeeks, lg.data.players, lg.data.schedule, pos as StreamPos) : {}))
}

/** Implied team totals for a week (betting lines for the coming week; nothing further out without stat lines). */
export const totalsFor = (lg: AsgmLeague, week: number): Record<string, TeamTotal> =>
  memo(lg, `totals:${week}`, () => impliedTotals({ week, schedule: lg.data.schedule, statLines: null, market: lg.data.market, players: lg.data.players }))

export type Game = { opp: string | null; home: boolean | null; bye: boolean }
export const gameOf = (lg: AsgmLeague, team: string | null | undefined, week: number): Game => {
  const s = lg.data.schedule
  if (!team || !s) return { opp: null, home: null, bye: false }
  const opp = s.opp[team]?.[week] ?? null
  return { opp, home: s.home?.[team]?.[week] ?? null, bye: !opp && s.weeks.includes(week) }
}

/** "vs SF (#28 to RB, tough)" or "BYE", for a player in a week. */
export const matchupText = (lg: AsgmLeague, id: string, week: number) => {
  const p = lg.data.players[id]
  if (!p) return ''
  const g = gameOf(lg, p.team, week)
  if (g.bye) return 'BYE'
  if (!g.opp) return ''
  const a = allowedFor(lg, p.pos)[g.opp]
  const n = Object.keys(allowedFor(lg, p.pos)).length || 32
  const where = g.home === false ? '@' : 'vs'
  if (!a) return `${where} ${g.opp}`
  const word = a.rank <= n / 4 ? 'soft' : a.rank > (n * 3) / 4 ? 'tough' : 'neutral'
  return `${where} ${g.opp} (#${a.rank}/${n} pts allowed to ${p.pos}, ${word})`
}

/** Injury designation and the model's chance he plays this week, when either says anything. */
export const statusText = (lg: AsgmLeague, id: string, week?: number) => {
  const p = lg.data.players[id]
  if (!p) return ''
  const note = lg.data.context[id]?.notes.find((n) => n.kind === 'status' && (week == null || n.week === week))
  const play = note && note.kind === 'status' ? note.play : null
  const inj = p.injury ? `${p.injury}${p.injuryBody ? ` (${p.injuryBody})` : ''}` : ''
  if (!inj && play == null) return ''
  return [inj, play != null ? `plays ${pct(play)}` : ''].filter(Boolean).join(', ')
}

const teamOf = (lg: AsgmLeague, id: string) => lg.analysis.rosteredBy[id]

/** A player's short tag: "RB, KC" plus owner. */
export const tagOf = (lg: AsgmLeague, id: string) => {
  const p = lg.data.players[id]
  if (!p) return id
  const rid = teamOf(lg, id)
  const own = rid == null ? 'FA' : rid === lg.myRosterId ? 'yours' : lg.analysis.teamById[rid]?.name ?? `team ${rid}`
  return `${p.pos} ${p.team ?? 'FA'}, ${own}`
}

/** A team's players at each position, ordered by this week's projection: what "my RB2" means. */
export const depthLabels = (lg: AsgmLeague, rosterId: number, week = currentWeek(lg)) => {
  const team = lg.analysis.teamById[rosterId]
  const out: Record<string, string> = {}
  if (!team) return out
  const byPos: Record<string, string[]> = {}
  for (const id of team.players) {
    const p = lg.data.players[id]
    if (p) (byPos[p.pos] ??= []).push(id)
  }
  const value = (id: string) => (expOf(lg, id, week) ?? projOf(lg, id, week)) + 0.25 * (lg.analysis.horizon.perWeek[id] ?? 0)
  for (const [pos, ids] of Object.entries(byPos)) ids.sort((a, b) => value(b) - value(a)).forEach((id, i) => (out[id] = `${pos}${i + 1}`))
  return out
}

/** A player from what the model wrote: an id, a full or last name, "my RB2". Rostered and valuable players win ties. */
export const resolvePlayer = (lg: AsgmLeague, raw: unknown, opts: { rosterId?: number | null } = {}): Resolved<string> => {
  const { players } = lg.data
  const q = String(raw ?? '').trim()
  if (!q) return { ok: false, error: 'no player named' }
  if (players[q]) return { ok: true, value: q }
  // "my RB2", "RB2", "Pos2 on <team>" is left to the team argument.
  const slot = /^(?:my\s+)?(qb|rb|wr|te|k|def|dst)\s*(\d)$/i.exec(q)
  if (slot) {
    const rid = opts.rosterId ?? lg.myRosterId
    if (rid == null) return { ok: false, error: `no team to read "${q}" on` }
    const labels = depthLabels(lg, rid)
    const want = `${POS_WORD[slot[1].toLowerCase()] ?? slot[1].toUpperCase()}${slot[2]}`
    const id = Object.keys(labels).find((k) => labels[k] === want)
    return id ? { ok: true, value: id } : { ok: false, error: `no ${want} on that roster` }
  }
  const n = normName(q.replace(/\s*\((?:[A-Z]{2,3}|FA)[^)]*\)\s*$/, ''))
  if (!n) return { ok: false, error: `no player matches "${q}"` }
  const score = (id: string) => (teamOf(lg, id) != null ? 100 : 0) + (lg.analysis.market[id] ?? 0) + (lg.analysis.horizon.perWeek[id] ?? 0) / 10
  const pick = (ids: string[]) => ids.sort((a, b) => score(b) - score(a))[0]
  const all = Object.values(players) as TrimmedPlayer[]
  const name = (p: TrimmedPlayer) => normName(p.name)
  const exact = all.filter((p) => name(p) === n).map((p) => p.id)
  if (exact.length) return { ok: true, value: pick(exact) }
  // A defense by team: "Bears", "CHI", "Chicago".
  const def = all.filter((p) => p.pos === 'DEF' && (p.id.toLowerCase() === n || name(p).split(' ').includes(n)))
  if (def.length) return { ok: true, value: pick(def.map((p) => p.id)) }
  const last = all.filter((p) => normName(lastName(p.name)) === n).map((p) => p.id)
  if (last.length) return { ok: true, value: pick(last) }
  const words = n.split(' ')
  const partial = all.filter((p) => {
    const w = name(p)
    return words.every((x) => w.includes(x))
  })
  if (partial.length) return { ok: true, value: pick(partial.map((p) => p.id)) }
  return { ok: false, error: `no player matches "${q}" in this league's player list` }
}

/** A team from what the model wrote: "me", a roster id, a team or manager name. */
export const resolveTeam = (lg: AsgmLeague, raw: unknown): Resolved<number> => {
  const { analysis } = lg
  if (raw == null || raw === '' || (typeof raw === 'string' && /^(me|my|mine|my team|you|yours|self)$/i.test(raw.trim()))) {
    return lg.myRosterId != null ? { ok: true, value: lg.myRosterId } : { ok: false, error: 'no team of yours in this league; name one' }
  }
  const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/^#|^team\s*/i, ''))
  if (Number.isInteger(n) && analysis.teamById[n]) return { ok: true, value: n }
  const q = normName(String(raw))
  const hit =
    analysis.teams.find((t) => normName(t.name) === q || normName(t.owner) === q) ??
    analysis.teams.find((t) => normName(t.name).includes(q) || q.includes(normName(t.name)) || normName(t.owner).includes(q))
  return hit ? { ok: true, value: hit.rosterId } : { ok: false, error: `no team matches "${raw}"; teams: ${analysis.teams.map((t) => t.name).join(', ')}` }
}

/** This roster's fantasy opponent in a week, from the league's schedule. */
export const opponentIn = (lg: AsgmLeague, rosterId: number, week: number): number | null => {
  const ms = lg.data.matchupsByWeek[week] ?? []
  const m = ms.find((x) => x.roster_id === rosterId)
  if (!m || m.matchup_id == null) return null
  return ms.find((x) => x.matchup_id === m.matchup_id && x.roster_id !== rosterId)?.roster_id ?? null
}

/** Last few games: points scored against Sleeper's pre-game projection. */
export const recentGames = (lg: AsgmLeague, id: string, n = 3) => {
  const { data } = lg
  if (data.pointsSource.startsWith('proxy')) return [] as { week: number; pts: number | null; proj: number | null }[]
  return data.regularWeeks
    .slice(-n)
    .map((w) => ({ week: w, pts: data.weekPoints[w]?.[id] ?? null, proj: data.pastProjections[w]?.[id] ?? null }))
}

export const weeksAhead = (lg: AsgmLeague) => lg.data.horizon.map((h) => h.week)
