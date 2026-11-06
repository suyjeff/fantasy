// The backtest's TypeScript half: every past league-season pulled, played forward through the app's own model code.
//
//   SHARD=0 SHARDS=4 npx vitest run --config research/vitest.config.ts
//
// Writes three CSVs per shard to research/data/harness/:
//
//   team_week   every team-week: points, opponent, the projected optimal lineup (lib/trades makeLineupEval, the number
//               the forecast rates), the projection of the starters actually used (what Sleeper's matchup screen
//               shows at kickoff), managed points (lib/forecast managedPoints) and the hindsight optimum
//   player      every rostered player-week: projection, actual, started, in the projected optimal lineup
//   season      after weeks 3, 5, 7, 9 and 11: each team's playoff and title odds from lib/forecast buildForecast at the
//               shipped settings, and re-simulated over a grid of tauShare × persistence on the same ratings, next to
//               whether it actually made the playoffs and won the title
//
// Nothing here changes a model: what the Python half fits is fitted on these rows.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { it } from 'vitest'
import { buildForecast, divisionsOf, managedPoints, persistMean, playoffRoundWeeks, simulateSeason, SIM, type ForecastInput } from '../../lib/forecast'
import { optimalLineup, startingSlots, type LineupPlayer } from '../../lib/lineup'
import { buildTeamSeasons, buildTeamWeeks, hasMedianGame } from '../../lib/power'
import { makeLineupEval, projectedReplacement } from '../../lib/trades'
import { allPlayers, asOfHorizon, DATA, leagueIds, leagueSeason, scoredProjections, type LeagueSeason } from './leagues'

const SHARD = Number(process.env.SHARD ?? 0)
const SHARDS = Number(process.env.SHARDS ?? 1)
const SIMS = Number(process.env.SIMS ?? 1000)
const ASOF = [3, 5, 7, 9, 11]
export const TAU_GRID = [0, 0.2, 0.3, 0.4, 0.5, 0.6]
export const PERSIST_GRID = [0.4, 0.5, 0.6, 0.7, 0.85, 1]

const csv = (rows: (string | number | null | undefined)[][]) => rows.map((r) => r.map((x) => (x == null ? '' : typeof x === 'number' ? +x.toFixed(4) : x)).join(',')).join('\n') + '\n'

const teamWeekRows: (string | number | null)[][] = []
const playerRows: (string | number | null)[][] = []
const seasonRows: (string | number | null)[][] = []

const runLeague = (ls: LeagueSeason) => {
  const players = allPlayers()
  const positions = ls.league.roster_positions ?? []
  const slots = startingSlots(positions)
  const scoring = ls.league.scoring_settings ?? {}
  const n = ls.rosters.length
  const median = hasMedianGame(ls.league)
  const teamWeeks = buildTeamWeeks(ls.matchups, ls.weeks, slots, players, { median })
  const proj: Record<number, Record<string, number>> = {}
  for (let w = 1; w <= Math.min(18, ls.playoffStart + 3); w++) proj[w] = scoredProjections(ls.season, w, scoring)

  for (const w of ls.weeks) {
    const pw = proj[w]
    if (!Object.keys(pw).length) continue
    const floor = projectedReplacement(pw, players, positions, n, 0.6)
    const ev = makeLineupEval(slots, players, pw, floor)
    for (const t of teamWeeks[w] ?? []) {
      const roster = t.players.filter((id) => players[id])
      const lp: LineupPlayer[] = roster.map((id) => ({ id, fpos: players[id].fpos, pts: pw[id] ?? 0 }))
      const opt = new Set(optimalLineup(slots, lp).assignments.filter((x): x is LineupPlayer => !!x).map((x) => x.id))
      const started = new Set(t.starters)
      const projStarters = t.starters.reduce((a, id) => a + (pw[id] ?? 0), 0)
      teamWeekRows.push([ls.id, ls.season, w, t.rosterId, t.opponentId, t.points, t.opponentPoints, ev.total(roster), projStarters, managedPoints(t, slots, pw, floor), t.optimalPoints, n, ls.playoffIds.has(t.rosterId) ? 1 : 0])
      for (const id of roster) {
        if (!(pw[id] > 0) && !started.has(id)) continue
        playerRows.push([ls.id, ls.season, w, t.rosterId, id, players[id].pos, pw[id] ?? 0, t.playersPoints[id] ?? 0, started.has(id) ? 1 : 0, opt.has(id) ? 1 : 0])
      }
    }
  }

  // Season odds from the app's forecast, as of the end of each week in ASOF.
  const regularEnd = ls.playoffStart - 1
  const rounds = playoffRoundWeeks(ls.playoffStart, ls.playoffTeams, Number(ls.league.settings?.playoff_round_type ?? 0), ls.season >= 2021 ? 18 : 17)
  if (ls.playoffIds.size !== ls.playoffTeams) return
  for (const asOf of ASOF) {
    if (asOf >= regularEnd - 1 || !ls.weeks.includes(asOf)) continue
    const played = ls.weeks.filter((w) => w <= asOf)
    const future = ls.weeks.filter((w) => w > asOf)
    const futureAll = [...future, ...rounds.flat()]
    const horizon = asOfHorizon(ls, asOf, futureAll, players)
    const next = proj[asOf + 1] ?? {}
    const floor = projectedReplacement(next, players, positions, n, 0.6)
    const rosterWeek = ls.matchups[asOf + 1]?.length ? asOf + 1 : asOf
    const teams = (ls.matchups[rosterWeek] ?? []).map((m) => ({ rosterId: m.roster_id, players: (m.players ?? []).filter((id) => players[id]) }))
    const record: ForecastInput['record'] = {}
    for (const s of buildTeamSeasons(teams.map((t) => t.rosterId), teamWeeks, played, {})) record[s.rosterId] = { wins: s.wins, losses: s.losses, ties: s.ties, pf: s.pf }
    const schedule: ForecastInput['schedule'] = []
    for (const w of future) {
      const ms = ls.matchups[w] ?? []
      for (const m of ms) {
        const o = ms.find((x) => x.matchup_id != null && x.matchup_id === m.matchup_id && x.roster_id !== m.roster_id)
        if (o && m.roster_id < o.roster_id) schedule.push({ week: w, a: m.roster_id, b: o.roster_id })
      }
    }
    const input: ForecastInput = {
      slots,
      players,
      horizon,
      floor,
      teams,
      teamWeeks: Object.fromEntries(played.map((w) => [w, teamWeeks[w] ?? []])),
      playedWeeks: played,
      pastProjections: Object.fromEntries(played.map((w) => [w, proj[w]])),
      schedule,
      record,
      playoffWeeks: rounds.flat(),
      playoffRounds: rounds,
      playoffTeams: ls.playoffTeams,
      elo: {},
      sigmaFallback: 25,
      weeksLeft: future.length,
      divisions: divisionsOf(ls.rosters, ls.league.settings?.divisions as number | undefined),
      median: median || undefined,
    }
    const f = buildForecast(input, SIMS)
    const ids = teams.map((t) => t.rosterId)
    const grid: Record<string, Record<number, { playoffs: number; title: number }>> = {}
    for (const tau of TAU_GRID)
      for (const p of PERSIST_GRID) {
        const sim = simulateSeason({ ...f.simInput, tau: tau * f.simInput.sigma, mean: persistMean(f.mean, ids, p) })
        grid[`${tau}_${p}`] = Object.fromEntries(ids.map((id) => [id, { playoffs: sim[id].playoffs, title: sim[id].title }]))
      }
    for (const id of ids) {
      const r = record[id]
      const s = f.sim[id]
      const row: (string | number | null)[] = [ls.id, ls.season, asOf, id, median ? 1 : 0, n, ls.playoffTeams, future.length, r.wins, r.losses, r.pf, f.byId[id].rating, f.byId[id].efficiency, f.sigma, ls.playoffIds.has(id) ? 1 : 0, ls.champion === id ? 1 : 0, s.clinch ?? '', s.playoffs, s.title]
      for (const k of Object.keys(grid)) row.push(grid[k][id].playoffs, grid[k][id].title)
      seasonRows.push(row)
    }
  }
}

it('plays every league-season forward', () => {
  const ids = leagueIds().filter((_, i) => i % SHARDS === SHARD)
  let done = 0
  for (const id of ids) {
    const ls = leagueSeason(id)
    if (!ls || ls.weeks.length < 8 || ls.rosters.length < 8 || ls.rosters.length > 14) continue
    if (ls.league.status !== 'complete' && ls.season !== 2026) continue
    if (ls.league.settings?.best_ball === 1) continue
    try {
      runLeague(ls)
      done++
    } catch (e) {
      console.error('league failed', id, (e as Error).message)
    }
  }
  const out = join(DATA, process.env.OUT ?? 'harness')
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, `team_week_${SHARD}.csv`), 'league_id,season,week,rid,opp,points,opp_points,proj_opt,proj_st,managed,optimal,n_teams,made\n' + csv(teamWeekRows))
  writeFileSync(join(out, `player_${SHARD}.csv`), 'league_id,season,week,rid,player_id,pos,proj,actual,started,in_opt\n' + csv(playerRows))
  const gridCols = TAU_GRID.flatMap((t) => PERSIST_GRID.flatMap((p) => [`po_${t}_${p}`, `ti_${t}_${p}`]))
  writeFileSync(
    join(out, `season_${SHARD}.csv`),
    ['league_id,season,asof,rid,median,n_teams,playoff_teams,weeks_left,wins,losses,pf,rating,efficiency,sigma,made,champ,clinch,p_playoffs,p_title', ...gridCols].join(',') + '\n' + csv(seasonRows),
  )
  console.log(`shard ${SHARD}: ${done} league-seasons, ${teamWeekRows.length} team-weeks, ${seasonRows.length} season rows (sims ${SIMS}, shipped ${SIM.sims})`)
}, 6 * 3600_000)
