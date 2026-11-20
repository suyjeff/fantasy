// What the assistant reads: the league as loaded, the core analysis and the models built on it. The page already
// has all three (components/FantasyContext); a caller holding only the raw league gets the rest built here.
import { analyze, type Analysis } from '../analysis'
import { buildModels, type Models } from '../models'
import { DEFAULT_POWER_WEIGHTS } from '../power'
import type { LeagueData } from '../useLeagueData'
import { DEFAULT_MODEL } from '../war'

export type AsgmLeague = {
  data: LeagueData
  analysis: Analysis
  models: Models
  /** The asking manager's roster, or null for a league they are only browsing. */
  myRosterId: number | null
  /** Per-league memo for expensive tool work (simulations, trade searches), keyed by the tool. */
  memo: Map<string, unknown>
}

export type AsgmLeagueInput = LeagueData | { data: LeagueData; analysis?: Analysis | null; models?: Models | null }

const isData = (x: AsgmLeagueInput): x is LeagueData => 'league' in x && 'rosters' in x && !('data' in x)

/** The assistant's view of a league. Pass the page's own analysis and models when there are some, so nothing is rebuilt. */
export const buildAsgmLeague = (input: AsgmLeagueInput, myRosterId: number | null = null): AsgmLeague => {
  const data = isData(input) ? input : input.data
  const analysis = (!isData(input) && input.analysis) || analyze(data, DEFAULT_MODEL, DEFAULT_POWER_WEIGHTS)
  const models = (!isData(input) && input.models) || buildModels(data, analysis)
  return { data, analysis, models, myRosterId: myRosterId ?? analysis.myRosterId ?? null, memo: new Map() }
}

/** A name for a player id, or the id itself. */
export const nameOf = (lg: AsgmLeague, id: string) => lg.data.players[id]?.name ?? id
/** A team's display name. */
export const teamName = (lg: AsgmLeague, rid: number | null | undefined) => (rid == null ? 'free agent' : (lg.analysis.teamById[rid]?.name ?? `Team ${rid}`))
