import { describe, expect, it } from 'vitest'
import { acceptRead, bandOf } from '../behavior'
import type { Consensus } from '../consensus'
import { dealTier, rosterStanding, tradeCurrency } from '../currency'
import type { Faab } from '../faab'
import { applyLessons, type Lessons } from '../grades'
import { startingSlots } from '../lineup'
import { findTrades, type Horizon, type TradeIdea } from '../trades'
import type { PlayerMap } from '../types'

// A 12-team league, one roster read closely (theirs, roster 1), yours (2), and ten more that only fill the pool, so
// "rostered in a league this size" means what it does in a real one: about 150 skill players.
const ROSTER = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF', 'BN', 'BN', 'BN', 'BN', 'BN', 'BN']
const P = (id: string, name: string, pos: string): PlayerMap[string] => ({ id, name, pos, fpos: [pos], team: 'KC', status: null, injury: null, age: null, exp: null })

// id, name, position, consensus overall rank, rank at position, trade price (pts/wk above replacement).
const THEIRS: [string, string, string, number, number, number][] = [
  ['gibbs', 'Jahmyr Gibbs', 'RB', 1, 1, 15.5],
  ['brown', 'Chase Brown', 'RB', 30, 14, 5.5],
  ['london', 'Drake London', 'WR', 15, 7, 7],
  ['waddle', 'Jaylen Waddle', 'WR', 50, 26, 3],
  ['doubs', 'Romeo Doubs', 'WR', 130, 62, 0.7],
  ['fannin', 'Harold Fannin Jr.', 'TE', 106, 10, 0.6],
  ['burrow', 'Joe Burrow', 'QB', 60, 7, 1.8],
  ['vaki', 'Sione Vaki', 'RB', 279, 71, 0],
  ['tk', 'Their Kicker', 'K', 200, 8, 0],
]
const MINE: [string, string, string, number, number, number][] = [
  ['hubbard', 'Chuba Hubbard', 'RB', 22, 11, 6],
  ['skattebo', 'Cam Skattebo', 'RB', 60, 27, 2.6],
  ['diggs', 'Stefon Diggs', 'WR', 62, 29, 2.4],
  ['downs', 'Josh Downs', 'WR', 70, 35, 2.2],
  ['samuel', 'Deebo Samuel Sr.', 'WR', 120, 56, 0.8],
  ['rachaad', 'Rachaad White', 'RB', 95, 37, 1],
  ['scrubby', 'Elijah Mitchell', 'RB', 290, 80, 0],
]

const build = () => {
  const players: PlayerMap = {}
  const consensus: Consensus = { date: null, byId: {}, matched: 0, unmatched: 0 }
  const prices: Record<string, number> = {}
  const add = ([id, name, pos, rank, posRank, price]: (typeof THEIRS)[number]) => {
    players[id] = P(id, name, pos)
    consensus.byId[id] = { rank, posRank, sd: null, best: null, worst: null, weekRank: null }
    prices[id] = price
  }
  THEIRS.forEach(add)
  MINE.forEach(add)
  const rosters = [
    { rosterId: 1, players: THEIRS.map((t) => t[0]) },
    { rosterId: 2, players: MINE.map((t) => t[0]) },
  ]
  // Ten more teams of fourteen skill players each, unranked, worth a little: the rest of the rostered pool.
  for (let r = 3; r <= 12; r++) {
    const ids: string[] = []
    for (let i = 0; i < 14; i++) {
      const id = `f${r}_${i}`
      players[id] = P(id, `Filler ${r} ${i}`, ['QB', 'RB', 'WR', 'TE'][i % 4])
      prices[id] = 1
      ids.push(id)
    }
    rosters.push({ rosterId: r, players: ids })
  }
  // Their lineup this week: Gibbs and Brown, London and Waddle, Fannin, Burrow.
  const starters = { 1: ['gibbs', 'brown', 'london', 'waddle', 'fannin', 'burrow'], 2: ['hubbard', 'skattebo', 'diggs', 'downs'] }
  const currency = tradeCurrency({ players, market: prices, rosterPositions: ROSTER, numTeams: 12, rosters, transactions: [], consensus, starters })
  return { players, consensus, prices, rosters, currency }
}

const { prices, currency } = build()
const FAAB: Faab = {
  budget: 200,
  minBid: 0,
  remaining: { 1: 150, 2: 150 },
  bids: [],
  going: { p50: 5, p75: 12, p90: 25, max: 60, n: 20, source: 'this season' },
  rate: 10,
  rateN: 10,
  weeksLeft: 6,
  regularWeeks: 14,
}

/** You send `give` and get `get` from roster 1; their lineup moves by `theirGain`. */
const idea = (give: string[], get: string[], theirGain = 0, faab?: number): TradeIdea => ({
  partnerId: 1,
  give,
  get,
  shape: 'swap',
  myGain: 1,
  theirGain,
  myCost: 0,
  valueAsk: 0,
  weeksBetter: 3,
  weeks: 3,
  fills: null,
  myCuts: [],
  theirCuts: [],
  mutual: 0,
  perWeek: [],
  faab,
})
const read = (i: TradeIdea, faab: Faab | null = FAAB) => acceptRead(i, 2, null, prices, currency, faab, null)

describe('standing', () => {
  const st = currency.standing!
  it('reads stars, starters, rosterable depth and cut candidates from the rankings and the rosters', () => {
    expect(st.gibbs).toMatchObject({ role: 'star', starts: true, posRank: 1 })
    expect(st.london.role).toBe('star')
    expect(st.brown.role).toBe('starter')
    // A top-10 tight end ranks around 100th overall, where his price is read; he still starts, and counts as a starter.
    expect(st.fannin).toMatchObject({ role: 'starter', starts: true })
    expect(st.burrow.role).toBe('starter')
    // WR62 on a bench: the consensus would roster him in a league this size.
    expect(st.doubs).toMatchObject({ role: 'useful', starts: false })
    expect(st.vaki.role).toBe('scrub')
    expect(st.tk.role).toBe('scrub')
  })

  it('counts a starter on bye as one: inside his team’s starting count at his position', () => {
    const { players, consensus, prices: market, rosters } = build()
    const s = rosterStanding({ players, market, rosterPositions: ROSTER, numTeams: 12, rosters, consensus, starters: { 1: ['gibbs'] } })
    expect(s.fannin.starts).toBe(true)
    expect(s.doubs.starts).toBe(false)
  })
})

describe('lopsided offers', () => {
  it('reads a star, a starter or a rostered bench player for nothing as one that would never happen', () => {
    const cases: [string, number, string][] = [
      ['gibbs', -10, 'would never happen: Gibbs, the RB1, for nothing'],
      ['london', -4, 'would never happen: London, a top-10 WR, for nothing'],
      ['brown', -3, 'would never happen: Brown, their starting RB, for nothing'],
      ['fannin', -0.1, 'would never happen: Fannin, their starting TE, for nothing'],
      ['burrow', -0.1, 'would never happen: Burrow, their starting QB, for nothing'],
      // The complaint: WR62 on their bench, no lineup cost to them, read "possible" at 59% before.
      ['doubs', 0, 'would never happen: Doubs, WR62 depth, for nothing'],
    ]
    for (const [id, gain, text] of cases) {
      const r = read(idea([], [id], gain))
      expect(r.tier, id).toBe('nonsense')
      expect(r.index, id).toBeLessThanOrEqual(1)
      expect(r.band, id).toBe('no chance')
      expect(r.signals[0], id).toEqual({ text, tone: 'neg' })
      expect(r.reasons.join(' '), id).not.toContain('overpay to them by consensus')
    }
  })

  it('reads a cut candidate for nothing as merely unlikely', () => {
    const r = read(idea([], ['vaki']))
    expect(r.tier).toBe('overpay')
    expect(r.index).toBeGreaterThan(5)
    expect(r.index).toBeLessThanOrEqual(15)
    expect(r.band).toBe('long shot')
    expect(r.reasons).toContain('nothing back for Vaki, a cut candidate')
  })

  it('reads a star for spare parts as nonsense, and for a lesser starter as lopsided', () => {
    const parts = read(idea(['samuel'], ['gibbs'], -9))
    expect(parts.tier).toBe('nonsense')
    expect(parts.signals[0].text).toBe('would never happen: Gibbs, the RB1, for spare parts')
    const lesser = read(idea(['skattebo'], ['gibbs'], -8))
    expect(lesser.tier).toBe('lopsided')
    expect(lesser.signals[0].text).toBe('no manager takes this: Gibbs is the RB1 for little back')
    expect(lesser.index).toBeLessThanOrEqual(3)
    expect(lesser.band).toBe('no chance')
  })

  it('reads a starter for a cut candidate as nonsense', () => {
    const r = read(idea(['scrubby'], ['fannin'], -0.1))
    expect(r.tier).toBe('nonsense')
    expect(r.signals[0].text).toBe('would never happen: Fannin, their starting TE, for a bench scrap')
  })

  it('reads a clear overpay as one, with odds that fall off steeply but stay above the lopsided tiers', () => {
    // Their starting RB14 for your starting WR35: nobody is insulted, but it asks far more than it gives back.
    const r = read(idea(['downs'], ['brown'], -0.5))
    expect(r.tier).toBe('overpay')
    expect(r.reasons).toContain('asks a lot more than it gives')
    expect(r.index).toBeLessThanOrEqual(15)
    // Steeper than the plain linear read of the same ask.
    const plain = acceptRead(idea(['downs'], ['brown'], -0.5), 2, null, prices, undefined, FAAB, null)
    expect(r.logit).toBeLessThan(plain.logit)
  })

  it('leaves a fair 2-for-1 consolidation and a slight overpay to the read’s own terms', () => {
    // Their WR7 for your RB11 and RB27: the star costs a little more than his parts, as it should.
    const twoForOne = read(idea(['hubbard', 'skattebo'], ['london'], 0.5))
    expect(twoForOne.tier).toBe('fair')
    expect(twoForOne.cap).toBeNull()
    expect(twoForOne.band === 'possible' || twoForOne.band === 'likely').toBe(true)
    const slight = read(idea(['downs'], ['waddle'], 0.2))
    expect(slight.tier).toBe('fair')
    expect(slight.index).toBeGreaterThanOrEqual(20)
    // Same deal, same number as before the tiers: the plain read is untouched for fair deals.
    const plain = acceptRead(idea(['downs'], ['waddle'], 0.2), 2, null, prices, { factor: currency.factor, attached: currency.attached }, FAAB, null)
    expect(slight.logit).toBeCloseTo(plain.logit, 9)
  })
})

describe('FAAB in a lopsided offer', () => {
  it('never buys a star: $1 or the whole budget for Gibbs would never happen', () => {
    for (const dollars of [1, 25, 150]) {
      const r = read(idea([], ['gibbs'], -10 + 1.5, dollars))
      expect(r.tier, `$${dollars}`).toBe('nonsense')
      expect(r.index).toBeLessThanOrEqual(1)
      expect(r.signals[0].text).toBe(`would never happen: Gibbs, the RB1, for $${dollars} FAAB`)
      // No amount of FAAB is offered as the fix.
      expect(r.faab).toBeNull()
    }
  })

  it('covers a bench player once it is worth about as much as he is, and says how much', () => {
    const none = read(idea([], ['doubs']))
    expect(none.tier).toBe('nonsense')
    // The way to make it an offer, though the read stays on the deal as it stands.
    expect(none.faab).not.toBeNull()
    expect(none.reasons).toContain(`add $${none.faab} FAAB to even it by consensus`)
    const token = read(idea([], ['doubs'], 0, 1))
    expect(token.tier).toBe('nonsense')
    const paid = read(idea([], ['doubs'], 0.1, 15))
    expect(paid.tier).toBe('fair')
    expect(paid.index).toBeGreaterThan(35)
  })

  it('makes a cut candidate a plain sale', () => {
    const r = read(idea([], ['vaki'], 0.1, 3))
    expect(r.tier).toBe('fair')
    expect(r.index).toBeGreaterThan(read(idea([], ['vaki'])).index)
  })

  it('works on standing alone where trades carry no FAAB', () => {
    const r = read(idea([], ['doubs']), null)
    expect(r.tier).toBe('nonsense')
    expect(r.faab).toBeNull()
  })
})

describe('keeping the tiers', () => {
  it('lets no lesson lift a capped deal, but your own grade of it decides', () => {
    const r = read(idea([], ['doubs']))
    const lessons: Lessons = {
      n: 1,
      global: 4,
      partner: {},
      untouchable: {},
      askCap: {},
      noUse: {},
      sharedDormant: {},
      sharedUntouchable: {},
      sharedAskCap: {},
      shared: false,
      grades: {},
    }
    const names = (id: string) => id
    const posOf = () => 'WR'
    expect(applyLessons(r, idea([], ['doubs']), lessons, names, posOf).index).toBeLessThanOrEqual(1)
    const graded = { ...lessons, grades: { '1|>doubs': { partnerId: 1, give: [], get: ['doubs'], grade: 'yes' as const, x: r.logit, ask: r.perceivedAsk, at: 0 } } }
    expect(applyLessons(r, idea([], ['doubs']), graded, names, posOf).index).toBe(75)
  })

  it('names the band by the index alone, the same everywhere', () => {
    expect([0, 4, 5, 34, 35, 59, 60].map(bandOf)).toEqual(['no chance', 'no chance', 'long shot', 'long shot', 'possible', 'possible', 'likely'])
  })

  it('reads nothing asked of them as fair', () => {
    expect(dealTier({ gives: [], gets: ['doubs'], prices, currency }).tier).toBe('fair')
  })
})

describe('the search never suggests a hopeless deal', () => {
  // You: a deep backfield and a hole at receiver. Them: a star receiver, a starter, and a thin backfield. On points
  // alone your third back for their star fills both holes; the room reads it as a star for spare parts.
  const slots = startingSlots(['QB', 'RB', 'WR', 'BN', 'BN'])
  const players: PlayerMap = {
    q1: P('q1', 'My Quarterback', 'QB'),
    r1: P('r1', 'My Back One', 'RB'),
    r2: P('r2', 'My Back Two', 'RB'),
    r3: P('r3', 'My Back Three', 'RB'),
    w0: P('w0', 'My Receiver', 'WR'),
    q2: P('q2', 'Their Quarterback', 'QB'),
    star: P('star', 'Their Star', 'WR'),
    w2: P('w2', 'Their Receiver', 'WR'),
    rb: P('rb', 'Their Back', 'RB'),
  }
  const pts = { q1: 18, r1: 14, r2: 13, r3: 12, w0: 6, q2: 18, star: 13, w2: 12.5, rb: 5 }
  const horizon: Horizon = [1, 2, 3].map((week) => ({ week, pts }))
  // The model has their star written down to a body; the room still has him as the WR2.
  const market = { q1: 4, r1: 7, r2: 6, r3: 5, w0: 0.5, q2: 4, star: 5, w2: 4.5, rb: 0.5 }
  const perceived = { ...market, star: 14 }
  const consensus: Consensus = { date: null, byId: { star: { rank: 3, posRank: 2, sd: null, best: null, worst: null, weekRank: null } }, matched: 1, unmatched: 0 }
  const rosters = [
    { rosterId: 1, players: ['q1', 'r1', 'r2', 'r3', 'w0'] },
    { rosterId: 2, players: ['q2', 'star', 'w2', 'rb'] },
  ]
  const cur = tradeCurrency({ players, market, rosterPositions: ['QB', 'RB', 'WR', 'BN', 'BN'], numTeams: 2, rosters, transactions: [], consensus })
  const input = {
    slots,
    players,
    horizon,
    pts,
    me: rosters[0],
    others: [rosters[1]],
    capacity: 5,
    tradeMarket: market,
    currency: cur,
    floor: { QB: 10, RB: 5, WR: 5 },
    config: { maxGive: 1, maxGet: 1 },
  }

  it('drops what the room would read as past fair, and counts it', () => {
    const before = findTrades(input)
    expect(before.some((i) => i.get.includes('star'))).toBe(true)
    let rejected = 0
    const after = findTrades({ ...input, perceived, onFunnel: (f) => (rejected = f.rejectedLopsided) })
    expect(after.some((i) => i.get.includes('star'))).toBe(false)
    expect(rejected).toBeGreaterThan(0)
    for (const i of after) expect(dealTier({ gives: i.get, gets: i.give, prices: perceived, currency: cur }).tier).toBe('fair')
  })
})
