// What each page tells Assistant GM about where the reader is, from the route alone. Sheets and the trade builder
// publish their own, more specific context over it while they are open (SheetHost, TradeDock).
import type { AsgmContext } from '../../lib/assistant'
import type { Analysis } from '../../lib/analysis'

const SECTION: Record<string, string> = {
  dash: 'Dashboard',
  slate: 'Gameday',
  trades: 'Trades',
  me: 'My team',
  waivers: 'Waivers',
  matchups: 'Matchups',
  power: 'Power Rank',
  playoffs: 'Playoffs',
  teams: 'Teams',
  players: 'Players',
  monke: 'M.O.N.K.E.',
  model: 'Tuning',
}

const SUB: Record<string, string> = {
  week: 'Your week',
  games: 'Games',
  managers: 'Every manager',
  suggested: 'Suggested trades',
  compare: 'Compare trades',
  targets: 'Trade targets',
  needs: 'League needs',
  injuries: 'Injuries & roles',
  overview: 'Overview',
  roster: 'Roster',
  moves: 'Recommended moves',
  adds: 'Recommended moves',
  available: 'Free agents',
  stream: 'Streamers',
  rankings: 'Rankings',
  standings: 'Standings',
  schedule: 'Remaining schedule',
  race: 'The race',
  whatif: 'What if',
  season: 'Play a season',
  seeds: 'Every seed',
  ahead: 'Rest of season',
  todate: 'Season to date',
}

/** The page's context: its name (and tab), and what it is about where that is one thing (your lineup, a team). */
export const sectionContext = (section: string, sub: string | null, analysis: Analysis | null, week: number | null): AsgmContext | null => {
  if (section === 'gm' || !SECTION[section]) return null
  const view = sub ? `${section}/${sub}` : section
  const me = analysis?.myRosterId ?? null
  if (section === 'teams' && sub && /^\d+$/.test(sub) && analysis) {
    const t = analysis.teamById[Number(sub)]
    if (t) return { view, label: t.rosterId === me ? 'Your team' : t.name, focus: { kind: 'team', rosterId: t.rosterId, label: t.name } }
  }
  const label = sub && SUB[sub] ? `${SECTION[section]} › ${SUB[sub]}` : SECTION[section]
  if (section === 'me' && me != null && week != null) return { view, label: `Your lineup, wk ${week}`, focus: { kind: 'lineup', rosterId: me, week, label: `Week ${week} lineup` } }
  if (section === 'waivers' && me != null) return { view, label, focus: { kind: 'waivers', rosterId: me, label: 'Your waiver moves' } }
  return { view, label }
}
