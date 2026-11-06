// clinchStatus checked against brute force. For small random leagues (4 or 6 teams, 0–3 weeks left, with and without
// divisions, existing ties in the record) every remaining result is enumerated, and every order of the points-for
// tiebreak with it, and each team's seed is worked out by the same seeding rule the simulation uses (seedOrder).
//
//   truly in    in the playoffs in every outcome under every tiebreak
//   truly out   out in every outcome under every tiebreak
//
// The app shows 100% and 0% only on clinchStatus's word (lib/format chance), so the one thing that must never happen
// is a call the brute force contradicts. clinchStatus is allowed to leave a settled race open (it errs that way by
// design); how often it does is reported, not failed.
import { describe, expect, it } from 'vitest'
import { clinchStatus, seedOrder, simulateSeason, SIM } from '../forecast'
import { rng } from '../forecast'

const permutations = (xs: number[]): number[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])))

type Case = {
  teams: number[]
  record: Record<number, { wins: number; losses: number; ties: number; pf: number }>
  schedule: { week: number; a: number; b: number }[]
  weeks: number
  spots: number
  divisions?: Record<number, number>
}

const makeCase = (u: () => number): Case => {
  const n = u() < 0.5 ? 4 : 6
  const teams = Array.from({ length: n }, (_, i) => i + 1)
  const divided = n === 6 && u() < 0.4
  // Division cases enumerate every tiebreak order (6! of them), so they keep to two weeks.
  const weeks = Math.floor(u() * (divided ? 3 : 4))
  const played = 4 + Math.floor(u() * 6)
  const record: Case['record'] = {}
  for (const t of teams) {
    const ties = u() < 0.15 ? 1 : 0
    const wins = Math.floor(u() * (played - ties + 1))
    record[t] = { wins, losses: played - ties - wins, ties, pf: 0 }
  }
  const schedule: Case['schedule'] = []
  for (let w = 1; w <= weeks; w++) {
    const order = [...teams].sort(() => u() - 0.5)
    for (let i = 0; i < n; i += 2) schedule.push({ week: w, a: order[i], b: order[i + 1] })
  }
  // At least two spots: a one-team "bracket" has no playoffs to count.
  const spots = 2 + Math.floor(u() * (n - 2))
  const divisions = divided ? Object.fromEntries(teams.map((t) => [t, t <= 3 ? 1 : 2])) : undefined
  return { teams, record, schedule, weeks, spots, divisions }
}

/** Every team's fate over all outcomes × tiebreak orders: 'in', 'out', or null when some world disagrees. */
const bruteForce = (c: Case): Record<number, 'in' | 'out' | null> => {
  const seen: Record<number, { in: boolean; out: boolean }> = {}
  for (const t of c.teams) seen[t] = { in: false, out: false }
  // Without divisions a team's seat depends only on where it falls among teams level with it, so seating it last
  // and first among them covers every order. With divisions, who wins each division moves everyone: all orders.
  const orders = c.divisions ? permutations(c.teams) : c.teams.flatMap((t) => [[t, ...c.teams.filter((o) => o !== t)], [...c.teams.filter((o) => o !== t), t]])
  const g = c.schedule.length
  for (let mask = 0; mask < 1 << g; mask++) {
    const wins: Record<number, number> = {}
    for (const t of c.teams) wins[t] = c.record[t].wins + 0.5 * c.record[t].ties
    c.schedule.forEach((x, i) => (wins[(mask >> i) & 1 ? x.a : x.b] += 1))
    for (const order of orders) {
      const pf = Object.fromEntries(order.map((t, i) => [t, i]))
      const seeded = seedOrder(c.teams, (t) => wins[t], (t) => pf[t], c.divisions ? (t) => c.divisions![t] : undefined)
      seeded.forEach((t, i) => (i < c.spots ? (seen[t].in = true) : (seen[t].out = true)))
    }
  }
  return Object.fromEntries(c.teams.map((t) => [t, seen[t].in && !seen[t].out ? 'in' : seen[t].out && !seen[t].in ? 'out' : null]))
}

describe('clinchStatus against brute force', () => {
  it('never calls a spot the enumeration contradicts (2,000 random leagues)', () => {
    const u = rng(20261106)
    let calls = 0
    let settled = 0
    let missed = 0
    for (let k = 0; k < 2000; k++) {
      const c = makeCase(u)
      const truth = bruteForce(c)
      const got = clinchStatus(c.teams, c.record, c.schedule, c.spots, c.weeks, c.divisions)
      for (const t of c.teams) {
        if (got[t] !== null) {
          calls++
          expect({ case: k, team: t, called: got[t] }).toEqual({ case: k, team: t, called: truth[t] })
        }
        if (truth[t] !== null) {
          settled++
          if (got[t] === null) missed++
        }
      }
    }
    if (process.env.REPORT) console.log(`calls ${calls}, settled ${settled}, left open ${missed} (${((100 * missed) / settled).toFixed(1)}%)`)
    // Conservative by design, but it should still call most settled races.
    expect(calls).toBeGreaterThan(0)
    expect(missed / settled).toBeLessThan(0.1)
  }, 120_000)

  it('a clinched team is in every simulated season, an eliminated one in none', () => {
    const u = rng(7)
    for (let k = 0; k < 300; k++) {
      const c = makeCase(u)
      const sim = simulateSeason({ teams: c.teams, record: c.record, schedule: c.schedule, playoffWeeks: [], playoffTeams: c.spots, mean: () => 100, sigma: 25, tau: 10, weeksLeft: c.weeks, sims: 200, divisions: c.divisions })
      for (const t of c.teams) {
        if (sim[t].clinch === 'in') expect(sim[t].playoffs).toBe(1)
        if (sim[t].clinch === 'out') expect(sim[t].playoffs).toBe(0)
      }
    }
  })
})

describe('Monte Carlo error budget', () => {
  it('the shipped run keeps any displayed odds within 1 point of simulation error', () => {
    // The standard error of a simulated share is at most √(0.25 / sims), at 50%.
    expect(Math.sqrt(0.25 / SIM.sims)).toBeLessThan(0.01)
  })
})
