// The tuned constants, pinned to the evidence that set them (research/results/fitted.json, research/RESULTS.md). A
// change here without a new holdout result is a change nobody measured.
import { describe, expect, it } from 'vitest'
import fitted from '../../research/results/fitted.json'
import { EFFICIENCY_PRIOR_GAMES, FORM_PRIOR_GAMES, FORM_WEIGHT, LINEUP_PRIOR_GAMES, SIM, lineupGaps, teamRatings, type ForecastInput } from '../forecast'
import { RESULTS_PRIOR_GAMES, TALENT_SHARE } from '../power'
import type { TeamWeek } from '../power'

describe('fitted constants', () => {
  it('match research/results/fitted.json', () => {
    expect(LINEUP_PRIOR_GAMES).toBe(fitted.LINEUP_PRIOR_GAMES.value)
    expect(EFFICIENCY_PRIOR_GAMES).toBe(fitted.EFFICIENCY_PRIOR_GAMES.value)
    expect(FORM_WEIGHT).toBe(fitted.FORM_WEIGHT.value)
    expect(FORM_PRIOR_GAMES).toBe(fitted.FORM_PRIOR_GAMES.value)
    expect(SIM.tauShare).toBe(fitted['SIM.tauShare'].value)
    expect(SIM.persistence).toBe(fitted['SIM.persistence'].value)
    expect(SIM.sims).toBe(fitted['SIM.sims'].value)
    expect(RESULTS_PRIOR_GAMES).toBe(fitted.RESULTS_PRIOR_GAMES.value)
    expect(TALENT_SHARE).toBe(fitted.TALENT_SHARE.value)
  })
})

const tw = (week: number, rosterId: number, points: number, starters: string[]): TeamWeek => ({
  week,
  rosterId,
  points,
  opponentId: null,
  opponentPoints: null,
  result: null,
  optimalPoints: points,
  starters,
  players: ['a', 'b', 'c', 'd'],
  playersPoints: {},
})

describe('lineup habit', () => {
  // Two teams with the same roster projection; team 2 leaves a slot empty every week.
  const past = { 1: { 1: 30, 2: 30 }, 2: { 1: 30, 2: 30 } }
  const started = { 1: { 1: 30, 2: 20 }, 2: { 1: 30, 2: 20 } }
  const teamWeeks = { 1: [tw(1, 1, 31, ['a', 'b']), tw(1, 2, 19, ['a'])], 2: [tw(2, 1, 29, ['a', 'b']), tw(2, 2, 21, ['a'])] }

  it('is shrunk toward the league by LINEUP_PRIOR_GAMES', () => {
    const { gap, league } = lineupGaps([1, 2], teamWeeks, past, started)
    expect(league).toBe(-5)
    const k = LINEUP_PRIOR_GAMES
    expect(gap[1]).toBeCloseTo((0 + k * -5) / (2 + k), 9)
    expect(gap[2]).toBeCloseTo((-20 + k * -5) / (2 + k), 9)
  })

  it('is added to the projected best lineup in the rating', () => {
    const players = { a: { id: 'a', name: 'a', pos: 'RB', fpos: ['RB'], team: 'X' }, b: { id: 'b', name: 'b', pos: 'RB', fpos: ['RB'], team: 'X' } } as unknown as ForecastInput['players']
    const input: ForecastInput = {
      slots: [{ name: 'RB', eligible: ['RB'] }, { name: 'RB', eligible: ['RB'] }],
      players,
      horizon: [{ week: 3, pts: { a: 15, b: 15 } }],
      floor: {},
      teams: [
        { rosterId: 1, players: ['a', 'b'] },
        { rosterId: 2, players: ['a', 'b'] },
      ],
      teamWeeks: { 1: [{ ...teamWeeks[1][0], players: ['a', 'b'] }, { ...teamWeeks[1][1], players: ['a', 'b'] }], 2: [{ ...teamWeeks[2][0], players: ['a', 'b'] }, { ...teamWeeks[2][1], players: ['a', 'b'] }] },
      playedWeeks: [1, 2],
      pastProjections: { 1: { a: 15, b: 15 }, 2: { a: 15, b: 15 } },
      schedule: [],
      record: {},
      playoffWeeks: [],
      playoffTeams: 0,
      elo: {},
      sigmaFallback: 20,
    }
    const { ratings } = teamRatings(input)
    const r = Object.fromEntries(ratings.map((x) => [x.rosterId, x]))
    expect(r[1].rating).toBeCloseTo(30 + r[1].lineupGap, 2)
    expect(r[2].rating).toBeCloseTo(30 + r[2].lineupGap, 2)
    expect(r[2].lineupGap).toBeLessThan(r[1].lineupGap)
  })
})
