import { describe, expect, it } from 'vitest'
import { addDealTeam, dealActive, dealFromIdea, dealSummary, emptyDeal, readDeal, redirectPlayer, removeDealTeam, setDealFaab, togglePlayer, type Deal } from '../deal'
import type { Faab } from '../faab'
import { startingSlots } from '../lineup'

const rosters = { 1: ['a1', 'a2'], 2: ['b1', 'b2'], 3: ['c1'] }
const names: Record<number, string> = { 1: 'Mine', 2: 'Team X', 3: 'Team Y' }
const name = (id: number) => names[id]

describe('editing a deal', () => {
  it('builds a deal from a suggested trade', () => {
    expect(dealFromIdea(1, 2, ['a1'], ['b1', 'b2']).moves).toEqual([
      { player: 'a1', from: 1, to: 2 },
      { player: 'b1', from: 2, to: 1 },
      { player: 'b2', from: 2, to: 1 },
    ])
  })

  it('sends your players to the first partner and brings theirs to you, and a second tap takes one out', () => {
    let d: Deal = { ...emptyDeal([1, 2, 3]) }
    d = togglePlayer(d, 'a1', rosters, 1)
    d = togglePlayer(d, 'c1', rosters, 1)
    expect(d.moves).toEqual([
      { player: 'a1', from: 1, to: 2 },
      { player: 'c1', from: 3, to: 1 },
    ])
    expect(togglePlayer(d, 'a1', rosters, 1).moves).toEqual([{ player: 'c1', from: 3, to: 1 }])
    // Someone not on any team in the deal changes nothing.
    expect(togglePlayer(d, 'zz', rosters, 1)).toBe(d)
  })

  it('redirects a player, but never back to the team sending him', () => {
    const d = togglePlayer(emptyDeal([1, 2, 3]), 'a1', rosters, 1)
    expect(redirectPlayer(d, 'a1', 3).moves[0].to).toBe(3)
    expect(redirectPlayer(d, 'a1', 1).moves[0].to).toBe(2)
  })

  it('keeps one FAAB payment per team, remembering a destination before the amount', () => {
    let d = emptyDeal([1, 2, 3])
    d = setDealFaab(d, 1, 0, 3)
    expect(d.faab).toEqual([{ from: 1, to: 3, dollars: 0 }])
    d = setDealFaab(d, 1, 12)
    expect(d.faab).toEqual([{ from: 1, to: 3, dollars: 12 }])
    expect(setDealFaab(d, 1, 0).faab).toEqual([])
  })

  it('keeps the destination while the amount is cleared and retyped', () => {
    // What the FAAB field does on each keystroke: the figure, with the payment's current destination passed through.
    const type = (d: Deal, from: number, dollars: number) => setDealFaab(d, from, dollars, d.faab.find((x) => x.from === from)?.to)
    let d = setDealFaab(emptyDeal([1, 2, 3]), 1, 5, 3)
    d = type(d, 1, 0)
    expect(d.faab).toEqual([{ from: 1, to: 3, dollars: 0 }])
    expect(dealActive(d)).toBe(false)
    d = type(d, 1, 7)
    expect(d.faab).toEqual([{ from: 1, to: 3, dollars: 7 }])
    // With no payment yet, an empty field adds none.
    expect(type(emptyDeal([1, 2, 3]), 1, 0).faab).toEqual([])
  })

  it('keeps a destination picked before the amount as teams come and go, unless its team leaves', () => {
    let d = setDealFaab(emptyDeal([1, 2, 3]), 1, 0, 3)
    d = setDealFaab(d, 2, 0, 3)
    d = addDealTeam(d, 4)
    expect(d.faab).toEqual([
      { from: 1, to: 3, dollars: 0 },
      { from: 2, to: 3, dollars: 0 },
    ])
    expect(removeDealTeam(d, 4).faab).toEqual(d.faab)
    // Taken out: payments to it and from it go.
    expect(removeDealTeam(d, 3).faab).toEqual([])
    expect(removeDealTeam(d, 2).faab).toEqual([{ from: 1, to: 3, dollars: 0 }])
    expect(setDealFaab(removeDealTeam(d, 4), 1, 9).faab).toContainEqual({ from: 1, to: 3, dollars: 9 })
  })

  it('drops moves that touch a team taken out', () => {
    let d = addDealTeam(emptyDeal([1, 2]), 3)
    d = togglePlayer(d, 'c1', rosters, 1)
    d = togglePlayer(d, 'b1', rosters, 1)
    expect(removeDealTeam(d, 3).moves).toEqual([{ player: 'b1', from: 2, to: 1 }])
    expect(addDealTeam(d, 3)).toBe(d)
  })
})

describe('dealSummary', () => {
  it('reads a two-team deal as what you send for what you get', () => {
    const d = dealFromIdea(1, 2, ['a1', 'a2'], ['b1'])
    expect(dealSummary(d, 1, name, 3.14)).toBe('You ⇄ Team X · 2 for 1 · +3.1/wk')
    expect(dealSummary(d, 1, name, -0.26)).toBe('You ⇄ Team X · 2 for 1 · −0.3/wk')
    expect(dealSummary(d, 1, name)).toBe('You ⇄ Team X · 2 for 1')
  })

  it('counts players in a bigger deal, and FAAB as money in or out', () => {
    let d = togglePlayer(emptyDeal([1, 2, 3]), 'a1', rosters, 1)
    d = togglePlayer(d, 'c1', rosters, 1)
    d = setDealFaab(d, 1, 5)
    expect(dealSummary(d, 1, name, 0.01)).toBe('You ⇄ Team X + Team Y · 2 players · −$5 · 0.0/wk')
  })

  it('says what is missing before anything moves', () => {
    expect(dealSummary(emptyDeal([1]), 1, name)).toBe('Pick a partner')
    expect(dealSummary(emptyDeal([1, 2]), 1, name, 0)).toBe('You ⇄ Team X · pick players')
  })
})

describe('a $0 payment', () => {
  const P = (id: string, pos: string) => ({ id, name: id, pos, fpos: [pos], team: null, status: null, injury: null, age: null, exp: null })
  const pts = { a1: 10, a2: 6, b1: 9, b2: 5, c1: 7 }
  const input = {
    slots: startingSlots(['RB', 'BN']),
    players: { a1: P('a1', 'RB'), a2: P('a2', 'RB'), b1: P('b1', 'RB'), b2: P('b2', 'RB'), c1: P('c1', 'RB') },
    horizon: [{ week: 6, pts }],
    floor: {},
    capacity: 3,
    pts,
    tradeMarket: {},
    rosters,
  }
  const faab: Faab = {
    budget: 100,
    minBid: 0,
    remaining: { 1: 0, 2: 50, 3: 50 },
    bids: [],
    going: { p50: 5, p75: 10, p90: 20, max: 30, n: 0, source: 'none' },
    rate: 10,
    rateN: 0,
    weeksLeft: 8,
    regularWeeks: 14,
  }

  it('moves nothing: no FAAB either way, no budget problem, nothing to price, nothing in the summary', () => {
    const d = setDealFaab(emptyDeal([1, 2, 3]), 1, 0, 3)
    const read = readDeal(d, { ...input, faab })
    for (const s of read.sides) {
      expect(s.faab).toBe(0)
      expect(s.faabValue.mid).toBe(0)
      expect(s.problems).toEqual([])
    }
    expect(read.valid).toBe(false)
    expect(dealActive(d)).toBe(false)
    expect(dealSummary(d, 1, name)).toBe('You ⇄ Team X + Team Y · pick players')
    const traded = togglePlayer(d, 'b1', rosters, 1)
    expect(dealSummary(traded, 1, name)).toBe('You ⇄ Team X + Team Y · 1 player')
    expect(readDeal(traded, { ...input, faab }).valid).toBe(true)
  })
})
