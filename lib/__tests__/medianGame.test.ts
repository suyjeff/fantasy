// Leagues that also play the week's median (Sleeper's league_average_match): about one Sleeper league in eight of the
// 1,300 pulled for the model audit. Every team gets a second result each week, so records, the simulation and the
// clinch arithmetic all have to count it, or a team two games clear reads as clinched when it is not.
import { describe, expect, it } from 'vitest'
import { clinchStatus, rng, seedOrder, simulateSeason } from '../forecast'
import { simulateOnce } from '../playoffSim'
import { buildTeamSeasons, buildTeamWeeks, hasMedianGame, medianResults } from '../power'
import type { SleeperMatchup } from '../types'

const permutations = (xs: number[]): number[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])))

describe('the median game', () => {
  it('goes to the top half of the week', () => {
    expect(medianResults([{ rosterId: 1, points: 120 }, { rosterId: 2, points: 90 }, { rosterId: 3, points: 110 }, { rosterId: 4, points: 80 }])).toEqual({ 1: 'W', 2: 'L', 3: 'W', 4: 'L' })
    // Level across the cut: both tie it.
    expect(medianResults([{ rosterId: 1, points: 120 }, { rosterId: 2, points: 100 }, { rosterId: 3, points: 100 }, { rosterId: 4, points: 80 }])).toEqual({ 1: 'W', 2: 'T', 3: 'T', 4: 'L' })
    expect(hasMedianGame({ settings: { league_average_match: 1 } })).toBe(true)
    expect(hasMedianGame({ settings: {} })).toBe(false)
  })

  it('counts in the record: two results a week', () => {
    const m = (roster_id: number, matchup_id: number, points: number): SleeperMatchup => ({ roster_id, matchup_id, points, starters: [], players: [], players_points: {} }) as unknown as SleeperMatchup
    const week = [m(1, 1, 130), m(2, 1, 100), m(3, 2, 120), m(4, 2, 90)]
    const tw = buildTeamWeeks({ 1: week }, [1], [], {}, { median: true })
    const s = Object.fromEntries(buildTeamSeasons([1, 2, 3, 4], tw, [1], {}).map((x) => [x.rosterId, [x.wins, x.losses]]))
    // 1 and 3 won their games and are the week's top half; 2 and 4 lost both.
    expect(s).toEqual({ 1: [2, 0], 2: [0, 2], 3: [2, 0], 4: [0, 2] })
    const plain = Object.fromEntries(buildTeamSeasons([1, 2, 3, 4], buildTeamWeeks({ 1: week }, [1], [], {}), [1], {}).map((x) => [x.rosterId, [x.wins, x.losses]]))
    expect(plain).toEqual({ 1: [1, 0], 2: [0, 1], 3: [1, 0], 4: [0, 1] })
  })

  it('is played every simulated week, and the single-season trace agrees with the odds', () => {
    const teams = [1, 2, 3, 4, 5, 6]
    const record = Object.fromEntries(teams.map((t) => [t, { wins: 4, losses: 4, ties: 0, pf: 800 }]))
    const schedule = [1, 2].flatMap((week) => [
      { week, a: 1, b: 2 },
      { week, a: 3, b: 4 },
      { week, a: 5, b: 6 },
    ])
    const input = { teams, record, schedule, playoffWeeks: [], playoffTeams: 4, mean: () => 100, sigma: 25, tau: 5, weeksLeft: 2, sims: 400, median: true }
    const sim = simulateSeason(input)
    // Six games and six median results over two weeks: 24 + 12 wins in total.
    expect(teams.reduce((a, t) => a + sim[t].wins, 0)).toBeCloseTo(24 + 6 + 6, 1)
    const trace = simulateOnce(input, 3)
    expect(trace.standings.reduce((a, r) => a + r.wins, 0)).toBe(36)
    expect(trace.standings.every((r) => r.wins + r.losses === 8 + 4)).toBe(true)
  })

  it('clinches only what every order of the week’s scores agrees on (brute force, 4-team leagues)', () => {
    const u = rng(11)
    let calls = 0
    for (let k = 0; k < 400; k++) {
      const teams = [1, 2, 3, 4]
      const played = 6 + Math.floor(u() * 4)
      const record = Object.fromEntries(teams.map((t) => {
        const wins = Math.floor(u() * (2 * played + 1))
        return [t, { wins, losses: 2 * played - wins, ties: 0, pf: 0 }]
      }))
      const weeks = Math.floor(u() * 3)
      const schedule = Array.from({ length: weeks }, (_, i) => {
        const o = [...teams].sort(() => u() - 0.5)
        return [{ week: i + 1, a: o[0], b: o[1] }, { week: i + 1, a: o[2], b: o[3] }]
      }).flat()
      const spots = 2
      // Every week's scores in every order decide both its games; then every tiebreak order.
      const orders = permutations(teams)
      const seen: Record<number, { in: boolean; out: boolean }> = Object.fromEntries(teams.map((t) => [t, { in: false, out: false }]))
      const walk = (w: number, wins: Record<number, number>) => {
        if (w > weeks) {
          for (const pfOrder of orders) {
            const pf = Object.fromEntries(pfOrder.map((t, i) => [t, i]))
            seedOrder(teams, (t) => wins[t], (t) => pf[t]).forEach((t, i) => (i < spots ? (seen[t].in = true) : (seen[t].out = true)))
          }
          return
        }
        for (const order of orders) {
          const next = { ...wins }
          const rank = Object.fromEntries(order.map((t, i) => [t, i]))
          for (const g of schedule.filter((x) => x.week === w)) next[rank[g.a] < rank[g.b] ? g.a : g.b]++
          order.slice(0, 2).forEach((t) => next[t]++)
          walk(w + 1, next)
        }
      }
      walk(1, Object.fromEntries(teams.map((t) => [t, record[t].wins])))
      const got = clinchStatus(teams, record, schedule, spots, weeks, undefined, undefined, weeks)
      for (const t of teams) {
        if (got[t] === null) continue
        calls++
        const truth = seen[t].in && !seen[t].out ? 'in' : seen[t].out && !seen[t].in ? 'out' : null
        expect({ k, t, got: got[t] }).toEqual({ k, t, got: truth })
      }
    }
    expect(calls).toBeGreaterThan(0)
  })
})
