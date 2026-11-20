import { describe, expect, it } from 'vitest'
import { ASGM_LIMITS, ASGM_TOOL_NAMES } from '../../workers/grades/src/asgmShared'
import { geminiSchema } from '../assistant/providers'
import { resolvePlayer, resolveTeam, signed } from '../assistant/resolve'
import { runTool, TOOLS } from '../assistant/tools'
import type { AsgmCard } from '../assistant/types'
import { buildAsgmLeague } from '../assistant/league'
import { leagueBrief } from '../assistant/pack'
import { fixtureData, fixtureLeague } from './assistantFixture'

// The Assistant GM's tools, run on a real league (week 11 of 2026, asking as Waiver Wolves, roster 2).
const lg = fixtureLeague()
const id = (name: string) => Object.values(lg.data.players).find((p) => p.name === name)!.id
const run = (name: string, args: Record<string, unknown> = {}) => runTool(name, args, lg)
const cardIds = (c: AsgmCard): string[] =>
  c.kind === 'players' ? c.rows.map((r) => r.id) : c.kind === 'compare' ? c.ids : c.kind === 'lineup' ? c.changes.flatMap((x) => [x.in, x.out]) : c.kind === 'waivers' ? c.rows.flatMap((r) => [r.add, ...(r.drop ? [r.drop] : [])]) : c.kind === 'trade' ? c.deal.moves.map((m) => m.player) : []

describe('assistant tools: contract', () => {
  it('offers exactly the tools the worker allows, each small enough for it and valid for every provider', () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual([...ASGM_TOOL_NAMES].sort())
    for (const t of TOOLS) {
      expect(JSON.stringify({ name: t.name, description: t.description, parameters: t.params }).length).toBeLessThan(ASGM_LIMITS.toolChars)
      expect(t.params.type).toBe('object')
      for (const r of t.params.required ?? []) expect(t.params.properties).toHaveProperty(r)
      // Gemini takes no empty objects: a tool without arguments sends no parameters at all.
      const g = geminiSchema(t.params)
      if (!Object.keys(t.params.properties ?? {}).length) expect(g).toBeUndefined()
      else expect(JSON.stringify(g)).not.toContain('"properties":{}')
      expect(t.label({}, lg)).toMatch(/^[A-Z][a-z]+ing /)
    }
  })

  it('reads players and teams the way people write them', () => {
    expect(resolvePlayer(lg, 'Hubbard')).toEqual({ ok: true, value: id('Chuba Hubbard') })
    expect(resolvePlayer(lg, 'my RB2')).toEqual({ ok: true, value: id('Chuba Hubbard') })
    expect(resolvePlayer(lg, "ja'marr chase")).toEqual({ ok: true, value: id("Ja'Marr Chase") })
    expect(resolvePlayer(lg, 'Bears')).toEqual({ ok: true, value: 'CHI' })
    expect(resolvePlayer(lg, 'Zzyzx Nobody').ok).toBe(false)
    expect(resolveTeam(lg, 'me')).toEqual({ ok: true, value: 2 })
    expect(resolveTeam(lg, 'fourth & long')).toEqual({ ok: true, value: 4 })
    expect(resolveTeam(lg, 'Manager 9').ok).toBe(true)
    expect(signed(-0.01)).toBe('+0.0')
  })

  it('turns a bad call into an error the model can read, never a throw', async () => {
    expect((await run('nope')).text).toMatch(/^Error: no tool named nope/)
    expect((await run('player', { player: 'Zzyzx Nobody' })).text).toMatch(/^Error: no player matches/)
    const fa = await run('evaluate_trade', { give: ['Chuba Hubbard'], get: ['Jaylen Waddle'] })
    expect(fa.ok).toBe(false)
    expect(fa.text).toMatch(/free agent: use waivers/)
    expect((await run('faab_bid', { player: 'Chuba Hubbard' })).text).toMatch(/not on waivers/)
    // A partner who does not have the players is refused, not priced as if he did.
    const wrong = await run('evaluate_trade', { give: ['Chuba Hubbard'], get: ['Puka Nacua'], partner: 'Pocket Passers' })
    expect(wrong.ok).toBe(false)
    expect(wrong.text).toBe('Error: Puka Nacua is on Fourth & Long, not Pocket Passers; trade with Fourth & Long, or name players Pocket Passers has.')
    expect((await run('evaluate_trade', { give: ['Chuba Hubbard'], get: ['Puka Nacua'], partner: 'Fourth & Long' })).ok).toBe(true)
    expect((await run('lineup', { week: 30 })).text).toMatch(/outside the season/)
  })
})

describe('assistant tools: answers', () => {
  it('lineup: the best lineup against the set one, with close calls, and a card of real ids', async () => {
    const r = await run('lineup')
    expect(r.ok).toBe(true)
    expect(r.text).toContain('As set: 117.3 projected. Best: 117.3')
    expect(r.text).toContain('Changes: none')
    expect(r.text).toMatch(/Close calls: Jameson Williams over Deebo Samuel Sr\. by 3\.1 \(Deebo Samuel Sr\. outscores him \d+% of the time\)/)
    expect(r.text).toMatch(/Chuba Hubbard \(RB CAR\) · proj 14\.4 · range [\d.]+–[\d.]+ · model exp 16 · vs BAL \(#\d+\/32 pts allowed to RB, \w+\)/)
    expect(r.text).toMatch(/A\.J\. Brown .*BYE · Out \(Hamstring\)/)
    const card = r.cards![0]
    expect(card).toMatchObject({ kind: 'lineup', rosterId: 2, week: 11, total: { before: 117.3, after: 117.3 } })
    // A week ahead uses that week's projections.
    const w13 = await run('lineup', { week: 13 })
    expect(w13.text).toMatch(/week 13/)
    expect(w13.text).toMatch(/Zay Flowers.*BYE/)
  })

  it('start_sit: ranks by projection with the odds each beats the next', async () => {
    const r = await run('start_sit', { players: ['my RB2', 'Cam Skattebo', 'Kyle Monangai'] })
    expect(r.text.split('\n')[1]).toMatch(/^- Cam Skattebo/)
    expect(r.text).toMatch(/Cam Skattebo outscores Chuba Hubbard \d+% of the time \(\+0\.8 projected\)/)
    expect(r.text).toMatch(/team implied [\d.]+ pts \(betting lines\)/)
    expect(r.cards!.map((c) => c.kind)).toEqual(['players', 'compare'])
    // Two of your players who both start anyway: no choice to make.
    expect((await run('start_sit', { players: ['Chuba Hubbard', 'Cam Skattebo'] })).text).toMatch(/Call: start both; which one sits in the flex slot changes nothing/)
    expect((await run('start_sit', { players: ['Chuba Hubbard'] })).text).toMatch(/at least two/)
  })

  it('player: value, ranks, form, usage and the schedule with playoff weeks marked', async () => {
    const r = await run('player', { player: 'Zay Flowers' })
    expect(r.text).toMatch(/^Zay Flowers: WR, BAL/)
    expect(r.text).toMatch(/Yours \(WR1\)/)
    expect(r.text).toMatch(/FantasyPros ROS WR\d+/)
    expect(r.text).toMatch(/w13 BYE/)
    expect(r.text).toMatch(/w15\* /)
    expect(r.actions).toEqual([{ kind: 'openPlayer', id: id('Zay Flowers'), label: 'Open Zay Flowers' }])
  })

  it('compare_players: who has the softer playoff schedule, week by week', async () => {
    const r = await run('compare_players', { players: ['Zay Flowers', 'Jameson Williams'], span: 'playoffs' })
    expect(r.text).toMatch(/^Span: playoffs, weeks 15–17 \(fantasy playoffs\)\. Weekly line: .*#1 = gives up the most, softest/)
    expect(r.text).toMatch(/Schedules: about even \(Zay Flowers −\d+%, Jameson Williams −\d+% pts allowed vs average\)\./)
    expect(r.text).toMatch(/Higher expectation over the span: Zay Flowers \(\+10\.1 pts over 3 weeks\)/)
    const ros = await run('compare_players', { players: ['Zay Flowers', 'Christian McCaffrey'] })
    expect(ros.text).toMatch(/^Span: ros, weeks 11–17/)
    expect((r.text.match(/w1[5-7]\*/g) ?? []).length).toBe(6)
    expect(r.cards![0]).toMatchObject({ kind: 'compare' })
  })

  it('evaluate_trade: both sides, the accept read, and both teams’ playoff odds before and after', async () => {
    const r = await run('evaluate_trade', { give: ['Chuba Hubbard'], get: ['Puka Nacua'] })
    expect(r.ok).toBe(true)
    expect(r.text).toMatch(/gets Puka Nacua \(WR, [\d.]+\/wk ROS, IR/)
    expect(r.text).toMatch(/Waiver Wolves lineup: −[\d.]+ pts\/wk/)
    expect(r.text).toMatch(/Accept odds: \d+\/100 \((no chance|long shot|possible|likely)\)/)
    expect(r.text).toMatch(/Playoff odds: Waiver Wolves \d+%→\d+% \(−\d+ pts\)/)
    const kinds = r.cards!.map((c) => c.kind)
    expect(kinds).toEqual(['trade', 'odds'])
    const odds = r.cards![1] as Extract<AsgmCard, { kind: 'odds' }>
    expect(odds.rows[0].after).toBeLessThan(odds.rows[0].before!)
    expect(r.actions![0]).toMatchObject({ kind: 'openTrade' })
  })

  it('find_trades: offers for a named target, the ones they would take first', async () => {
    const r = await run('find_trades', { target: "Ja'Marr Chase" })
    expect(r.ok).toBe(true)
    expect(r.text).toMatch(/1\. With Pocket Passers: give .*; get Ja'Marr Chase \(WR\)/)
    for (const c of r.cards!) for (const p of cardIds(c)) expect(lg.data.players[p]).toBeTruthy()
    const wr = await run('find_trades', { position: 'WR' })
    expect(wr.text).toMatch(/get .*\(WR\)/)
  })

  it('waivers and faab_bid: the plan, and a bid that respects the budget it is given', async () => {
    const w = await run('waivers')
    expect(w.text).toMatch(/^FAAB: you have \$164 of \$200/)
    expect(w.text).toMatch(/Week 11 streams:/)
    const b = await run('faab_bid', { player: 'Jaylen Waddle', budget: 34 })
    expect(b.ok).toBe(true)
    expect(b.text).toMatch(/you have \$34 of \$200/)
    const bid = Number(/Bid: \$(\d+)/.exec(b.text)![1])
    expect(bid).toBeGreaterThanOrEqual(1)
    expect(bid).toBeLessThanOrEqual(34)
    const def = await run('waivers', { position: 'DEF' })
    expect(def.text).toMatch(/Top free-agent DEFs this week:/)
  })

  it('playoff_odds: the table, this week’s stakes, and a what-if', async () => {
    const r = await run('playoff_odds')
    expect(r.text).toMatch(/Waiver Wolves \(you\) \| 5-5 \| [\d.]+ \| 64% /)
    expect(r.text).toMatch(/This week \(11\) vs Pocket Passers: \d+% to win\. Win → playoffs \d+%.*loss → playoffs \d+%/)
    const out = await run('playoff_odds', { win_out: true })
    expect(out.text).toMatch(/Assuming: Waiver Wolves wins out/)
    expect(out.text).toMatch(/Waiver Wolves \(you\) \| 5-5 \| 9 \| >99% \(was 64%\)/)
    const lose = await run('playoff_odds', { what_if: [{ week: 11, loser: 'me' }] })
    expect(lose.text).toMatch(/w11 Pocket Passers beats Waiver Wolves/)
    expect((await run('playoff_odds', { what_if: [{ week: 16, winner: 'me' }] })).text).toMatch(/no regular-season game left in week 16/)
  })

  it('matchup, standings, team, trade_values and rankings', async () => {
    const m = await run('matchup')
    expect(m.text).toMatch(/^Week 11: Waiver Wolves 117\.3 vs Pocket Passers 109/)
    expect(m.text).toMatch(/Pocket Passers has a hole: Los Angeles Rams/)
    const s = await run('standings')
    expect(s.text.split('\n')).toHaveLength(11)
    const t = await run('team', { team: 'Fourth & Long' })
    expect(t.text).toMatch(/^Fourth & Long: 2-8/)
    expect(t.text).toMatch(/Biggest need: /)
    const v = await run('trade_values', { position: 'WR' })
    expect(v.text).toMatch(/Call: sell /)
    expect(v.text).not.toMatch(/Call: sell A\.J\. Brown/)
    const buy = await run('trade_values', { team: 'league', position: 'RB' })
    expect(buy.text).toMatch(/Call: target /)
    const te = await run('rankings', { position: 'TE', pool: 'available', week: 12 })
    expect(te.text).toMatch(/^TE by week 12 projection, available:/)
    expect(te.text).not.toMatch(/yours|Waiver Wolves/)
  })
})

describe('assistant tools: thin data', () => {
  it('says what is missing, never throws, when the weeks ahead have no projections', async () => {
    const d = fixtureData()
    d.horizon = []
    d.rawHorizon = []
    d.projections = null
    d.projectionWeek = null
    d.projectionsByWeek = {}
    d.horizonSource = 'none'
    const thin = buildAsgmLeague(d)
    expect(thin.models.forecast).toBeNull()
    const args: Record<string, Record<string, unknown>> = {
      start_sit: { players: ['Chuba Hubbard', 'Cam Skattebo'] },
      player: { player: 'Chuba Hubbard' },
      compare_players: { players: ['Chuba Hubbard', 'Cam Skattebo'] },
      news: { players: ['Chuba Hubbard'] },
      evaluate_trade: { give: ['Chuba Hubbard'], get: ['Puka Nacua'] },
      faab_bid: { player: 'Jaylen Waddle' },
      rankings: { position: 'RB' },
    }
    for (const t of TOOLS) {
      if (t.name === 'news') continue
      const r = await runTool(t.name, args[t.name] ?? {}, thin)
      expect(typeof r.text).toBe('string')
      if (!r.ok) expect(r.text).toMatch(/^Error: (the app has no projections|no projections for week|no season simulation|no RB with a projection)/)
    }
    expect(leagueBrief(thin)).toMatch(/no projections for the weeks ahead are loaded/)
  }, 60_000)

  it('asks which team when the manager has none in the league', async () => {
    const browsing = { ...fixtureLeague(), myRosterId: null }
    expect((await runTool('waivers', {}, browsing)).text).toMatch(/no team of yours/)
    expect((await runTool('lineup', { team: 'Fourth & Long' }, browsing)).ok).toBe(true)
    expect(leagueBrief(browsing)).toMatch(/has no team in this league/)
  })
})
