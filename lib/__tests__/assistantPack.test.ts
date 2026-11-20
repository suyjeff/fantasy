import { describe, expect, it } from 'vitest'
import { firstPayload, trimHistory } from '../assistant/loop'
import { leagueBrief, PACK_LIMIT, planPreRuns, playersIn, readQuestion } from '../assistant/pack'
import { suggestions } from '../assistant/suggest'
import type { AsgmContext, AsgmMessage } from '../assistant/types'
import { QUESTIONS } from '../../scripts/asgm-questions'
import { fixtureData, fixtureLeague } from './assistantFixture'

const lg = fixtureLeague()
const names = (ids: string[]) => ids.map((id) => lg.data.players[id]?.name)
const plan = (q: string, context?: AsgmContext) => planPreRuns(lg, q, context).map((p) => (p.deal ? `${p.tool}(deal)` : `${p.tool}(${JSON.stringify(p.args)})`))

describe('the fixture', () => {
  it('carries nothing that identifies the real league or its managers', () => {
    const raw = JSON.stringify(fixtureData())
    // Every long Sleeper id is one of the neutral ones the capture hands out.
    for (const id of raw.match(/"\d{15,20}"/g) ?? []) expect(id.slice(1, -1)).toMatch(/^100000000000000\d{3}$/)
    expect(lg.data.league.name).toBe('Fixture League')
    expect(Object.keys(lg.data.league).some((k) => k.startsWith('last_'))).toBe(false)
    expect(lg.data.users.every((u) => /^manager\d+$/.test(u.username ?? '') && !u.avatar)).toBe(true)
    expect(lg.data.me.user_id).toBe(lg.data.rosters.find((r) => r.roster_id === lg.myRosterId)!.owner_id)
  })
})

describe('reading the question', () => {
  it('finds the players it names: full names, surnames written as names, and "my RB2"', () => {
    expect(names(playersIn(lg, 'Hubbard or Skattebo at flex this week?'))).toEqual(['Chuba Hubbard', 'Cam Skattebo'])
    expect(names(playersIn(lg, "What would it take to get Ja'Marr Chase?"))).toEqual(["Ja'Marr Chase"])
    expect(names(playersIn(lg, 'Should I bench my RB2 against the Ravens?'))).toEqual(['Chuba Hubbard'])
    // Everyday words are not players.
    expect(playersIn(lg, 'should i chase a trade or love my team')).toEqual([])
  })

  it('reads the week, the position and a budget', () => {
    const r = readQuestion(lg, 'How much FAAB should I spend on Jaylen Waddle with $34 left in week 12?')
    expect(r.intents[0]).toBe('faab')
    expect(r.budget).toBe(34)
    expect(r.week).toBe(12)
    expect(readQuestion(lg, 'best TE on the wire').position).toBe('TE')
  })

  it('pre-runs the obvious tool for each kind of question', () => {
    expect(plan('Who should I start this week?')).toEqual(['lineup({})'])
    expect(plan('Hubbard or Skattebo at flex this week?')).toEqual(['start_sit({"players":["Chuba Hubbard","Cam Skattebo"]})'])
    expect(plan('Who has the softer playoff schedule, Zay Flowers or Jameson Williams?')).toEqual(['compare_players({"players":["Zay Flowers","Jameson Williams"],"span":"playoffs"})'])
    expect(plan('Which of my WRs is the sell-high?')).toEqual(['trade_values({"team":"me","position":"WR"})'])
    expect(plan('How much FAAB should I spend on Jaylen Waddle with $34 left?')).toEqual(['faab_bid({"player":"Jaylen Waddle","budget":34})'])
    expect(plan('Would Fourth & Long take Chuba Hubbard for Puka Nacua?')).toEqual(['evaluate_trade({"give":["Chuba Hubbard"],"get":["Puka Nacua"]})'])
    expect(plan("What would it take to get Ja'Marr Chase?")).toEqual(['find_trades({"target":"Ja\'Marr Chase"})'])
    expect(plan('What if I win out?')).toEqual(['playoff_odds({"win_out":true})'])
    expect(plan('Find me a WR upgrade', { view: 'trades', label: 'Trades' })).toEqual(['find_trades({"position":"WR"})'])
    expect(plan('Find me a WR upgrade')).toEqual(['find_trades({"position":"WR"})', 'waivers({"position":"WR"})'])
    expect(plan('Write me a poem about the stock market.')).toEqual([])
  })

  it('takes what is on screen: a deal, a player, a lineup', () => {
    const deal = { teams: [2, 4], moves: [{ player: '12481', from: 2, to: 4 }, { player: '9493', from: 4, to: 2 }], faab: [] }
    expect(plan('Is this fair?', { view: 'trades/builder', label: 'Trade builder', focus: { kind: 'trade', deal, label: 'x' } })).toEqual(['evaluate_trade(deal)'])
    expect(plan('Thoughts?', { view: 'players', label: 'Player', focus: { kind: 'player', id: '7594', label: 'Chuba Hubbard' } })).toEqual(['player({"player":"Chuba Hubbard"})'])
    expect(plan('Anything to change?', { view: 'me', label: 'Lineup', focus: { kind: 'lineup', rosterId: 2, week: 12, label: 'Week 12' } })).toEqual(['lineup({"team":"Waiver Wolves","week":12})'])
  })
})

describe('the context pack', () => {
  it('says the league, the asker and the roster in a few lines', () => {
    const b = leagueBrief(lg, { view: 'me', label: 'My team' })
    expect(b).toMatch(/^League: Fixture League · 10 teams · half PPR/)
    expect(b).toMatch(/trade deadline week 11 \(this week: last chance to trade\)/)
    expect(b).toMatch(/You: Waiver Wolves · 5-5 · power #4 of 10 · playoffs 64%, title 8% · FAAB \$164 left · week 11 vs Pocket Passers \(\d+% to win\)/)
    expect(b).toMatch(/\*RB2 Chuba Hubbard \(CAR\) 14\.4 · [\d.]+\/wk · vs BAL/)
    expect(b).toMatch(/On screen: My team \(me\)\./)
  })

  it('keeps every battery question to one compact message', async () => {
    for (const q of QUESTIONS) {
      const p = await firstPayload({ history: [], text: q.q, context: q.context, league: lg, provider: 'house' })
      const user = p.messages[p.messages.length - 1].content as string
      expect(user.length).toBeLessThanOrEqual(PACK_LIMIT + 1300)
      expect(user).toMatch(/^CONTEXT \(computed by the app/)
      expect(user.endsWith(`QUESTION: ${q.q}`)).toBe(true)
      expect(p.pre.every((x) => x.ok)).toBe(true)
      // The facts its answer rests on are already in the one message the model gets.
      for (const re of q.needs ?? []) expect(user, `${q.id} needs ${re}`).toMatch(re)
    }
  }, 60_000)

  it('trims history to the last exchanges, without errors or old contexts', () => {
    const u = (text: string): AsgmMessage => ({ role: 'user', id: text, text, at: 0 })
    const g = (text: string, error = false): AsgmMessage => ({ role: 'gm', id: text, text, steps: [], cards: [], actions: [], at: 0, ...(error ? { error: { type: 'error', code: 'provider', message: 'x' } } : {}) })
    const h = [u('a'), g('A'), u('b'), g('B', true), u('c'), g('C'), u('d'), g('D'.repeat(2000))]
    const t = trimHistory(h)
    expect(t[0]).toEqual({ role: 'user', content: 'b' })
    expect(t.map((m) => m.role)).toEqual(['user', 'user', 'assistant', 'user', 'assistant'])
    expect(t[t.length - 1].content.length).toBeLessThan(1000)
  })

  it('suggests starter questions with the league’s own names', () => {
    const s = suggestions(undefined, lg)
    expect(s.length).toBeGreaterThanOrEqual(3)
    expect(s.length).toBeLessThanOrEqual(4)
    expect(s.join(' ')).toMatch(/Should I bench Chuba Hubbard against BAL\?/)
    const po = suggestions({ view: 'playoffs', label: 'Playoffs' }, lg)
    expect(po).toContain('What if I win out?')
    const fa = suggestions({ view: 'players', label: 'Player', focus: { kind: 'player', id: '7526', label: 'Jaylen Waddle' } }, lg)
    expect(fa[0]).toBe('How much FAAB should I bid on Jaylen Waddle with $164 left?')
  })
})
