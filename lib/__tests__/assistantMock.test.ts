import { describe, expect, it } from 'vitest'
import { runTurn } from '../assistant'
import type { AsgmEvent } from '../assistant/types'
import { fixtureLeague } from './assistantFixture'

const run = async (text: string, signal = new AbortController().signal) => {
  const events: AsgmEvent[] = []
  await runTurn({ history: [], text, league: fixtureLeague(), provider: 'mock' }, (e) => events.push(e), signal)
  return events
}

describe('mock provider', () => {
  it('emits steps, every card kind with real ids, actions, text and done', async () => {
    const lg = fixtureLeague()
    const events = await run('Who should I start?')
    const kinds = new Set(events.flatMap((e) => (e.type === 'card' ? [e.card.kind] : [])))
    expect([...kinds].sort()).toEqual(['compare', 'lineup', 'odds', 'players', 'trade', 'waivers'])
    const steps = events.filter((e) => e.type === 'step')
    expect(steps.filter((s) => s.type === 'step' && s.status === 'running').length).toBe(steps.filter((s) => s.type === 'step' && s.status === 'done').length)
    for (const e of events) if (e.type === 'card' && e.card.kind === 'players') for (const r of e.card.rows) expect(lg.data.players[r.id]).toBeTruthy()
    expect(events.some((e) => e.type === 'action' && e.action.kind === 'openTrade')).toBe(true)
    const text = events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('')
    expect(text).toMatch(/^Start /)
    expect(events[events.length - 1]).toMatchObject({ type: 'done', provider: 'mock' })
  }, 30_000)

  it('ends in a forced error', async () => {
    const events = await run('!quota please')
    expect(events[events.length - 1]).toMatchObject({ type: 'error', code: 'quota' })
    const rate = await run('!rate')
    expect(rate[rate.length - 1]).toMatchObject({ type: 'error', code: 'rate' })
  }, 30_000)

  it('stops when aborted', async () => {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 400)
    const events = await run('Who should I start?', ac.signal)
    expect(events[events.length - 1]).toMatchObject({ type: 'error', code: 'aborted' })
  }, 30_000)
})
