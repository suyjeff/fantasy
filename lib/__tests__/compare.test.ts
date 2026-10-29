import { describe, expect, it } from 'vitest'
import {
  addCompare,
  bestOf,
  dealKey,
  findDeal,
  MAX_COMPARE,
  moveCompare,
  parseCompare,
  removeCompare,
  replaceCompare,
  serializeCompare,
  slotLetter,
  staleMoves,
  verdictText,
  type CompareSet,
} from '../compare'
import { dealFromIdea, emptyDeal, type Deal } from '../deal'

const ME = 1
const deal = (partner: number, give = 'a1', get = `p${partner}`): Deal => dealFromIdea(ME, partner, [give], [get])
const fill = (n: number) => {
  let s: CompareSet = []
  for (let i = 0; i < n; i++) s = addCompare(s, deal(i + 2), 1000 + i).set
  return s
}

describe('the comparison set', () => {
  it('adds deals up to the limit, each in the lowest free slot, and no more', () => {
    const s = fill(MAX_COMPARE)
    expect(s.map((i) => i.slot)).toEqual([0, 1, 2, 3])
    expect(s.map((i) => slotLetter(i.slot))).toEqual(['A', 'B', 'C', 'D'])
    const r = addCompare(s, deal(9))
    expect(r.status).toBe('full')
    expect(r.set).toBe(s)
  })

  it('knows the same deal however it was put together, and keeps it once', () => {
    const a: Deal = {
      teams: [ME, 2],
      moves: [
        { player: 'x', from: ME, to: 2 },
        { player: 'y', from: 2, to: ME },
      ],
      faab: [{ from: ME, to: 2, dollars: 0 }],
    }
    const b: Deal = {
      teams: [2, ME],
      moves: [
        { player: 'y', from: 2, to: ME },
        { player: 'x', from: ME, to: 2 },
      ],
      faab: [],
    }
    expect(dealKey(a)).toBe(dealKey(b))
    const s = addCompare([], a).set
    const r = addCompare(s, b)
    expect(r.status).toBe('present')
    expect(r.set).toHaveLength(1)
    expect(findDeal(s, b)?.id).toBe(s[0].id)
    // FAAB that moves makes it another deal.
    expect(dealKey({ ...b, faab: [{ from: ME, to: 2, dollars: 5 }] })).not.toBe(dealKey(a))
  })

  it('takes nothing empty', () => {
    expect(addCompare([], emptyDeal([ME, 2])).status).toBe('empty')
  })

  it('keeps colours with their trades: a removed slot is reused, moving keeps the slot', () => {
    let s = fill(3)
    s = removeCompare(s, s[1].id)
    expect(s.map((i) => i.slot)).toEqual([0, 2])
    s = addCompare(s, deal(7)).set
    expect(s.map((i) => i.slot)).toEqual([0, 2, 1])
    s = moveCompare(s, s[2].id, -1)
    expect(s.map((i) => i.slot)).toEqual([0, 1, 2])
    expect(moveCompare(s, s[0].id, -1)).toBe(s)
  })

  it('updates a trade in place, or merges it into the same deal already there', () => {
    let s = fill(2)
    const changed = deal(2, 'a1', 'q2')
    s = replaceCompare(s, s[0].id, changed)
    expect(s[0].slot).toBe(0)
    expect(dealKey(s[0].deal)).toBe(dealKey(changed))
    s = replaceCompare(s, s[0].id, s[1].deal)
    expect(s).toHaveLength(1)
    expect(s[0].slot).toBe(1)
  })

  it('round-trips through storage, and reads bad storage as safely as it can', () => {
    const s = fill(3)
    expect(parseCompare(serializeCompare(s))).toEqual(s)
    expect(parseCompare(null)).toEqual([])
    expect(parseCompare('{oops')).toEqual([])
    expect(parseCompare(JSON.stringify({ items: [{ deal: { teams: 'x' } }, null, 4] }))).toEqual([])
    // Duplicates merge, clashing slots move, past the limit is dropped.
    const raw = JSON.stringify({
      items: [
        { id: 'a', deal: deal(2), slot: 1 },
        { id: 'b', deal: deal(2), slot: 2 },
        { id: 'c', deal: deal(3), slot: 1 },
        { id: 'd', deal: deal(4), slot: 3 },
        { id: 'e', deal: deal(5), slot: 0 },
        { id: 'f', deal: deal(6), slot: 0 },
      ],
    })
    const got = parseCompare(raw)
    expect(got.map((i) => i.id)).toEqual(['a', 'c', 'd', 'e'])
    expect(new Set(got.map((i) => i.slot)).size).toBe(4)
  })

  it('finds a trade out of date when a player has left the team sending him', () => {
    const d: Deal = {
      teams: [ME, 2],
      moves: [
        { player: 'x', from: ME, to: 2 },
        { player: 'y', from: 2, to: ME },
      ],
      faab: [],
    }
    expect(staleMoves(d, { [ME]: ['x'], 2: ['y'] })).toEqual([])
    expect(staleMoves(d, { [ME]: ['x'], 2: ['z'] }).map((m) => m.player)).toEqual(['y'])
    expect(staleMoves(d, { [ME]: ['x'] }).map((m) => m.player)).toEqual(['y'])
  })
})

describe('the best in a row', () => {
  it('marks the highest, ties within the margin, and nothing when it cannot tell them apart', () => {
    expect(bestOf([1, 3, 2])).toEqual([1])
    expect(bestOf([1, 3, 2.97])).toEqual([1, 2])
    expect(bestOf([1, null, -2], 'low')).toEqual([2])
    expect(bestOf([2, 2])).toEqual([])
    expect(bestOf([5, null, undefined])).toEqual([])
    expect(bestOf([])).toEqual([])
  })
})

describe('the verdict', () => {
  const col = (label: string, lineup: number | null, odds: number | null, playoffs?: number | null, out = false) => ({ label: `Trade ${label}`, lineup, odds, playoffs, out })

  it('names the trade that adds most and the one likeliest to be accepted', () => {
    expect(verdictText([col('A', 1.2, 0.41), col('B', 3.1, 0.2)])).toBe('Trade B adds the most this season (+3.1/wk); Trade A is likeliest to be accepted (41%).')
  })

  it('says so in one clause when one trade leads both', () => {
    expect(verdictText([col('A', 3.1, 0.6), col('B', 1, 0.2)])).toBe('Trade A adds the most this season (+3.1/wk) and is likeliest to be accepted (60%).')
  })

  it('adds the playoff odds only when they point to a third trade', () => {
    expect(verdictText([col('A', 1, 0.6, 0.01), col('B', 3, 0.2, 0.02), col('C', 2, 0.3, 0.05)])).toBe(
      'Trade B adds the most this season (+3.0/wk); Trade A is likeliest to be accepted (60%); Trade C does most for your playoff odds (+5.0pt).',
    )
    expect(verdictText([col('A', 1, 0.6, 0.01), col('B', 3, 0.2, 0.05)])).not.toMatch(/playoff/)
  })

  it('shares a lead between trades that tie', () => {
    expect(verdictText([col('A', 3.05, 0.3), col('B', 3.1, 0.3), col('C', 1, 0.2)])).toBe('Trades A and B add the most this season (+3.1/wk) and are likeliest to be accepted (30%).')
  })

  it('says when none helps', () => {
    expect(verdictText([col('A', -0.4, 0.5), col('B', -1.2, 0.3)])).toBe('None of these makes your lineup better; Trade A costs it least (−0.4/wk) and is likeliest to be accepted (50%).')
  })

  it('leaves out a trade that is out of date, and says what to do when they all are', () => {
    expect(verdictText([col('A', 9, 0.9, null, true), col('B', 1, 0.2), col('C', 2, 0.1)])).toBe('Trade C adds the most this season (+2.0/wk); Trade B is likeliest to be accepted (20%).')
    expect(verdictText([col('A', null, null, null, true)])).toMatch(/out of date/)
  })

  it('reads one trade on its own, and asks for another', () => {
    expect(verdictText([col('A', 2.4, 0.31)])).toBe('Trade A: +2.4/wk for your lineup, 31% to be accepted. Add another trade to compare it with.')
  })
})
