import { useCallback, useEffect, useRef, useState } from 'react'
import type { LeagueData } from '../lib/useLeagueData'
import { appUrl, LEAGUE_ID } from '../workers/grades/src/links'
import { MAX_TRADE_CHARS } from '../workers/grades/src/tradeLink'

/**
 * A shared Power Rank link: `?league=<id>&season=<year>&reveal=<week>`. It is read once on arrival and kept in memory
 * while the visitor gets through onboarding (and the tour), so it survives the name prompt; the address keeps its
 * parameters until the link has been used, so a reload in the middle of that still finds it. Then the league is selected
 * if the visitor is in it, and the week's reveal opens (useReveal). Used up, the parameters come off the address.
 *
 * `reveal=` alone, or `reveal=1`, means the latest week. A week number means that week; week 1 is written `01`.
 * The address itself is written in one place, workers/grades/src/links.ts, which the worker redirects to.
 */
export type DeepLink = {
  league: string | null
  season: string | null
  week: number | 'latest' | null
  /** A shared trade (lib/tradeShare `encodeDeal`), to open in the builder once the league is up. */
  trade?: string | null
  /**
   * Why a trade in the address was turned away (no league to open it in, or longer than any deal a link carries). The
   * link is then not followed at all, but still keeps the reveal shut for the visit, as a trade link would.
   */
  refused?: string
}

const NO_LEAGUE = 'That trade link doesn’t say which league it is from, so it can’t open. Ask whoever sent it for a new one.'
const TOO_LONG = 'That trade link is damaged or longer than any trade, so it can’t open. Ask whoever sent it for a new one.'

/** The link in an address's query string, or null when it carries none. */
export const parseDeepLink = (search: string): DeepLink | null => {
  const q = new URLSearchParams(search)
  const league = q.get('league')
  const reveal = q.get('reveal')
  const trade = q.get('trade')
  if (league == null && reveal == null && trade == null) return null
  let week: DeepLink['week'] = null
  if (reveal != null) {
    // A bare 1 has always meant "the latest"; week 1 is `01`.
    week = reveal === '1' || !/^\d{1,2}$/.test(reveal) ? 'latest' : Number(reveal)
    if (week === 0) week = 'latest'
  }
  const season = q.get('season')
  const okLeague = league && LEAGUE_ID.test(league) ? league : null
  // A trade's roster ids mean something only in its own league: without one it would open against the visitor's.
  if (trade != null) {
    const refused = !okLeague ? NO_LEAGUE : trade.length > MAX_TRADE_CHARS ? TOO_LONG : null
    if (refused) return { league: null, season: null, week: null, refused }
  }
  return { league: okLeague, season: season && /^\d{4}$/.test(season) ? season : null, week, ...(trade ? { trade } : {}) }
}

/** The plain address of a week's reveal in the app, for a link with no preview. */
export const deepLinkUrl = (leagueId: string, week: number, season?: string | null) => appUrl({ leagueId, week, season })

/** Takes the link's parameters off the address, leaving the rest. */
const clearParams = () => {
  const q = new URLSearchParams(window.location.search)
  if (q.get('league') == null && q.get('reveal') == null && q.get('season') == null && q.get('trade') == null) return
  q.delete('league')
  q.delete('reveal')
  q.delete('season')
  q.delete('trade')
  const rest = q.toString()
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${rest ? `?${rest}` : ''}${window.location.hash}`)
}

/** What the visitor is told when the link cannot be followed all the way. */
export type DeepNote = { text: string }

const NOT_IN_TRADE = 'That trade is from a league this account is not in, so it can’t open here. Use “Switch league or user” in the menu to open it as a member.'
const NOT_IN_LEAGUE = 'That link is for a league this account is not in, so this is your own league instead.'

/** How long a requested switch of league (or season) may take before the link gives up on it. */
const SWITCH_MS = 20000

/**
 * `ready` is the link once its league is the one on screen (or it names none): hand it to useReveal, which opens the week
 * and calls `finish`. `note` is a friendly line for a link that could not be followed.
 *
 * The league is found in the visitor's own list of leagues. A link from another season asks the app to look at that
 * season; if the visitor has no such league there, it goes back to where they were and opens the same week in their own
 * league, with a note, rather than saying they are not in a league they may well be in.
 */
export const useDeepLink = ({
  onboarded,
  data,
  loading,
  selectLeague,
  leagueId,
  season,
}: {
  onboarded: boolean
  data: LeagueData | null
  loading: boolean
  /** Show this league (and this season, `null` for the current one; leave it as it is when omitted). */
  selectLeague: (id: string | null, season?: string | null) => void
  /** The league and season the visitor had chosen, to go back to. */
  leagueId: string | null
  season: string | null
}) => {
  const [link, setLink] = useState<DeepLink | null>(null)
  const [note, setNote] = useState<DeepNote | null>(null)
  // The address carried a trade this visit, opened or not: the reveal stays shut for it (pages/index.tsx).
  const [sharedTrade, setSharedTrade] = useState(false)
  // After asking for the link's league: waiting for the load to start, then to land.
  const [switching, setSwitching] = useState(false)
  // After putting things back: waiting for the visitor's own league to come back before opening anything.
  const [restoring, setRestoring] = useState(false)
  const sawLoad = useRef(false)
  // The season the visitor's own league is in, which tells that it has come back.
  const backTo = useRef<string | null>(null)
  const before = useRef<{ leagueId: string | null; season: string | null } | null>(null)

  // A trade turned away on arrival: said at once, its parameters taken off once the league is up (Next puts the query
  // back while it hydrates, so earlier would not hold).
  const refused = useRef(false)

  useEffect(() => {
    const parsed = parseDeepLink(window.location.search)
    if (parsed?.trade || parsed?.refused) setSharedTrade(true)
    if (parsed?.refused) {
      refused.current = true
      setNote({ text: parsed.refused })
      return
    }
    setLink(parsed)
  }, [])

  useEffect(() => {
    if (!refused.current || !data) return
    refused.current = false
    clearParams()
  }, [data])

  const finish = useCallback((text?: string) => {
    clearParams()
    setSwitching(false)
    before.current = null
    setLink(null)
    if (text) setNote({ text })
  }, [])

  // Gave up on the link's league. When a season was switched for it, put things back and carry on with the same week in
  // the visitor's own league.
  const giveUp = useCallback(() => {
    const week = link?.week
    if (before.current && link?.season) {
      const back = before.current
      sawLoad.current = false
      backTo.current = back.season ?? (data ? String(data.state.league_season ?? data.state.season) : null)
      selectLeague(back.leagueId, back.season)
      setRestoring(true)
      // A trade cannot be shown in the visitor's own league: the link is used up, with the note.
      if (link.trade) return finish(NOT_IN_TRADE)
      setSwitching(false)
      before.current = null
      setNote({ text: `You aren't in that league for ${link.season}, so this is week ${week && week !== 'latest' ? week : 'the latest'} of your own league.` })
      setLink({ league: null, season: null, week })
      return
    }
    finish(link?.trade ? NOT_IN_TRADE : NOT_IN_LEAGUE)
  }, [link, selectLeague, finish, data])

  useEffect(() => {
    if (!link?.league || !onboarded || !data) return
    if (data.league.league_id === link.league) {
      if (switching) setSwitching(false)
      return
    }
    if (!switching) {
      if (loading) return
      const here = String(data.league.season)
      const inList = data.leagues.some((l) => l.league_id === link.league)
      if (inList) {
        sawLoad.current = false
        setSwitching(true)
        selectLeague(link.league)
      } else if (link.season && link.season !== here) {
        // Another season's league: ask the app to show that season, and see if the visitor has it there.
        const current = String(data.state.league_season ?? data.state.season)
        before.current = { leagueId, season }
        sawLoad.current = false
        setSwitching(true)
        selectLeague(link.league, link.season === current ? null : link.season)
      } else finish(link.trade ? NOT_IN_TRADE : NOT_IN_LEAGUE)
      return
    }
    // Switching: it has landed once a load has come and gone.
    if (loading) sawLoad.current = true
    else if (sawLoad.current) giveUp()
  }, [link, onboarded, data, loading, switching, selectLeague, finish, giveUp, leagueId, season])

  // A switch that never shows a load must not hold the link forever: the clock starts when it is asked for.
  useEffect(() => {
    if (!switching) return
    const id = window.setTimeout(giveUp, SWITCH_MS)
    return () => window.clearTimeout(id)
  }, [switching, giveUp])

  useEffect(() => {
    if (!restoring) return
    if (loading) sawLoad.current = true
    // Back once the visitor's season is on screen again (a load may never show if it was kept).
    else if (data && String(data.league.season) === backTo.current) setRestoring(false)
  }, [restoring, loading, data])
  useEffect(() => {
    if (!restoring) return
    const id = window.setTimeout(() => setRestoring(false), SWITCH_MS)
    return () => window.clearTimeout(id)
  }, [restoring])

  const ready = link && onboarded && data && !loading && !restoring && (!link.league || data.league.league_id === link.league) ? link : null
  // A link that names a league and no week (and no trade) is used up as soon as the league is up.
  useEffect(() => {
    if (ready && ready.week == null && !ready.trade) finish()
  }, [ready, finish])

  const dismiss = useCallback(() => setNote(null), [])
  /** A shared trade, once its league is on screen: open it in the builder (SharedTradeOpener), then `finish`. */
  const trade = ready?.trade ?? null
  return { link, ready: ready && ready.week != null ? { week: ready.week } : null, trade, sharedTrade, finish, note, dismiss }
}
