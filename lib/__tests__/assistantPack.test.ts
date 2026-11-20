import { describe, expect, it } from 'vitest'
import { firstPayload, trimHistory } from '../assistant/loop'
import { leagueBrief, PACK_LIMIT, packText, planPreRuns, playersIn, readQuestion } from '../assistant/pack'
import { suggestions } from '../assistant/suggest'
import { findPlayers, findTeams, namesShared } from '../assistant/find'
import { quickAnswer, withoutTeams } from '../assistant/quick'
import type { AsgmLeague } from '../assistant/league'
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

  it('finds players however they are typed: first names, nicknames, initials, initial + surname, typos, lower case', () => {
    const one = (q: string) => names(playersIn(lg, q))
    expect(one('what team has Puka')).toEqual(['Puka Nacua'])
    expect(one('who has puka')).toEqual(['Puka Nacua'])
    expect(one("Puka's owner?")).toEqual(['Puka Nacua'])
    expect(one('is JSN rostered')).toEqual(['Jaxon Smith-Njigba'])
    expect(one('who has ARSB')).toEqual(['Amon-Ra St. Brown'])
    expect(one('who has CMC')).toEqual(['Christian McCaffrey'])
    expect(one('jjeff owner')).toEqual(['Justin Jefferson'])
    expect(one('who owns nacau')).toEqual(['Puka Nacua'])
    expect(one('who has jaylen waddel')).toEqual(['Jaylen Waddle'])
    expect(one('hubbard or skattebo')).toEqual(['Chuba Hubbard', 'Cam Skattebo'])
    expect(one("compare my RB2 to Fourth & Long's RB1")).toEqual(['Chuba Hubbard', 'Saquon Barkley'])
    // Ambiguous or everyday words are nobody.
    expect(one('is jalen available')).toEqual([])
    expect(one('Write me a poem about the stock market.')).toEqual([])
    expect(one('who has brown')).toEqual([])
  })

  it('finds teams by name, manager, a distinctive word, lower case and "and" for "&"', () => {
    const t = (q: string) => findTeams(lg, q).map((r) => lg.analysis.teamById[r].name)
    expect(t("whats fourth & long's record")).toEqual(['Fourth & Long'])
    expect(t('who does fourth and long play')).toEqual(['Fourth & Long'])
    expect(t('who is manager 6 playing')).toEqual(['Fourth & Long'])
    expect(t('capacitors lineup')).toEqual(['Flex Capacitors'])
    expect(t('the pocket passers qb')).toEqual(['Pocket Passers'])
    expect(t('a long week')).toEqual([])
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

  it('pre-runs the right tool for questions about any team', () => {
    expect(plan('which team needs a WR most')).toEqual(['league_needs({"position":"WR"})'])
    expect(plan('Should Pocket Passers bench Mike Washington?')).toEqual(['lineup({"team":"Pocket Passers"})'])
    expect(plan("what's my head-to-head with Fourth & Long")).toEqual(['schedule({"team":"me","vs":"Fourth & Long"})'])
    expect(plan('who leads the league in WR points')).toEqual(['rankings({"position":"WR","basis":"season","pool":"all"})'])
    expect(plan('what trades have happened in the league?')[0]).toBe('transactions({"type":"trade"})')
    expect(plan('What does Hail Marys need?')).toEqual(['team({"team":"Hail Marys"})'])
    expect(plan('Who has Puka and should I trade for him?')).toEqual(['player({"player":"Puka Nacua"})', 'find_trades({"target":"Puka Nacua"})'])
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
      // Plain lookups are answered by the app itself, with every fact they need; nothing else is.
      if (q.route === 'quick') {
        expect(p.quick, `${q.id} is a plain lookup`).toBeTruthy()
        for (const re of q.needs ?? []) expect(p.quick!.text, `${q.id} says ${re}`).toMatch(re)
        continue
      }
      expect(p.quick, `${q.id} needs the model`).toBeNull()
      const ran = p.plan.map((x) => x.tool)
      for (const t of q.pre ?? []) expect(ran, `${q.id} pre-runs ${t}`).toContain(t)
      if (q.pre && !q.pre.length) expect(ran).toEqual([])
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

/** The fixture with one manager renamed (and that manager's username), for names that collide with words and players. */
const renamed = (owner: string, username = owner): AsgmLeague => {
  const t4 = lg.analysis.teamById[4]
  const teams = lg.analysis.teams.map((t) => (t.rosterId === 4 ? { ...t, owner } : t))
  return {
    ...lg,
    memo: new Map(),
    analysis: { ...lg.analysis, teams, teamById: { ...lg.analysis.teamById, 4: { ...t4, owner } } },
    data: { ...lg.data, users: lg.data.users.map((u) => (u.user_id === t4.userId ? { ...u, display_name: owner, username } : u)) },
  }
}

describe('instant lookups answer only pure lookups', () => {
  const q = (text: string, league: AsgmLeague = lg) => quickAnswer(league, text)

  it('leaves judgment, lineup, past-tense, head-to-head and ambiguous questions to the model', () => {
    const model = [
      // A lineup sense, not "who do I play".
      'who do I start against the Ravens',
      'who do I play at flex',
      'who should I start at QB',
      'should I start Puka',
      "who's on my bench",
      'who does Fourth & Long start at flex if Puka is out',
      // Past tense: a result, not this week's game.
      'who did I play last week',
      'who did Fourth & Long play last week',
      'what was Fourth & Long\'s record last season',
      'how many points did Puka score last week',
      'who did Hail Marys pick up',
      'who scored the most last week',
      // Two sides at once.
      "what's my record against Fourth & Long",
      'head to head with Fourth & Long',
      'is Fourth & Long my opponent this week',
      "my RB2 vs Fourth & Long's RB1",
      'compare Fourth & Long and Hail Marys',
      // Judgment and more than one ask.
      'who has Puka and should I trade for him',
      'is Puka better than Zay Flowers',
      "what's Puka worth",
      "Puka's outlook rest of season",
      'who do I play next week and can I win',
      'who are my opponents in the playoffs',
      'Who should I pick up?',
      // League-wide rankings and needs: the model reads the tool.
      'who has the most points at RB',
      'which team needs a WR most',
      'who has the easiest schedule',
      'who has the best odds to win the league',
      'what trades has Fourth & Long made',
      // A name several players share, or that is also a first name.
      'who has robinson',
      'who has Daniels',
      'Who has Chase',
      'which teams have a Robinson',
      // A player only in passing.
      'who does Puka play this week?',
    ]
    for (const text of model) expect(q(text), text).toBeNull()
  })

  it('answers the plain ones', () => {
    const quick: [string, RegExp][] = [
      ['what team has Puka', /^Fourth & Long has Puka Nacua/],
      ['whose team is Puka on', /^Fourth & Long has Puka Nacua/],
      ['who has jamarr chase', /^Pocket Passers has Ja'Marr Chase/],
      ['who am i playing', /^You play Pocket Passers in week 11/],
      ['who will Fourth & Long play', /^Fourth & Long plays Flex Capacitors in week 11/],
      ['who are the Hail Marys playing', /^Hail Marys plays Bye Week Bandits in week 11/],
      ["who's starting for Fourth & Long at RB", /^Fourth & Long starts .* at RB in week 11/],
      ['is Hail Marys in first place', /^Hail Marys is 6-4, 5th of 10/],
      ['what are the standings', /^Standings after week 10:/],
    ]
    for (const [text, re] of quick) expect(q(text)?.text, text).toMatch(re)
  })

  it('never lets a manager or team name eat part of a word', () => {
    // A manager called "Sho" must not turn "should" into "TEAMuld" and slip past the judgment check.
    const sho = renamed('Sho', 'odd')
    expect(withoutTeams(sho, 'should I trade for Puka? odds?')).toBe('should I trade for Puka? odds?')
    expect(withoutTeams(sho, 'what is Sho record')).toBe('what is  TEAM  record')
    expect(q('should I start Puka', sho)).toBeNull()
  })

  it('reads a manager named like a word or a player as neither', () => {
    // Managers "Chase" and "Will": "Ja'Marr Chase" stays the player, "will Puka play" names no team.
    const chase = renamed('Chase', 'will')
    expect(findPlayers(chase, "who has Ja'Marr Chase").map((id) => lg.data.players[id].name)).toEqual(["Ja'Marr Chase"])
    expect(findTeams(chase, "who has Ja'Marr Chase")).toEqual([])
    expect(findTeams(chase, 'will Puka play')).toEqual([])
    expect(findPlayers(chase, 'will Puka play').map((id) => lg.data.players[id].name)).toEqual(['Puka Nacua'])
    // A distinctive manager name still finds the team.
    expect(findTeams(renamed('Zorblax'), 'who is zorblax playing')).toEqual([4])
  })

  it('flags a surname several players share, and guesses only for the model', () => {
    expect(namesShared(lg, 'who has robinson')).toBe(true)
    expect(namesShared(lg, 'who has bijan robinson')).toBe(false)
    // Two rostered Robinsons: no guess at all.
    expect(findPlayers(lg, 'who has robinson')).toEqual([])
    // The asker's own player wins a shared surname for the tools (Jayden Daniels is yours), never for an instant answer.
    expect(findPlayers(lg, 'should I start Daniels').map((id) => lg.data.players[id].name)).toEqual(['Jayden Daniels'])
    expect(q('what is Daniels projected')).toBeNull()
    expect(q('what is Jayden Daniels projected')?.text).toMatch(/^Jayden Daniels projects/)
  })

  it('tells the model to lead with a verdict only when the verdict is the asker\'s', () => {
    const hint = /Answer with the app's verdict first/
    expect(packText('brief', [{ label: 'x', tool: 'lineup', text: 'Changes: none, the lineup as set is the best one. Call for Pocket Passers: lineup is set, no changes.' }])).not.toMatch(hint)
    expect(packText('brief', [{ label: 'x', tool: 'lineup', text: 'Changes: none, the lineup as set is the best one. Call for Waiver Wolves (you): lineup is set, no changes.' }])).toMatch(hint)
    expect(packText('brief', [{ label: 'x', tool: 'evaluate_trade', text: "Call for Pocket Passers: don't make this trade." }])).not.toMatch(hint)
  })
})
