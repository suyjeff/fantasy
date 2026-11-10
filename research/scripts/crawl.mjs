// Pulls the raw material for the model audit from Sleeper's API into research/data/raw (gzipped JSON, one file per
// request, so a re-run only fetches what is missing).
//
//   node research/scripts/crawl.mjs players          the player directory (positions, teams, ids)
//   node research/scripts/crawl.mjs nfl 2018 2026    weekly projections and stat lines, every week of those seasons
//   node research/scripts/crawl.mjs leagues          league-seasons: the seeds in tests/accuracy/leagues.json, their
//                                                    previous_league_id chains, and (one hop out) every league their
//                                                    managers played in, each with its own chain
//
// Sleeper asks for fewer than 1,000 calls a minute; this stays near 400.
import { gzipSync, gunzipSync } from 'node:zlib'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'raw')
const API = 'https://api.sleeper.app'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let last = 0
const GAP = Number(process.env.GAP ?? 150)
const get = async (path) => {
  const file = join(ROOT, path.replace(/^\/+/, '').replace(/[?&=]/g, '_') + '.json.gz')
  if (existsSync(file)) return JSON.parse(gunzipSync(readFileSync(file)).toString())
  for (let i = 0; i < 5; i++) {
    const wait = last + GAP - Date.now()
    last = Math.max(Date.now(), last + GAP)
    if (wait > 0) await sleep(wait)
    try {
      const res = await fetch(API + path)
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`${res.status} ${path}`)
      const body = await res.json()
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, gzipSync(JSON.stringify(body)))
      return body
    } catch (e) {
      if (i === 4) throw e
      await sleep(1000 * 2 ** i)
    }
  }
}

/** Run `fn` over `xs` with `n` in flight (the rate limit is the real throttle). */
const pool = async (xs, n, fn) => {
  let i = 0
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < xs.length) {
      const x = xs[i++]
      try {
        await fn(x)
      } catch (e) {
        console.error('skip', x, e.message)
      }
    }
  }))
}

const nfl = async (from, to) => {
  const jobs = []
  for (let s = from; s <= to; s++) for (let w = 1; w <= 18; w++) jobs.push([s, w])
  await pool(jobs, 4, async ([s, w]) => {
    await get(`/v1/projections/nfl/regular/${s}/${w}`)
    await get(`/v1/stats/nfl/regular/${s}/${w}`)
  })
  for (let s = from; s <= to; s++) await get(`/schedule/nfl/regular/${s}`)
}

/** One league-season, whole: settings, rosters, every week's matchups through the playoffs, the bracket. */
const leagueSeason = async (id) => {
  const league = await get(`/v1/league/${id}`)
  if (!league) return null
  await get(`/v1/league/${id}/rosters`)
  await get(`/v1/league/${id}/users`)
  const start = league.settings?.playoff_week_start || 15
  for (let w = 1; w <= Math.min(18, start + 3); w++) await get(`/v1/league/${id}/matchups/${w}`)
  await get(`/v1/league/${id}/winners_bracket`)
  return league
}

const leagues = async () => {
  const seeds = JSON.parse(readFileSync(join(ROOT, '..', '..', '..', 'tests', 'accuracy', 'leagues.json'), 'utf8')).leagues.map((l) => l.id)
  const seen = new Set()
  const users = new Set()
  const chain = async (id, collectUsers) => {
    while (id && id !== '0' && !seen.has(id)) {
      seen.add(id)
      const league = await leagueSeason(id)
      if (!league) return
      if (collectUsers) for (const u of (await get(`/v1/league/${id}/users`)) ?? []) users.add(u.user_id)
      id = league.previous_league_id
    }
  }
  for (const id of seeds) await chain(id, true)
  console.log(`seeds: ${seen.size} league-seasons, ${users.size} managers`)
  // One hop: every NFL league those managers played in, 2021-2026, each with its chain.
  const found = new Set()
  await pool([...users], 4, async (u) => {
    for (let s = 2021; s <= 2026; s++) for (const l of (await get(`/v1/user/${u}/leagues/nfl/${s}`)) ?? []) found.add(l.league_id)
  })
  console.log(`one hop: ${found.size} leagues to fetch`)
  let done = 0
  await pool([...found], 6, async (id) => {
    await chain(id, false)
    if (++done % 50 === 0) console.log(`${done} / ${found.size} (${seen.size} league-seasons)`)
  })
  writeFileSync(join(ROOT, 'league_ids.json'), JSON.stringify([...seen]))
  console.log(`league-seasons: ${seen.size}`)
}

/**
 * A second hop: every manager in the leagues fetched so far, and every finished league they played in, 2022–2025.
 * Only head-to-head redraft-shaped leagues the model is built for: 8–14 teams, not best ball, season complete.
 * Capped at `cap` league-seasons, taken in a fixed (hashed) order so the sample is not biased toward early managers.
 */
const expand = async (cap) => {
  const ids = JSON.parse(readFileSync(join(ROOT, 'league_ids.json'), 'utf8'))
  const users = new Set()
  for (const id of ids) for (const u of (await get(`/v1/league/${id}/users`)) ?? []) users.add(u.user_id)
  console.log(`managers: ${users.size}`)
  const found = new Map()
  await pool([...users], Number(process.env.POOL ?? 6), async (u) => {
    for (let s = 2022; s <= 2025; s++)
      for (const l of (await get(`/v1/user/${u}/leagues/nfl/${s}`)) ?? []) {
        const n = l.total_rosters
        if (l.status !== 'complete' || n < 8 || n > 14 || l.settings?.best_ball === 1 || ids.includes(l.league_id)) continue
        found.set(l.league_id, s)
      }
  })
  const hash = (s) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7)
  const pick = [...found.keys()].sort((x, y) => hash(x) - hash(y)).slice(0, cap)
  console.log(`eligible: ${found.size}; fetching ${pick.length}`)
  let done = 0
  await pool(pick, Number(process.env.POOL ?? 8), async (id) => {
    await leagueSeason(id)
    if (++done % 100 === 0) console.log(`${done} / ${pick.length}`)
  })
  writeFileSync(join(ROOT, 'league_ids.json'), JSON.stringify([...new Set([...ids, ...pick])]))
  console.log('done')
}

const [cmd, a, b] = process.argv.slice(2)
mkdirSync(ROOT, { recursive: true })
if (cmd === 'players') await get('/v1/players/nfl')
else if (cmd === 'nfl') await nfl(Number(a), Number(b))
else if (cmd === 'leagues') await leagues()
else if (cmd === 'expand') await expand(Number(a) || 1200)
else console.log('usage: crawl.mjs players | nfl <from> <to> | leagues')
