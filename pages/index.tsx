import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FantasyProvider } from '../components/FantasyContext'
import SheetHost, { sheetKey, type SheetRef } from '../components/SheetHost'
import { TradeDockProvider } from '../components/TradeDock'
import Shell, { SECTION_KEYS, sectionLabel, type SectionKey } from '../components/Shell'
import { cx } from '../components/ui'
import DashboardView from '../components/views/DashboardView'
import Onboarding, { type OnboardResult } from '../components/Onboarding'
import MeView from '../components/views/MeView'
import ModelView, { READOUT } from '../components/views/ModelView'
import MatchupsView from '../components/views/MatchupsView'
import PlayoffsView from '../components/views/PlayoffsView'
import SlateView from '../components/views/SlateView'
import PlayersView from '../components/views/PlayersView'
import PowerView from '../components/views/PowerView'
import TeamsView from '../components/views/TeamsView'
import WaiversView from '../components/views/WaiversView'
import TradesView from '../components/views/TradesView'
import type { AcceptRead } from '../lib/behavior'
import { applyLessons, ideaKey, learn, loadGrades, saveGrades, type GradeRecord, type Grades } from '../lib/grades'
import { useSharedPrior } from '../lib/sharedGrades'
import type { TradeIdea } from '../lib/trades'
import { applyAdjustments, liveAdjustments, loadAdjustments, saveAdjustments, type Adjustment, type Adjustments } from '../lib/adjust'
import { analyze, withWeights } from '../lib/analysis'
import { buildHistory, buildModels } from '../lib/models'
import { DEFAULT_POWER_WEIGHTS, type PowerWeights } from '../lib/power'
import { purgeStaleCache } from '../lib/sleeper'
import { writeStored } from '../lib/storage'
import {
  DEFAULT_HORIZON_MODE,
  DEFAULT_PLAYOFF_WEIGHT,
  providerName,
  useLeagueData,
  type HorizonMode,
  type LoadOptions,
  type Provider,
} from '../lib/useLeagueData'
import { useRoute } from '../lib/useRoute'
import { DEFAULT_MODEL, type ModelConfig } from '../lib/war'
import { DEFAULT_THEME, themeById, type Scheme } from '../lib/themes'
import { type Density } from '../components/ThemePicker'
import Settings, { isSettingsTab, type SettingsTab } from '../components/Settings'
import CommandPalette from '../components/CommandPalette'
import { useTheme } from '../lib/useTheme'
import { RevealHost } from '../components/PowerReveal'
import { NavBanner } from '../components/RevealBanner'
import { useReveal } from '../components/useReveal'
import { useDeepLink } from '../components/useDeepLink'
import DeepLinkNote from '../components/DeepLinkNote'
import { SharedTradeOpener } from '../components/TradeShare'

const PREFS_KEY = 'ff:prefs'

export type Prefs = {
  /** True once a league has been confirmed (a Sleeper username, or an ESPN league and team); until then the page shows onboarding. */
  onboarded: boolean
  /** Where the league lives. Missing in prefs saved before ESPN support, which were all Sleeper. */
  provider: Provider
  username: string
  /** The Sleeper league picked in the switcher. */
  leagueId: string | null
  /** ESPN's league id and your team in it. */
  espnLeagueId: string | null
  espnTeamId: number | null
  season: string | null
  horizon: HorizonMode
  playoffWeight: number
  model: ModelConfig
  weights: PowerWeights
  /** Colour theme id (lib/themes.ts) and, for themes with both, light, dark or the system's. */
  theme: string
  scheme: Scheme
  /** Compact (the default) or comfortable: type size and row height across the app. */
  density: Density
  /** The desktop sidebar: shown, or folded away behind a show-sidebar button. */
  sidebar: boolean
}

const TOUR_KEY = 'ff:tour:v1'
/** Per league and season, the latest power-rank week whose sidebar card was put away. */
const CARD_KEY = (league: string) => `ff:revealcard:${league}`
const readCardWeek = (league: string | null) => {
  // -1: never put away, so even a card for the season's first week (no reveal yet, one on its way) shows.
  if (!league) return -1
  try {
    const v = window.localStorage.getItem(CARD_KEY(league))
    return v == null ? -1 : Number(v) || 0
  } catch {
    return -1
  }
}
/** `#settings` or `#settings/appearance`: a link that opens the settings dialog. */
const SETTINGS_HASH = /^#\/?settings(?:\/([a-z]+))?$/

const loadPrefs = (): Prefs => {
  const base: Prefs = {
    onboarded: false,
    provider: 'sleeper',
    username: '',
    leagueId: null,
    espnLeagueId: null,
    espnTeamId: null,
    season: null,
    horizon: DEFAULT_HORIZON_MODE,
    playoffWeight: DEFAULT_PLAYOFF_WEIGHT,
    model: DEFAULT_MODEL,
    weights: DEFAULT_POWER_WEIGHTS,
    theme: DEFAULT_THEME,
    scheme: 'system',
    density: 'compact',
    sidebar: true,
  }
  try {
    const raw = window.localStorage.getItem(PREFS_KEY)
    if (!raw) return base
    const p = JSON.parse(raw) as Partial<Prefs>
    // Prefs saved before onboarding existed carry a username but no flag: they get the (pre-filled) form once.
    const known = p.provider === 'espn' ? !!p.espnLeagueId : !!p.username
    // A saved theme that has since been retired (gray, neutral, stone) falls back to the default.
    return { ...base, ...p, theme: themeById(p.theme).id, onboarded: p.onboarded === true && known, model: { ...DEFAULT_MODEL, ...(p.model ?? {}) }, weights: { ...DEFAULT_POWER_WEIGHTS, ...(p.weights ?? {}) } }
  } catch {
    return base
  }
}

const FantasyPage = () => {
  const [prefs, setPrefs] = useState<Prefs | null>(null)
  const route = useRoute(SECTION_KEYS, 'dash', { matchup: 'slate/week' })
  useTheme(prefs?.theme, prefs?.scheme ?? 'system', prefs != null)
  // Density is one attribute on the root; styles/fantasy.css scales type and rows from it.
  useEffect(() => {
    if (!prefs) return
    document.documentElement.dataset.ffDensity = prefs.density
    return () => {
      delete document.documentElement.dataset.ffDensity
    }
  }, [prefs?.density]) // eslint-disable-line react-hooks/exhaustive-deps
  // The page scrolls vertically only: styles/fantasy.css locks the sideways axis on html/body while this class is set.
  useEffect(() => {
    document.documentElement.classList.add('ff-page')
    return () => document.documentElement.classList.remove('ff-page')
  }, [])
  // Waivers moved out of My team into their own section; old links still land there.
  useEffect(() => {
    if (route.section === 'me' && route.sub === 'waivers') route.go('waivers', 'adds', { replace: true })
    // The Model page split into M.O.N.K.E. (read-only) and Tuning; its read-only tabs moved over.
    if (route.section === 'model' && route.sub && READOUT.includes(route.sub as (typeof READOUT)[number])) route.go('monke', route.sub, { replace: true })
    // Playoffs moved out of Power into its own page; your matchup moved into Gameday, the league's into Matchups.
    if (route.section === 'power' && route.sub === 'odds') route.go('playoffs', null, { replace: true })
  }, [route.section, route.sub]) // eslint-disable-line react-hooks/exhaustive-deps

  // Settings is a dialog over the page, not a page. `#settings` (an old bookmark, or a link) opens it over whatever
  // was showing and puts that page's address back, so Back never lands on a settings route.
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null)
  const lastRoute = useRef(route)
  if (!SETTINGS_HASH.test(typeof window !== 'undefined' ? window.location.hash : '')) lastRoute.current = route
  useEffect(() => {
    const read = () => {
      const m = SETTINGS_HASH.exec(window.location.hash)
      if (!m) return
      setSettingsTab(isSettingsTab(m[1]) ? m[1] : 'account')
      setSettingsAsk((n) => n + 1)
      const r = lastRoute.current
      route.go(r.section, r.sub, { replace: true, page: r.page })
    }
    read()
    window.addEventListener('hashchange', read)
    return () => window.removeEventListener('hashchange', read)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  // Reopened, it comes back to the category it was left on.
  const lastTab = useRef<SettingsTab>('account')
  if (settingsTab) lastTab.current = settingsTab
  const [settingsAsk, setSettingsAsk] = useState(0)
  const openSettings = useCallback((tab?: SettingsTab) => {
    setSettingsTab(tab ?? lastTab.current)
    setSettingsAsk((n) => n + 1)
  }, [])
  const closeSettings = useCallback(() => setSettingsTab(null), [])

  useEffect(() => {
    purgeStaleCache()
    const p = loadPrefs()
    setPrefs(p)
  }, [])
  useEffect(() => {
    if (!prefs) return
    writeStored(PREFS_KEY, JSON.stringify(prefs))
  }, [prefs])

  // Nothing loads until a username is confirmed. Once one has been this
  // session, reopening the form (switch) keeps the current data live, so
  // backing out of it costs nothing.
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (prefs?.onboarded) setReady(true)
  }, [prefs?.onboarded])
  const opts = useMemo<LoadOptions | null>(() => {
    if (!prefs || !ready) return null
    const common = { season: prefs.season, horizon: prefs.horizon, playoffWeight: prefs.playoffWeight }
    return prefs.provider === 'espn' && prefs.espnLeagueId
      ? { ...common, provider: 'espn', leagueId: prefs.espnLeagueId, teamId: prefs.espnTeamId }
      : { ...common, provider: 'sleeper', username: prefs.username, leagueId: prefs.leagueId }
  }, [ready, prefs?.provider, prefs?.username, prefs?.leagueId, prefs?.espnLeagueId, prefs?.espnTeamId, prefs?.season, prefs?.horizon, prefs?.playoffWeight]) // eslint-disable-line react-hooks/exhaustive-deps
  const { data: loaded, error, loading, progress, reload } = useLeagueData(opts)
  // Your nudges for this league, applied to the data itself so every model downstream uses them.
  // Read in the same render the league arrives in, so no model is built with another league's reads.
  const leagueKey = loaded?.league.league_id ?? null
  const stored = useMemo(() => (leagueKey ? loadAdjustments(leagueKey) : {}), [leagueKey])
  const [edited, setEdited] = useState<{ key: string | null; adj: Adjustments } | null>(null)
  const adj = edited && edited.key === leagueKey ? edited.adj : stored
  const firstWeek = loaded?.horizon[0]?.week ?? null
  const live = useMemo(() => liveAdjustments(adj, firstWeek), [adj, firstWeek])
  const data = useMemo(() => (loaded ? applyAdjustments(loaded, live) : null), [loaded, live])
  const adjust = useMemo(
    () => ({
      all: live,
      week: firstWeek,
      set: (id: string, a: Adjustment | null) => {
        const next = { ...live }
        if (a && a.pct) next[id] = a
        else delete next[id]
        if (leagueKey) saveAdjustments(leagueKey, next)
        setEdited({ key: leagueKey, adj: next })
      },
    }),
    [live, firstWeek, leagueKey],
  )
  // Your grades of suggested trades, per league, and what they teach the trade read.
  const storedGrades = useMemo(() => (leagueKey ? loadGrades(leagueKey) : {}), [leagueKey])
  const [editedGrades, setEditedGrades] = useState<{ key: string | null; g: Grades } | null>(null)
  const gradeMap = editedGrades && editedGrades.key === leagueKey ? editedGrades.g : storedGrades
  // Everyone else's grades in this league, when sharing is set up; null otherwise.
  const sharedPrior = useSharedPrior(leagueKey)
  const grades = useMemo(() => {
    const players = loaded?.players ?? {}
    const posOf = (id: string) => players[id]?.pos
    const name = (id: string) => players[id]?.name ?? id
    const lessons = learn(gradeMap, posOf, sharedPrior)
    return {
      all: gradeMap,
      lessons,
      set: (idea: TradeIdea, rec: Omit<GradeRecord, 'partnerId' | 'give' | 'get' | 'at'> | null) => {
        const next = { ...gradeMap }
        const k = ideaKey(idea)
        if (rec) next[k] = { ...rec, partnerId: idea.partnerId, give: idea.give, get: idea.get, at: Date.now() }
        else delete next[k]
        if (leagueKey) saveGrades(leagueKey, next)
        setEditedGrades({ key: leagueKey, g: next })
      },
      apply: (read: AcceptRead, idea: TradeIdea) => applyLessons(read, idea, lessons, name, posOf),
    }
  }, [gradeMap, leagueKey, loaded?.players, sharedPrior])
  // Everything but the composite ranking depends on the data and the value model;
  // weights only re-rank. Models and the trade search key on the core, so moving
  // a weight slider never reruns the season simulation or the backtest.
  // Your reads change the weeks ahead only: the history-based models (Elo, the backtest, league behaviour)
  // are built once from the league as loaded and kept when a read changes.
  const coreLoaded = useMemo(() => (loaded && prefs ? analyze(loaded, prefs.model, DEFAULT_POWER_WEIGHTS) : null), [loaded, prefs?.model]) // eslint-disable-line react-hooks/exhaustive-deps
  const core = useMemo(
    () => (data && prefs ? (data === loaded ? coreLoaded : analyze(data, prefs.model, DEFAULT_POWER_WEIGHTS)) : null),
    [data, loaded, coreLoaded, prefs?.model], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const analysis = useMemo(() => (core && prefs ? withWeights(core, prefs.weights) : null), [core, prefs?.weights]) // eslint-disable-line react-hooks/exhaustive-deps
  const history = useMemo(() => (loaded && coreLoaded ? buildHistory(loaded, coreLoaded) : null), [loaded, coreLoaded])
  const models = useMemo(() => (data && core && history ? buildModels(data, core, history) : null), [data, core, history])

  // The one detail sheet, over whatever page you are on. Opening another from inside it swaps the content in place
  // and keeps a short trail back; the same thing twice in a row is one entry.
  const [sheets, setSheets] = useState<SheetRef[]>([])
  const openSheet = useCallback(
    (r: SheetRef) => setSheets((xs) => (xs.length && sheetKey(xs[xs.length - 1]) === sheetKey(r) ? xs : [...xs.slice(-7), r])),
    [],
  )
  const closeSheet = useCallback(() => setSheets([]), [])
  const backSheet = useCallback(() => setSheets((xs) => xs.slice(0, -1)), [])
  const sheetApi = useMemo(
    () => ({
      openPlayer: (id: string) => openSheet({ kind: 'player', id }),
      openTeam: (id: number) => openSheet({ kind: 'team', id }),
      openGame: (key: string) => openSheet({ kind: 'game', key }),
      openMatchup: (week: number, a: number, b: number) => openSheet({ kind: 'matchup', week, a, b }),
    }),
    [openSheet],
  )
  // Cmd/Ctrl+K opens the command palette from anywhere, fields included; again closes it.
  const [palette, setPalette] = useState(false)
  const closePalette = useCallback(() => setPalette(false), [])
  // Only once the app is up: on the loader or onboarding there is nothing to jump to, and a press there must not open it later.
  const appUp = !!(data && analysis && models && prefs)
  const canPalette = useRef(appUp)
  canPalette.current = appUp
  useEffect(() => {
    if (!appUp) setPalette(false)
  }, [appUp])

  // The tour runs on a first visit, once a league is up to point at; after that only when asked for.
  const [tour, setTour] = useState(false)
  useEffect(() => {
    if (!appUp) return
    try {
      if (!window.localStorage.getItem(TOUR_KEY)) setTour(true)
    } catch {
      // Storage blocked: skip it rather than show it on every visit.
    }
  }, [appUp])
  // The weekly power-rank reveal. It waits while the tour has the screen, and a first visit (which gets the tour)
  // does not also get last week's reveal on top of it.
  const [toured, setToured] = useState(false)
  useEffect(() => {
    if (tour) setToured(true)
  }, [tour])
  // The tour is about to start on this render's commit when it has never been seen: hold the reveal for it too.
  let tourDue = false
  try {
    tourDue = appUp && !window.localStorage.getItem(TOUR_KEY)
  } catch {
    // Storage blocked: the tour never starts by itself either.
  }
  const revealPrefs = useMemo(() => (prefs ? { weights: prefs.weights, model: prefs.model } : null), [prefs?.weights, prefs?.model]) // eslint-disable-line react-hooks/exhaustive-deps
  // A shared Power Rank link: its league is selected once the visitor is through onboarding, then the week opens.
  const selectLeague = useCallback((id: string | null, season?: string | null) => setPrefs((p) => (p ? { ...p, leagueId: id, ...(season !== undefined ? { season } : {}) } : p)), [])
  const deepLink = useDeepLink({ onboarded: !!prefs?.onboarded, data, loading, selectLeague, leagueId: prefs?.leagueId ?? null, season: prefs?.season ?? null })
  const deep = useMemo(() => (deepLink.ready ? { week: deepLink.ready.week, finish: deepLink.finish } : null), [deepLink.ready?.week, deepLink.finish]) // eslint-disable-line react-hooks/exhaustive-deps
  // A shared trade opens in the builder (or says why it can't), and the reveal does not open over it this visit.
  const tradeLink = deepLink.sharedTrade
  // While a link is still finding its league, the reveal that opens by itself waits.
  const reveal = useReveal({ data, analysis, models, prefs: revealPrefs, blocked: !appUp || tour || tourDue || tradeLink || (!!deepLink.link && !deepLink.ready), quiet: toured, deep })
  // The sidebar's power-rank card can be put away until the next week drops. The reveal stays a tap away on the
  // Power Rank page and in the command palette.
  const cardLeague = data ? `${data.league.league_id}:${data.league.season}` : null
  const [cardHidden, setCardHidden] = useState<{ league: string | null; week: number }>({ league: null, week: -1 })
  const hiddenWeek = cardHidden.league === cardLeague ? cardHidden.week : readCardWeek(cardLeague)
  const latestWeek = reveal.source?.recap.week ?? 0
  const showCard = !!(reveal.source || reveal.pending) && latestWeek > hiddenWeek
  const hideCard = useCallback(() => {
    if (!cardLeague) return
    writeStored(CARD_KEY(cardLeague), String(latestWeek))
    setCardHidden({ league: cardLeague, week: latestWeek })
  }, [cardLeague, latestWeek])
  const paletteReveal = useMemo(() => (latestWeek ? { week: latestWeek, open: reveal.show } : null), [latestWeek, reveal.show])
  const endTour = useCallback(() => {
    setTour(false)
    writeStored(TOUR_KEY, '1')
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (canPalette.current && (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPalette((x) => !x)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  useEffect(() => setSheets([]), [leagueKey])

  // A new section fades its content in (the header stays put), so switching never flashes. Tabs within a page
  // switch instantly: they are flipped back and forth far too often to wait on.
  const view = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const root = view.current
    if (!root || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    for (const el of root.children) if (!el.classList.contains('ff-pagehead')) el.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: 'ease-out' })
  }, [route.section])

  // When the league last arrived, for Settings › Data.
  const [loadedAt, setLoadedAt] = useState<Date | null>(null)
  useEffect(() => {
    if (loaded) setLoadedAt(new Date())
  }, [loaded])

  const seasonOptions = useMemo(() => {
    const current = Number(data?.state.league_season ?? data?.state.season ?? new Date().getFullYear())
    return [current, current - 1, current - 2].map(String)
  }, [data])

  // Functional form, so two updates in one handler (Model's "Reset all") both land.
  const update = (patch: Partial<Prefs>) => setPrefs((p) => (p ? { ...p, ...patch } : p))

  const myTeam = analysis && analysis.myRosterId != null ? analysis.teamById[analysis.myRosterId] : null
  const mySeason = myTeam ? analysis!.seasonById[myTeam.rosterId] : null
  const horizonWeeks = data?.horizon.map((h) => h.week) ?? []
  const leagueList = useMemo(() => (data?.leagues ?? []).map((l) => ({ id: l.league_id, name: l.name })), [data?.leagues])

  const section = route.section as SectionKey
  const title = data ? `${sectionLabel(section) ?? 'Fantasy'} · ${data.league.name}` : 'Fantasy'
  // What the engine is running on, for Settings › Data.
  const readouts = [
    { label: 'NFL week', hint: `From ${providerName(data?.provider ?? prefs?.provider ?? 'sleeper')}'s calendar.`, value: data?.state.season_type === 'regular' ? String(data.state.week) : '—' },
    { label: 'Seasons simulated', hint: 'Run for the playoff odds.', value: models?.forecast ? models.forecast.sims.toLocaleString() : '—' },
    { label: 'Score noise (σ)', hint: 'How far a team-week strays from its projection, in points.', value: models?.forecast ? models.forecast.sigma.toFixed(1) : '—' },
    { label: 'Consensus ranks', hint: 'FantasyPros expert consensus (ECR).', value: !data ? '—' : data.consensus ? 'Loaded' : 'Off' },
  ]

  // Until prefs are read (first client render), draw nothing rather than flash the wrong screen.
  if (!prefs) return <div className="ff min-h-dvh bg-ff-bg" />
  if (!prefs.onboarded) {
    return (
      <Onboarding
        initial={{ provider: prefs.provider, username: prefs.username, espnLeagueId: prefs.espnLeagueId, espnTeamId: prefs.espnTeamId }}
        onDone={(r: OnboardResult) => {
          if (r.provider === 'espn') {
            const same = prefs.provider === 'espn' && r.leagueId === prefs.espnLeagueId
            update({ onboarded: true, provider: 'espn', espnLeagueId: r.leagueId, espnTeamId: r.teamId, season: same ? prefs.season : null })
            return
          }
          const same = prefs.provider !== 'espn' && r.username.toLowerCase() === prefs.username.trim().toLowerCase()
          update({ onboarded: true, provider: 'sleeper', username: r.username, leagueId: same ? prefs.leagueId : null, season: same ? prefs.season : null })
        }}
        onCancel={(prefs.provider === 'espn' ? prefs.espnLeagueId : prefs.username) ? () => update({ onboarded: true }) : undefined}
        cancelLabel={prefs.provider === 'espn' ? `keep ESPN league ${prefs.espnLeagueId}` : `keep @${prefs.username}`}
        hint={deepLink.link ? (deepLink.link.trade ? 'Someone shared a trade with you. Sign in and it opens in the trade builder.' : deepLink.link.week != null ? 'Someone shared a Power Rank with you. Sign in and it opens right up.' : 'Someone shared a league with you. Sign in and it opens right up.') : undefined}
      />
    )
  }

  return (
    <Shell
      section={section}
      onNavigate={(s) => route.go(s)}
      title={title}
      leagues={leagueList}
      leagueId={data?.league.league_id ?? null}
      onLeague={(id) => update({ leagueId: id })}
      leagueMeta={data ? `${data.league.season} · ${data.league.total_rosters} teams${data.state.season_type === 'regular' && data.league.season === data.state.season ? ` · wk ${data.state.week}` : ''}` : undefined}
      // Your team and its record; the playoff odds live on its page.
      me={myTeam ? { name: myTeam.name, avatar: myTeam.avatar, line: mySeason && mySeason.wins + mySeason.losses + mySeason.ties > 0 ? `${mySeason.wins}-${mySeason.losses}${mySeason.ties ? `-${mySeason.ties}` : ''}` : myTeam.owner && myTeam.owner !== 'Unowned' ? myTeam.owner : '', onOpen: () => route.go('teams', String(myTeam.rosterId)) } : null}
      account={prefs.provider === 'espn' ? `ESPN ${prefs.espnLeagueId}` : `@${prefs.username}`}
      onSettings={openSettings}
      loading={loading}
      progress={progress}
      onRefresh={reload}
      source={providerName(data?.provider ?? prefs.provider)}
      onSearch={data ? () => setPalette(true) : undefined}
      sidebar={prefs.sidebar}
      onSidebar={(open) => update({ sidebar: open })}
      tour={tour && appUp}
      onTourEnd={endTour}
      navFooter={
        showCard && analysis
          ? (closeDrawer) => (
              <NavBanner
                key={cardLeague}
                recap={reveal.source?.recap ?? null}
                pending={reveal.pending}
                analysis={analysis}
                onOpen={() => {
                  closeDrawer?.()
                  reveal.show()
                }}
                onDismiss={hideCard}
              />
            )
          : undefined
      }
    >
      {error && (
        <div className="mt-4 border border-ff-neg/40 bg-ff-neg/10 px-3 py-2.5 font-mono text-[12px] text-ff-neg">ERR · {error}</div>
      )}
      {data && data.warnings.length > 0 && (
        <div className="mt-3 space-y-0.5">
          {data.warnings.map((w) => (
            <div key={w} className="font-mono text-[11px] text-ff-warn">
              ! {w}
            </div>
          ))}
        </div>
      )}

      {/* Settings open over any page, whether or not a league has loaded (or failed to), so a wrong season or user can
          always be put right. Rendered here once, so a league change or data arriving never remounts them. */}
      {settingsTab && (
        <Settings
          tab={settingsTab}
          onTab={setSettingsTab}
          onClose={closeSettings}
          reopen={settingsAsk}
          prefs={prefs}
          update={update}
          leagues={leagueList}
          leagueId={data?.league.league_id ?? null}
          seasons={seasonOptions}
          horizonWeeks={horizonWeeks}
          playoffWeeks={data?.playoffWeeks ?? []}
          onTour={() => {
            closeSettings()
            setTour(true)
          }}
          sync={{ loading, progress, loadedAt, source: providerName(data?.provider ?? prefs.provider), onReload: reload, readouts }}
        />
      )}
      {data && analysis && models && prefs ? (
        <FantasyProvider value={{ data, analysis, models, adjust, grades, go: (s, sub) => route.go(s, sub ?? undefined), ...sheetApi }}>
        {/* The trade builder's one deal, kept here so it outlives the page that opened it. */}
        <TradeDockProvider>
        <div key={data.league.league_id} ref={view} className={cx(loading && 'opacity-60 transition-opacity')}>
          {section === 'dash' && <DashboardView />}
          {section === 'trades' && <TradesView data={data} analysis={analysis} sub={route.sub} onSub={route.setSub} />}
          {section === 'waivers' && <WaiversView data={data} analysis={analysis} sub={route.sub} onSub={route.setSub} />}
          {section === 'me' && <MeView data={data} analysis={analysis} sub={route.sub} onSub={route.setSub} onTeam={(id) => route.go('teams', String(id))} />}
          {section === 'power' && (
            <PowerView data={data} analysis={analysis} sub={route.sub} onSub={route.setSub} onTeam={sheetApi.openTeam} weights={prefs.weights} recap={reveal.source?.recap ?? null} pending={reveal.pending} onReveal={reveal.show} />
          )}
          {section === 'teams' && (
            // Moving to another team keeps the page, so rosters can be compared.
            <TeamsView data={data} analysis={analysis} sub={route.sub} page={route.page} onPage={route.setPage} onTeam={(id) => route.go('teams', id == null ? null : String(id), { page: route.page })} />
          )}
          {section === 'players' && <PlayersView data={data} analysis={analysis} sub={route.sub} onSub={route.setSub} />}
          {section === 'slate' && <SlateView data={data} analysis={analysis} sub={route.sub} onSub={route.setSub} />}
          {section === 'matchups' && <MatchupsView />}
          {section === 'playoffs' && <PlayoffsView sub={route.sub} onSub={route.setSub} />}
          {(section === 'model' || section === 'monke') && (
            <ModelView
              key={section}
              mode={section === 'monke' ? 'readout' : 'tuning'}
              data={data}
              analysis={analysis}
              sub={route.sub}
              onSub={route.setSub}
              model={prefs.model}
              setModel={(m) => update({ model: m })}
              weights={prefs.weights}
              setWeights={(w) => update({ weights: w })}
              reload={reload}
            />
          )}
        </div>
        {sheets.length > 0 && <SheetHost stack={sheets} onBack={backSheet} onClose={closeSheet} />}
        <RevealHost api={reveal} />
        <SharedTradeOpener trade={deepLink.trade} finish={deepLink.finish} />
        {deepLink.note && <DeepLinkNote text={deepLink.note.text} onDismiss={deepLink.dismiss} />}
        <CommandPalette
          open={palette}
          onClose={closePalette}
          theme={prefs.theme}
          scheme={prefs.scheme}
          onTheme={(t) => update({ theme: t })}
          onScheme={(m) => update({ scheme: m })}
          density={prefs.density}
          onDensity={(d) => update({ density: d })}
          onReload={reload}
          source={providerName(data.provider)}
          onTour={() => setTour(true)}
          leagues={leagueList}
          onLeague={(id) => update({ leagueId: id })}
          onSettings={openSettings}
          // Anything but a Settings command acts on the page, so the dialog gets out of its way first.
          onRun={(id) => {
            if (id !== 'go:settings' && !id.startsWith('settings:')) closeSettings()
          }}
          reveal={paletteReveal}
        />
        </TradeDockProvider>
        </FantasyProvider>
      ) : (
        !error && (
          // Padding, not margin: a top margin here collapses through to the page and shows a strip of body.
          <div className="pb-6">
            <div className="ff-bleed ff-gutter flex h-11 items-center gap-2.5 border-b border-ff-line font-mono text-[11.5px] text-ff-muted">
              <span className="ff-pulse h-1.5 w-1.5 shrink-0 bg-ff-warn" />
              <span className="ff-caret min-w-0 truncate">{loading ? progress : 'starting'}</span>
            </div>
            <div className="mt-4 grid gap-px border border-ff-line bg-ff-line lg:grid-cols-2">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-56 animate-pulse bg-ff-panel" />
              ))}
            </div>
          </div>
        )
      )}
    </Shell>
  )
}

export default FantasyPage
