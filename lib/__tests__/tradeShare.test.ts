import { describe, expect, it } from 'vitest'
import type { Deal, DealRead, DealSide } from '../deal'
import {
  blockOn,
  buildCard,
  cardText,
  cleanNote,
  decodeDeal,
  encodeDeal,
  linkMeta,
  NOTE_MAX,
  ppwDefault,
  shareBlocks,
  slotFill,
  type Audience,
  type ShareContext,
  type ShareFacts,
  type ShareOptions,
} from '../tradeShare'

// You (1) send Jefferson to them (2) for McCaffrey. The figures are picked so every one of yours is distinctive, and
// a leak of any of them into what they would see can be caught by its spelling.
const ME = 1
const THEM = 2
const side = (over: Partial<DealSide> & { rosterId: number }): DealSide => ({
  receives: [],
  sends: [],
  faab: 0,
  lineup: 0,
  perWeek: [],
  weeksBetter: 0,
  value: 0,
  faabValue: { low: 0, mid: 0, high: 0 },
  net: { low: 0, mid: 0, high: 0 },
  cuts: [],
  problems: [],
  ...over,
})
const weeks = (ds: number[]) => ds.map((delta, i) => ({ week: 10 + i, delta }))
const deal: Deal = { teams: [ME, THEM], moves: [{ player: 'jj', from: ME, to: THEM }, { player: 'cmc', from: THEM, to: ME }], faab: [] }
const read = (mine: Partial<DealSide>, theirs: Partial<DealSide>): DealRead => ({
  valid: true,
  weeks: [10, 11, 12, 13],
  sides: [side({ rosterId: ME, receives: ['cmc'], sends: ['jj'], ...mine }), side({ rosterId: THEM, receives: ['jj'], sends: ['cmc'], ...theirs })],
})
// Theirs: +2.25/wk, better 3 of 4 weeks. Yours: +7.77/wk, value +9.99.
const good = read({ lineup: 7.77, perWeek: weeks([7.7, 7.8, 7.8, 7.8]), weeksBetter: 4, value: 9.99 }, { lineup: 2.25, perWeek: weeks([3, 2, 4, -0.5]), weeksBetter: 3, value: 1.4 })
const facts = (over: Partial<ShareFacts> = {}): ShareFacts => ({
  deal,
  read: good,
  leverage: { playoffs: 0.041, title: 0.012 },
  fill: { slot: 'WR2', before: 7, after: 12.5 },
  consensus: 1.4,
  form: { jj: { kind: 'buy-low', name: 'Jefferson', text: 'down week: 4.2 vs 14.0 expected' } },
  ...over,
})
const names = (rid: number) => ({ 1: 'Sender FC', 2: 'Recipients', 3: 'Third Wheel' })[rid] ?? `Team ${rid}`
const pitch: Audience = { kind: 'pitch', to: THEM }
const ctx: ShareContext = {
  league: 'NYC Fantasy Football',
  leagueId: '1234567890',
  season: '2026',
  week: 10,
  provider: 'sleeper',
  me: ME,
  teams: { 1: { name: 'Sender FC', avatar: null }, 2: { name: 'Recipients', avatar: null }, 3: { name: 'Third Wheel', avatar: null } },
  players: { jj: { name: 'Justin Jefferson', pos: 'WR', team: 'MIN' }, cmc: { name: 'Christian McCaffrey', pos: 'RB', team: 'SF' }, ja: { name: 'Josh Allen', pos: 'QB', team: 'BUF' } },
  ppw: { jj: 16.2, cmc: 17.9, ja: 22.4 },
}
const opts = (over: Partial<ShareOptions> = {}): ShareOptions => ({ audience: pitch, include: {}, ppw: true, faab: true, sender: true, note: '', ...over })
const byKey = (f: ShareFacts, a: Audience = pitch) => Object.fromEntries(shareBlocks(a, f, names).map((b) => [b.key, b]))

describe('what a pitch may show', () => {
  it('shows their lineup gain, and "better N of M" only when it is most weeks', () => {
    const b = byKey(facts())
    expect(b.lineup.available).toBe(true)
    expect(b.lineup.stats[0]).toMatchObject({ value: '+2.3', unit: 'pts/wk', sub: 'better 3 of 4 weeks', tone: 'pos' })
    const half = byKey(facts({ read: read({}, { lineup: 1, perWeek: weeks([1, 1, -1, -1]), weeksBetter: 2 }) }))
    expect(half.lineup.available).toBe(true)
    expect(half.lineup.stats[0].sub).toBeNull()
  })
  it('hides a lineup that gets worse or barely moves, and the strip with it, saying why', () => {
    const worse = byKey(facts({ read: read({}, { lineup: -1.2, perWeek: weeks([-1, -1, -1, -1]) }) }))
    expect(worse.lineup).toMatchObject({ available: false, reason: 'their lineup gets worse', stats: [] })
    expect(worse.weeks).toMatchObject({ available: false, reason: 'shown only with a lineup gain' })
    expect(byKey(facts({ read: read({}, { lineup: 0.05, perWeek: weeks([0, 0, 0, 0.2]) }) })).lineup.reason).toBe('their lineup barely moves')
    expect(byKey(facts({ read: read({}, { lineup: 2, perWeek: weeks([2]), weeksBetter: 1 }) })).weeks.reason).toBe('only one week left')
  })
  it('shows their playoff odds only when they rise, in a two-team deal, once simulated', () => {
    expect(byKey(facts()).odds.stats[0]).toMatchObject({ label: 'Playoff odds', value: '+4.1', unit: 'pt', sub: 'title +1.2 pt' })
    // With the odds after the trade, the odds themselves lead the note, so the change never reads as fantasy points.
    expect(byKey(facts({ leverage: { playoffs: 0.116, title: 0.03, after: 0.6 } })).odds.stats[0]).toMatchObject({ value: '+11.6', unit: 'pt', sub: '48% → 60% · title +3.0 pt' })
    expect(byKey(facts({ leverage: { playoffs: -0.03, title: 0 } })).odds).toMatchObject({ available: false, reason: 'their playoff odds drop' })
    expect(byKey(facts({ leverage: { playoffs: 0.001, title: 0 } })).odds.reason).toBe('their playoff odds hold steady')
    // A title bump alone still helps them.
    expect(byKey(facts({ leverage: { playoffs: 0, title: 0.02 } })).odds.stats[0]).toMatchObject({ label: 'Title odds', value: '+2.0' })
    expect(byKey(facts({ leverage: undefined })).odds.reason).toBe('still working out the odds')
    expect(byKey(facts({ leverage: null })).odds.reason).toBe('no season forecast for this league')
    const three = { ...deal, teams: [1, 2, 3] }
    expect(byKey(facts({ deal: three })).odds.reason).toBe('two-team trades only')
  })
  it('shows the slot it fills only when it gets better', () => {
    expect(byKey(facts()).need.stats[0]).toMatchObject({ label: 'Fills WR2', value: '7.0 → 12.5' })
    expect(byKey(facts({ fill: null })).need.available).toBe(false)
    expect(byKey(facts({ fill: { slot: 'WR2', before: 7, after: 7.02 } })).need.available).toBe(false)
  })
  it('shows consensus value only when it goes their way', () => {
    expect(byKey(facts()).value.stats[0].value).toBe('+1.4')
    expect(byKey(facts({ consensus: -2 })).value).toMatchObject({ available: false, reason: 'consensus favours your side' })
    expect(byKey(facts({ consensus: 0 })).value.reason).toBe('consensus calls it even')
    expect(byKey(facts({ consensus: null })).value.reason).toBe('no consensus rankings')
  })
  it('shows FAAB they take in, never FAAB they pay', () => {
    const paid = { ...good, sides: good.sides.map((s) => (s.rosterId === THEM ? { ...s, faab: 15 } : { ...s, faab: -15 })) }
    expect(byKey(facts({ read: paid })).faab.stats[0].value).toBe('$15')
    const pays = { ...good, sides: good.sides.map((s) => (s.rosterId === THEM ? { ...s, faab: -10 } : s)) }
    expect(byKey(facts({ read: pays })).faab).toMatchObject({ available: false, reason: 'they would pay FAAB' })
    expect(byKey(facts()).faab.reason).toBe('no FAAB comes their way')
  })
  it('frames timing only in their favour: a buy-low they get, a sell-high they send', () => {
    expect(byKey(facts()).momentum.stats[0]).toMatchObject({ value: 'Buy low', sub: 'Jefferson: down week: 4.2 vs 14.0 expected' })
    // A buy-low they would send is your edge, not theirs.
    expect(byKey(facts({ form: { cmc: { kind: 'buy-low', name: 'McCaffrey', text: 'x' } } })).momentum.available).toBe(false)
    expect(byKey(facts({ form: { cmc: { kind: 'sell-high', name: 'McCaffrey', text: 'big week' } } })).momentum.stats[0].value).toBe('Sell high')
    // A sell-high they would get reads well to nobody.
    expect(byKey(facts({ form: { jj: { kind: 'sell-high', name: 'Jefferson', text: 'x' } } })).momentum.available).toBe(false)
  })
  it('lists every block, allowed or not, so nothing drops silently', () => {
    const all = shareBlocks(pitch, facts({ read: read({}, { lineup: -3 }), leverage: null, fill: null, consensus: -1, form: {} }), names)
    expect(all.map((b) => b.key)).toEqual(['lineup', 'weeks', 'odds', 'need', 'value', 'faab', 'momentum'])
    expect(all.every((b) => !b.available && b.reason)).toBe(true)
    expect(all.every((b) => !blockOn(b, { lineup: true, odds: true }))).toBe(true)
  })
})

describe('the card a pitch sends', () => {
  const card = (f = facts(), o: Partial<ShareOptions> = {}) => buildCard(ctx, f, shareBlocks(o.audience ?? pitch, f, names), opts(o))

  it('puts them first, then your side, with their figures', () => {
    const c = card()
    expect(c.kind).toBe('pitch')
    expect(c.to).toBe('Recipients')
    expect(c.from).toBe('Sender FC')
    expect(c.sides.map((s) => [s.head, s.focus, s.players.map((p) => p.name)])).toEqual([
      ['Recipients gets', true, ['Justin Jefferson']],
      ['Sender FC gets', false, ['Christian McCaffrey']],
    ])
    expect(c.stats.map((s) => s.key)).toEqual(['lineup', 'odds', 'need', 'value', 'momentum'])
    expect(c.strip).toEqual(weeks([3, 2, 4, -0.5]))
    // The strip's dashed line is the Lineup figure, not the plain average of its bars.
    expect(c.net).toBe(2.25)
    expect(c.sides[0].players[0]).toMatchObject({ ppw: 16.2, tag: 'buy low' })
  })
  it('never carries your own gain, ask, odds of a yes or the model’s internals', () => {
    for (const f of [facts(), facts({ read: read({ lineup: 7.77, value: 9.99 }, { lineup: -4.44, value: -3.33 }) })]) {
      const c = card(f)
      const json = JSON.stringify([c, linkMeta(c), cardText(c)])
      // Your figures, in any spelling the card uses.
      for (const leak of ['7.77', '7.8', '9.99', '10.0', '−4.4', '-4.4', '4.44', '−3.3', '3.33']) expect(json).not.toContain(leak)
      for (const key of ['index', 'band', 'tier', 'logit', 'perceivedAsk', 'valueAsk', 'myGain', 'signals', 'weight', 'accept', 'say yes']) expect(json).not.toContain(key)
      // Only their side's numbers, and only the kinds of block a pitch allows.
      expect(c.stats.every((s) => s.tone === 'pos')).toBe(true)
      expect(c.stats.every((s) => ['lineup', 'odds', 'need', 'value', 'faab', 'momentum'].includes(s.key))).toBe(true)
    }
  })
  it('leaves out a block switched off, and the strip with the lineup off', () => {
    const c = card(facts(), { include: { odds: false, weeks: false } })
    expect(c.stats.map((s) => s.key)).not.toContain('odds')
    expect(c.strip).toBeNull()
    expect(JSON.stringify(c)).not.toContain('4.1')
  })
  it('cannot be switched to show a block that does not help them', () => {
    const f = facts({ read: read({}, { lineup: -2.2 }), consensus: -1 })
    const c = card(f, { include: { lineup: true, value: true, weeks: true } })
    expect(c.stats.map((s) => s.key)).not.toContain('lineup')
    expect(c.stats.map((s) => s.key)).not.toContain('value')
    expect(c.strip).toBeNull()
  })
  it('unsigned, names you nowhere', () => {
    const c = card(facts(), { sender: false })
    expect(c.from).toBeNull()
    expect(c.sides[1].head).toBe('Recipients sends')
    expect(c.sides[1].avatar).toBeNull()
    expect(JSON.stringify([c, linkMeta(c), cardText(c)])).not.toContain('Sender FC')
  })
  it('drops points per week, timing tags and FAAB when switched off', () => {
    const withFaab = { ...deal, faab: [{ from: ME, to: THEM, dollars: 12 }] }
    const r = { ...good, sides: good.sides.map((s) => (s.rosterId === THEM ? { ...s, faab: 12 } : { ...s, faab: -12 })) }
    const on = card(facts({ deal: withFaab, read: r }))
    expect(on.sides[0].faab).toBe(12)
    expect(on.stats.map((s) => s.key)).toContain('faab')
    expect(on.deal.faab).toEqual([[ME, THEM, 12]])
    const off = card(facts({ deal: withFaab, read: r }), { ppw: false, faab: false, include: { momentum: false } })
    expect(off.sides.flatMap((s) => s.players).every((p) => p.ppw == null && p.tag == null)).toBe(true)
    expect(off.sides[0].faab).toBe(0)
    expect(off.stats.map((s) => s.key)).not.toContain('faab')
    expect(off.deal.faab).toEqual([])
  })
  it('keeps the note to one line and a length', () => {
    expect(cleanNote('  hi\nthere\u0000 ')).toBe('hi there')
    expect(cleanNote('x'.repeat(500))).toHaveLength(NOTE_MAX)
    expect(card(facts(), { note: 'Open to more' }).note).toBe('Open to more')
    expect(card(facts(), { note: '   ' }).note).toBeNull()
  })
  it('in a deal of three, says who sends each player', () => {
    const d3: Deal = { teams: [1, 2, 3], moves: [{ player: 'jj', from: 1, to: 2 }, { player: 'cmc', from: 2, to: 3 }, { player: 'ja', from: 3, to: 1 }], faab: [] }
    const r3: DealRead = {
      valid: true,
      weeks: [10],
      sides: [side({ rosterId: 1, receives: ['ja'], sends: ['jj'] }), side({ rosterId: 2, receives: ['jj'], sends: ['cmc'], lineup: 1, perWeek: weeks([1]), weeksBetter: 1 }), side({ rosterId: 3, receives: ['cmc'], sends: ['ja'] })],
    }
    const c = card(facts({ deal: d3, read: r3, leverage: null }))
    expect(c.sides.map((s) => s.head)).toEqual(['Recipients gets', 'Sender FC gets', 'Third Wheel gets'])
    expect(c.sides[0].players[0].from).toBe('Sender FC')
    const anon = card(facts({ deal: d3, read: r3, leverage: null }), { sender: false })
    expect(anon.sides[1].head).toBe('Proposer gets')
    expect(anon.sides[0].players[0].from).toBe('proposer')
    expect(JSON.stringify(anon)).not.toContain('Sender FC')
  })
})

describe('the league view', () => {
  it('shows the trade and every team’s lineup change, and nothing that is a pitch', () => {
    const league: Audience = { kind: 'league' }
    const blocks = shareBlocks(league, facts(), names)
    expect(blocks.filter((b) => b.available).map((b) => b.key)).toEqual(['lineup'])
    const c = buildCard(ctx, facts(), blocks, opts({ audience: league }))
    expect(c.kind).toBe('league')
    expect(c.to).toBeNull()
    expect(c.stats.map((s) => [s.label, s.value])).toEqual([
      ['Sender FC', '+7.8'],
      ['Recipients', '+2.3'],
    ])
    expect(c.sides.every((s) => !s.focus)).toBe(true)
    expect(c.strip).toBeNull()
  })
})

describe('defaults', () => {
  it('shows points per week in a pitch only when they take in at least what they send', () => {
    expect(ppwDefault(pitch, good, { jj: 16, cmc: 18 })).toBe(false)
    expect(ppwDefault(pitch, good, { jj: 18, cmc: 16 })).toBe(true)
    expect(ppwDefault({ kind: 'league' }, good, { jj: 1, cmc: 18 })).toBe(true)
  })
})

describe('the deal in a link', () => {
  it('goes there and back', () => {
    const d: Deal = { teams: [3, 7], moves: [{ player: '4034', from: 3, to: 7 }, { player: 'KC', from: 7, to: 3 }], faab: [{ from: 7, to: 3, dollars: 15 }] }
    const s = encodeDeal({ moves: d.moves.map((m) => [m.player, m.from, m.to]), faab: d.faab.map((x) => [x.from, x.to, x.dollars]) })
    expect(s).toBe('3.7.4034,7.3.KC,7.3.$15')
    expect(decodeDeal(s)).toEqual(d)
  })
  it('refuses what is not a deal', () => {
    for (const bad of ['', 'x', '1.1.4034', '1.2.4034,1.2.4034', '1.2.$0', '1.2.$abc', '1.2.40 34', '1.2.<b>', '1.2.$5,1.3.$5', Array.from({ length: 31 }, (_, i) => `1.2.p${i}`).join(','), '1.2.a,2.3.b,3.4.c,4.5.d,5.1.e']) expect(decodeDeal(bad)).toBeNull()
    expect(decodeDeal(null)).toBeNull()
  })
})

describe('slotFill', () => {
  it('names the starting slot that improves most, numbered when the name repeats', () => {
    const players = Object.fromEntries(
      [
        ['r1', 'RB'],
        ['r2', 'RB'],
        ['w1', 'WR'],
        ['new', 'RB'],
      ].map(([id, pos]) => [id, { id, name: id, pos, fpos: [pos], team: null, status: null, injury: null, age: null, exp: null }]),
    )
    const slots = [
      { name: 'RB', eligible: ['RB'] },
      { name: 'RB', eligible: ['RB'] },
      { name: 'WR', eligible: ['WR'] },
    ]
    const pts = { r1: 15, r2: 7, w1: 12, new: 12.5 }
    const fill = slotFill({ slots, players, horizon: [{ week: 10, pts }], floor: {}, capacity: 10, pts, roster: ['r1', 'r2', 'w1'], sends: ['w1'], receives: ['new'] })
    expect(fill).toEqual({ slot: 'RB2', before: 7, after: 12.5 })
    expect(slotFill({ slots, players, horizon: [{ week: 10, pts }], floor: {}, capacity: 10, pts, roster: ['r1', 'r2', 'w1'], sends: [], receives: [] })).toBeNull()
  })
})

describe('a shared trade’s address', () => {
  it('is read back with its league and deal', async () => {
    const { parseDeepLink } = await import('../../components/useDeepLink')
    expect(parseDeepLink('?league=abc&season=2026&trade=1.2.4034%2C2.1.%245')).toEqual({ league: 'abc', season: '2026', week: null, trade: '1.2.4034,2.1.$5' })
    expect(decodeDeal(parseDeepLink('?league=abc&trade=1.2.4034%2C2.1.%245')!.trade)).toEqual({ teams: [1, 2], moves: [{ player: '4034', from: 1, to: 2 }], faab: [{ from: 2, to: 1, dollars: 5 }] })
  })
})
