import { describe, expect, it } from 'vitest'
import { availabilityOf, clearDaysOf, clearsLabel, filterPlayers, matchesOwn, matchesPos, matchesQuery, sortPlayers, waiverClears } from '../availability'
import type { PlayerMap, SleeperTransaction } from '../types'

const p = (id: string, pos: string, team: string | null, fpos = [pos]) => ({ id, name: id, pos, fpos, team, status: null, injury: null, age: null, exp: null })
const players: PlayerMap = {
  qb1: p('qb1', 'QB', 'DET'),
  rb1: p('rb1', 'RB', 'NYG'),
  wr1: p('wr1', 'WR', 'SEA'),
  te1: p('te1', 'TE', 'SEA'),
  k1: p('k1', 'K', 'CIN'),
  hunter: p('hunter', 'DB', 'JAX', ['WR', 'DB']),
  lb1: p('lb1', 'LB', 'DAL'),
  gone: p('gone', 'WR', null),
}
const DAY = 24 * 3600_000
const now = Date.UTC(2026, 9, 29, 12)
const tx = (type: string, drops: Record<string, number>, ago: number): SleeperTransaction => ({ type, status: 'complete', roster_ids: [1], adds: null, drops, picks: 0, created: now - ago, leg: 8 })

describe('waiverClears', () => {
  it('holds players dropped within the waiver period, and lets them clear after it', () => {
    const w = waiverClears([tx('free_agent', { rb1: 1 }, DAY), tx('waiver', { wr1: 2 }, 3 * DAY)], {}, 2, now)
    expect(w).toEqual({ rb1: now - DAY + 2 * DAY })
  })
  it('starts the clock when a claim went through, not when it was put in', () => {
    // Put in three days ago, processed half a day ago: the player it dropped has been on waivers for half a day.
    const claim = { ...tx('waiver', { wr1: 2 }, 3 * DAY), processed: now - DAY / 2 }
    expect(waiverClears([claim], {}, 2, now)).toEqual({ wr1: now - DAY / 2 + 2 * DAY })
    // Without a processed time (an older cached copy, another platform), the submission time stands in.
    expect(waiverClears([tx('waiver', { wr1: 2 }, 3 * DAY)], {}, 2, now)).toEqual({})
  })
  it('ignores trades, failed moves and players picked up again', () => {
    const failed = { ...tx('waiver', { k1: 1 }, DAY), status: 'failed' }
    const w = waiverClears([tx('trade', { qb1: 1 }, DAY), failed, tx('free_agent', { te1: 1 }, DAY)], { te1: 3 }, 2, now)
    expect(w).toEqual({})
  })
  it('has nothing on waivers in a league that clears at once', () => {
    expect(waiverClears([tx('free_agent', { rb1: 1 }, 1000)], {}, 0, now)).toEqual({})
  })
  it('reads the league setting, two days by default', () => {
    expect(clearDaysOf({ waiver_clear_days: 1 })).toBe(1)
    expect(clearDaysOf({})).toBe(2)
    expect(clearDaysOf(undefined)).toBe(2)
  })
})

describe('availability', () => {
  const rosteredBy = { qb1: 1, rb1: 2 }
  const waivers = { wr1: now + DAY }
  it('tells yours, another team, waivers and free agents apart', () => {
    expect(availabilityOf('qb1', rosteredBy, 1, waivers)).toEqual({ kind: 'mine', rosterId: 1 })
    expect(availabilityOf('rb1', rosteredBy, 1, waivers)).toEqual({ kind: 'team', rosterId: 2 })
    expect(availabilityOf('wr1', rosteredBy, 1, waivers)).toEqual({ kind: 'waivers', clears: now + DAY })
    expect(availabilityOf('te1', rosteredBy, 1, waivers)).toEqual({ kind: 'fa' })
  })
  it('counts waiver claims as available, and yours as rostered', () => {
    expect(matchesOwn({ kind: 'waivers', clears: 0 }, 'available')).toBe(true)
    expect(matchesOwn({ kind: 'fa' }, 'rostered')).toBe(false)
    expect(matchesOwn({ kind: 'mine', rosterId: 1 }, 'rostered')).toBe(true)
    expect(matchesOwn({ kind: 'team', rosterId: 2 }, 'mine')).toBe(false)
    expect(matchesOwn({ kind: 'team', rosterId: 2 }, 'all')).toBe(true)
  })
  it('labels when a claim clears', () => {
    expect(clearsLabel(now + 3600_000, now)).toBe('clears today')
    expect(clearsLabel(now + 2 * DAY, now)).toMatch(/^clears \S+/)
  })
})

describe('filters', () => {
  it('matches a position on any eligible spot, and FLEX on the league flex', () => {
    expect(matchesPos(players.hunter, 'WR')).toBe(true)
    expect(matchesPos(players.k1, 'FLEX')).toBe(false)
    expect(matchesPos(players.te1, 'FLEX')).toBe(true)
    expect(matchesPos(players.te1, 'FLEX', ['RB', 'WR'])).toBe(false)
    expect(matchesPos(players.k1, 'ALL')).toBe(true)
  })
  it('searches every word across name, team and position', () => {
    expect(matchesQuery(players.qb1, 'det qb')).toBe(true)
    expect(matchesQuery(players.qb1, 'det wr')).toBe(false)
    expect(matchesQuery({ name: 'Amon-Ra St. Brown', team: 'DET', pos: 'WR' }, 'amon')).toBe(true)
    expect(matchesQuery({ name: 'Zaccheaus Bédard', team: null, pos: 'WR' }, 'bedard')).toBe(true)
    expect(matchesQuery(players.qb1, '   ')).toBe(true)
  })
  it('keeps the league positions, drops players off every NFL roster unless rostered, and hides the long tail until searched', () => {
    const status = (id: string) => availabilityOf(id, { gone: 1 }, 1, {})
    const base = { players, pos: 'ALL' as const, own: 'all' as const, query: '', positions: ['QB', 'RB', 'WR', 'TE', 'K'], status }
    expect(filterPlayers(base).sort()).toEqual(['gone', 'hunter', 'k1', 'qb1', 'rb1', 'te1', 'wr1'])
    const relevant = (id: string) => id !== 'k1'
    expect(filterPlayers({ ...base, relevant })).not.toContain('k1')
    expect(filterPlayers({ ...base, relevant, query: 'k1' })).toEqual(['k1'])
    expect(filterPlayers({ ...base, own: 'available' })).not.toContain('gone')
  })
  it('keeps a released player with numbers for the view, off every NFL roster and every fantasy one', () => {
    const status = (id: string) => availabilityOf(id, {}, 1, {})
    const base = { players, pos: 'ALL' as const, own: 'all' as const, query: '', status }
    expect(filterPlayers(base)).not.toContain('gone')
    // Season to date: he played for someone before his release.
    expect(filterPlayers({ ...base, pool: ['gone', 'wr1'], keep: (id) => id === 'gone' })).toEqual(['gone', 'wr1'])
    expect(filterPlayers({ ...base, own: 'available', keep: (id) => id === 'gone' })).toContain('gone')
  })
})

describe('sortPlayers', () => {
  const m = {
    week: { qb1: 15, rb1: 9, wr1: 9 },
    value: { qb1: 2, rb1: 1, wr1: 3, te1: 0.5 },
    trend: { rb1: 50000 },
    gain: { wr1: 1.2 },
  }
  it('sorts best first by the chosen number, breaking ties on value', () => {
    expect(sortPlayers(['rb1', 'wr1', 'qb1'], 'week', m, players)).toEqual(['qb1', 'wr1', 'rb1'])
    expect(sortPlayers(['rb1', 'wr1', 'qb1'], 'value', m, players)).toEqual(['wr1', 'qb1', 'rb1'])
  })
  it('puts players with no number last, in value order', () => {
    expect(sortPlayers(['te1', 'qb1', 'rb1'], 'trend', m, players)).toEqual(['rb1', 'qb1', 'te1'])
    expect(sortPlayers(['te1', 'wr1', 'k1'], 'gain', m, players)).toEqual(['wr1', 'te1', 'k1'])
  })
})
