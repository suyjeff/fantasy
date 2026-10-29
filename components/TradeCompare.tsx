import React, { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AcceptRead } from '../lib/behavior'
import { bestOf, slotLetter, staleFaab, staleMoves, verdictText, type CompareItem } from '../lib/compare'
import { rostersOf, type Deal, type DealFaab, type DealMove, type DealRead, type DealSide } from '../lib/deal'
import type { Leverage, TradeSides } from '../lib/forecast'
import { isWaiverFill, makeLineupEval } from '../lib/trades'
import { formText } from '../lib/momentum'
import { useFantasy, useTradeRead } from './FantasyContext'
import { useTradeDock } from './TradeDock'
import { acceptOf, headline, useDealReader } from './TradeBuilder'
import { useLeverages, useTradeSides } from './TradeCard'
import PlayerName from './PlayerName'
import { Disclosure } from './Disclosure'
import { BuildIcon, TradeIcon } from './icons'
import { SlotKey, useCompare } from './useCompare'
import { Avatar, Button, Chip, PlayerAvatar, cx, fmt, fmtSigned, isOut, pct, usePhone } from './ui'

// The Compare tab: up to four trades side by side, to answer "which of these should I make?". A sentence first (the
// verdict), then one column per trade, each row a measure with the best of it marked, then the trades' lineup gain
// week by week on one chart. The trades themselves live in the comparison set (useCompare, lib/compare), as deals:
// everything here is priced afresh from them, with the builder's own pricing, kept per deal.

type Col = {
  item: CompareItem
  letter: string
  /** The other teams in the deal. */
  partners: number[]
  /** Moves it can no longer make. */
  stale: DealMove[]
  /** FAAB payments it can no longer make (more than the payer has left). */
  broke: DealFaab[]
  /** Either of those: out of date, and left out of every figure. */
  out: boolean
  read: DealRead | null
  mine: DealSide | null
  accept: Record<number, AcceptRead>
  odds: number | null
  /** Playoff odds before and after: undefined while simulating, null when there is none (not two teams, no forecast). */
  lev: Leverage | null | undefined
  two: boolean
}

type Tone = 'pos' | 'neg' | 'neutral'
const toneOf = (v: number, edge = 0.25): Tone => (v > edge ? 'pos' : v < -edge ? 'neg' : 'neutral')
const TEXT: Record<Tone, string> = {
  pos: 'text-ff-pos',
  neg: 'text-ff-neg',
  neutral: 'text-ff-text',
}
// The chart-series set each theme carries (--ff-k1..4, validated per theme in lib/themes), one per comparison slot: a
// trade keeps its colour. Each slot has a dash of its own as well, so two lines are told apart without colour too.
const ink = (slot: number) => `rgb(var(--ff-k${slot + 1}))`
const DASH = ['', '7 4', '1.5 4', '10 3 1.5 3']
const dashOf = (slot: number) => DASH[slot] || undefined

/** A series' key: a short stretch of its line, colour and dash, for the legend and the crosshair's readout. */
const LineKey = ({ slot }: { slot: number }) => (
  <svg aria-hidden width="18" height="6" viewBox="0 0 18 6" className="block shrink-0">
    <path d="M1 3h16" stroke={ink(slot)} strokeWidth={2} strokeLinecap="round" strokeDasharray={dashOf(slot)} />
  </svg>
)
const EMPTY: CompareItem[] = []
const slotName = (s: string) => s.replace('SUPER_FLEX', 'SF').replace('REC_FLEX', 'R-FLEX').replace('WRRB_FLEX', 'W/R')

// ---- Who starts ----

type StarterChange = {
  kind: 'in' | 'out' | 'bench' | 'filled' | 'hole'
  id?: string
  slot: string
  /** Leaves his slot to a waiver pickup. */ wire?: boolean
}
/**
 * Kept against the points per week the lineups are set on, which are rebuilt with the rosters and slots behind them
 * (new league data) but kept across power-weight changes (withWeights), which move no starter.
 */
const startersCache = new WeakMap<object, WeakMap<Deal, StarterChange[]>>()

/** Which of your starters change, on the average week: who comes into the lineup and who leaves it. */
const useStarterChanges = () => {
  const { data, analysis } = useFantasy()
  const { slots, horizon, horizonReplacement, teamById } = analysis
  return useMemo(() => {
    const ev = makeLineupEval(slots, data.players, horizon.perWeek, horizonReplacement)
    let byDeal = startersCache.get(horizon.perWeek)
    if (!byDeal) startersCache.set(horizon.perWeek, (byDeal = new WeakMap()))
    const cache = byDeal
    return (deal: Deal, side: DealSide): StarterChange[] => {
      const hit = cache.get(deal)
      if (hit) return hit
      const roster = teamById[side.rosterId]?.players ?? []
      const after = roster.filter((id) => !side.sends.includes(id) && !side.cuts.includes(id)).concat(side.receives.filter((id) => !roster.includes(id)))
      const lineup = (ids: string[]) =>
        ev.assign(ids).assignments.map((p, i) => ({
          id: p?.id ?? null,
          slot: slotName(slots[i]?.name ?? ''),
        }))
      const before = lineup(roster)
      const next = lineup(after)
      const has = (xs: typeof before, id: string) => xs.some((x) => x.id === id)
      const out: StarterChange[] = []
      for (const x of next) if (x.id && !isWaiverFill(x.id) && !has(before, x.id)) out.push({ kind: 'in', id: x.id, slot: x.slot })
      for (const x of before) if (x.id && !isWaiverFill(x.id) && !has(next, x.id)) out.push({ kind: 'out', id: x.id, slot: x.slot })
      // A slot the wire was filling, now filled from the roster (or the other way round).
      const holes = (xs: typeof before) => xs.filter((x) => x.id && isWaiverFill(x.id)).map((x) => x.slot)
      const h0 = holes(before)
      const h1 = holes(next)
      // A hole a new starter fills is said by his line ("+ Purdy QB"); one a departing starter leaves, by his.
      for (const s of h0) if (h1.indexOf(s) < 0 && !out.some((x) => x.kind === 'in' && x.slot === s)) out.push({ kind: 'filled', slot: s })
      for (const s of h1)
        if (h0.indexOf(s) < 0) {
          const left = out.find((x) => x.kind === 'out' && x.slot === s && !x.wire)
          if (left) left.wire = true
          else out.push({ kind: 'hole', slot: s })
        }
      for (const id of side.receives) if (!has(next, id)) out.push({ kind: 'bench', id, slot: data.players[id]?.pos ?? '' })
      cache.set(deal, out)
      return out
    }
  }, [slots, horizon, horizonReplacement, teamById, data.players])
}

// ---- Small pieces ----

/** The mark on a row's best value: a word as well as the wash, so it never rests on colour alone. */
const Best = ({ word = 'best' }: { word?: string }) => (
  <span className="ml-1.5 inline-flex items-center gap-0.5 border border-ff-pos/35 px-1 align-[2px] font-mono text-[9.5px] uppercase leading-[15px] tracking-[0.04em] text-ff-pos">
    <span aria-hidden>▲</span>
    {word}
  </span>
)

/** Shown where a figure is still coming: the same size as the figure, so nothing moves when it lands. */
const Wait = ({ sub }: { sub: string }) => (
  <>
    <span className="num block text-[18px] leading-6 text-ff-muted">···</span>
    <span className="block font-mono text-[10.5px] text-ff-muted">{sub}</span>
  </>
)
const Dash = ({ sub }: { sub: string }) => (
  <>
    <span className="num block text-[18px] leading-6 text-ff-muted">–</span>
    <span className="block font-mono text-[10.5px] text-ff-muted">{sub}</span>
  </>
)

const Figure = ({ value, unit, tone = 'neutral', sub, best }: { value: string; unit?: string; tone?: Tone; sub?: ReactNode; best?: string | null }) => (
  <>
    <span className="block whitespace-nowrap leading-6">
      <span className={cx('num text-[18px] font-medium', TEXT[tone])}>{value}</span>
      {unit && <span className={cx('font-mono text-[10.5px] text-ff-muted', unit.startsWith('/') ? 'ml-0.5' : 'ml-1')}>{unit}</span>}
      {best && <Best word={best} />}
    </span>
    {sub != null && <span className="block font-mono text-[10.5px] text-ff-muted">{sub}</span>}
  </>
)

const IconBtn = ({ label, onClick, children, disabled, danger }: { label: string; onClick: () => void; children: ReactNode; disabled?: boolean; danger?: boolean }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    aria-label={label}
    title={label}
    className={cx(
      'ff-press flex h-10 min-w-0 flex-1 items-center justify-center border border-ff-line text-[13px] text-ff-text2 hover:bg-ff-raised hover:text-ff-text disabled:pointer-events-none disabled:opacity-35 md:h-8',
      danger && 'hover:!text-ff-neg',
    )}
  >
    {children}
  </button>
)

// ---- The chart ----

const niceStep = (range: number) => {
  const raw = range / 4
  const pow = 10 ** Math.floor(Math.log10(Math.max(raw, 0.01)))
  return ([1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow) as number
}

type Series = {
  key: string
  slot: number
  letter: string
  name: string
  values: { week: number; delta: number }[]
}

/**
 * Your lineup's gain from each trade, week by week: one line per trade in its own colour, the zero line drawn
 * stronger, the playoff weeks shaded. A crosshair follows the pointer (or a tap, or the arrow keys) with every trade's
 * figure for that week; letters at the line ends name the trades where they do not collide, the legend always does.
 */
const LineupChart = ({ series, playoffWeeks }: { series: Series[]; playoffWeeks: number[] }) => {
  const box = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(640)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => el.clientWidth && setW(el.clientWidth))
    ro.observe(el)
    if (el.clientWidth) setW(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  const [hover, setHover] = useState<number | null>(null)
  const weeks = useMemo(() => [...new Set(series.flatMap((s) => s.values.map((v) => v.week)))].sort((a, b) => a - b), [series])
  if (!weeks.length) return null
  const all = series.flatMap((s) => s.values.map((v) => v.delta))
  const step = niceStep(Math.max(1, Math.max(0, ...all) - Math.min(0, ...all)))
  const lo = Math.min(0, Math.floor(Math.min(...all) / step) * step)
  const hi = Math.max(step, Math.ceil(Math.max(...all) / step) * step)
  const H = w >= 640 ? 220 : 188
  const pad = { l: 34, r: 22, t: 14, b: 22 }
  const iw = Math.max(40, w - pad.l - pad.r)
  const ih = H - pad.t - pad.b
  const x = (i: number) => pad.l + (weeks.length === 1 ? iw / 2 : (i / (weeks.length - 1)) * iw)
  const y = (v: number) => pad.t + ih - ((v - lo) / (hi - lo || 1)) * ih
  const ticks: number[] = []
  for (let t = lo; t <= hi + 1e-9; t += step) ticks.push(Math.round(t * 100) / 100)
  const at = (s: Series, wk: number) => s.values.find((v) => v.week === wk)?.delta
  const band = playoffWeeks.filter((wk) => weeks.includes(wk))
  const bandFrom = band.length ? x(weeks.indexOf(Math.min(...band))) - (weeks.length > 1 ? iw / (weeks.length - 1) / 2 : 0) : 0
  // End letters, every one of them: where two would sit on each other they are nudged apart (a line's dot stays on
  // its line), so no line is left to its colour to be told by.
  const ends: ({ yy: number } | null)[] = series.map(() => null)
  const order = series
    .map((s, i) => ({ i, v: s.values[s.values.length - 1]?.delta }))
    .filter((e): e is { i: number; v: number } => e.v != null)
    .sort((a, b) => y(a.v) - y(b.v))
  let prev = -Infinity
  for (const e of order) {
    const yy = Math.max(y(e.v), prev + 11)
    ends[e.i] = { yy }
    prev = yy
  }
  // Pushed past the bottom: shift the run back up.
  const over = prev - (pad.t + ih + 6)
  if (over > 0) for (const e of ends) if (e) e.yy -= over
  const pick = (clientX: number) => {
    const r = box.current?.getBoundingClientRect()
    if (!r) return
    const rel = clientX - r.left - pad.l
    const i = weeks.length === 1 ? 0 : Math.round((rel / iw) * (weeks.length - 1))
    setHover(Math.max(0, Math.min(weeks.length - 1, i)))
  }
  const hw = hover != null ? weeks[hover] : null
  const flip = hover != null && x(hover) > w * 0.6
  return (
    <div
      ref={box}
      className="relative touch-pan-y select-none outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ff-accent"
      tabIndex={0}
      role="group"
      aria-label={`Your lineup gain by week, for each trade. ${series.map((s) => `Trade ${s.letter}: ${s.values.map((v) => `week ${v.week} ${fmtSigned(v.delta, 1)}`).join(', ')}`).join('. ')}`}
      onPointerMove={(e) => pick(e.clientX)}
      onPointerDown={(e) => pick(e.clientX)}
      onPointerLeave={(e) => e.pointerType === 'mouse' && setHover(null)}
      onBlur={() => setHover(null)}
      onKeyDown={(e) => {
        const n = weeks.length
        if (e.key === 'ArrowRight') setHover((h) => (h == null ? 0 : Math.min(n - 1, h + 1)))
        else if (e.key === 'ArrowLeft') setHover((h) => (h == null ? n - 1 : Math.max(0, h - 1)))
        else if (e.key === 'Escape') setHover(null)
        else return
        e.preventDefault()
      }}
    >
      <svg width={w} height={H} className="block" aria-hidden>
        {band.length > 0 && (
          <g>
            <rect x={bandFrom} y={pad.t} width={Math.max(0, pad.l + iw + (weeks.length > 1 ? iw / (weeks.length - 1) / 2 : 0) - bandFrom)} height={ih} className="fill-ff-text/[0.04]" />
            <text x={bandFrom + 4} y={pad.t - 4} className="fill-ff-muted font-mono text-[9.5px]">
              playoffs
            </text>
          </g>
        )}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={pad.l + iw} y1={y(t)} y2={y(t)} className={t === 0 ? 'stroke-ff-text2/40' : 'stroke-ff-line'} strokeWidth={1} />
            <text x={pad.l - 6} y={y(t) + 3} textAnchor="end" className="fill-ff-muted font-mono text-[9.5px]">
              {t === 0 ? '0' : fmtSigned(t, Number.isInteger(step) ? 0 : 1)}
            </text>
          </g>
        ))}
        {weeks.map((wk, i) =>
          weeks.length <= 10 || i % 2 === 0 || i === weeks.length - 1 ? (
            <text key={wk} x={x(i)} y={H - 6} textAnchor="middle" className="fill-ff-muted font-mono text-[9.5px]">
              {i === 0 ? `wk ${wk}` : wk}
            </text>
          ) : null,
        )}
        {hover != null && <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + ih} className="stroke-ff-text2/50" strokeWidth={1} />}
        {series.map((s, si) => {
          const pts = weeks.map((wk, i) => [x(i), at(s, wk)] as const).filter((p): p is readonly [number, number] => p[1] != null)
          const last = pts[pts.length - 1]
          const end = ends[si]
          return (
            <g key={s.key}>
              <path
                d={pts.map(([px, v], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${y(v).toFixed(1)}`).join(' ')}
                fill="none"
                stroke={ink(s.slot)}
                strokeWidth={2}
                strokeDasharray={dashOf(s.slot)}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {last && <circle cx={last[0]} cy={y(last[1])} r={4} fill={ink(s.slot)} className="stroke-ff-panel" strokeWidth={2} />}
              {last && end && (
                <text x={last[0] + 8} y={end.yy + 3.5} className="fill-ff-text2 font-mono text-[10.5px] font-medium">
                  {s.letter}
                </text>
              )}
              {hw != null && at(s, hw) != null && <circle cx={x(hover!)} cy={y(at(s, hw)!)} r={4} fill={ink(s.slot)} className="stroke-ff-panel" strokeWidth={2} />}
            </g>
          )
        })}
      </svg>
      {hw != null && (
        <div
          className="pointer-events-none absolute z-10 min-w-[132px] border border-ff-line2 bg-ff-panel px-2.5 py-1.5 shadow-[0_8px_24px_-8px_rgba(0,0,0,0.35)]"
          style={{
            top: pad.t,
            left: flip ? undefined : x(hover!) + 10,
            right: flip ? w - x(hover!) + 10 : undefined,
          }}
        >
          <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.06em] text-ff-muted">
            Week {hw}
            {playoffWeeks.includes(hw) && ' · playoffs'}
          </div>
          {series.map((s) => {
            const v = at(s, hw)
            return (
              <div key={s.key} className="flex items-center gap-2 py-px">
                <LineKey slot={s.slot} />
                <span className={cx('num w-12 text-[12.5px] font-medium', v == null ? 'text-ff-muted' : TEXT[toneOf(v)])}>{v == null ? '–' : fmtSigned(v, 1)}</span>
                <span className="font-mono text-[10.5px] text-ff-text2">Trade {s.letter}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ---- The view ----

const CompareView = ({ onSuggested }: { onSuggested: () => void }) => {
  const { data, analysis, models } = useFantasy()
  const c = useCompare()
  const dock = useTradeDock()
  const phone = usePhone()
  const me = analysis.myRosterId ?? -1
  const items = c?.items ?? EMPTY
  const teams = analysis.teams
  const rosters = useMemo(() => rostersOf({ teams }), [teams])
  // What each team has left to pay with, where trades carry FAAB.
  const remaining = data.tradeFaab ? models.faab?.remaining : null
  const reader = useDealReader()
  const tradeRead = useTradeRead()
  const starters = useStarterChanges()
  const sidesOf = useTradeSides()
  const base = useMemo(
    () =>
      items.map((item) => {
        const stale = staleMoves(item.deal, rosters)
        const broke = staleFaab(item.deal, rosters, remaining)
        const out = stale.length + broke.length > 0
        const partners = item.deal.teams.filter((t) => t !== me)
        const two = item.deal.teams.length === 2 && item.deal.teams.includes(me)
        const give = item.deal.moves.filter((m) => m.from === me).map((m) => m.player)
        const get = item.deal.moves.filter((m) => m.to === me).map((m) => m.player)
        const sides: TradeSides | null = two && !out ? sidesOf(partners[0], give, get) : null
        return { item, stale, broke, out, partners, two, sides }
      }),
    [items, rosters, remaining, me, sidesOf],
  )
  const levs = useLeverages(base.map((b) => b.sides))
  const cols: Col[] = useMemo(
    () =>
      base.map((b, i) => {
        const priced = b.out ? null : reader.read(b.item.deal)
        const mine = priced?.sides.find((s) => s.rosterId === me) ?? null
        const { accept, odds } = priced ? acceptOf(priced, me, tradeRead) : { accept: {}, odds: null }
        return {
          item: b.item,
          letter: slotLetter(b.item.slot),
          partners: b.partners,
          stale: b.stale,
          broke: b.broke,
          out: b.out,
          read: priced,
          mine,
          accept,
          odds,
          lev: b.sides ? levs[i] : null,
          two: b.two,
        }
      }),
    [base, reader, me, tradeRead, levs],
  )

  // Each row's figures, for the marks: a trade out of date (or not yet priced) takes no part.
  const usable = (col: Col) => !col.out && !!col.mine
  const lineupOf = (col: Col) => (usable(col) ? headline(col.mine!) : null)
  const consensusOf = (col: Col) => {
    const xs = Object.values(col.accept).map((a) => a.perceivedAsk)
    return usable(col) && xs.length && xs.every((x) => x != null) ? xs.reduce((a, x) => a + (x as number), 0) : null
  }
  const best = {
    lineup: bestOf(cols.map(lineupOf), 'high', 0.1),
    weeks: bestOf(
      cols.map((col) => (usable(col) ? col.mine!.weeksBetter : null)),
      'high',
      0,
    ),
    playoffs: bestOf(
      cols.map((col) => (usable(col) && col.lev ? col.lev.me.playoffs : null)),
      'high',
      0.0025,
    ),
    ask: bestOf(
      cols.map((col) => (usable(col) ? col.mine!.value : null)),
      'high',
      0.1,
    ),
    consensus: bestOf(cols.map(consensusOf), 'high', 0.1),
    odds: bestOf(
      cols.map((col) => (usable(col) ? col.odds : null)),
      'high',
      0.02,
    ),
  }
  const verdict = verdictText(
    cols.map((col) => ({
      label: `Trade ${col.letter}`,
      lineup: lineupOf(col),
      odds: usable(col) ? col.odds : null,
      playoffs: usable(col) && col.lev ? col.lev.me.playoffs : null,
      out: col.out,
      // Priced at once when it can be: a trade with no figure has none to come.
      unpriced: col.out || col.mine ? undefined : !data.horizon.length ? 'season' : 'yours',
    })),
  )
  const anyMany = cols.some((col) => !col.two)
  const nameOf = (t: number) => (t === me ? 'You' : (analysis.teamById[t]?.name ?? `#${t}`))
  const openIn = (deal: Deal) => dock?.open(deal)
  const chartId = useId()

  // The trades' names stay in view while the rows scroll under the page's tabs: a copy of the header row sticks
  // there once the real one has scrolled away, moved sideways with the table as it scrolls.
  const scroller = useRef<HTMLDivElement>(null)
  const headCell = useRef<HTMLDivElement>(null)
  const cloneRow = useRef<HTMLDivElement>(null)
  const cloneLabel = useRef<HTMLDivElement>(null)
  const [stickAt, setStickAt] = useState(0)
  const [stuck, setStuck] = useState(false)
  const n = cols.length
  useEffect(() => {
    const tabs = document.querySelector<HTMLElement>('.ff-pagetabs')
    const measure = () => tabs && setStickAt((parseFloat(getComputedStyle(tabs).top) || 0) + tabs.offsetHeight)
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])
  useEffect(() => {
    const el = headCell.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => setStuck(!e.isIntersecting && e.boundingClientRect.top < stickAt), { rootMargin: `-${stickAt}px 0px 0px 0px` })
    io.observe(el)
    return () => io.disconnect()
  }, [stickAt, n])
  useEffect(() => {
    const sc = scroller.current
    if (!sc || !stuck) return
    const sync = () => {
      const x = sc.scrollLeft
      if (cloneRow.current) cloneRow.current.style.transform = `translateX(${-x}px)`
      if (cloneLabel.current) cloneLabel.current.style.transform = `translateX(${x}px)`
    }
    sync()
    sc.addEventListener('scroll', sync, { passive: true })
    return () => sc.removeEventListener('scroll', sync)
  }, [stuck])

  if (!c) return null
  if (!items.length)
    return (
      <div className="border border-dashed border-ff-line2 px-4 py-10 text-center">
        <span aria-hidden className="mx-auto mb-3 flex h-10 w-10 items-center justify-center border border-ff-line2 text-ff-muted">
          <TradeIcon size={16} />
        </span>
        <p className="text-[14px] font-medium text-ff-text">Compare trades side by side</p>
        <p className="mx-auto mt-1 max-w-[440px] text-[13px] leading-relaxed text-ff-muted">
          Put up to four trades next to each other and see which one to make: what each does for your lineup and your playoff odds, its value, and how likely it is to be accepted. Add a trade with{' '}
          <span className="text-ff-text2">Add to compare</span> in the builder, or <span className="text-ff-text2">Compare</span> on a suggested trade.
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          {dock && (
            <Button variant="aqua" onClick={() => dock.open()}>
              <TradeIcon size={14} />
              Build a trade
            </Button>
          )}
          <Button onClick={onSuggested}>See suggested trades</Button>
        </div>
      </div>
    )

  // The empty column on a wide screen is where the next trade goes; a phone has a button under the table instead.
  const addCol = !phone && n < 4
  const template = `var(--lab) repeat(${n}, minmax(var(--col), 1fr))${addCol ? ' minmax(var(--col), 1fr)' : ''}`
  type Row = {
    key: string
    label: ReactNode
    hint?: string
    cell: (col: Col, i: number) => ReactNode
    best?: number[]
  }
  const cellWait = (col: Col) => (col.out ? <Dash sub="out of date" /> : !col.mine ? <Dash sub="not priced" /> : null)

  const playerLine = (id: string, moved: boolean) => {
    const p = data.players[id]
    const owner = analysis.rosteredBy[id]
    // Someone who has moved: struck through, and where he is now, in place of his line.
    if (moved)
      return (
        <li key={id} className="flex min-w-0 items-center gap-2 py-0.5">
          <PlayerAvatar id={id} player={p} size={22} className="opacity-60" />
          <span className="min-w-0 leading-tight">
            <span className="block truncate text-[13px] text-ff-text2 line-through decoration-ff-warn">{p?.name ?? id}</span>
            <span className="block truncate font-mono text-[10.5px] text-ff-warn">now {owner == null ? 'a free agent' : nameOf(owner)}</span>
          </span>
        </li>
      )
    return (
      <li key={id} className="min-w-0 py-0.5">
        <PlayerName player={p} id={id} size={22} className="text-[12.5px]" sub={`${fmt(analysis.horizon.perWeek[id])}/wk`} />
      </li>
    )
  }
  const faabLine = (dollars: number, dir: 'out' | 'in') =>
    dollars > 0 && (
      <li className="flex items-center gap-2 py-0.5 text-[12.5px] text-ff-text">
        <span aria-hidden className="flex h-[22px] w-[22px] shrink-0 items-center justify-center border border-ff-line2 bg-ff-sunken font-mono text-[11px] text-ff-text2">
          $
        </span>
        <span className="num">${dollars}</span>
        <span className="font-mono text-[10.5px] text-ff-muted">FAAB {dir === 'out' ? 'out' : 'in'}</span>
      </li>
    )
  const flow = (col: Col, dir: 'send' | 'get') => {
    const moves = col.item.deal.moves.filter((m) => (dir === 'send' ? m.from === me : m.to === me))
    const dollars = col.item.deal.faab.reduce((a, x) => a + (dir === 'send' ? (x.from === me ? x.dollars : 0) : x.to === me ? x.dollars : 0), 0)
    if (!moves.length && !dollars) return <span className="text-[12px] text-ff-muted">Nothing</span>
    return (
      <ul className="min-w-0">
        {moves.map((m) => playerLine(m.player, col.stale.includes(m) && !(rosters[m.from] ?? []).includes(m.player)))}
        {faabLine(dollars, dir === 'send' ? 'out' : 'in')}
      </ul>
    )
  }
  const flags = (col: Col) => {
    if (col.out)
      return (
        <p className="text-[12px] leading-snug text-ff-warn">
          {!col.stale.length
            ? 'It pays more FAAB than is left to pay with.'
            : `${col.stale.length === 1 ? `${data.players[col.stale[0].player]?.name ?? 'A player'} has moved` : `${col.stale.length} players have moved`} since you added it.`}
        </p>
      )
    const mine = col.mine
    if (!mine) return null
    const out: {
      text: string
      tone: 'pos' | 'neg' | 'warn' | 'neutral'
      title?: string
    }[] = []
    for (const id of mine.receives) {
      const inj = data.players[id]?.injury
      if (inj)
        out.push({
          text: `${data.players[id]?.name.split(' ').slice(-1)[0]} ${inj.slice(0, 3).toUpperCase()}`,
          tone: isOut(inj) ? 'neg' : 'warn',
          title: `${data.players[id]?.name}: ${inj}`,
        })
    }
    for (const id of [...mine.receives, ...mine.sends]) {
      const f = analysis.form[id]
      if (!f) continue
      const getting = mine.receives.includes(id)
      const good = getting ? f.kind === 'buy-low' : f.kind === 'sell-high'
      const word = getting ? (f.kind === 'buy-low' ? 'buy low' : 'buying high') : f.kind === 'sell-high' ? 'sell high' : 'selling low'
      out.push({
        text: `${word}: ${f.name}`,
        tone: good ? 'pos' : 'warn',
        title: formText(f),
      })
    }
    if (mine.weeksBetter <= 1 && mine.perWeek.length > 2)
      out.push({
        text: `helps ${mine.weeksBetter} week${mine.weeksBetter === 1 ? '' : 's'}`,
        tone: 'warn',
        title: 'Better in one week at most: a bye patch, not an upgrade',
      })
    if (mine.cuts.length)
      out.push({
        text: `you cut ${mine.cuts.map((id) => data.players[id]?.name.split(' ').slice(-1)[0] ?? id).join(', ')}`,
        tone: 'neutral',
        title: 'Players you would drop to stay under the roster limit',
      })
    for (const s of col.read?.sides ?? []) for (const p of s.problems) out.push({ text: p, tone: 'neg' })
    if (!out.length) return <span className="text-[12px] text-ff-muted">None</span>
    return (
      <div className="flex flex-wrap gap-1">
        {out.map((f) => (
          <Chip key={f.text} tone={f.tone} title={f.title} className="!text-[11px]">
            {f.text}
          </Chip>
        ))}
      </div>
    )
  }

  const rows: Row[] = [
    { key: 'send', label: 'You send', cell: (col) => flow(col, 'send') },
    { key: 'get', label: 'You get', cell: (col) => flow(col, 'get') },
    {
      key: 'lineup',
      label: 'For your lineup',
      hint: 'Points per week added to your best lineup, averaged over the weeks left; FAAB counted when it moves',
      best: best.lineup,
      cell: (col, i) => {
        const wait = cellWait(col)
        if (wait) return wait
        const m = col.mine!
        const v = headline(m)!
        const ds = m.perWeek.map((w) => w.delta)
        return (
          <Figure
            value={fmtSigned(v, 1)}
            unit="/wk"
            tone={toneOf(v)}
            best={best.lineup.includes(i) ? 'most' : null}
            sub={m.faab ? `${fmtSigned(m.net.low, 1)} to ${fmtSigned(m.net.high, 1)} w/ FAAB` : ds.length > 1 ? `wk ${fmtSigned(Math.min(...ds), 1)} to ${fmtSigned(Math.max(...ds), 1)}` : null}
          />
        )
      },
    },
    {
      key: 'weeks',
      label: 'Weeks better',
      hint: 'Weeks of those left in which your lineup comes out ahead',
      best: best.weeks,
      cell: (col, i) => cellWait(col) ?? <Figure value={String(col.mine!.weeksBetter)} unit={`of ${col.mine!.perWeek.length}`} best={best.weeks.includes(i) ? 'most' : null} />,
    },
    {
      key: 'playoffs',
      label: 'Playoff odds',
      hint: 'Change in your playoff odds: the same simulated seasons, before and after',
      best: best.playoffs,
      cell: (col, i) => {
        if (col.out) return <Dash sub="out of date" />
        if (!col.two) return <Dash sub="two-team trades only" />
        if (col.lev === undefined) return <Wait sub="simulating" />
        if (!col.lev) return <Dash sub="no projections" />
        const v = col.lev.me.playoffs * 100
        return (
          <Figure
            value={fmtSigned(v, 1)}
            unit="pt"
            tone={toneOf(v, 0.2)}
            best={best.playoffs.includes(i) ? 'best' : null}
            sub={Math.abs(col.lev.me.title) >= 0.0005 ? `title ${fmtSigned(col.lev.me.title * 100, 1)}pt` : 'title odds unchanged'}
          />
        )
      },
    },
    {
      key: 'ask',
      label: 'Value: your ask',
      hint: 'Trade value you take minus what you send, as managers price players. Positive: you ask for a premium',
      best: best.ask,
      cell: (col, i) => cellWait(col) ?? <Figure value={fmtSigned(col.mine!.value, 1)} unit="/wk" best={best.ask.includes(i) ? 'most' : null} />,
    },
    {
      key: 'consensus',
      label: 'Value: consensus',
      hint: 'What you come out with in FantasyPros consensus value, priced the same way',
      best: best.consensus,
      cell: (col, i) => {
        const wait = cellWait(col)
        if (wait) return wait
        const v = consensusOf(col)
        return v == null ? <Dash sub="no consensus ranks" /> : <Figure value={fmtSigned(v, 1)} unit="/wk" best={best.consensus.includes(i) ? 'most' : null} />
      },
    },
    {
      key: 'odds',
      label: anyMany ? 'Would they? / all say yes' : 'Would they?',
      hint: 'How likely they are to say yes: their gain, how the deal looks by consensus, and how they trade. With more than one other team, every one of them saying yes',
      best: best.odds,
      cell: (col, i) => {
        const wait = cellWait(col)
        if (wait) return wait
        if (col.odds == null) return <Dash sub="–" />
        const a = Object.values(col.accept)
        const band = col.two && a[0] ? a[0].band : `${a.length} teams`
        const why = a[0]?.signals[0]?.text
        return (
          <>
            <Figure value={pct(col.odds)} tone={col.odds >= 0.5 ? 'pos' : col.odds < 0.25 ? 'neg' : 'neutral'} best={best.odds.includes(i) ? 'likeliest' : null} sub={band} />
            {why && <span className="mt-0.5 block text-[11px] leading-snug text-ff-text2">{why}</span>}
          </>
        )
      },
    },
    {
      key: 'starters',
      label: 'Your starters',
      hint: 'Who comes into and leaves your best lineup on an average week',
      cell: (col) => {
        if (col.out) return <span className="text-[12px] text-ff-muted">–</span>
        if (!col.mine) return <span className="text-[12px] text-ff-muted">–</span>
        const ch = starters(col.item.deal, col.mine)
        if (!ch.length) return <span className="text-[12px] text-ff-muted">No change</span>
        const nm = (id?: string) => (id ? (data.players[id]?.name ?? id) : '')
        return (
          <ul className="space-y-0.5 text-[12px] leading-snug">
            {ch.map((x, k) => (
              <li key={k} className="flex min-w-0 items-baseline gap-1.5">
                <span aria-hidden className={cx('w-2.5 shrink-0 text-center font-mono', x.kind === 'in' || x.kind === 'filled' ? 'text-ff-pos' : x.kind === 'bench' ? 'text-ff-muted' : 'text-ff-neg')}>
                  {x.kind === 'in' || x.kind === 'filled' ? '+' : x.kind === 'bench' ? '·' : '−'}
                </span>
                <span className="min-w-0 text-ff-text">
                  {x.kind === 'filled' ? `fills the hole at ${x.slot}` : x.kind === 'hole' ? `leaves ${x.slot} to the wire` : nm(x.id)}
                  <span className="sr-only">{x.kind === 'in' ? ' starts' : x.kind === 'out' ? ' leaves the lineup' : x.kind === 'bench' ? ' to your bench' : ''}</span>
                </span>
                {x.id && (
                  <span className="ml-auto shrink-0 font-mono text-[10px] text-ff-muted" title={x.wire ? `His ${x.slot} spot goes to a waiver pickup` : undefined}>
                    {x.kind === 'bench' ? 'bench' : x.wire ? `${x.slot}→FA` : x.slot}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )
      },
    },
    {
      key: 'flags',
      label: 'Flags',
      hint: 'Injuries, buy-low or sell-high timing, players you would cut, and anything wrong with the deal',
      cell: flags,
    },
  ]

  const head = (col: Col, i: number) => {
    const many = col.partners.length > 1
    const moves = col.item.deal.moves
    const out = moves.filter((m) => m.from === me).length
    const back = moves.filter((m) => m.to === me).length
    // Named by what you get, as the legend and the stuck copy of this row name it (the partner is often the same in
    // every column), with whom on the line under. Both wrap rather than cut a name short.
    return (
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex min-w-0 items-start gap-2">
          <span className="flex h-6 shrink-0 items-center gap-1.5 border border-ff-line2 px-1.5 font-mono text-[11.5px] font-medium text-ff-text">
            <SlotKey slot={col.item.slot} />
            {col.letter}
          </span>
          <span className="min-w-0 pt-[3px] text-[13px] font-medium leading-snug text-ff-text">{getsOf(col)}</span>
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-[12px] leading-snug text-ff-text2">
          {!many && <Avatar src={analysis.teamById[col.partners[0]]?.avatar ?? null} name={nameOf(col.partners[0])} size={16} />}
          <span className="min-w-0 [overflow-wrap:anywhere]">with {col.partners.map(nameOf).join(' + ')}</span>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 font-mono text-[10.5px] text-ff-muted">
          <span>{many ? `${col.item.deal.teams.length}-team · ${moves.length} players` : `${out}-for-${back}`}</span>
          {col.out && <span className="border border-ff-warn/40 bg-ff-warn/10 px-1 leading-[16px] text-ff-warn">out of date</span>}
          {best.lineup.includes(i) && best.odds.includes(i) && <span className="text-ff-pos">· top pick</span>}
        </div>
      </div>
    )
  }
  const actions = (col: Col, i: number) => (
    <div className="flex flex-col gap-1.5">
      <Button
        size="sm"
        variant={col.out ? 'aqua' : 'outline'}
        className={cx('w-full', col.out && 'ff-aqua-soft')}
        onClick={() => openIn(col.item.deal)}
        title={col.out ? 'Open it in the builder to change what can no longer be done' : 'Open this trade in the builder'}
      >
        <BuildIcon size={12} />
        {col.out ? 'Open to fix' : 'Open in builder'}
      </Button>
      <div className="flex gap-1">
        <IconBtn label={`Move trade ${col.letter} left`} onClick={() => c.move(col.item.id, -1)} disabled={i === 0}>
          ←
        </IconBtn>
        <IconBtn label={`Move trade ${col.letter} right`} onClick={() => c.move(col.item.id, 1)} disabled={i === n - 1}>
          →
        </IconBtn>
        <IconBtn label={`Remove trade ${col.letter} from compare`} onClick={() => c.remove(col.item.id)} danger>
          <svg aria-hidden width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square">
            <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" />
          </svg>
        </IconBtn>
      </div>
    </div>
  )

  const labelCell = (key: string, label: ReactNode, hint?: string) => (
    <div key={`l-${key}`} role="rowheader" title={hint} className="sticky left-0 z-[2] bg-ff-sunken px-2 py-2.5 md:px-3">
      <span className="ff-label block !leading-[1.35] [overflow-wrap:anywhere]">{label}</span>
    </div>
  )
  const cell = (key: string, col: Col, body: ReactNode, mark?: boolean, extra?: string) => (
    <div
      key={`${key}-${col.item.id}`}
      role="cell"
      className={cx(
        'relative min-w-0 bg-ff-panel px-2 py-2.5 md:px-3',
        mark && 'shadow-[inset_0_0_0_999px_rgb(var(--ff-pos)/0.06)]',
        extra,
      )}
    >
      {body}
    </div>
  )
  const totalRows = rows.length + 2
  // A trade named by what you get ("for Purdy, Likely"): the partner is often the same in every column.
  const getsOf = (col: Col) => {
    const ids = col.item.deal.moves.filter((m) => m.to === me).map((m) => data.players[m.player]?.name.split(' ').slice(-1)[0] ?? m.player)
    const cash = col.item.deal.faab.reduce((a, x) => a + (x.to === me ? x.dollars : 0), 0)
    const what = [...ids, cash > 0 ? `$${cash}` : ''].filter(Boolean)
    return what.length ? `for ${what.join(', ')}` : 'for nothing back'
  }
  const figuresFrom = rows.findIndex((r) => r.key === 'lineup')
  const staleNote = (col: Col, i: number, k: number) => (
    <div
      key={`stale-${col.item.id}`}
      role="cell"
      className="bg-ff-panel px-2 py-3 shadow-[inset_0_0_0_999px_rgb(var(--ff-warn)/0.05)] md:px-3"
      style={{ gridColumn: i + 2, gridRow: `${k + 2} / span ${rows.length - k}` }}
    >
      <p className="ff-label !text-ff-warn">Out of date</p>
      <ul className="mt-1.5 space-y-1 text-[12.5px] leading-snug text-ff-text">
        {col.stale.map((m) => {
          const owner = analysis.rosteredBy[m.player]
          const who = data.players[m.player]?.name ?? 'A player'
          // Still where he was: it is the team he was going to that has gone.
          if ((rosters[m.from] ?? []).includes(m.player)) return <li key={m.player}>The team getting {who} is no longer in the league.</li>
          return (
            <li key={m.player}>
              {who} is {owner == null ? 'no longer on a roster' : `now on ${owner === me ? 'your team' : nameOf(owner)}`}.
            </li>
          )
        })}
        {col.broke.some((x) => !(x.from in rosters) || !(x.to in rosters)) && <li>A team in its FAAB payments is no longer in the league.</li>}
        {[...new Set(col.broke.filter((x) => x.from in rosters && x.to in rosters).map((x) => x.from))].map((from) => (
          <li key={`faab-${from}`}>
            {`${from === me ? 'You have' : `${nameOf(from)} has`} $${remaining?.[from] ?? 0} of FAAB left, not the $${col.item.deal.faab.reduce((a, x) => a + (x.from === from ? x.dollars : 0), 0)} this pays.`}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[12px] leading-snug text-ff-muted">Its figures are left out until it is fixed: open it in the builder to change it, or remove it.</p>
    </div>
  )

  const series: Series[] = cols
    .filter((col) => usable(col))
    .map((col) => ({
      key: col.item.id,
      slot: col.item.slot,
      letter: col.letter,
      name: getsOf(col),
      values: col.mine!.perWeek,
    }))

  return (
    <div className="space-y-3">
      <section aria-label="Verdict" className="flex items-start gap-3 border border-ff-line bg-ff-panel px-3 py-2.5 md:px-4">
        <span className="ff-label mt-[3px] shrink-0">Verdict</span>
        <p aria-live="polite" className="min-w-0 text-[13.5px] leading-snug text-ff-text">
          {verdict}
        </p>
      </section>

      <div className="[--col:136px] [--lab:92px] md:[--col:200px] md:[--lab:156px]">
        <div aria-hidden className="sticky z-[6] h-0" style={{ top: stickAt }}>
          {stuck && (
            <div className="tb-fade overflow-hidden border border-ff-line bg-ff-line shadow-[0_8px_18px_-10px_rgba(0,0,0,0.45)]">
              <div ref={cloneRow} className="grid gap-px" style={{ gridTemplateColumns: template }}>
                <div ref={cloneLabel} className="relative z-[1] flex items-center bg-ff-sunken px-2.5 md:px-3">
                  <span className="font-mono text-[10px] text-ff-muted">{n} of 4</span>
                </div>
                {cols.map((col) => (
                  <div key={col.item.id} className="relative flex h-9 min-w-0 items-center gap-2 bg-ff-panel px-2.5 md:px-3">
                    <span className="absolute inset-x-0 top-0 h-[2px]" style={{ background: ink(col.item.slot) }} />
                    <span className="flex shrink-0 items-center gap-1.5 font-mono text-[11.5px] font-medium text-ff-text">
                      <SlotKey slot={col.item.slot} />
                      {col.letter}
                    </span>
                    <span className="min-w-0 truncate text-[12.5px] text-ff-text2" title={getsOf(col)}>
                      {getsOf(col)}
                    </span>
                  </div>
                ))}
                {addCol && <div className="bg-ff-panel" />}
              </div>
            </div>
          )}
        </div>
        <div ref={scroller} className={cx('ff-scroll ff-scroll-x border border-ff-line', n > 2 && 'max-md:snap-x max-md:snap-proximity')} style={{ scrollPaddingInlineStart: 'var(--lab)' }}>
          <div role="table" aria-label="Trades compared" className="grid gap-px bg-ff-line" style={{ gridTemplateColumns: template }}>
            <div role="row" className="contents">
              <div ref={headCell} role="columnheader" className="sticky left-0 z-[2] flex items-end bg-ff-sunken px-2.5 py-2.5 md:px-3">
                <span className="font-mono text-[10px] text-ff-muted">{n} of 4</span>
              </div>
              {cols.map((col, i) => (
                <div key={`h-${col.item.id}`} role="columnheader" className="relative min-w-0 snap-start bg-ff-panel px-2 py-2.5 md:px-3">
                  <span aria-hidden className="absolute inset-x-0 top-0 h-[2px]" style={{ background: ink(col.item.slot) }} />
                  {head(col, i)}
                </div>
              ))}
              {addCol && (
                <div
                  className="flex flex-col items-center justify-center gap-2 bg-ff-panel px-4 py-6 text-center"
                  style={{
                    gridRow: `1 / span ${totalRows}`,
                    gridColumn: n + 2,
                  }}
                >
                  <span aria-hidden className="flex h-9 w-9 items-center justify-center border border-dashed border-ff-line2 text-ff-muted">
                    +
                  </span>
                  <p className="max-w-[200px] text-[12.5px] leading-snug text-ff-muted">Add another trade: from the builder, or Compare on a suggested trade.</p>
                  <div className="flex flex-col gap-1.5">
                    {dock && (
                      <Button size="sm" onClick={() => dock.open()}>
                        <TradeIcon size={12} />
                        Build a trade
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={onSuggested}>
                      Suggested trades →
                    </Button>
                  </div>
                </div>
              )}
            </div>
            {rows.map((r, k) => (
              <div key={r.key} role="row" className="contents">
                {labelCell(r.key, r.label, r.hint)}
                {cols.map((col, i) =>
                  // An out-of-date trade has no figures to show: one note in their place, down its column.
                  col.out && k >= figuresFrom ? (k === figuresFrom ? staleNote(col, i, k) : null) : cell(r.key, col, r.cell(col, i), r.best?.includes(i)),
                )}
              </div>
            ))}
            <div role="row" className="contents">
              {labelCell('act', <span className="sr-only">Actions</span>)}
              {cols.map((col, i) => cell('act', col, actions(col, i)))}
            </div>
          </div>
        </div>
      </div>

      {phone && n < 4 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12.5px] text-ff-muted">Add another:</span>
          {dock && (
            <Button size="sm" onClick={() => dock.open()}>
              <TradeIcon size={12} />
              Build a trade
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onSuggested}>
            Suggested →
          </Button>
        </div>
      )}

      {series.length > 0 && series[0].values.length > 1 && (
        <section aria-labelledby={chartId} className="border border-ff-line bg-ff-panel">
          <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-b border-ff-line px-3 py-2">
            <h3 id={chartId} className="ff-label text-ff-text2">
              Your lineup gain, week by week
            </h3>
            {/* The legend: always there, so no trade is told apart by colour alone. A line key, as the marks are lines. */}
            <ul className="flex flex-wrap gap-x-3 gap-y-1" aria-label="Legend">
              {series.map((s) => (
                <li key={s.key} className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-ff-text2">
                  <LineKey slot={s.slot} />
                  <span className="font-mono font-medium text-ff-text">{s.letter}</span>
                  <span className="min-w-0">{s.name}</span>
                </li>
              ))}
            </ul>
          </header>
          <div className="px-1 pb-1 pt-2 md:px-2">
            <LineupChart series={series} playoffWeeks={data.playoffWeeks} />
          </div>
          <Disclosure inset summary="As a table" className="px-3 pb-3">
            <div className="ff-scroll ff-scroll-x">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="font-mono text-[10.5px] text-ff-muted">
                    <th className="py-1 pr-3 text-left font-normal">Week</th>
                    {series.map((s) => (
                      <th key={s.key} className="px-2 py-1 text-right font-normal">
                        Trade {s.letter}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {series[0].values.map((v) => (
                    <tr key={v.week} className="border-t border-ff-line">
                      <td className="num py-1 pr-3 text-ff-text2">
                        {v.week}
                        {data.playoffWeeks.includes(v.week) && <span className="ml-1.5 font-mono text-[10px] text-ff-muted">playoffs</span>}
                      </td>
                      {series.map((s) => {
                        const d = s.values.find((x) => x.week === v.week)?.delta
                        return (
                          <td key={s.key} className={cx('num px-2 py-1 text-right', d == null ? 'text-ff-muted' : TEXT[toneOf(d)])}>
                            {d == null ? '–' : fmtSigned(d, 1)}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Disclosure>
        </section>
      )}

      <Disclosure from="md" summary="How trades are compared" className="text-[11.5px] leading-relaxed text-ff-muted">
        Each trade is priced afresh from today&apos;s projections, as the builder prices it: your best lineup week by week before and after, value as managers price players, and how likely the other
        side is to say yes. Playoff odds come from the same simulated seasons before and after, for two-team trades. <span className="text-ff-pos">▲</span> marks the best in each row. A trade whose
        players have since moved, or whose FAAB is more than is left to pay with, is out of date: open it to fix it.
        {/* What each row measures: the row names carry it as a tooltip too, which a finger or a keyboard never sees. */}
        <dl className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-[max-content_minmax(0,1fr)]">
          {rows
            .filter((r) => r.hint)
            .map((r) => (
              <React.Fragment key={r.key}>
                <dt className="text-ff-text2">{r.label}</dt>
                <dd className="max-sm:mb-1">{r.hint}</dd>
              </React.Fragment>
            ))}
        </dl>
      </Disclosure>
    </div>
  )
}

export default CompareView
