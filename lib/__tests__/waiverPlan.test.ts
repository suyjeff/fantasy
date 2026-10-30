import { describe, expect, it } from 'vitest'
import type { PlayerMap } from '../types'
import { planWaivers } from '../waivers'

const p = (id: string, pos: string, team: string, extra: Partial<PlayerMap[string]> = {}) => ({ id, name: id, pos, fpos: [pos], team, status: null, injury: null, age: null, exp: null, ...extra })
const players: PlayerMap = {
  // Mine
  myQb: p('myQb', 'QB', 'AAA'),
  myRb: p('myRb', 'RB', 'BBB', { depth: 1 }),
  myRb2: p('myRb2', 'RB', 'CCC', { depth: 1 }),
  myWr: p('myWr', 'WR', 'DDD'),
  myK: p('myK', 'K', 'AAA'),
  myDef: p('myDef', 'DEF', 'AAA'),
  bench1: p('bench1', 'WR', 'EEE'),
  bench2: p('bench2', 'RB', 'EEE'),
  // Free agents
  rbA: p('rbA', 'RB', 'FFF'),
  rbB: p('rbB', 'RB', 'GGG'),
  rbC: p('rbC', 'RB', 'HHH'),
  rbD: p('rbD', 'RB', 'III'),
  wrA: p('wrA', 'WR', 'JJJ'),
  faK: p('faK', 'K', 'KKK'),
  faK2: p('faK2', 'K', 'LLL'),
  faDef: p('faDef', 'DEF', 'MMM'),
  faQb: p('faQb', 'QB', 'NNN'),
  cuff: p('cuff', 'RB', 'BBB', { depth: 2 }),
  cuffOut: p('cuffOut', 'RB', 'CCC', { depth: 2, injury: 'Out' }),
  cuff3: p('cuff3', 'RB', 'CCC', { depth: 3 }),
  stashA: p('stashA', 'WR', 'OOO'),
  stashB: p('stashB', 'TE', 'PPP'),
}
const mine = ['myQb', 'myRb', 'myRb2', 'myWr', 'myK', 'myDef', 'bench1', 'bench2']
const rosteredBy = Object.fromEntries(mine.map((id) => [id, 1]))
const base = {
  targets: [
    { id: 'rbA', add: 2.5, slot: 'RB' },
    { id: 'rbB', add: 1.8, slot: 'FLEX' },
    { id: 'rbC', add: 1.0, slot: 'FLEX' },
    { id: 'rbD', add: 0.6, slot: 'FLEX' },
    { id: 'wrA', add: 1.2, slot: 'WR' },
    { id: 'faDef', add: 0.9, slot: 'DEF' },
    { id: 'faQb', add: 0.1, slot: null },
  ],
  players,
  rosteredBy,
  myPlayers: mine,
  myStarters: ['myQb', 'myRb', 'myRb2', 'myWr', 'myK', 'myDef'],
  drops: ['bench2', 'bench1'],
  weekPts: { myQb: 18, faQb: 18.2, myK: 7, faK: 9.5, faK2: 8.9, myDef: 6, faDef: 6.2, cuff: 4, cuff3: 3 } as Record<string, number>,
  perWeek: { cuff: 4, cuffOut: 6, cuff3: 3, myK: 7, myDef: 6 } as Record<string, number>,
  value: { stashA: 1.4, stashB: 0.2, wrA: 2, rbD: 0.4, faQb: 0.8 } as Record<string, number>,
  trending: { stashB: 100000 } as Record<string, number>,
  startable: ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'],
  starts: { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DEF: 1 },
}

describe('planWaivers', () => {
  const plan = planWaivers(base)
  it('ranks lineup upgrades by gain, two a position at most, kickers and defenses left to streams', () => {
    expect(plan.upgrades.map((u) => u.id)).toEqual(['rbA', 'rbB', 'wrA'])
    expect(plan.upgrades.find((u) => u.id === 'faDef')).toBeUndefined()
  })
  it('gives each upgrade its own drop and the next ones at the position as alternatives', () => {
    expect(plan.upgrades.map((u) => u.drop)).toEqual(['bench2', 'bench1', null])
    expect(plan.upgrades[0].alts.map((a) => a.id)).toEqual(['rbC', 'rbD'])
    expect(plan.upgrades[1].alts).toEqual([])
  })
  it('streams a position only when the best free agent beats your starter there by half a point', () => {
    expect(plan.streams.map((s) => s.id)).toEqual(['faK'])
    expect(plan.streams[0]).toMatchObject({ pos: 'K', vs: 'myK', drop: 'myK', alts: [{ id: 'faK2', proj: 8.9 }] })
    expect(plan.streams[0].gain).toBeCloseTo(2.5)
  })
  it('handcuffs the backup behind each back you start, never one who is out', () => {
    expect(plan.handcuffs).toEqual([
      { id: 'cuff', starter: 'myRb', value: 0 },
      { id: 'cuff3', starter: 'myRb2', value: 0 },
    ])
  })
  it('stashes value left on the wire that no other group took, nudged by trend', () => {
    const ids = plan.stashes.map((s) => s.id)
    expect(ids.slice(0, 2)).toEqual(['stashA', 'stashB'])
    // An alternative, an upgrade, or a kicker is not a stash.
    for (const id of ['rbC', 'rbD', 'wrA', 'faK']) expect(ids).not.toContain(id)
  })
  it('never stashes a player who would start for you, though the upgrade limits left him out', () => {
    // Room for one upgrade only: the receiver who would start misses the cut, and is no bench bet either.
    const tight = planWaivers({ ...base, limits: { upgrades: 1 } })
    expect(tight.upgrades.map((u) => u.id)).toEqual(['rbA'])
    const ids = tight.stashes.map((s) => s.id)
    expect(ids).not.toContain('wrA')
    // One who would not start (under the bar) still can be.
    expect(ids).toContain('faQb')
  })
  it('takes a K stream in place of yours, so no bench player is cut twice', () => {
    const drops = [...plan.upgrades, ...plan.streams].map((m) => m.drop).filter(Boolean)
    expect(new Set(drops).size).toBe(drops.length)
  })
})
