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
  /** What the first payload must already hold for a good answer without another tool call (checked in the tests). */
  needs?: RegExp[]
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
  { id: 'start', q: 'Who should I start this week?', context: { view: 'me/lineup', label: 'My lineup' }, expect: 'Says the set lineup is already optimal (no changes), names the closest call (Jameson Williams over Deebo Samuel) with its odds.', dump: true, needs: [/Changes: none/, /Close calls: Jameson Williams over Deebo Samuel Sr\. by 3\.1 \(Deebo Samuel Sr\. outscores him \d+%/] },
  { id: 'bench-rb2', q: 'Should I bench my RB2 against the Ravens?', expect: 'Resolves RB2 = Chuba Hubbard (vs BAL); keeps him in (14.4 proj, FLEX), notes BAL is a tough RB matchup (#25) but no bench RB is close (Monangai 8.0).', dump: true, needs: [/\*RB2 Chuba Hubbard \(CAR\)/, /Chuba Hubbard \(RB CAR\) · proj 14\.4 .*vs BAL \(#\d+\/32 pts allowed to RB/, /Kyle Monangai \(RB CHI\) · proj 8/] },
  { id: 'flex', q: 'Hubbard or Skattebo at flex this week?', expect: 'Start both is possible (they are RB2/RB3 with FLEX); if forced, near coin flip (52%), Skattebo +0.8 proj; flags Skattebo big week sell-high and tough JAX matchup.', dump: true, needs: [/Call: start both/, /outscores Chuba Hubbard \d+% of the time/] },
  { id: 'softer-po', q: 'Who has the softer playoff schedule, Zay Flowers or Jameson Williams?', expect: 'Compares weeks 15–17 opponents with defense ranks; names the softer one and the expectation edge.', dump: true, needs: [/w15\* @PIT #\d+/, /w15\* @MIN #\d+/, /Schedules: about even|Softer schedule:/, /Higher expectation over the span: Zay Flowers/] },
  { id: 'sell-high-wr', q: 'Which of my WRs is the sell-high?', expect: 'Names one WR with the room-vs-model gap and form (from trade_values); not an injured player as a real sale unless flagged.', dump: true, needs: [/Call: sell \w+/, /sell-high: big week/] },
  { id: 'faab-34', q: 'How much FAAB should I spend on Jaylen Waddle with $34 left?', expect: 'Gives one dollar figure from faab_bid with the league range and why; notes the share of the $34.', dump: true, needs: [/you have \$34 of \$200/, /Bid: \$\d+/, /League price for this value: \$\d+–\d+/] },
  { id: 'pickup', q: 'Who should I pick up this week?', context: { view: 'waivers', label: 'Waivers' }, expect: 'Says no lineup upgrade on the wire; the kicker stream (Cairo Santos +1.0) is the only move; mentions stashes briefly.', dump: true, needs: [/No free agent upgrades your lineup/, /K: Cairo Santos exp/] },
  { id: 'odds', q: 'What are my playoff odds?', expect: '64% playoffs, 8% title; this week vs Pocket Passers: win → 79%, loss → 45%.', dump: true, needs: [/Waiver Wolves \(you\) \| 5-5 \| [\d.]+ \| 64%/, /Win → playoffs \d+%.*loss → playoffs \d+%/] },
  { id: 'win-out', q: 'What if I win out?', expect: '>99% playoffs, bye 40%, title 16%.' },
  { id: 'lose-week', q: 'How bad is it if I lose this week?', expect: 'Playoffs drop to 45% with a loss vs 79% with a win.' },
  { id: 'eval-named', q: 'Would Fourth & Long take Chuba Hubbard for Puka Nacua?', expect: 'Decline/no: you lose lineup points, accept odds and the playoff-odds drop with numbers.', dump: true, needs: [/Waiver Wolves lineup: −4\.2 pts\/wk/, /Accept odds: \d+\/100/, /Playoff odds: Waiver Wolves 64%→\d+%/, /IR \(Knee/] },
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
  { id: 'off-topic', q: 'Write me a poem about the stock market.', expect: 'Declines in one line and steers back to the league.' },
]
