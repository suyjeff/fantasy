// The live test: each week's predictions written down before kickoff, then scored against what happened.
//
//   LIVE=log   npx vitest run --config research/vitest.config.ts research/harness/live.test.ts
//   LIVE=score npx vitest run --config research/vitest.config.ts research/harness/live.test.ts
//
// log    for every league in tests/accuracy/leagues.json, through the app's own pipeline (loadLeagueData, analyze,
//        buildModels): next week's games with MONKE's expectation and win probability, Sleeper's matchup number (its
//        projection of the starters set right now) turned into a probability on the same σ, and every team's playoff
//        and title odds. Written once per week to research/live/<season>/w<week>.json with the time it was taken and
//        how many of each side's starters had already kicked off; a later run that week does not overwrite it.
// score  every logged week whose games are final: log loss, Brier and picks for MONKE and Sleeper, game by game and
//        to date, into research/live/<season>/scores.json.
//
// .github/workflows/live-log.yml runs both on a schedule and commits the files, so the record is timestamped by git.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { it } from 'vitest'
import { analyze } from '../../lib/analysis'
import { phi } from '../../lib/forecast'
import { buildModels } from '../../lib/models'
import { DEFAULT_POWER_WEIGHTS } from '../../lib/power'
import { getMatchups, getSchedule } from '../../lib/sleeper'
import { loadLeagueData } from '../../lib/useLeagueData'
import { DEFAULT_MODEL } from '../../lib/war'
import config from '../../tests/accuracy/leagues.json'

const USERNAME = 'thejeffanator'
const DIR = join(__dirname, '..', 'live')
const winP = (a: number, b: number, sigma: number) => phi((a - b) / (Math.SQRT2 * Math.max(1, sigma)))

type LoggedGame = {
  a: number
  b: number
  nameA: string
  nameB: string
  monke: { muA: number; muB: number; pA: number }
  sleeper: { projA: number; projB: number; pA: number }
  /** Starters whose NFL game had already started when this was logged (0 means fully pre-kickoff). */
  kickedOff: { a: number; b: number }
}
type LoggedLeague = { id: string; name: string; sigma: number; games: LoggedGame[]; odds: Record<number, { playoffs: number; title: number; clinch: string | null }> }
type Log = { season: string; week: number; loggedAt: string; leagues: LoggedLeague[] }

const logWeek = async () => {
  let out: Log | null = null
  for (const l of config.leagues) {
    const data = await loadLeagueData({ provider: 'sleeper', username: USERNAME, leagueId: l.id })
    if (data.state.season_type !== 'regular' || data.league.season !== data.state.season) continue
    const analysis = analyze(data, DEFAULT_MODEL, DEFAULT_POWER_WEIGHTS)
    const models = buildModels(data, analysis)
    const f = models.forecast
    if (!f || !f.nextWeek.length) continue
    const week = f.nextWeek[0].week
    out ??= { season: data.league.season, week, loggedAt: new Date().toISOString(), leagues: [] }
    const nflGames = (await getSchedule(data.league.season)).filter((g) => g.week === week)
    const started = new Set(nflGames.filter((g) => g.status && g.status !== 'pre_game').flatMap((g) => [g.home, g.away]))
    const ms = data.matchupsByWeek[week] ?? []
    const raw = data.rawHorizon.find((h) => h.week === week)?.pts ?? {}
    const starters = (rid: number) => (ms.find((m) => m.roster_id === rid)?.starters ?? []).filter((s) => s && s !== '0')
    const proj = (rid: number) => starters(rid).reduce((a, id) => a + (raw[id] ?? 0), 0)
    const kicked = (rid: number) => starters(rid).filter((id) => started.has(data.players[id]?.team ?? (data.players[id]?.pos === 'DEF' ? id : ''))).length
    const name = (rid: number) => analysis.teams.find((t) => t.rosterId === rid)?.name ?? String(rid)
    out.leagues.push({
      id: l.id,
      name: l.name,
      sigma: f.sigma,
      games: f.nextWeek.map((g) => ({
        a: g.a,
        b: g.b,
        nameA: name(g.a),
        nameB: name(g.b),
        monke: { muA: g.muA, muB: g.muB, pA: g.pA },
        sleeper: { projA: Math.round(proj(g.a) * 100) / 100, projB: Math.round(proj(g.b) * 100) / 100, pA: Math.round(winP(proj(g.a), proj(g.b), f.sigma) * 1000) / 1000 },
        kickedOff: { a: kicked(g.a), b: kicked(g.b) },
      })),
      odds: Object.fromEntries(Object.values(f.sim).map((s) => [s.rosterId, { playoffs: s.playoffs, title: s.title, clinch: s.clinch }])),
    })
  }
  if (!out) return console.log('nothing to log: out of season')
  const dir = join(DIR, out.season)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `w${String(out.week).padStart(2, '0')}.json`)
  if (existsSync(file)) return console.log(`already logged: ${file}`)
  writeFileSync(file, JSON.stringify(out, null, 1) + '\n')
  console.log(`logged ${file}`)
}

const scoreWeeks = async () => {
  if (!existsSync(DIR)) return
  for (const season of readdirSync(DIR)) {
    const dir = join(DIR, season)
    const rows: { week: number; league: string; a: number; b: number; y: number; monke: number; sleeper: number; preKickoff: boolean }[] = []
    for (const f of readdirSync(dir).filter((x) => /^w\d+\.json$/.test(x)).sort()) {
      const log = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Log
      for (const l of log.leagues) {
        const ms = await getMatchups(l.id, log.week, true)
        const pts = (rid: number) => ms.find((m) => m.roster_id === rid)?.points ?? 0
        // Final only: every game in the week has points on both sides, and the week has passed.
        const sched = (await getSchedule(log.season)).filter((g) => g.week === log.week)
        if (!sched.length || sched.some((g) => g.status !== 'complete')) continue
        for (const g of l.games) {
          const pa = pts(g.a)
          const pb = pts(g.b)
          if (!(pa > 0 && pb > 0) || pa === pb) continue
          rows.push({ week: log.week, league: l.name, a: g.a, b: g.b, y: pa > pb ? 1 : 0, monke: g.monke.pA, sleeper: g.sleeper.pA, preKickoff: g.kickedOff.a + g.kickedOff.b === 0 })
        }
      }
    }
    const ll = (p: number, y: number) => -(y ? Math.log(Math.max(1e-6, p)) : Math.log(Math.max(1e-6, 1 - p)))
    const sum = (k: 'monke' | 'sleeper', xs = rows) => ({
      games: xs.length,
      logLoss: xs.length ? xs.reduce((a, r) => a + ll(r[k], r.y), 0) / xs.length : null,
      brier: xs.length ? xs.reduce((a, r) => a + (r[k] - r.y) ** 2, 0) / xs.length : null,
      right: xs.filter((r) => r[k] !== 0.5 && r[k] > 0.5 === (r.y === 1)).length,
    })
    const pre = rows.filter((r) => r.preKickoff)
    const scores = { scoredAt: new Date().toISOString(), all: { monke: sum('monke'), sleeper: sum('sleeper') }, preKickoff: { monke: sum('monke', pre), sleeper: sum('sleeper', pre) }, games: rows }
    writeFileSync(join(dir, 'scores.json'), JSON.stringify(scores, null, 1) + '\n')
    console.log(season, JSON.stringify(scores.all))
  }
}

it('live predictions', async () => {
  if (process.env.LIVE === 'score') await scoreWeeks()
  else await logWeek()
}, 600_000)
