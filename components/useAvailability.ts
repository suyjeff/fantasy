import { useCallback, useMemo } from 'react'
import type { Analysis } from '../lib/analysis'
import { availabilityOf, clearDaysOf, waiverClears } from '../lib/availability'
import type { LeagueData } from '../lib/useLeagueData'

/** Each player's standing in this league, waivers included, read once per load of the league's transactions. */
export const useAvailability = (data: LeagueData, analysis: Analysis) => {
  const waivers = useMemo(
    () => waiverClears(data.transactions, analysis.rosteredBy, clearDaysOf(data.league.settings), Date.now()),
    [data.transactions, analysis.rosteredBy, data.league.settings],
  )
  const status = useCallback((id: string) => availabilityOf(id, analysis.rosteredBy, analysis.myRosterId, waivers), [analysis.rosteredBy, analysis.myRosterId, waivers])
  return { waivers, status }
}
