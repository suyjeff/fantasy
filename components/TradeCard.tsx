import React, { useCallback, useEffect, useId, useMemo, useState } from 'react'
import type { Analysis } from '../lib/analysis'
import { bandTone, type AcceptRead } from '../lib/behavior'
import { leverageOf, leverageRun, type Forecast, type ForecastInput, type Leverage, type TradeSides } from '../lib/forecast'
import { runSim } from '../lib/simRunner'
import { applyTrade, type TradeIdea } from '../lib/trades'
import type { LeagueData } from '../lib/useLeagueData'
import { ContextNotes } from './ContextNotes'
import { dealFromIdea } from '../lib/deal'
import { CompareToggle } from './useCompare'
import { ShareTradeButton } from './TradeShare'
import { BuildIcon, ChevronIcon } from './icons'
import { InsightMark } from './InsightMark'
import { useFantasy, useTradeRead } from './FantasyContext'
import { PRICING_VERSION } from '../lib/currency'
import { formText } from '../lib/momentum'
import { lastName } from '../lib/names'
import { streakText } from '../lib/power'
import { GRADE_LABEL, WHY_LABEL, ideaKey, type Grade, type GradeWhy } from '../lib/grades'
import { Avatar, Badge, Button, Chip, Figure, PlayerAvatar, Segmented, WeekBars, cx, fmtSigned, isOut, pct, simOdds } from './ui'

export const SHAPE_LABEL: Record<TradeIdea['shape'], string> = {
  'one-for-one': 'Straight swap',
  consolidate: 'Consolidation',
  depth: 'Depth',
  swap: 'Package swap',
}

/** A cell's wash, by verdict: enough colour to tell the cells apart from each other and the page. */
const WASH: Record<'pos' | 'neg' | 'warn' | 'none', string> = {
  // An inset shadow lays the tint over the panel, not over the hairline grid behind it.
  pos: 'bg-ff-panel shadow-[inset_0_0_0_999px_rgb(var(--ff-pos)/0.07)]',
  neg: 'bg-ff-panel shadow-[inset_0_0_0_999px_rgb(var(--ff-neg)/0.06)]',
  warn: 'bg-ff-panel shadow-[inset_0_0_0_999px_rgb(var(--ff-warn)/0.08)]',
  none: 'bg-ff-panel',
}

const PlayerLine = ({ id, data, analysis, notes, side }: { id: string; data: LeagueData; analysis: Analysis; notes?: boolean; side: 'give' | 'get' }) => {
  const p = data.players[id]
  const ctx = data.context[id]
  const perWeek = analysis.horizon.perWeek[id]
  const play = ctx?.play
  const ecr = data.consensus?.byId[id]
  const out = isOut(p?.injury)
  // Recent form, marked only where it favours you: a player you get off a dud, one you send off a spike.
  const form = analysis.form[id]
  const moment = form && (side === 'get' ? form.kind === 'buy-low' : form.kind === 'sell-high') ? form : null
  return (
    <div className="flex items-center gap-2.5 py-1.5">
      <PlayerAvatar id={id} player={p} size={34} />
      <div className="min-w-0 flex-1 leading-tight">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13.5px] font-medium text-ff-text">{p?.name ?? id}</span>
          {p?.injury && <span className={cx('shrink-0 font-mono text-[9.5px] font-semibold uppercase', out ? 'text-ff-neg' : 'text-ff-warn')}>{p.injury.slice(0, 3)}</span>}
          {moment && (
            <span
              className="shrink-0 cursor-help font-mono text-[9.5px] font-semibold uppercase text-ff-pos"
              title={`${formText(moment)[0].toUpperCase()}${formText(moment).slice(1)}. ${moment.kind === 'buy-low' ? 'His outlook holds, but the room prices him off it' : 'His outlook has not moved, but the room prices him off it'}.`}
            >
              {moment.kind === 'buy-low' ? 'buy low' : 'sell high'}
            </span>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-mono text-[10.5px] text-ff-muted">
          <span className="font-semibold text-ff-text2">{p?.pos}</span>
          <span>{p?.team ?? 'FA'}</span>
          {ecr?.posRank != null && (
            <span title="FantasyPros consensus rank, rest of season">
              · ecr {p?.pos}
              {Math.round(ecr.posRank)}
            </span>
          )}
          {play != null && play < 0.85 && (
            <span className={cx('px-1', play < 0.75 ? 'bg-ff-neg/10 text-ff-neg' : 'bg-ff-warn/10 text-ff-warn')} title="Chance he plays in a given week, from his status and history">
              plays {pct(play)}
            </span>
          )}
        </div>
        {/* What you take on matters more than what you send: a role about to shrink, a hard playoff run. */}
        {notes && ctx?.notes.length ? (
          <div className="mt-1">
            <ContextNotes context={ctx} players={data.players} max={2} />
          </div>
        ) : null}
      </div>
      <Figure value={perWeek != null ? perWeek.toFixed(1) : '–'} unit="/wk" className="shrink-0" title="Expected points per week over the horizon" />
    </div>
  )
}

// Each trade's leverage, once per forecast and trade: run sliced in idle time on the shared simulation queue
// (lib/simRunner), one trade at a time, and kept for every card that shows the same trade. What has settled is kept
// beside the promise too, so a card that shows it again (a re-sort, a remount, the comparison) has it at once.
type LevCache = { pending: Map<string, Promise<Leverage | null>>; done: Map<string, Leverage | null> }
const leverageCache = new WeakMap<Forecast, LevCache>()
const cacheOf = (f: Forecast) => {
  let c = leverageCache.get(f)
  if (!c) leverageCache.set(f, (c = { pending: new Map(), done: new Map() }))
  return c
}
const leverageKey = (trade: TradeSides) => `${trade.me}:${[...trade.myRoster].sort().join(',')}|${trade.partner}:${[...trade.theirRoster].sort().join(',')}`
const leverageFor = (input: ForecastInput, f: Forecast, trade: TradeSides, key = leverageKey(trade)) => {
  const c = cacheOf(f)
  let hit = c.pending.get(key)
  if (!hit) {
    // Rating the two rosters is work too: done in idle time, one trade at a time, ahead of its simulation.
    hit = (ratingQueue = ratingQueue.catch(() => {}).then(idle))
      .then(() => {
        const run = leverageRun(input, f, trade)
        return run ? runSim(run, { urgent: false }).then((post) => (post ? leverageOf(f, trade, post) : null)) : null
      })
      .then((v) => {
        c.done.set(key, v)
        return v
      })
    c.pending.set(key, hit)
  }
  return hit
}
let ratingQueue: Promise<unknown> = Promise.resolve()
const idle = () =>
  new Promise<void>((r) => {
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }
    if (w.requestIdleCallback) w.requestIdleCallback(() => r(), { timeout: 400 })
    else window.setTimeout(r, 16)
  })

/** Both rosters after a two-team trade, each side cutting its weakest if it ends up over the limit. */
export const useTradeSides = () => {
  const { analysis } = useFantasy()
  return useCallback(
    (partner: number, give: string[], get: string[]): TradeSides | null => {
      const me = analysis.myRosterId != null ? analysis.teamById[analysis.myRosterId] : null
      const them = analysis.teamById[partner]
      if (!me || !them) return null
      const pts = analysis.horizon.perWeek
      return {
        me: me.rosterId,
        partner: them.rosterId,
        myRoster: applyTrade(me.players, give, get, analysis.capacity, pts),
        theirRoster: applyTrade(them.players, get, give, analysis.capacity, pts),
      }
    },
    [analysis],
  )
}

/**
 * Playoff and title odds before and after, for each trade (null where there is none to run), on the same simulated
 * seasons, in idle time so what shows them paints first. A trade already run shows at once: undefined only while
 * one is still simulating, null where there is no forecast to run it on.
 */
export const useLeverages = (trades: (TradeSides | null)[]): (Leverage | null | undefined)[] => {
  const { models } = useFantasy()
  const f = models.forecast
  const keys = trades.map((t) => (t ? leverageKey(t) : null))
  const sig = keys.join('~')
  // Bumped as runs land, to show them; what to show is read from the cache, never held in state that could lag it.
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!f) return
    let live = true
    const c = cacheOf(f)
    trades.forEach((t, i) => {
      const k = keys[i]
      if (!t || !k || c.done.has(k)) return
      leverageFor(models.forecastInput, f, t, k).then(() => live && setTick((x) => x + 1))
    })
    return () => {
      live = false
    }
  }, [sig, f, models.forecastInput]) // eslint-disable-line react-hooks/exhaustive-deps
  // One array for as long as nothing in it changes, so a memo that takes it holds.
  return useMemo(() => keys.map((k) => (!f || !k ? null : cacheOf(f).done.get(k))), [sig, f, tick]) // eslint-disable-line react-hooks/exhaustive-deps
}

/** One suggested trade's leverage (see useLeverages). */
const useLeverage = (idea: TradeIdea) => {
  const sidesOf = useTradeSides()
  const sides = useMemo(() => sidesOf(idea.partnerId, idea.give, idea.get), [sidesOf, idea])
  return useLeverages([sides])[0]
}

/** A change in probability as signed points: +0.9. */
const pt = (v: number | undefined) => (v === undefined ? '···' : fmtSigned(v * 100, 1))

type Signal = AcceptRead['signals'][number]

/**
 * Your call on whether they would take it. A grade pulls this manager's odds toward it from now on;
 * a reason ("won't move him", "asks too much") becomes a rule the trade read applies to every deal.
 */
const GradeBar = ({ idea, base, nm, posOf }: { idea: TradeIdea; base: AcceptRead; nm: (id: string) => string; posOf: (id: string) => string | undefined }) => {
  const { grades } = useFantasy()
  const rec = grades.all[ideaKey(idea)]
  const pick = (g: Grade) =>
    // Picking the grade you already gave takes it back.
    rec?.grade === g ? grades.set(idea, null) : grades.set(idea, { grade: g, x: base.logit, capped: base.capped || undefined, ask: base.perceivedAsk, v: PRICING_VERSION, why: g === 'yes' ? undefined : rec?.why, player: g === 'yes' ? undefined : rec?.player })
  const because = (why: GradeWhy, player?: string) =>
    rec && grades.set(idea, { grade: rec.grade, x: rec.x, capped: rec.capped, ask: rec.ask, v: rec.v, ...(rec.why === why && rec.player === player ? {} : { why, player }) })
  const givePos = [...new Set(idea.give.map(posOf).filter(Boolean))].join('/')
  const reasons: { why: GradeWhy; player?: string; label: string }[] = [
    ...idea.get.map((id) => ({ why: 'untouchable' as const, player: id, label: `won't move ${nm(id).split(' ').slice(-1)[0]}` })),
    { why: 'lopsided', label: WHY_LABEL.lopsided },
    { why: 'fit', label: `doesn't need ${givePos || 'it'}` },
    { why: 'dormant', label: WHY_LABEL.dormant },
  ]
  return (
    <div className="space-y-1.5 border-t border-ff-line px-3 py-2">
      {/* One row at any width: the question, three answers filling the space, and a mark once saved. */}
      <div className="flex items-center gap-2">
        <span className="ff-label shrink-0">Would they?</span>
        <span className="min-w-0 flex-1 max-md:[&_button]:h-11 sm:max-w-[300px]">
          <Segmented<Grade | ''>
            size="sm"
            block
            label="Would they take it?"
            manual
            value={rec?.grade ?? ''}
            onChange={(g) => g && pick(g)}
            options={[
              { key: 'yes', label: 'Yes', title: 'They would take this or close to it' },
              { key: 'maybe', label: 'Maybe', title: 'Worth a message, not a sure thing' },
              { key: 'no', label: 'No', title: 'Not happening' },
            ]}
          />
        </span>
        {rec && (
          <span className="shrink-0 font-mono text-[10px] text-ff-pos" role="status">
            saved
          </span>
        )}
      </div>
      {rec && rec.grade !== 'yes' && (
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Why not">
          <span className="mr-0.5 text-[11px] text-ff-muted">Why?</span>
          {reasons.map((r) => {
            const on = rec.why === r.why && (r.why !== 'untouchable' || rec.player === r.player)
            return (
              <button
                key={`${r.why}:${r.player ?? ''}`}
                type="button"
                aria-pressed={on}
                onClick={() => because(r.why, r.player)}
                className={cx(
                  'border px-1.5 py-0.5 text-[11px] transition-colors',
                  on ? 'border-ff-accent bg-ff-accent/10 text-ff-text' : 'border-ff-line text-ff-text2 hover:border-ff-line2 hover:text-ff-text',
                )}
              >
                {r.label}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * The other ways to land the same players from this team, as tabs under the header. Each says what it sends (its
 * shape) and what it does for you, so that there is a choice, and how the options differ, shows before any click.
 * Every tab is in the tab order; the arrow keys also step between them.
 */
const OptionTabs = ({ versions, v, setV, getName, nm }: { versions: TradeIdea[]; v: number; setV: (i: number) => void; getName: string; nm: (id: string) => string }) => {
  const id = useId()
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    e.preventDefault()
    const next = (v + step + versions.length) % versions.length
    setV(next)
    e.currentTarget.querySelectorAll('button')[next]?.focus()
  }
  return (
    <div className="border-b border-ff-line bg-ff-sunken/50 px-3 pb-2 pt-1.5">
      <div id={id} className="ff-label mb-1 truncate">
        {versions.length} ways to get {getName}
      </div>
      <div role="group" aria-labelledby={id} onKeyDown={onKey} className="grid grid-cols-[repeat(auto-fit,minmax(8.5rem,1fr))] gap-1">
        {versions.map((x, i) => {
          const on = i === v
          // What sets this option apart: the players only some options send (the rest go in every one), else its shape.
          const own = x.give.filter((p) => !versions.every((o) => o.give.includes(p)))
          return (
            <button
              key={i}
              type="button"
              aria-pressed={on}
              onClick={() => setV(i)}
              className={cx(
                'ff-press flex min-h-10 min-w-0 flex-col justify-center gap-0.5 border px-2 py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ff-accent/50 max-md:min-h-11',
                on ? 'border-ff-accent bg-ff-panel text-ff-text shadow-[inset_0_-2px_0_rgb(var(--ff-accent))]' : 'border-ff-line bg-ff-panel/60 text-ff-text2 hover:border-ff-line2 hover:bg-ff-panel hover:text-ff-text',
              )}
            >
              <span className="flex items-baseline justify-between gap-2 text-[12px] font-medium">
                <span>
                  Option {i + 1}
                  <span className="sr-only"> of {versions.length},</span>
                </span>
                <span className="num font-mono text-[10.5px]">{fmtSigned(x.myGain, 1)}/wk</span>
              </span>
              <span className="truncate text-[11px]">
                {own.length ? `with ${own.map((p) => lastName(nm(p))).join(', ')}` : `${x.give.length}-for-${x.get.length}`}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

const TradeCard = ({
  versions,
  data,
  analysis,
  tag,
  gradeMoved,
  onBuild,
}: {
  /** Ways to land the same players from the same team, best first. */
  versions: TradeIdea[]
  data: LeagueData
  analysis: Analysis
  /** A short distinction, e.g. "Best for you". */
  tag?: string
  /** Your grades moved this team's odds: the grades note on the Trades page names it. */
  gradeMoved?: 'up' | 'down'
  onBuild?: (idea: TradeIdea) => void
}) => {
  const { models, grades } = useFantasy()
  const [v, setV] = useState(0)
  const [open, setOpen] = useState(false)
  const detailId = useId()
  const idea = versions[Math.min(v, versions.length - 1)]
  const team = analysis.teamById[idea.partnerId]
  const season = analysis.seasonById[idea.partnerId]
  const players = data.players
  const nm = (id: string) => players[id]?.name ?? id
  const readOf = useTradeRead()
  // The bare read is what a new grade is measured against; the card shows it with your grades applied.
  const base = useMemo(() => readOf(idea, false), [readOf, idea])
  const read = useMemo(() => grades.apply(base, idea), [grades, base, idea])
  const lev = useLeverage(idea)
  // The deal as the builder and the comparison hold it.
  const asDeal = useMemo(() => (analysis.myRosterId != null ? dealFromIdea(analysis.myRosterId, idea.partnerId, idea.give, idea.get) : null), [analysis.myRosterId, idea])
  const odds = models.forecast?.sim[idea.partnerId]
  const mood = models.momentum.teams[idea.partnerId]
  const need = analysis.needs[idea.partnerId]?.worstPos

  // Why they would (or would not) say yes, strongest first: what the deal does for them, then who they are.
  const signals: Signal[] = []
  if (idea.fills) signals.push({ text: `fills their ${idea.fills.slot} ${idea.fills.before.toFixed(1)} → ${idea.fills.after.toFixed(1)}`, tone: 'pos' })
  if (idea.theirGain >= 0.25) signals.push({ text: `they gain ${idea.theirGain.toFixed(1)}/wk`, tone: 'pos' })
  else if (idea.theirGain <= -0.25) signals.push({ text: `they lose ${Math.abs(idea.theirGain).toFixed(1)}/wk`, tone: 'neg' })
  if (lev && Math.abs(lev.partner.playoffs) >= 0.005) signals.push({ text: `their playoff odds ${pt(lev.partner.playoffs)}pt`, tone: lev.partner.playoffs > 0 ? 'pos' : 'neg' })
  signals.push(...read.signals)
  const shown = open ? signals : signals.slice(0, 3)
  const tone = bandTone(read.band)
  const playoffTone = lev && lev.me.playoffs > 0.002 ? 'pos' : lev && lev.me.playoffs < -0.002 ? 'neg' : undefined

  return (
    <article className={cx('ff-tcard flex min-w-0 flex-col border border-ff-line bg-ff-panel transition-opacity', read.ruledOut && 'opacity-60 hover:opacity-100 focus-within:opacity-100')}>
      {/* The name and the tags share a line while the name keeps 8rem; past that the tags wrap under it. The meta
          line runs the full width below, so the tags never squeeze it, and ends in an ellipsis if it must. */}
      <header className="flex items-start gap-2 border-b border-ff-line px-3 py-2">
        <Avatar src={team?.avatar ?? null} name={team?.name ?? '?'} size={24} />
        <div className="min-w-0 flex-1 leading-tight">
          <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
            <div className="flex min-w-0 flex-[1_1_8rem] items-center gap-2 text-[13.5px] font-medium text-ff-text">
              <span className="truncate">{team?.name}</span>
              {gradeMoved && <InsightMark label={gradeMoved === 'up' ? 'odds up' : 'odds down'} title={`Your grades ${gradeMoved === 'up' ? 'raised' : 'lowered'} this team's odds`} className="max-sm:[&>span]:sr-only" />}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {tag && <Badge tone="accent">{tag}</Badge>}
              <Badge title={SHAPE_LABEL[idea.shape]}>
                {idea.give.length}-for-{idea.get.length}
              </Badge>
            </div>
          </div>
          <div className="mt-0.5 truncate font-mono text-[10.5px] text-ff-muted">
            {season && (
              <span className="text-ff-text2">
                {season.wins}-{season.losses}
                {season.ties ? `-${season.ties}` : ''}
              </span>
            )}
            {mood && mood.urgency !== 0 && (
              <span className={mood.streak > 0 ? 'text-ff-pos' : 'text-ff-neg'} title={mood.text ?? undefined}>
                {' · '}
                {streakText(mood.streak)}
              </span>
            )}
            {odds && <span>{` · PO ${simOdds(odds, 'playoffs')}`}</span>}
            {need && <span>{` · needs ${need}`}</span>}
          </div>
        </div>
      </header>

      {versions.length > 1 && <OptionTabs versions={versions} v={v} setV={setV} getName={idea.get.length === 1 ? nm(idea.get[0]) : idea.get.map((id) => lastName(nm(id))).join(' + ')} nm={nm} />}

      {/* Cards sit in a grid whose rows share the tallest card's height: this section takes up the slack, so the
          send and get columns (and the rule between them) run to the verdict and the footer stays at the bottom. They sit
          side by side once the card itself is wide enough (ff-tcard-sides, in fantasy.css), not the viewport. */}
      <div className="ff-tcard-sides grid flex-1 grid-cols-1">
        {/* Switching options swaps what you send: the column fades in afresh, so the change is seen where it happens. */}
        <div key={v} className={cx('min-w-0 border-b border-ff-line px-3 pb-1.5 pt-2', versions.length > 1 && 'ff-fade-in')}>
          <div className="ff-label">You send{versions.length > 1 && <span className="normal-case tracking-normal text-ff-accent">{` · option ${v + 1}`}</span>}</div>
          {idea.give.map((id) => (
            <PlayerLine key={id} id={id} data={data} analysis={analysis} side="give" />
          ))}
          {read.faab != null && models.faab && data.tradeFaab && (
            <div className="flex items-center gap-2.5 py-1.5" title="Sleeper trades can carry FAAB. This much makes the deal read as fair to them without giving up another player.">
              <span aria-hidden className="flex h-[34px] w-[34px] shrink-0 items-center justify-center border border-ff-line bg-ff-sunken font-mono text-[13px] text-ff-text2">
                $
              </span>
              <div className="min-w-0 flex-1 leading-tight">
                <div className="num text-[13.5px] font-medium text-ff-text">${read.faab} FAAB</div>
                <div className="truncate font-mono text-[10.5px] text-ff-muted">evens it for them · you have ${models.faab.remaining[analysis.myRosterId ?? -1] ?? 0}</div>
              </div>
            </div>
          )}
        </div>
        <div className="min-w-0 px-3 pb-1.5 pt-2">
          <div className="ff-label">You get</div>
          {idea.get.map((id) => (
            <PlayerLine key={id} id={id} data={data} analysis={analysis} notes side="get" />
          ))}
        </div>
      </div>

      {/* The verdict: what it does for your lineup, for your season, and whether it will happen. Each cell takes a wash of its verdict's colour. */}
      <div className="grid grid-cols-3 gap-px border-y border-ff-line bg-ff-line">
        <div className={cx('min-w-0 px-3 py-2.5', WASH[idea.myGain > 0 ? 'pos' : 'neg'])}>
          <Figure
            label="For you"
            size="hero"
            value={fmtSigned(idea.myGain, 1)}
            unit="/wk"
            tone={idea.myGain > 0 ? 'pos' : 'neg'}
            sub={<span className={idea.weeksBetter <= 1 && idea.weeks > 2 ? 'text-ff-warn' : undefined}>better {idea.weeksBetter} of {idea.weeks} wks</span>}
            title="Points per week added to your best lineup, averaged over the horizon"
          />
        </div>
        <div className={cx('min-w-0 px-3 py-2.5', WASH[playoffTone ?? 'none'])}>
          <Figure
            label="Playoffs"
            size="lg"
            value={lev === null ? '–' : pt(lev?.me.playoffs)}
            unit={lev ? 'pt' : undefined}
            tone={playoffTone}
            sub={lev ? (Math.abs(lev.me.title) >= 0.0005 ? `title ${pt(lev.me.title)}pt` : 'title odds unchanged') : lev === null ? 'no projections' : 'simulating'}
            title="Change in your playoff odds: the same simulated seasons, before and after"
          />
        </div>
        <div className={cx('min-w-0 px-3 py-2.5', WASH[tone])} title={`Yes-odds ${read.index}/100: their gain, how the deal looks by consensus, and how they trade`}>
          <div className="ff-label">{read.graded ? 'You said' : 'Will they'}</div>
          <div className={cx('mt-1 text-[16px] font-medium leading-none', tone === 'pos' ? 'text-ff-pos' : tone === 'warn' ? 'text-ff-warn' : 'text-ff-neg')}>
            {read.graded ? GRADE_LABEL[read.graded].toLowerCase() : read.band}
          </div>
          <span className="mt-2 block h-1 w-full max-w-[72px] bg-ff-text/10">
            <span className={cx('block h-full', tone === 'pos' ? 'bg-ff-pos' : tone === 'warn' ? 'bg-ff-warn' : 'bg-ff-neg')} style={{ width: `${Math.max(4, read.index)}%` }} />
          </span>
        </div>
      </div>

      {shown.length > 0 && (
        <div className="flex flex-wrap gap-1 px-3 py-2">
          {shown.map((r, i) => (
            // A reason wraps rather than cut off: the long ones ("would never happen: …") are the ones that matter.
            <Chip key={i} tone={r.tone} className={cx('[&>span]:whitespace-normal', !open && i >= 2 && 'max-sm:hidden')}>
              {r.tone === 'pos' ? '+ ' : r.tone === 'neg' ? '− ' : ''}
              {r.text}
            </Chip>
          ))}
        </div>
      )}

      {/* The expander names what it opens, and how many reasons are folded away (two show on a phone, three wider). */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={detailId}
        className="group flex min-h-9 w-full items-center gap-2 border-t border-ff-line px-3 text-left text-[12px] hover:bg-ff-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ff-accent/50 max-md:min-h-11"
      >
        <span className="shrink-0 font-medium text-ff-text">{open ? 'Hide details' : 'Show details'}</span>
        {!open && (
          <span className="min-w-0 truncate text-ff-muted">
            {signals.length > 2 && <span className="sm:hidden">+{signals.length - 2} reasons · </span>}
            {signals.length > 3 && <span className="max-sm:hidden">+{signals.length - 3} reasons · </span>}
            their side, value, week by week
          </span>
        )}
        <span aria-hidden className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center border border-ff-line text-ff-text2 group-hover:border-ff-line2 group-hover:text-ff-text">
          <ChevronIcon className={cx('motion-safe:transition-transform motion-safe:duration-200 motion-safe:ease-ff-out', open && 'rotate-180')} />
        </span>
      </button>

      {/* Always mounted so it can slide open: the row grows from 0 to its height, and closed it leaves the tab order. */}
      <div id={detailId} className={cx('grid transition-[grid-template-rows] duration-[220ms] ease-ff-drawer motion-reduce:transition-none', open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}>
        <div className="min-h-0 overflow-hidden" inert={!open}>
          <div className="space-y-2.5 border-t border-ff-line bg-ff-sunken/40 px-3 py-2.5 text-[11.5px] text-ff-muted">
            <div className="ff-tcard-figs grid grid-cols-2 gap-3">
              <Figure label="They gain" value={fmtSigned(idea.theirGain, 2)} unit="/wk" title="Points per week added to their best lineup" />
              <Figure
                label="Your ask"
                value={fmtSigned(idea.valueAsk, 1)}
                unit="/wk"
                title="Trade value you take minus what you send, priced as managers price players: consensus rank and draft slot counted, stars dear, streamers cheap, players they drafted dearer. Positive means you ask for a premium."
              />
              {read.perceivedAsk != null && (
                <Figure label="By consensus" value={fmtSigned(-read.perceivedAsk, 1)} unit="/wk" title="What they come out with in FantasyPros consensus value, priced the same way. Negative reads as them overpaying." />
              )}
              {lev && <Figure label="Their playoffs" value={pt(lev.partner.playoffs)} unit="pt" title="Change in their playoff odds" />}
            </div>
            <div>
              <div className="ff-label mb-1">your gain by week</div>
              <WeekBars weeks={idea.perWeek.map((w) => ({ week: w.week, value: w.mine }))} highlight={data.playoffWeeks} barWidth={7} height={28} />
            </div>
            {(idea.myCost > 0.05 || idea.myCuts.length > 0 || idea.theirCuts.length > 0) && (
              <ul className="space-y-0.5 leading-snug">
                {idea.myCost > 0.05 && (
                  <li>
                    Sending costs your lineup <span className="num text-ff-text2">{idea.myCost.toFixed(2)}</span>/wk before the return.
                  </li>
                )}
                {idea.myCuts.length > 0 && <li>You drop {idea.myCuts.map(nm).join(', ')} to make room.</li>}
                {idea.theirCuts.length > 0 && <li>They drop {idea.theirCuts.map(nm).join(', ')}.</li>}
              </ul>
            )}
          </div>
        </div>
      </div>

      <GradeBar idea={idea} base={base} nm={nm} posOf={(id) => players[id]?.pos} />

      {/* The actions, all one height (40px on a phone, 32px wider). On a narrow card they fill the row, and narrower
          still Open in builder takes a row of its own (ff-tcard-fill, in fantasy.css); share is an icon below md. */}
      {onBuild && (
        <footer className="mt-auto flex flex-wrap items-center justify-end gap-2 border-t border-ff-line px-3 py-2">
          {asDeal && <ShareTradeButton deal={asDeal} label={`Share this trade with ${team?.name ?? 'them'}`} className="md:!h-8 md:!px-3 md:!text-[12.5px]" />}
          {asDeal && <CompareToggle deal={asDeal} className="ff-tcard-fill" />}
          <Button variant="soft" className="ff-tcard-fill ff-tcard-own-row" onClick={() => onBuild(idea)} title="Open this deal in the builder to change it">
            <BuildIcon size={13} />
            Open in builder
          </Button>
        </footer>
      )}
    </article>
  )
}

export default TradeCard
