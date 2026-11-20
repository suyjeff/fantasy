// Captures a real league, as the app loads it, into the Assistant GM test fixture (lib/__tests__/fixtures/asgm-league.json.gz).
// Skipped unless ASGM_CAPTURE is set; it reads Sleeper's public API:
//   ASGM_CAPTURE=1 ASGM_USER=<sleeper username> ASGM_LEAGUE=<league id> npx vitest run scripts/asgm-capture.test.ts
// Players are trimmed to the ones the league touches, and nothing identifying is kept (see anonymise): team, manager
// and league names are neutral, and every Sleeper id for the league, its draft, its users and its chat is remapped.
// ASGM_ANON=1 re-applies the anonymising to the fixture already on disk, without the network.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { loadLeagueData, type LeagueData } from '../lib/useLeagueData'

const NAMES = ['Gridiron Gang', 'Waiver Wolves', 'Bye Week Bandits', 'Flex Capacitors', 'Red Zone Rebels', 'Fourth & Long', 'Hail Marys', 'Blitz Brigade', 'Pocket Passers', 'Two-Point Tries', 'Goal Line Stand', 'Sack Masters', 'Punt Returners', 'Screen Team']

const trim = (d: LeagueData): LeagueData => {
  const keep = new Set<string>()
  for (const r of d.rosters) for (const id of [...(r.players ?? []), ...(r.reserve ?? []), ...(r.taxi ?? [])]) keep.add(id)
  // The best unrostered players at each position by the weeks ahead and the season so far: the waiver pool.
  const score: Record<string, number> = {}
  for (const h of d.horizon) for (const [id, p] of Object.entries(h.pts)) score[id] = (score[id] ?? 0) + p
  for (const w of d.valueWeeks) for (const [id, p] of Object.entries(d.weekPoints[w] ?? {})) score[id] = (score[id] ?? 0) + p * 0.5
  const byPos: Record<string, string[]> = {}
  for (const id of Object.keys(score)) {
    const pos = d.players[id]?.pos
    if (!pos) continue
    ;(byPos[pos] ??= []).push(id)
  }
  for (const pos of Object.keys(byPos)) byPos[pos].sort((a, b) => score[b] - score[a]).slice(0, pos === 'K' || pos === 'DEF' ? 40 : 110).forEach((id) => keep.add(id))
  for (const t of d.transactions) for (const id of [...Object.keys(t.adds ?? {}), ...Object.keys(t.drops ?? {})]) keep.add(id)
  for (const t of d.trending) keep.add(t.player_id)
  const has = (id: string) => keep.has(id) && !!d.players[id]
  const pick = <T,>(o: Record<string, T> | null | undefined) => (o ? Object.fromEntries(Object.entries(o).filter(([id]) => has(id))) : o)
  const users = d.users.map((u, i) => ({ ...u, username: `manager${i + 1}`, display_name: `Manager ${i + 1}`, avatar: null, metadata: { team_name: NAMES[i % NAMES.length] } }))
  return {
    ...d,
    me: { ...d.me, ...users.find((u) => u.user_id === d.me.user_id) },
    leagues: [d.league],
    users,
    players: pick(d.players)!,
    weekPoints: Object.fromEntries(Object.entries(d.weekPoints).map(([w, x]) => [w, pick(x)!])),
    projections: pick(d.projections),
    projectionsByWeek: Object.fromEntries(Object.entries(d.projectionsByWeek).map(([w, x]) => [w, pick(x)!])),
    horizon: d.horizon.map((h) => ({ ...h, pts: pick(h.pts)! })),
    rawHorizon: d.rawHorizon.map((h) => ({ ...h, pts: pick(h.pts)! })),
    context: pick(d.context)!,
    availability: pick(d.availability)!,
    usage: pick(d.usage)!,
    pastProjections: Object.fromEntries(Object.entries(d.pastProjections).map(([w, x]) => [w, pick(x)!])),
    consensus: d.consensus ? { ...d.consensus, byId: pick(d.consensus.byId)! } : null,
    market: d.market ? { ...d.market, byId: pick(d.market.byId)! } : null,
    history: d.history ? { ...d.history, transactions: d.history.transactions.slice(-200) } : null,
  }
}

/** League fields that are Sleeper's chat and bracket plumbing: nothing the app reads, and some of it identifying. */
const CHAT = /^(last_|shard$|group_id$|company_id$|bracket_|loser_bracket_|avatar$)/

/** The neutral ids handed out: 100000000000000001 and up. */
export const FAKE_ID = /^100000000000000\d{3}$/

/** Every Sleeper id of 15+ digits (league, draft, users, chat) mapped onto a neutral one, the same id always the same. */
const remapIds = (x: unknown, map: Map<string, string>): unknown => {
  if (typeof x === 'string') {
    // Ids this has already handed out stay as they are, so running it twice changes nothing.
    if (!/^\d{15,20}$/.test(x) || FAKE_ID.test(x)) return x
    if (!map.has(x)) map.set(x, `100000000000000${String(map.size + 1).padStart(3, '0')}`)
    return map.get(x)
  }
  if (Array.isArray(x)) return x.map((v) => remapIds(v, map))
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [remapIds(k, map) as string, remapIds(v, map)]))
  return x
}

/** Nothing identifying: neutral names, no chat fields, every Sleeper id remapped consistently. Idempotent. */
export const anonymise = (d: LeagueData): LeagueData => {
  const clean = (l: LeagueData['league']) => ({
    ...Object.fromEntries(Object.entries(l).filter(([k]) => !CHAT.test(k))),
    name: 'Fixture League',
    metadata: null,
  }) as unknown as LeagueData['league']
  const users = d.users.map((u, i) => ({ user_id: u.user_id, username: `manager${i + 1}`, display_name: `Manager ${i + 1}`, avatar: null, metadata: { team_name: NAMES[i % NAMES.length] }, is_owner: u.is_owner ?? null }))
  const out: LeagueData = {
    ...d,
    league: clean(d.league),
    leagues: [clean(d.league)],
    users,
    me: { ...users.find((u) => u.user_id === d.me.user_id)! },
    rosters: d.rosters.map((r) => ({ ...r, metadata: null })),
    history: d.history ? { ...d.history, league: clean(d.history.league) } : null,
    warnings: d.warnings.map((w) => w.replace(/"[^"]*"/g, '"…"')),
  }
  return remapIds(out, new Map()) as LeagueData
}

const FIXTURE = join(__dirname, '..', 'lib', '__tests__', 'fixtures', 'asgm-league.json.gz')

describe.skipIf(!process.env.ASGM_ANON)('anonymise the fixture on disk', () => {
  it('rewrites it', () => {
    const f = JSON.parse(gunzipSync(readFileSync(FIXTURE)).toString())
    writeFileSync(FIXTURE, gzipSync(JSON.stringify({ capturedAt: f.capturedAt, data: anonymise(f.data) })))
  })
})

describe.skipIf(!process.env.ASGM_CAPTURE)('capture', () => {
  it('writes the fixture', async () => {
    const d = await loadLeagueData({ provider: 'sleeper', username: process.env.ASGM_USER!, leagueId: process.env.ASGM_LEAGUE ?? null }, (m) => console.log(m))
    const t = anonymise(trim(d))
    writeFileSync(FIXTURE, gzipSync(JSON.stringify({ capturedAt: Date.now(), data: t })))
    console.log('players', Object.keys(t.players).length, 'warnings', d.warnings)
    expect(Object.keys(t.players).length).toBeGreaterThan(100)
  }, 300_000)
})
