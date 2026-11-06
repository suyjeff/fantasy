// Reads the raw pulls (research/scripts/crawl.mjs) back as the app's own types, and rebuilds what the app would have
// known about a league at any week of a past season. Everything model-shaped goes through lib/, unchanged.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { trimPlayer } from '../../lib/sleeper'
import { scoreProjectionLine } from '../../lib/scoring'
import { BASE_AVAILABILITY, playProbability, SKILL_POSITIONS } from '../../lib/context'
import type { PlayerMap, SleeperLeague, SleeperMatchup, SleeperRoster } from '../../lib/types'

export const DATA = join(__dirname, '..', 'data')
const RAW = join(DATA, 'raw')

export const load = <T>(path: string): T | null => {
  const f = join(RAW, path + '.json.gz')
  return existsSync(f) ? (JSON.parse(gunzipSync(readFileSync(f)).toString()) as T) : null
}

let playersCache: PlayerMap | null = null
/** Every player Sleeper lists, retired ones included: a past season's rosters are full of them. */
export const allPlayers = (): PlayerMap => {
  if (playersCache) return playersCache
  const raw = load<Record<string, Record<string, unknown>>>('v1/players/nfl') ?? {}
  const out: PlayerMap = {}
  for (const id of Object.keys(raw)) {
    const t = trimPlayer({ ...(raw[id] as object), player_id: id } as never)
    if (t) out[id] = t
  }
  return (playersCache = out)
}

export type LeagueSeason = {
  id: string
  season: number
  league: SleeperLeague
  rosters: SleeperRoster[]
  matchups: Record<number, SleeperMatchup[]>
  /** Regular-season weeks with results. */
  weeks: number[]
  playoffStart: number
  playoffTeams: number
  /** Teams that played in the winners bracket, and its champion: the truth the odds are graded on. */
  playoffIds: Set<number>
  champion: number | null
}

type BracketGame = { r: number; m: number; t1: number | { w?: number; l?: number } | null; t2: number | { w?: number; l?: number } | null; w: number | null; l: number | null; p?: number }

export const leagueIds = (): string[] => JSON.parse(readFileSync(join(RAW, 'league_ids.json'), 'utf8'))

export const leagueSeason = (id: string): LeagueSeason | null => {
  const league = load<SleeperLeague>(`v1/league/${id}`)
  const rosters = load<SleeperRoster[]>(`v1/league/${id}/rosters`)
  if (!league || !rosters) return null
  const playoffStart = Number(league.settings?.playoff_week_start ?? 15)
  const matchups: Record<number, SleeperMatchup[]> = {}
  for (let w = 1; w <= Math.min(18, playoffStart + 3); w++) matchups[w] = load<SleeperMatchup[]>(`v1/league/${id}/matchups/${w}`) ?? []
  const weeks: number[] = []
  for (let w = 1; w < playoffStart; w++) if ((matchups[w] ?? []).some((m) => m.matchup_id != null && (m.points ?? 0) > 0)) weeks.push(w)
  const bracket = load<BracketGame[]>(`v1/league/${id}/winners_bracket`) ?? []
  const playoffIds = new Set<number>()
  for (const g of bracket) for (const t of [g.t1, g.t2]) if (typeof t === 'number') playoffIds.add(t)
  const final = bracket.find((g) => g.p === 1)
  return {
    id,
    season: Number(league.season),
    league,
    rosters,
    matchups,
    weeks,
    playoffStart,
    playoffTeams: Number(league.settings?.playoff_teams ?? 6),
    playoffIds,
    champion: final?.w ?? null,
  }
}

const projCache = new Map<string, Record<string, number>>()
/** A week of Sleeper projections scored with the league's settings (one number per player), as the app reads them. */
export const scoredProjections = (season: number, week: number, scoring: Record<string, number>) => {
  const key = `${season}:${week}:${JSON.stringify(scoring)}`
  const hit = projCache.get(key)
  if (hit) return hit
  const raw = load<Record<string, Record<string, number>>>(`v1/projections/nfl/regular/${season}/${week}`) ?? {}
  const out: Record<string, number> = {}
  for (const id of Object.keys(raw)) {
    const line = raw[id]
    if (!line || !(line.pts_half_ppr || line.pts_ppr || line.pts_std || line.fgm || line.def_td || line.sack)) continue
    const pts = scoreProjectionLine(line, scoring)
    if (pts) out[id] = pts
  }
  if (projCache.size > 400) projCache.clear()
  projCache.set(key, out)
  return out
}

const teamCache = new Map<number, { teams: Record<string, Record<string, string>>; byes: Record<string, number[]> }>()
const NV_TEAM: Record<string, string> = { LAR: 'LA' }
/** A player's NFL team as of `week` (the last week nflverse saw him), and whether it is off in week `f`. */
export const byeOf = (season: number) => {
  let t = teamCache.get(season)
  if (!t) {
    const f = join(DATA, 'derived', `teams_${season}.json`)
    t = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : { teams: {}, byes: {} }
    teamCache.set(season, t!)
  }
  const { teams, byes } = t!
  return (id: string, asOf: number, f: number, fallback: string | null) => {
    const byWeek = teams[id]
    let team: string | null = null
    if (byWeek) for (const [w, x] of Object.entries(byWeek)) if (Number(w) <= asOf || team === null) team = x
    team ??= fallback ? (NV_TEAM[fallback] ?? fallback) : null
    return team ? (byes[team] ?? []).includes(f) : false
  }
}

/**
 * The weeks ahead as the app would have priced them after week `asOf`: next week's projection, carried forward, with
 * the app's own availability decay (lib/context playProbability at the base rate) and zero on a bye. The app reads
 * each future week's own projection; a stored past week's projection already knows that week's injuries, so carrying
 * next week's forward is what keeps the backtest from seeing the future.
 */
export const asOfHorizon = (ls: LeagueSeason, asOf: number, futureWeeks: number[], players: PlayerMap) => {
  const scoring = ls.league.scoring_settings ?? {}
  const next = scoredProjections(ls.season, asOf + 1, scoring)
  const bye = byeOf(ls.season)
  return futureWeeks.map((f) => {
    const pts: Record<string, number> = {}
    for (const id of Object.keys(next)) {
      const p = players[id]
      if (bye(id, asOf, f, p?.pos === 'DEF' ? id : (p?.team ?? null))) continue
      const skill = p && (SKILL_POSITIONS as readonly string[]).includes(p.pos)
      pts[id] = next[id] * (skill && f > asOf + 1 ? playProbability(BASE_AVAILABILITY, f - asOf - 1) : 1)
    }
    return { week: f, pts }
  })
}
