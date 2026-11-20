// The Assistant GM's question battery: realistic and niche questions against the fixture league
// (lib/__tests__/fixtures/asgm-league.json.gz, week 11 of 2026, asking as Waiver Wolves). Used by
// scripts/asgm-eval.mjs (a live model, with a key) and scripts/asgm-payloads.test.ts (what the model would be sent).
import type { AsgmContext } from '../lib/assistant/types'

export type EvalQuestion = {
  id: string
  q: string
  context?: AsgmContext
  /** What a good answer must do, for whoever reads the run. */
  expect: string
  /** In the payload dump. */
  dump?: boolean
  /** What the first payload must already hold for a good answer without another tool call (checked in the tests). For
   * a question the app answers itself (`route: 'quick'`), what that answer must say. */
  needs?: RegExp[]
  /** 'quick': a plain lookup the app answers from its own data, no model. 'model' (default): the model answers. */
  route?: 'quick' | 'model'
  /** Tools the app must pre-run for it (checked in the tests). */
  pre?: string[]
}

const tradeFocus: AsgmContext = {
  view: 'trades/builder',
  label: 'Trade builder',
  focus: {
    kind: 'trade',
    label: 'Cam Skattebo for Puka Nacua',
    deal: { teams: [2, 4], moves: [{ player: '12481', from: 2, to: 4 }, { player: '9493', from: 4, to: 2 }], faab: [] },
  },
}

export const QUESTIONS: EvalQuestion[] = [
  { id: 'start', q: 'Who should I start this week?', context: { view: 'me/lineup', label: 'My lineup' }, expect: 'Says the set lineup is already optimal (no changes), names the closest call (Jameson Williams over Deebo Samuel) with its odds.', dump: true, needs: [/Changes: none.*Call for Waiver Wolves \(you\): lineup is set, no changes/, /Answer with the app's verdict first/, /Close calls: Jameson Williams over Deebo Samuel Sr\. by 3\.1 \(Deebo Samuel Sr\. outscores him \d+%/] },
  { id: 'bench-rb2', q: 'Should I bench my RB2 against the Ravens?', expect: 'Resolves RB2 = Chuba Hubbard (vs BAL); keeps him in (14.4 proj, FLEX), notes BAL is a tough RB matchup (#25) but no bench RB is close (Monangai 8.0).', dump: true, needs: [/\*RB2 Chuba Hubbard \(CAR\)/, /Chuba Hubbard \(RB CAR\) · proj 14\.4 .*vs BAL \(#\d+\/32 pts allowed to RB/, /Kyle Monangai \(RB CHI\) · proj 8/] },
  { id: 'flex', q: 'Hubbard or Skattebo at flex this week?', expect: 'Start both is possible (they are RB2/RB3 with FLEX); if forced, near coin flip (52%), Skattebo +0.8 proj; flags Skattebo big week sell-high and tough JAX matchup.', dump: true, needs: [/Call: start both/, /outscores Chuba Hubbard \d+% of the time/] },
  { id: 'softer-po', q: 'Who has the softer playoff schedule, Zay Flowers or Jameson Williams?', expect: 'Compares weeks 15–17 opponents with defense ranks; names the softer one and the expectation edge.', dump: true, needs: [/w15\* @PIT #\d+/, /w15\* @MIN #\d+/, /Schedules: about even|Softer schedule:/, /Higher expectation over the span: Zay Flowers/] },
  { id: 'sell-high-wr', q: 'Which of my WRs is the sell-high?', expect: 'Names one WR with the room-vs-model gap and form (from trade_values); not an injured player as a real sale unless flagged.', dump: true, needs: [/Call: sell \w+/, /sell-high: big week/] },
  { id: 'faab-34', q: 'How much FAAB should I spend on Jaylen Waddle with $34 left?', expect: 'Gives one dollar figure from faab_bid with the league range and why; notes the share of the $34.', dump: true, needs: [/you have \$34 of \$200/, /Bid: \$\d+/, /League price for this value: \$\d+–\d+/] },
  { id: 'pickup', q: 'Who should I pick up this week?', context: { view: 'waivers', label: 'Waivers' }, expect: 'Says no lineup upgrade on the wire; the kicker stream (Cairo Santos +1.0) is the only move; mentions stashes briefly.', dump: true, needs: [/No free agent upgrades your lineup/, /K: Cairo Santos exp/] },
  { id: 'odds', q: 'What are my playoff odds?', expect: '64% playoffs, 8% title; this week vs Pocket Passers: win → 79%, loss → 45%.', dump: true, needs: [/Waiver Wolves \(you\) \| 5-5 \| [\d.]+ \| 64%/, /Win → playoffs \d+%.*loss → playoffs \d+%/] },
  { id: 'win-out', q: 'What if I win out?', expect: '>99% playoffs, bye 40%, title 16%.' },
  { id: 'lose-week', q: 'How bad is it if I lose this week?', expect: 'Playoffs drop to 45% with a loss vs 79% with a win.' },
  { id: 'eval-named', q: 'Would Fourth & Long take Chuba Hubbard for Puka Nacua?', expect: 'Decline/no: you lose lineup points, accept odds and the playoff-odds drop with numbers.', dump: true, needs: [/^Call for Waiver Wolves \(you\): don't make this trade\. It costs Waiver Wolves −4\.2 pts\/wk/m, /Answer with the app's verdict first/, /Waiver Wolves lineup: −4\.2 pts\/wk/, /Accept odds: \d+\/100/, /Playoff odds: Waiver Wolves 64%→\d+%/, /IR \(Knee/] },
  { id: 'trade-focus', q: 'Is this trade good for me?', context: tradeFocus, expect: 'Prices the on-screen deal: lineup delta, accept odds, playoff odds change; a clear call.', dump: true, needs: [/sends Cam Skattebo/, /Accept odds: \d+\/100/, /Playoff odds: Waiver Wolves 64%→\d+%/] },
  { id: 'wr-upgrade', q: 'Find me a WR upgrade', context: { view: 'trades', label: 'Trades' }, expect: 'Names the best offer from find_trades with gain and accept odds; mentions the trade deadline status.' },
  { id: 'get-chase', q: "What would it take to get Ja'Marr Chase?", expect: 'Builds offers to Pocket Passers; best package with accept odds, or says none reads fair.', dump: true, needs: [/1\. With Pocket Passers: give .* get Ja'Marr Chase/, /Accept \d+\/100/] },
  { id: 'win-week', q: 'Can I win this week?', expect: '60% to win vs Pocket Passers, 117.3 vs 109 projected; notes their DEF on bye and two questionable starters.', dump: true, needs: [/Waiver Wolves 117\.3 vs Pocket Passers 109/, /wins \d+%/, /Pocket Passers has a hole: Los Angeles Rams/, /Questionable/] },
  { id: 'best-team', q: "Who's the best team in the league?", expect: 'Uses power ranks and odds: Red Zone Rebels power #1, Flex Capacitors best odds (99%); a call with the split explained.' },
  { id: 'needs', q: 'What does my team need most?', expect: 'WR (league-average starter adds +2.5 pts/wk); names the weak WR slots.' },
  { id: 'te-available', q: 'Best TE available for week 12?', expect: 'Ranks free-agent TEs by week 12 projection with matchups.' },
  { id: 'must-start', q: 'Is Jayden Daniels a must-start against Cincinnati?', expect: 'Yes, QB1, no QB on the bench; 21.3 proj, range, CIN neutral (#14).' },
  { id: 'drop', q: 'Should I drop Kyle Monangai?', expect: 'He is first in the drop order but only matters if there is a pickup worth his spot; says what the wire offers.' },
  { id: 'buy-low-rb', q: 'Who is a buy-low RB I could target?', expect: 'League-wide trade_values at RB: names one or two with gaps and owners.' },
  { id: 'news', q: "What's the latest on A.J. Brown?", expect: 'Out (hamstring), on bye this week; if the news feed is unreachable, says so plainly.' },
  { id: 'stream-def', q: 'Which defense should I stream this week?', expect: 'No DEF stream beats the Bears by enough (or names one if it does) with projection and opponent.' },
  { id: 'rb-ros', q: 'Top 10 RBs rest of season?', expect: 'A ranked list from rankings (ros), owners noted.' },
  { id: 'threat', q: "Who's the biggest threat to me in the playoffs?", expect: 'Names the team with the best title odds/power from playoff_odds and standings, with numbers.' },
  { id: 'off-data', q: "What's Patrick Mahomes' completion percentage this season?", expect: 'Says the app does not track completion percentage; offers what it has (projection, ppg).' },
  { id: 'off-topic', q: 'Write me a poem about the stock market.', expect: 'Declines in one line and steers back to the league.', route: 'model', pre: [] },

  // ---- League-wide: any team, any player, however it is typed ----
  { id: 'owner-puka', q: 'what team has Puka', expect: 'Fourth & Long has Puka Nacua (their WR3, IR, on bye). Instant, no model.', route: 'quick', needs: [/^Fourth & Long has Puka Nacua \(WR, LAR\), their WR\d/, /IR \(Knee/] },
  { id: 'owner-lower', q: 'who has puka nacua', expect: 'Fourth & Long.', route: 'quick', needs: [/^Fourth & Long has Puka Nacua/] },
  { id: 'owner-jsn', q: 'is JSN available?', expect: 'No: Flex Capacitors has Jaxon Smith-Njigba.', route: 'quick', needs: [/^Flex Capacitors has Jaxon Smith-Njigba/] },
  { id: 'owner-arsb', q: 'Who owns ARSB?', expect: 'Hail Marys has Amon-Ra St. Brown.', route: 'quick', needs: [/^Hail Marys has Amon-Ra St\. Brown/] },
  { id: 'owner-jjeff', q: 'who has jjeff', expect: 'Bye Week Bandits has Justin Jefferson.', route: 'quick', needs: [/^Bye Week Bandits has Justin Jefferson/] },
  { id: 'owner-typo', q: 'who has jaylen waddel', expect: 'Nobody: Jaylen Waddle is a free agent.', route: 'quick', needs: [/^Nobody: Jaylen Waddle .* is a free agent/] },
  { id: 'owner-two', q: 'Who has Kittle and Bijan?', expect: 'One line per player with the owner.', route: 'quick', needs: [/George Kittle/, /Bijan Robinson/] },
  { id: 'qb-other', q: "who's starting at QB for Pocket Passers", expect: 'Pocket Passers starts Dak Prescott (20.8 proj).', route: 'quick', needs: [/^Pocket Passers starts Dak Prescott 20\.8/] },
  { id: 'lineup-other', q: 'pocket passers lineup', expect: 'Their set lineup slot by slot with projections; best lineup would add +16.9.', route: 'quick', needs: [/^Pocket Passers' week 11 lineup as set, 92\.1 projected/, /TE Tucker Kraft 0 \(BYE\)/, /\+16\.9/] },
  { id: 'record-other', q: "what's fourth & long's record", expect: '2-8, 9th of 10, PF/PA, power, odds.', route: 'quick', needs: [/^Fourth & Long is 2-8, 9th of 10 \(PF 819\.1, PA 1101\.2\)/] },
  { id: 'record-mine', q: "what's my record?", expect: "You're 5-5, 6th of 10.", route: 'quick', needs: [/^You're 5-5, 6th of 10/] },
  { id: 'opp-other', q: 'who does fourth and long play this week', expect: 'Flex Capacitors in week 11, with projections and win odds.', route: 'quick', needs: [/^Fourth & Long plays Flex Capacitors in week 11\. Best lineups project 88\.3 to 100\.8; Fourth & Long wins \d+%/] },
  { id: 'opp-manager', q: 'who is manager 6 playing in week 12', expect: 'Fourth & Long (Manager 6) plays you in week 12.', route: 'quick', needs: [/^Fourth & Long plays Waiver Wolves \(you\) in week 12/] },
  { id: 'proj', q: "what's Jayden Daniels projected this week", expect: '21.3 vs CIN with range.', route: 'quick', needs: [/^Jayden Daniels projects 21\.3 in week 11, vs CIN/] },
  { id: 'roster-other', q: 'what RBs do the capacitors have', expect: "Flex Capacitors' RBs with pts/wk.", route: 'quick', needs: [/^Flex Capacitors' roster at RB/, /Derrick Henry/] },
  { id: 'standings', q: 'standings', expect: 'The table, top to bottom.', route: 'quick', needs: [/^Standings after week 10:\n1\. Flex Capacitors 7-3/] },
  { id: 'compare-rb', q: "compare my RB2 to Fourth & Long's RB1", expect: "Chuba Hubbard vs Saquon Barkley rest of season, with a call.", route: 'model', pre: ['compare_players'], needs: [/\[compare_players\]/, /Chuba Hubbard \(RB CAR, yours\) .* schedule (softer|tougher) than average/, /Saquon Barkley/] },
  { id: 'wr-need', q: 'which team needs a WR most', expect: 'Two-Point Tries and Fourth & Long (+4.4 each); names their WR starters.', route: 'model', pre: ['league_needs'], needs: [/1\. Two-Point Tries \+4\.4/, /2\. Fourth & Long \+4\.4/] },
  { id: 'trades', q: 'what trades have happened in the league?', expect: 'One trade: Blitz Brigade got Javonte Williams, Two-Point Tries got Chris Olave (week 8).', route: 'model', pre: ['transactions'], needs: [/w8 trade: Blitz Brigade gets Javonte Williams; Two-Point Tries gets Chris Olave/] },
  { id: 'leaders', q: 'who leads the league in WR points', expect: 'Jaxon Smith-Njigba, 223.7 (Flex Capacitors).', route: 'model', pre: ['rankings'], needs: [/1\. Jaxon Smith-Njigba \(WR SEA, Flex Capacitors\) 223\.7/] },
  { id: 'h2h', q: "what's my head-to-head with Fourth & Long", expect: '1-0 this season (w3), they meet again week 12.', route: 'model', pre: ['schedule'], needs: [/Head-to-head with Fourth & Long: this season 1-0 \(w3 W 107\.3–80\.9\); they meet again week 12/] },
  { id: 'other-bench', q: 'Should Pocket Passers bench Mike Washington?', expect: 'Yes: their best lineup starts David Montgomery over him (+8.2).', route: 'model', pre: ['lineup'], needs: [/start David Montgomery over Mike Washington Jr\. at RB \(\+8\.2\)/] },
  { id: 'other-needs', q: 'What does Hail Marys need?', expect: 'RB (biggest need), with the slot gaps.', route: 'model', pre: ['team'], needs: [/Hail Marys: 6-4/, /Biggest need: RB/] },
  { id: 'other-last', q: 'How did Fourth & Long do last week?', expect: 'Lost 79.3–129 to Hail Marys in week 10.', route: 'model', pre: ['schedule'], needs: [/w10 L 79\.3–129 vs Hail Marys/] },
  { id: 'owner-judge', q: 'Who has Puka and should I trade for him?', expect: 'Fourth & Long has him; IR, so not a buy unless cheap; offers from find_trades.', route: 'model', pre: ['player', 'find_trades'], needs: [/On Fourth & Long/] },
  { id: 'start-two', q: 'Who should I start, Flowers or Puka?', expect: 'Flowers: Puka is on bye and on IR.', route: 'model', pre: ['start_sit'], needs: [/Zay Flowers \(WR BAL\) · proj 12\.\d/, /Puka Nacua \(WR LAR\) · proj 0/] },
]
