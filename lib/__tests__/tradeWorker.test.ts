// @vitest-environment node
import { describe, expect, it } from 'vitest'
import worker from '../../workers/grades/src/index'
import { tradeAppUrl } from '../../workers/grades/src/links'
import { TTL_SECONDS } from '../../workers/grades/src/share'
import { MAX_TRADE_META, parseTradeMeta } from '../../workers/grades/src/trade'
import { MAX_DEAL_PARTS, MAX_DEAL_TEAMS, MAX_TRADE_CHARS } from '../../workers/grades/src/tradeLink'
import { cardText, decodeDeal, linkMeta, linkProblem, type TradeCard } from '../tradeShare'

// The worker's shared trades (workers/grades/src/trade.ts), run against a fake of its KV namespace.
const fakeKV = () => {
  const store = new Map<string, { value: string | ArrayBuffer; ttl?: number }>()
  return {
    store,
    async get(key: string, type?: string) {
      const hit = store.get(key)
      if (!hit) return null
      if (type === 'json') return JSON.parse(hit.value as string)
      return hit.value
    },
    async put(key: string, value: string | ArrayBuffer, opts?: { expirationTtl?: number }) {
      store.set(key, { value, ttl: opts?.expirationTtl })
    },
    async list() {
      return { keys: [], list_complete: true }
    },
    async delete() {},
  }
}

const png = (w = 1200, h = 630) => {
  const out = new Uint8Array(8 + 25 + 12)
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const dv = new DataView(out.buffer)
  dv.setUint32(8, 13)
  out.set([0x49, 0x48, 0x44, 0x52], 12)
  dv.setUint32(16, w)
  dv.setUint32(20, h)
  out.set([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82], out.length - 12)
  return out
}
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64')

const meta = (over: Record<string, unknown> = {}) => ({
  kind: 'pitch',
  league: 'NYC Fantasy Football',
  leagueId: '1234567890',
  season: '2026',
  week: 10,
  provider: 'sleeper',
  title: 'Trade idea for Emillionaires from chode',
  description: 'Emillionaires gets: Christian McCaffrey · chode gets: Justin Jefferson · Lineup +2.3 pts/wk',
  to: 'Emillionaires',
  from: 'chode',
  note: 'Open to more',
  sides: [
    { rosterId: 2, head: 'Emillionaires gets', focus: true, faab: 0, players: [{ id: '4034', name: 'Christian McCaffrey', pos: 'RB', team: 'SF', ppw: 17.9, tag: 'buy low', from: null }] },
    { rosterId: 1, head: 'chode gets', focus: false, faab: 15, players: [{ id: '6794', name: 'Justin Jefferson', pos: 'WR', team: 'MIN', ppw: 16.2, tag: null, from: null }] },
  ],
  stats: [{ label: 'Lineup', value: '+2.3', unit: 'pts/wk', sub: 'better 9 of 11 weeks', tone: 'pos' }],
  strip: [
    { week: 10, delta: 1.2 },
    { week: 11, delta: -0.4 },
  ],
  trade: '1.2.4034,2.1.6794,2.1.$15',
  ...over,
})

let n = 0
const post = (env: { GRADES: ReturnType<typeof fakeKV> }, body: unknown, init: { origin?: string; ip?: string } = {}) => {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return worker.fetch(
    new Request('https://ff-grades.example.workers.dev/trade', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(new TextEncoder().encode(text).length), origin: init.origin ?? 'https://ff.sujeff.com', 'cf-connecting-ip': init.ip ?? `10.1.0.${++n}` },
      body: text,
    }),
    env as never,
  )
}
const get = (env: { GRADES: ReturnType<typeof fakeKV> }, path: string, ua = 'Mozilla/5.0 (iPhone) Safari') => worker.fetch(new Request(`https://ff-grades.example.workers.dev${path}`, { headers: { 'user-agent': ua } }), env as never)
const stored = async (over: Record<string, unknown> = {}) => {
  const env = { GRADES: fakeKV() }
  const r = await post(env, { meta: meta(over), png: b64(png()) })
  expect(r.status).toBe(200)
  const { id } = (await r.json()) as { id: string }
  return { env, id }
}

describe('parseTradeMeta', () => {
  it('keeps what the card shows and drops anything else', () => {
    const m = parseTradeMeta(meta({ secret: 'my ask is +4.2', sides: [{ ...meta().sides[0], accept: 0.31 }, meta().sides[1]] })) as Record<string, unknown>
    expect(typeof m).toBe('object')
    expect(JSON.stringify(m)).not.toContain('secret')
    expect(JSON.stringify(m)).not.toContain('accept')
    expect(m).toMatchObject({ kind: 'pitch', to: 'Emillionaires', week: 10, trade: '1.2.4034,2.1.6794,2.1.$15' })
    // What the card's deal decodes to in the app.
    expect(decodeDeal((m as { trade: string }).trade)?.teams).toEqual([1, 2])
  })
  it('checks and caps every field', () => {
    const p0 = meta().sides[0].players[0]
    const bad: [Record<string, unknown>, string][] = [
      [{ kind: 'secret' }, 'bad kind'],
      [{ league: 'x'.repeat(81) }, 'bad league'],
      [{ leagueId: 'a b' }, 'bad leagueId'],
      [{ season: 2026 }, 'bad season'],
      [{ week: 31 }, 'bad week'],
      [{ provider: 'yahoo' }, 'bad provider'],
      [{ to: null }, 'bad to'],
      [{ from: 'x'.repeat(61) }, 'bad from'],
      [{ note: 'x'.repeat(101) }, 'bad note'],
      [{ trade: '1.2.<script>' }, 'bad trade'],
      [{ trade: 'x'.repeat(900) }, 'bad trade'],
      [{ sides: [meta().sides[0]] }, 'bad sides'],
      [{ sides: Array(5).fill(meta().sides[0]) }, 'bad sides'],
      [{ sides: [{ ...meta().sides[0], players: Array(MAX_DEAL_PARTS + 1).fill(p0) }, meta().sides[1]] }, 'bad sides'],
      [{ sides: [{ ...meta().sides[0], rosterId: 'two' }, meta().sides[1]] }, 'bad sides'],
      [{ sides: [{ ...meta().sides[0], players: [{ ...p0, id: '<b>' }] }, meta().sides[1]] }, 'bad player'],
      [{ sides: [{ ...meta().sides[0], faab: -5 }, meta().sides[1]] }, 'bad sides'],
      [{ sides: [{ ...meta().sides[0], players: [{ ...p0, pos: '<b>' }] }, meta().sides[1]] }, 'bad player'],
      [{ sides: [{ ...meta().sides[0], players: [{ ...p0, ppw: 'lots' }] }, meta().sides[1]] }, 'bad player'],
      [{ sides: [{ ...meta().sides[0], players: [{ ...p0, tag: 'fleece them' }] }, meta().sides[1]] }, 'bad player'],
      [{ stats: Array(9).fill(meta().stats[0]) }, 'bad stats'],
      [{ stats: [{ ...meta().stats[0], tone: 'secret' }] }, 'bad stats'],
      [{ stats: [{ ...meta().stats[0], value: 'x'.repeat(25) }] }, 'bad stats'],
      [{ strip: [{ week: 10, delta: Infinity }] }, 'bad strip'],
      [{ strip: Array(21).fill({ week: 1, delta: 0 }) }, 'bad strip'],
      [{ net: 'lots' }, 'bad net'],
    ]
    for (const [over, why] of bad) expect(parseTradeMeta(meta(over))).toBe(why)
    expect(parseTradeMeta(null)).toBe('bad meta')
    // A league view has no recipient.
    expect(parseTradeMeta(meta({ kind: 'league', to: null }))).toMatchObject({ kind: 'league', to: null })
  })
})

describe('the deal behind the card', () => {
  const [s0, s1] = meta().sides
  it('writes the title and description itself, ignoring what the request says', async () => {
    const m = parseTradeMeta(meta({ title: 'FREE MONEY: click here', description: 'Emillionaires gets: Patrick Mahomes' })) as { title: string; description: string }
    expect(m.title).toBe('Trade idea for Emillionaires from chode')
    expect(m.description).toBe('Emillionaires gets: Christian McCaffrey · chode gets: Justin Jefferson, $15 FAAB · Lineup +2.3 pts/wk')
    // Missing altogether is fine too: the app no longer sends them.
    expect(parseTradeMeta({ ...meta(), title: undefined, description: undefined })).toMatchObject({ title: m.title, description: m.description })
    // And the page shows only its own words.
    const { env, id } = await stored({ title: 'FREE MONEY: click here', description: 'spoofed' })
    const html = await (await get(env, `/t/${id}`)).text()
    expect(html).not.toContain('FREE MONEY')
    expect(html).not.toContain('spoofed')
    expect(html).toContain('<meta property="og:title" content="Trade idea for Emillionaires from chode">')
    expect(html).toContain('<h1>Trade idea for Emillionaires from chode</h1>')
  })
  it('words a preview exactly as the app does', () => {
    const card: TradeCard = {
      v: 1,
      kind: 'league',
      league: 'NYC Fantasy Football',
      leagueId: '1234567890',
      season: '2026',
      week: 10,
      provider: 'sleeper',
      to: null,
      from: 'chode',
      sides: [
        { rosterId: 1, head: 'chode gets', avatar: null, focus: false, faab: 15, players: [{ id: '6794', name: 'Justin Jefferson', pos: 'WR', team: 'MIN', ppw: 16.2, tag: null, from: null }] },
        { rosterId: 2, head: 'Emillionaires gets', avatar: null, focus: false, faab: 0, players: [{ id: '4034', name: 'Christian McCaffrey', pos: 'RB', team: 'SF', ppw: null, tag: null, from: null }] },
      ],
      stats: [{ key: 'lineup', label: 'chode', value: '+1.2', unit: '/wk', sub: null, tone: 'pos' }],
      strip: null,
      note: null,
      deal: { moves: [['4034', 1, 2], ['6794', 2, 1]], faab: [[2, 1, 15]] },
    }
    const m = parseTradeMeta(JSON.parse(JSON.stringify(linkMeta(card))))
    expect(m).toMatchObject(cardText(card))
  })
  it('refuses a deal that is not the one pictured', () => {
    const bad: Record<string, unknown>[] = [
      // A player moves in the deal but is not on the card.
      { trade: '1.2.4034,2.1.6794,2.1.$15,1.2.9999' },
      // A player is on the card but not in the deal.
      { trade: '1.2.4034,2.1.$15' },
      // The right players, the wrong way round.
      { trade: '2.1.4034,1.2.6794,2.1.$15' },
      // A side under another team's roster.
      { sides: [{ ...s0, rosterId: 3 }, s1] },
      // A side on the card that is not in the deal.
      { sides: [s0, s1, { rosterId: 7, head: 'Third gets', focus: false, faab: 0, players: [] }] },
      // FAAB shown that the deal does not pay, or other than it pays.
      { trade: '1.2.4034,2.1.6794' },
      { sides: [s0, { ...s1, faab: 50 }] },
      { trade: '1.2.4034,2.1.6794,2.1.$15,1.2.$5', sides: [s0, s1] },
      // The recipient's FAAB figure is not what they take in.
      { stats: [{ label: 'FAAB in', value: '$40', unit: null, sub: null, tone: 'pos' }] },
    ]
    for (const over of bad) expect(parseTradeMeta(meta(over)), JSON.stringify(over)).toBe('trade does not match the card')
    // FAAB left off the card entirely is fine: the deal still pays it.
    expect(parseTradeMeta(meta({ sides: [s0, { ...s1, faab: 0 }] }))).toMatchObject({ trade: '1.2.4034,2.1.6794,2.1.$15' })
    // So is the recipient's FAAB figure when it is what they take in, net.
    expect(parseTradeMeta(meta({ trade: '2.1.4034,1.2.6794,1.2.$15', sides: [{ ...s0, faab: 15, players: [{ ...s0.players[0], id: '6794' }] }, { ...s1, faab: 0, players: [{ ...s1.players[0], id: '4034' }] }], stats: [{ label: 'FAAB in', value: '$15', unit: null, sub: null, tone: 'pos' }] }))).not.toBeTypeOf('string')
  })
})

describe('the largest deal the builder can make', () => {
  // Every field at its cap, in characters JSON writes twice, so the bound holds whatever the names are.
  const q = (n: number) => '"'.repeat(n)
  const teams = Array.from({ length: MAX_DEAL_TEAMS }, (_, i) => 9001 + i)
  const ids = Array.from({ length: MAX_DEAL_PARTS }, (_, i) => `p${String(i).padStart(23, '0')}`)
  const trade = ids.map((p, i) => `${teams[(i + 1) % teams.length]}.${teams[i % teams.length]}.${p}`).join(',')
  const big = meta({
    league: q(80),
    leagueId: 'x'.repeat(64),
    to: q(60),
    from: q(60),
    note: q(100),
    sides: teams.map((t) => ({
      rosterId: t,
      head: q(80),
      focus: t === teams[0],
      faab: 0,
      players: ids.filter((_, i) => teams[i % teams.length] === t).map((id) => ({ id, name: q(60), pos: 'ABCDEF', team: 'ABCD', ppw: -9.99, tag: 'sell high', from: q(60) })),
    })),
    stats: Array.from({ length: 8 }, () => ({ label: q(60), value: q(24), unit: q(10), sub: q(90), tone: 'neutral' })),
    strip: Array.from({ length: 20 }, () => ({ week: 30, delta: -199.99 })),
    net: -199.99,
    trade,
  })
  it('fits a link, within the limits the app checks before it posts', async () => {
    expect(trade.length).toBe(MAX_TRADE_CHARS)
    expect(decodeDeal(trade)?.moves).toHaveLength(MAX_DEAL_PARTS)
    expect(parseTradeMeta(big)).not.toBeTypeOf('string')
    const size = JSON.stringify(big).length
    expect(size).toBeLessThanOrEqual(MAX_TRADE_META)
    // The bound is close to the real worst case, not a guess far above it.
    expect(size).toBeGreaterThan(MAX_TRADE_META * 0.9)
    const env = { GRADES: fakeKV() }
    expect((await post(env, { meta: big, png: b64(png()) })).status).toBe(200)
  })
  it('says why when a trade is too big for a link, before posting', () => {
    const card = (n: number): TradeCard => ({
      v: 1,
      kind: 'league',
      league: 'L',
      leagueId: '1',
      season: '2026',
      week: 1,
      provider: 'sleeper',
      to: null,
      from: null,
      sides: [],
      stats: [],
      strip: null,
      note: null,
      deal: { moves: Array.from({ length: n }, (_, i) => [`p${i}`, 1, 2] as [string, number, number]), faab: [] },
    })
    expect(linkProblem(card(MAX_DEAL_PARTS))).toBeNull()
    expect(linkProblem(card(MAX_DEAL_PARTS + 1))).toBe(`This trade moves ${MAX_DEAL_PARTS + 1} players and payments, more than the ${MAX_DEAL_PARTS} a link can carry. Copy or download the image instead.`)
    expect(linkProblem({ ...card(1), deal: { moves: [['has space', 1, 2]], faab: [] } })).toMatch(/can’t be put in a link/)
  })
})

describe('POST /trade', () => {
  it('stores the card and the facts for 120 days', async () => {
    const env = { GRADES: fakeKV() }
    const r = await post(env, { meta: meta(), png: b64(png()) })
    expect(r.status).toBe(200)
    const { id, url } = (await r.json()) as { id: string; url: string }
    expect(url).toBe(`https://ff-grades.example.workers.dev/t/${id}`)
    expect(env.GRADES.store.get(`t:${id}`)?.ttl).toBe(TTL_SECONDS)
    expect(env.GRADES.store.get(`t:${id}:png`)?.ttl).toBe(TTL_SECONDS)
  })
  it('refuses other origins, the wrong picture, bad facts and too much, storing nothing', async () => {
    const env = { GRADES: fakeKV() }
    expect((await post(env, { meta: meta(), png: b64(png()) }, { origin: 'https://evil.example' })).status).toBe(403)
    expect((await post(env, { meta: meta(), png: b64(png(1080, 1080)) })).status).toBe(400)
    expect((await post(env, { meta: meta({ week: 0 }), png: b64(png()) })).status).toBe(400)
    expect((await post(env, { meta: meta({ pad: 'x'.repeat(MAX_TRADE_META) }), png: b64(png()) })).status).toBe(413)
    expect((await post(env, 'nope')).status).toBe(400)
    expect(env.GRADES.store.size).toBe(0)
  })
  it('slows down one address', async () => {
    const env = { GRADES: fakeKV() }
    const codes: number[] = []
    for (let i = 0; i < 8; i++) codes.push((await post(env, { meta: meta(), png: b64(png()) }, { ip: '7.7.7.9' })).status)
    expect(codes.slice(6)).toEqual([429, 429])
  })
})

describe('GET /t/:id', () => {
  it('shows bots and people the same page: tags, the card, the trade, and the way into the app', async () => {
    const { env, id } = await stored()
    for (const ua of ['Slackbot-LinkExpanding 1.0', 'Discordbot/2.0', 'Mozilla/5.0 (iPhone) Safari/604.1']) {
      const r = await get(env, `/t/${id}`, ua)
      expect(r.status).toBe(200)
      expect(r.headers.get('location')).toBeNull()
      const html = await r.text()
      expect(html).toContain('<meta property="og:title" content="Trade idea for Emillionaires from chode">')
      expect(html).toContain(`<meta property="og:image" content="https://ff-grades.example.workers.dev/t/${id}.png">`)
      expect(html).toContain('<meta property="og:image:width" content="1200">')
      expect(html).toContain('<meta name="twitter:card" content="summary_large_image">')
      expect(html).toContain('Christian McCaffrey')
      expect(html).toContain('“Open to more”')
      expect(html).toContain(`href="${tradeAppUrl({ leagueId: '1234567890', season: '2026', trade: '1.2.4034,2.1.6794,2.1.$15' }).replace(/&/g, '&amp;')}"`)
      expect(html).toContain('Open in Fantasy')
      expect(html).not.toContain('location.replace')
    }
    expect(tradeAppUrl({ leagueId: 'espn:9', season: '2025', trade: '1.2.a,2.1.$5' })).toBe('https://ff.sujeff.com/?league=espn%3A9&season=2025&trade=1.2.a%2C2.1.%245#trades')
  })
  it('escapes everything it prints', async () => {
    const { env, id } = await stored({ league: '<script>alert(1)</script>', note: '"><img src=x onerror=alert(1)>', sides: [{ ...meta().sides[0], head: '<b>x</b> gets' }, meta().sides[1]] })
    const html = await (await get(env, `/t/${id}`)).text()
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('<b>x</b>')
    expect(html).toContain('&lt;script&gt;')
  })
  it('serves the card, and says so plainly when a link is gone', async () => {
    const { env, id } = await stored()
    const r = await get(env, `/t/${id}.png`, 'Slackbot')
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await r.arrayBuffer()).length).toBe(png().length)
    expect((await get(env, '/t/AAAAAAAAAAAAAA')).status).toBe(404)
    expect(await (await get(env, '/t/AAAAAAAAAAAAAA')).text()).toContain('expired')
    expect((await get(env, '/t/AAAAAAAAAAAAAA.png')).status).toBe(404)
    expect((await get(env, '/t/short')).status).toBe(404)
    // Stored facts that no longer pass are not shown.
    env.GRADES.store.set(`t:${id}`, { value: JSON.stringify({ ...meta(), week: 99 }) })
    expect((await get(env, `/t/${id}`)).status).toBe(404)
  })
})
