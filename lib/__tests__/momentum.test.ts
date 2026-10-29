import { describe, expect, it } from 'vitest'
import { acceptRead } from '../behavior'
import { starValue } from '../currency'
import type { Usage } from '../context'
import { startingSlots } from '../lineup'
import { classifyForm, DEFAULT_RESIDUAL_SD, FORM, lastName, playerForms, residualSd, streakOf, teamMood, teamMoods, type FormInput, type Momentum, type PlayerForm } from '../momentum'
import type { TeamSeason } from '../power'
import { findTrades, type Horizon, type TradeIdea } from '../trades'
import type { PlayerMap } from '../types'

const P = (id: string, pos: string, injury: string | null = null): PlayerMap[string] => ({ id, name: `First ${id}`, pos, fpos: [pos], team: 'KC', status: null, injury, age: null, exp: null })

describe('streaks', () => {
  it('reads the current run from the results, latest last', () => {
    expect(streakOf(['W', 'L', 'L', 'L'])).toBe(-3)
    expect(streakOf(['L', 'W', 'W'])).toBe(2)
    expect(streakOf(['W', 'T'])).toBe(0)
    expect(streakOf([])).toBe(0)
    // Weeks without a result (not yet played) do not break a run.
    expect(streakOf(['L', 'L', null, undefined])).toBe(-2)
  })

  it('makes a losing team hungrier, most of all on the bubble, and a winning one complacent', () => {
    const l1 = teamMood(1, -1, 0.5, 5)
    const l2 = teamMood(1, -2, 0.5, 5)
    const l3 = teamMood(1, -3, 0.5, 5)
    const l6 = teamMood(1, -6, 0.5, 5)
    expect(l1.urgency).toBe(0)
    expect(l1.text).toBeNull()
    expect(l2.urgency).toBeGreaterThan(0)
    expect(l3.urgency).toBeGreaterThan(l2.urgency)
    expect(l6.urgency).toBe(1)
    expect(l3.bubble).toBe(true)
    expect(l3.text).toBe('lost 3 straight on the bubble, looking to shake things up')
    // Same run, safely in or already out: less to play for.
    expect(teamMood(1, -3, 0.95, 5).urgency).toBeLessThan(l3.urgency)
    expect(teamMood(1, -3, 0.01, 5).urgency).toBeLessThan(teamMood(1, -3, 0.95, 5).urgency)
    expect(teamMood(1, -3, 0.5, 5, 'out').bubble).toBe(false)
    // Winning runs: two is nothing, three starts it, safe teams most.
    expect(teamMood(1, 2, 0.9, 5).urgency).toBe(0)
    const w4safe = teamMood(1, 4, 0.95, 5)
    expect(w4safe.urgency).toBeLessThan(teamMood(1, 4, 0.5, 5).urgency + 1e-9)
    expect(w4safe.urgency).toBeGreaterThanOrEqual(-0.6)
    expect(w4safe.text).toBe('won 4 straight, little reason to change')
    // No regular season left, nothing to save.
    expect(teamMood(1, -5, 0.5, 0).urgency).toBe(0)
  })

  it('builds every team from its season and the forecast', () => {
    const season = (rosterId: number, results: string[]) => ({ rosterId, weeks: results.map((result, i) => ({ week: i + 1, result })) }) as unknown as TeamSeason
    const moods = teamMoods([season(1, ['W', 'L', 'L', 'L']), season(2, ['W', 'W', 'W', 'W'])], { 1: { playoffs: 0.4 }, 2: { playoffs: 0.99, clinch: 'in' } }, 4)
    expect(moods[1].streak).toBe(-3)
    expect(moods[1].urgency).toBeGreaterThan(0)
    expect(moods[2].urgency).toBeLessThan(0)
  })
})

describe('buy low, sell high', () => {
  const base: FormInput = { name: 'Kupp', pos: 'WR', recent: [{ week: 8, actual: 4.2, expected: 14 }], forward: 13.5, sd: 7 }

  it('flags a good player well under his projection whose outlook holds', () => {
    const f = classifyForm(base)!
    expect(f.kind).toBe('buy-low')
    expect(f.factor).toBeLessThan(1)
    expect(f.factor).toBeGreaterThanOrEqual(1 - FORM.cap)
    expect(f.games).toBe(1)
  })

  it('needs the gap to clear the position noise and be large in proportion', () => {
    // 3 under on a 14: a quiet week.
    expect(classifyForm({ ...base, recent: [{ week: 8, actual: 11, expected: 14 }] })).toBeNull()
    // The same miss reads as noise at a noisier position.
    expect(classifyForm({ ...base, sd: 12 })).toBeNull()
    // A 9-point miss on a 25-point quarterback is still 64% of the projection: not a dud.
    expect(classifyForm({ ...base, pos: 'QB', recent: [{ week: 8, actual: 16, expected: 25 }], forward: 24, sd: 7 })).toBeNull()
    // A bench body's quiet week is just a week.
    expect(classifyForm({ ...base, recent: [{ week: 8, actual: 0.5, expected: 5 }], forward: 5 })).toBeNull()
  })

  it('leaves out injured players, a model that has marked him down, and a role that shrank', () => {
    expect(classifyForm({ ...base, injury: 'Questionable' })).toBeNull()
    expect(classifyForm({ ...base, injury: 'Out' })).toBeNull()
    expect(classifyForm({ ...base, play: 0.6 })).toBeNull()
    // The projection ahead fell with the dud: the model has seen something.
    expect(classifyForm({ ...base, forward: 9 })).toBeNull()
    const usage = (lastOpps: number, priorOpps: number): Usage => ({ snaps: 0.8, recentSnaps: 0.7, opps: priorOpps, recentOpps: lastOpps, lastOpps, priorOpps, lastSnaps: 0.7, lastWeek: 8, games: 7 })
    expect(classifyForm({ ...base, usage: usage(3, 10) })).toBeNull()
    // Usage as normal: a dud on his usual work is the buy-low.
    expect(classifyForm({ ...base, usage: usage(9, 10) })?.kind).toBe('buy-low')
  })

  it('flags a spike the model has not followed as a sell-high, at a higher bar', () => {
    const spike = classifyForm({ ...base, recent: [{ week: 8, actual: 28, expected: 12 }], forward: 12.5 })!
    expect(spike.kind).toBe('sell-high')
    expect(spike.factor).toBeGreaterThan(1)
    expect(spike.factor).toBeLessThanOrEqual(1 + FORM.cap)
    // 1.4 SD up is not enough for a spike, though it would be for a dud.
    expect(classifyForm({ ...base, recent: [{ week: 8, actual: 21.8, expected: 12 }], forward: 12 })).toBeNull()
    // Projected higher from here: a new role, not luck.
    expect(classifyForm({ ...base, recent: [{ week: 8, actual: 28, expected: 12 }], forward: 16 })).toBeNull()
    expect(classifyForm({ ...base, recent: [{ week: 8, actual: 28, expected: 12 }], forward: 12, injury: 'IR' })).toBeNull()
  })

  it('reads two bad games together and moves the price further, never past the cap', () => {
    const one = classifyForm(base)!
    const two = classifyForm({ ...base, recent: [base.recent[0], { week: 7, actual: 6, expected: 14 }] })!
    expect(two.games).toBe(2)
    expect(two.factor).toBeLessThan(one.factor)
    const huge = classifyForm({ ...base, recent: [{ week: 8, actual: 0.5, expected: 30 }, { week: 7, actual: 1, expected: 30 }], forward: 30 })!
    expect(huge.factor).toBeCloseTo(1 - FORM.cap, 5)
  })

  it('measures each position from the league and skips byes, zeros and last season', () => {
    const players: PlayerMap = { a: P('a', 'WR'), b: P('b', 'WR'), hurt: P('hurt', 'WR', 'Out'), c: P('c', 'RB') }
    const weekPoints = { 6: { a: 15, b: 12, c: 10 }, 7: { a: 14, b: 13, c: 11 }, 8: { a: 3, b: 0, hurt: 2, c: 12 } }
    const projections = { 6: { a: 14, b: 12, c: 11 }, 7: { a: 14, b: 12, c: 11 }, 8: { a: 14, b: 13, hurt: 14, c: 11 } }
    const sd = residualSd([6, 7, 8], weekPoints, projections, players)
    // A thin sample stays near the default.
    expect(Math.abs(sd.WR - DEFAULT_RESIDUAL_SD.WR)).toBeLessThan(1.5)
    const forms = playerForms({ players, weeks: [6, 7, 8], weekPoints, projections, forward: { a: 14, b: 12, hurt: 14, c: 11 }, current: true })
    expect(Object.keys(forms)).toEqual(['a'])
    expect(forms.a.name).toBe('a')
    expect(lastName('Luther Burden III')).toBe('Burden')
    expect(lastName('Omar Cooper Jr.')).toBe('Cooper')
    expect(lastName('Kenneth Walker III')).toBe('Walker')
    expect(playerForms({ players, weeks: [6, 7, 8], weekPoints, projections, forward: { a: 14 }, current: false })).toEqual({})
  })
})

describe('the trade read with momentum', () => {
  const idea = { partnerId: 1, give: ['g'], get: ['t'], theirGain: 0.5, valueAsk: 0, perWeek: [] } as unknown as TradeIdea
  const perceived = { t: 6, g: 6 }
  const form = (kind: PlayerForm['kind'], factor: number): PlayerForm => ({ kind, name: 'T', actual: 4, expected: 14, games: 1, z: 1.5, factor })
  const calm: Momentum = { form: {}, teams: {}, market: perceived }

  it('asks less of them for a buy-low and more for a sell-high, within the cap', () => {
    const plain = acceptRead(idea, 2, null, perceived, undefined, null, calm)
    const low = acceptRead(idea, 2, null, perceived, undefined, null, { ...calm, form: { t: form('buy-low', 0.88) } })
    const high = acceptRead(idea, 2, null, perceived, undefined, null, { ...calm, form: { t: form('sell-high', 1.12) } })
    expect(low.perceivedAsk!).toBeLessThan(plain.perceivedAsk!)
    expect(high.perceivedAsk!).toBeGreaterThan(plain.perceivedAsk!)
    expect(low.index).toBeGreaterThanOrEqual(plain.index)
    expect(high.index).toBeLessThan(plain.index)
    // The move is the player's value at his new price, never more.
    expect(plain.perceivedAsk! - low.perceivedAsk!).toBeCloseTo(starValue(6) - starValue(6 * 0.88), 2)
    expect(low.signals[0]).toEqual({ text: 'T down week: 4.0 vs 14.0 expected, buy low', tone: 'pos' })
    expect(high.signals[0].tone).toBe('neg')
  })

  it('reads a sell-high you send as worth more to them', () => {
    const plain = acceptRead(idea, 2, null, perceived, undefined, null, calm)
    const sell = acceptRead(idea, 2, null, perceived, undefined, null, { ...calm, form: { g: form('sell-high', 1.12) } })
    expect(sell.perceivedAsk!).toBeLessThan(plain.perceivedAsk!)
    expect(sell.index).toBeGreaterThan(plain.index)
    expect(sell.signals[0].text).toContain('sell high')
  })

  it('moves the ask on the trade market when there is no consensus', () => {
    const plain = acceptRead({ ...idea, valueAsk: 2 }, 2, null, null, undefined, null, calm)
    const low = acceptRead({ ...idea, valueAsk: 2 }, 2, null, null, undefined, null, { ...calm, form: { t: form('buy-low', 0.88) } })
    expect(plain.perceivedAsk).toBeNull()
    expect(low.index).toBeGreaterThan(plain.index)
  })

  it('raises the odds for a team on a losing run, lowers them for a hot one, and stays bounded', () => {
    const mood = (urgency: number, streak: number) => ({ ...calm, teams: { 1: { rosterId: 1, streak, urgency, playoffs: 0.5, bubble: true, text: urgency ? 'run' : null } } })
    const plain = acceptRead(idea, 2, null, perceived, undefined, null, calm)
    const losing = acceptRead(idea, 2, null, perceived, undefined, null, mood(1, -5))
    const winning = acceptRead(idea, 2, null, perceived, undefined, null, mood(-0.6, 5))
    expect(losing.index).toBeGreaterThan(plain.index)
    expect(winning.index).toBeLessThan(plain.index)
    expect(losing.logit - plain.logit).toBeLessThanOrEqual(0.4 + 1e-9)
    expect(plain.logit - winning.logit).toBeLessThanOrEqual(0.24 + 1e-9)
    expect(losing.index - plain.index).toBeLessThanOrEqual(10)
    expect(losing.signals[0]).toEqual({ text: 'run', tone: 'pos' })
    expect(winning.signals[0].tone).toBe('neg')
    // An urgent team forgives part of an overpay when the deal helps it now, not when it does not.
    const over = { t: 9, g: 5 }
    const helps = { ...idea, theirGain: 1 }
    const gap = (i: TradeIdea) => acceptRead(i, 2, null, over, undefined, null, mood(1, -5)).logit - acceptRead(i, 2, null, over, undefined, null, calm).logit
    expect(gap(helps)).toBeGreaterThan(0.4)
    expect(gap({ ...idea, theirGain: 0 })).toBeCloseTo(0.4, 5)
  })
})

describe('the search with recent form', () => {
  const ROSTER = ['QB', 'RB', 'WR', 'BN', 'BN']
  const slots = startingSlots(ROSTER)
  // You: two good backs, one weak receiver. Them: two equal receivers, a weak back.
  const players: PlayerMap = { q1: P('q1', 'QB'), r1: P('r1', 'RB'), r2: P('r2', 'RB'), w0: P('w0', 'WR'), q2: P('q2', 'QB'), w1: P('w1', 'WR'), w2: P('w2', 'WR'), r3: P('r3', 'RB') }
  const pts = { q1: 18, r1: 14, r2: 13, w0: 6, q2: 18, w1: 13, w2: 13, r3: 5 }
  const horizon: Horizon = [1, 2, 3].map((week) => ({ week, pts }))
  const market = { q1: 4, r1: 7, r2: 6, w0: 0.5, q2: 4, w1: 6, w2: 6, r3: 0.5 }
  const input = {
    slots,
    players,
    horizon,
    pts,
    me: { rosterId: 1, players: ['q1', 'r1', 'r2', 'w0'] },
    others: [{ rosterId: 2, players: ['q2', 'w1', 'w2', 'r3'] }],
    capacity: 5,
    tradeMarket: market,
    floor: { QB: 10, RB: 5, WR: 5 },
    config: { maxGive: 1, maxGet: 1 },
  }

  it('puts the buy-low ahead of an otherwise equal deal', () => {
    const plain = findTrades(input).filter((i) => i.give[0] === 'r2')
    const first = (ideas: TradeIdea[]) => ideas.find((i) => i.give[0] === 'r2')?.get[0]
    expect(plain.map((i) => i.get[0]).sort()).toEqual(['w1', 'w2'])
    expect(first(findTrades({ ...input, form: { w2: 0.88 } }))).toBe('w2')
    expect(first(findTrades({ ...input, form: { w1: 0.88 } }))).toBe('w1')
    // Prices themselves do not move: the card and the builder read the same ask.
    const withForm = findTrades({ ...input, form: { w2: 0.88 } }).find((i) => i.get[0] === 'w2' && i.give[0] === 'r2')!
    expect(withForm.valueAsk).toBe(plain.find((i) => i.get[0] === 'w2')!.valueAsk)
  })
})
