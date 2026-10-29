import React, { useDeferredValue, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AcceptRead } from '../lib/behavior'
import {
  addDealTeam,
  dealActive,
  readDeal,
  redirectPlayer,
  removeDealTeam,
  rostersOf,
  setDealFaab,
  togglePlayer,
  type Deal,
  type DealRead,
  type DealSide,
} from '../lib/deal'
import type { TradeIdea } from '../lib/trades'
import { useFantasy, useTradeRead } from './FantasyContext'
import { AddIcon, TradeIcon } from './icons'
import { Disclosure } from './Disclosure'
import PlayerName from './PlayerName'
import TeamName from './TeamName'
import { Avatar, Dropdown, PlayerAvatar, WeekBars, cx, fmt, fmtSigned, pct, playerImage, reducedMotion } from './ui'

// The trade builder's body: pick the teams and the players, then review the deal priced for every side. On a phone
// the two are steps of one sheet; on a wide screen they sit side by side. It holds no deal of its own: the dock
// (TradeDock) keeps it, so it survives being minimized and moving between pages.

export const MAX_TEAMS = 4
export type BuilderStep = 'pick' | 'review'
export type BuilderLayout = 'steps' | 'split'
export type DealUpdate = (fn: (d: Deal) => Deal) => void

export type DealPricing = {
  read: DealRead | null
  /** How each other team's manager would read their side, by roster. */
  accept: Record<number, AcceptRead>
  /** Every other team saying yes, taken as independent; null until there is something to say yes to. */
  odds: number | null
  /** The figures are for an older deal while the newest one is priced. */
  stale: boolean
  /** Nothing to price against: no weeks left to project. The deal can still be put together, just not read. */
  unpriced: boolean
}

/**
 * Price a deal for every side. The pricing trails the deal (a deferred value), so a tap shows at once and the
 * numbers catch up a beat later rather than holding the tap back.
 */
export const useDealPricing = (deal: Deal, on: boolean): DealPricing => {
  const { data, analysis, models } = useFantasy()
  const tradeRead = useTradeRead()
  const deferred = useDeferredValue(deal)
  const me = analysis.myRosterId ?? -1
  const rosters = useMemo(() => rostersOf(analysis), [analysis])
  // Only where trades can carry FAAB (not ESPN): otherwise the money is never priced.
  const faab = data.tradeFaab ? models.faab : null
  const read = useMemo(
    () =>
      on && data.horizon.length && dealActive(deferred)
        ? readDeal(deferred, {
            slots: analysis.slots,
            players: data.players,
            horizon: data.horizon,
            floor: analysis.horizonReplacement,
            capacity: analysis.capacity,
            pts: analysis.horizon.perWeek,
            tradeMarket: analysis.tradeMarket,
            rosters,
            currency: analysis.currency,
            faab,
          })
        : null,
    [on, deferred, data.horizon, data.players, analysis, rosters, faab],
  )
  // Each other manager's read of their side, from the same read the suggested trades use.
  const accept = useMemo(() => {
    const out: Record<number, AcceptRead> = {}
    if (!read) return out
    const mine = read.sides.find((s) => s.rosterId === me)
    for (const s of read.sides) {
      if (s.rosterId === me || (!s.receives.length && !s.sends.length && !s.faab)) continue
      const idea: TradeIdea = {
        partnerId: s.rosterId,
        give: s.receives,
        get: s.sends,
        shape: s.sends.length === s.receives.length ? 'swap' : s.sends.length > s.receives.length ? 'depth' : 'consolidate',
        myGain: mine?.lineup ?? 0,
        theirGain: s.net.mid,
        myCost: 0,
        valueAsk: -s.value,
        weeksBetter: s.weeksBetter,
        weeks: s.perWeek.length,
        fills: null,
        myCuts: [],
        theirCuts: s.cuts,
        mutual: Math.min(mine?.lineup ?? 0, s.net.mid),
        perWeek: [],
      }
      out[s.rosterId] = tradeRead(idea, false)
    }
    return out
  }, [read, me, tradeRead])
  const reads = Object.values(accept)
  const odds = reads.length ? reads.reduce((a, r) => a * (r.index / 100), 1) : null
  return { read, accept, odds, stale: deferred !== deal, unpriced: !data.horizon.length }
}

// ---- Small pieces ----

type Tone = 'pos' | 'neg' | 'neutral'
const toneOf = (v: number, edge = 0.25): Tone => (v > edge ? 'pos' : v < -edge ? 'neg' : 'neutral')
const bandTone = (band: AcceptRead['band']): Tone => (band === 'likely' ? 'pos' : band === 'long shot' ? 'neg' : 'neutral')
const oddsTone = (p: number): Tone => (p >= 0.5 ? 'pos' : p < 0.25 ? 'neg' : 'neutral')
/** The odds of a yes, named as the trade cards name them: one partner's "Would they?", or every partner's. */
const oddsLabel = (many: boolean) => (many ? 'All say yes' : 'Would they?')
const TEXT: Record<Tone, string> = { pos: 'text-ff-pos', neg: 'text-ff-neg', neutral: 'text-ff-text' }
/** Low-key washes for a status: a gain, a loss, or neither, at low alpha so the text on them stays plain. */
const WASH: Record<Tone, string> = { pos: 'border-ff-pos/30 bg-ff-pos/[0.07]', neg: 'border-ff-neg/30 bg-ff-neg/[0.07]', neutral: 'border-ff-line2 bg-ff-sunken' }

/** The house's square, hairline glyphs for the builder's own controls. */
export const Glyph = ({ d, size = 14 }: { d: string; size?: number }) => (
  <svg aria-hidden width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="square" className="shrink-0">
    <path d={d} />
  </svg>
)
export const CLOSE = 'M3.5 3.5l7 7M10.5 3.5l-7 7'
export const MINIMIZE = 'M3 10.5h8'
const CHECK = 'M3.5 7.2l2.4 2.4 4.6-5'

/** A small square × for taking something out, 40px on a phone. */
const RemoveButton = ({ label, onClick }: { label: string; onClick: () => void }) => (
  <button
    type="button"
    onClick={onClick}
    aria-label={label}
    title={label}
    className="ff-press flex h-10 w-10 shrink-0 items-center justify-center text-ff-muted hover:bg-ff-raised hover:text-ff-neg md:h-8 md:w-8"
  >
    <Glyph d={CLOSE} size={12} />
  </button>
)

/** "to Team X ▾": where a player or a FAAB payment goes, in a deal of three or four. */
const DestPicker = ({ label, value, teams, onChange }: { label: string; value: number; teams: number[]; onChange: (to: number) => void }) => {
  const { analysis } = useFantasy()
  const me = analysis.myRosterId
  return (
    <Dropdown
      label={label}
      value={String(value)}
      onChange={(v) => onChange(Number(v))}
      options={teams.map((t) => ({ value: String(t), label: t === me ? 'You' : (analysis.teamById[t]?.name ?? String(t)) }))}
      menuClassName="!right-0 !left-auto w-[200px]"
      renderButton={(cur, open) => (
        <span className="flex h-10 max-w-[124px] items-center gap-1 border border-ff-line px-2 font-mono text-[11px] text-ff-text2 hover:border-ff-line2 md:h-7 md:px-1.5 md:text-[10.5px]">
          <span className="text-ff-muted">to</span>
          <span className="truncate">{cur?.label}</span>
          <span aria-hidden className="text-ff-muted">
            {open ? '▴' : '▾'}
          </span>
        </span>
      )}
    />
  )
}

// ---- Pick: the teams ----

/** Who is in the deal, as cards of their own, and the league to choose more from. */
const TeamsSection = ({ deal, update, onView, onClear }: { deal: Deal; update: DealUpdate; onView: (t: number) => void; /** Take every player and all FAAB out (with an undo). */ onClear: () => void }) => {
  const { analysis } = useFantasy()
  const me = analysis.myRosterId!
  const partners = deal.teams.filter((t) => t !== me)
  const [choosing, setChoosing] = useState(false)
  const others = analysis.teams.filter((t) => !deal.teams.includes(t.rosterId))
  const canAdd = deal.teams.length < MAX_TEAMS && others.length > 0
  // With no partner yet, choosing one is the whole job, so the league is laid out from the start.
  const open = canAdd && (choosing || partners.length === 0)
  const record = (id: number) => {
    const s = analysis.seasonById[id]
    return s ? `${s.wins}-${s.losses}${s.ties ? `-${s.ties}` : ''}` : ''
  }
  const facts = (id: number) => [record(id), analysis.needs[id]?.worstPos && `needs ${analysis.needs[id]?.worstPos}`].filter(Boolean).join(' · ')
  const add = (id: number) => {
    update((d) => addDealTeam(d, id))
    setChoosing(false)
    onView(id)
  }

  return (
    <section aria-labelledby="tb-teams" className="border-b border-ff-line px-3 pb-3 pt-3 md:px-4">
      <div className="mb-2 flex h-5 items-center justify-between gap-2">
        <h3 id="tb-teams" className="ff-label">
          Teams
        </h3>
        <span className="flex items-center gap-2 font-mono text-[10.5px] text-ff-muted">
          {partners.length ? `${deal.teams.length} of ${MAX_TEAMS} max` : `up to ${MAX_TEAMS} for a bigger trade`}
          {dealActive(deal) && (
            <button
              type="button"
              onClick={onClear}
              className="ff-hit -my-1 border-l border-ff-line py-1 pl-2 text-ff-text2 hover:text-ff-neg"
              title="Take every player and all FAAB out"
            >
              Clear players
            </button>
          )}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {deal.teams.map((t) => {
          const team = analysis.teamById[t]
          return (
            <div key={t} className={cx('tb-fade flex min-w-0 items-center border bg-ff-panel', t === me ? 'border-ff-accent/40' : 'border-ff-line2')}>
              <button type="button" onClick={() => onView(t)} className="ff-press flex min-h-[52px] min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2 text-left hover:bg-ff-raised" title={`Show ${t === me ? 'your' : `${team?.name}'s`} roster`}>
                <Avatar src={team?.avatar ?? null} name={team?.name ?? ''} size={30} />
                <span className="min-w-0 leading-tight">
                  <span className={cx('block truncate text-[13.5px] font-medium', t === me ? 'text-ff-accent' : 'text-ff-text')}>{t === me ? 'You' : team?.name}</span>
                  <span className="block truncate font-mono text-[10.5px] text-ff-muted">{t === me ? team?.name : facts(t)}</span>
                </span>
              </button>
              {t !== me && <RemoveButton label={`Take ${team?.name} out of the trade`} onClick={() => update((d) => removeDealTeam(d, t))} />}
            </div>
          )
        })}
        {partners.length === 0 && (
          <div className="flex min-h-[52px] min-w-0 items-center gap-2.5 border border-dashed border-ff-line2 px-2.5 text-ff-muted">
            <span aria-hidden className="flex h-[30px] w-[30px] shrink-0 items-center justify-center border border-ff-line2 font-mono text-[13px]">
              ?
            </span>
            <span className="min-w-0 leading-tight">
              <span className="block truncate text-[13.5px] text-ff-text2">Partner</span>
              <span className="block truncate font-mono text-[10.5px]">pick below</span>
            </span>
          </div>
        )}
        {canAdd && partners.length > 0 && (
          <button
            type="button"
            onClick={() => setChoosing((x) => !x)}
            aria-expanded={open}
            className={cx(
              'ff-press flex min-h-[44px] items-center justify-center gap-2 border border-dashed px-3 text-[13px] md:min-h-[36px]',
              open ? 'border-ff-text2 bg-ff-raised text-ff-text' : 'border-ff-line2 text-ff-text2 hover:border-ff-text2 hover:text-ff-text',
              deal.teams.length % 2 === 0 && 'col-span-2',
            )}
          >
            {open ? (
              <>
                <Glyph d={CLOSE} size={11} />
                Never mind
              </>
            ) : (
              <>
                <AddIcon size={12} />
                {deal.teams.length === 2 ? 'Add a third team' : 'Add a fourth team'}
              </>
            )}
          </button>
        )}
      </div>
      {open && (
        <div className="tb-fade mt-2.5">
          <p className="mb-1.5 text-[13px] text-ff-text">{partners.length === 0 ? 'Who are you trading with?' : 'Bring in another team'}</p>
          <ul className="grid grid-cols-2 gap-1.5 sm:grid-cols-3" aria-label="Teams in the league">
            {others.map((t) => (
              <li key={t.rosterId}>
                <button
                  type="button"
                  onClick={() => add(t.rosterId)}
                  className={cx(
                    'ff-press flex w-full min-w-0 items-center gap-2.5 border border-ff-line bg-ff-sunken/60 px-2.5 text-left hover:border-ff-line2 hover:bg-ff-raised',
                    partners.length ? 'min-h-[48px] py-1.5' : 'min-h-[56px] py-2',
                  )}
                >
                  <Avatar src={t.avatar} name={t.name} size={partners.length ? 26 : 30} />
                  <span className="min-w-0 leading-tight">
                    <span className={cx('block truncate text-ff-text', partners.length ? 'text-[12.5px]' : 'text-[13.5px]')}>{t.name}</span>
                    <span className="block truncate font-mono text-[10px] text-ff-muted">{facts(t.rosterId)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

// ---- Pick: the rosters ----

/** One player in a roster to pick from: a big, plain toggle. */
const RosterRow = React.memo(function RosterRow({
  id,
  movingTo,
  onToggle,
}: {
  id: string
  /** Where he goes, when he is in the deal. */
  movingTo: string | null
  onToggle: (id: string) => void
}) {
  const { data, analysis } = useFantasy()
  const p = data.players[id]
  const on = movingTo != null
  return (
    <li>
      <button
        type="button"
        onClick={() => onToggle(id)}
        aria-pressed={on}
        className={cx('group relative flex h-[52px] w-full min-w-0 items-center gap-2.5 px-3 text-left md:h-11', on ? 'bg-ff-accent/[0.09]' : 'hover:bg-ff-raised')}
      >
        <span aria-hidden className={cx('absolute inset-y-0 left-0 w-[2px]', on ? 'bg-ff-accent' : 'bg-transparent')} />
        <PlayerAvatar id={id} player={p} size={32} />
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-[14px] text-ff-text md:text-[13px]">{p?.name}</span>
          <span className={cx('block truncate font-mono text-[10.5px]', on ? 'text-ff-accent' : 'text-ff-muted')}>{on ? `→ ${movingTo}` : [p?.pos, p?.team, p?.injury].filter(Boolean).join(' · ')}</span>
        </span>
        <span className="num shrink-0 text-right text-[13px] text-ff-text2">
          {fmt(analysis.horizon.perWeek[id])}
          <span className="ml-0.5 font-mono text-[9.5px] text-ff-muted">/wk</span>
        </span>
        <span
          aria-hidden
          className={cx(
            'flex h-5 w-5 shrink-0 items-center justify-center border',
            on ? 'border-[rgb(var(--ff-accent-deep))] bg-[rgb(var(--ff-accent-deep))] text-[rgb(var(--ff-on-accent))]' : 'border-ff-line2 text-transparent group-hover:border-ff-text2',
          )}
        >
          <Glyph d={CHECK} size={12} />
        </span>
      </button>
    </li>
  )
})

/**
 * The rosters, one team at a time, behind large tabs fused into the top of the list. Changing team slides the list
 * the way the tabs went; a sideways swipe on the list does the same.
 */
const Rosters = ({ deal, update, view, onView, cols }: { deal: Deal; update: DealUpdate; view: number; onView: (t: number) => void; /** Two columns of players, where there is room. */ cols?: boolean }) => {
  const { data, analysis } = useFantasy()
  const me = analysis.myRosterId!
  const perWeek = analysis.horizon.perWeek
  const rosters = useMemo(() => rostersOf(analysis), [analysis])
  const shown = deal.teams.includes(view) ? view : (deal.teams.find((t) => t !== me) ?? me)
  // Which way the list slid in, decided where the tab changes so it follows the tabs' order.
  const [dir, setDir] = useState<1 | -1>(1)
  const go = (t: number) => {
    if (t === shown) return
    setDir(deal.teams.indexOf(t) > deal.teams.indexOf(shown) ? 1 : -1)
    onView(t)
  }
  const step = (by: 1 | -1) => {
    const i = deal.teams.indexOf(shown) + by
    if (i >= 0 && i < deal.teams.length) go(deal.teams[i])
  }
  const touch = useRef<{ x: number; y: number } | null>(null)
  const toggle = useMemo(() => (id: string) => update((d) => togglePlayer(d, id, rosters, me)), [update, rosters, me])
  const tabs = useRef<HTMLDivElement>(null)
  // The tabs' keys (arrows wrap, Home and End jump). Handled keys never fall through to scrolling, which on a phone
  // would carry the sheet with them.
  const onTabKey = (e: React.KeyboardEvent) => {
    const n = deal.teams.length
    const at = deal.teams.indexOf(shown)
    const i = e.key === 'ArrowRight' ? (at + 1) % n : e.key === 'ArrowLeft' ? (at - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1
    if (i < 0) return
    e.preventDefault()
    const t = deal.teams[i]
    go(t)
    requestAnimationFrame(() => tabs.current?.querySelector<HTMLElement>(`[data-team="${t}"]`)?.focus())
  }

  // Every roster's portraits fetched as the teams join, so switching tabs never shows empty frames.
  const teamsKey = deal.teams.join(',')
  useEffect(() => {
    for (const t of deal.teams)
      for (const id of rosters[t] ?? []) {
        const img = new Image()
        img.decoding = 'async'
        img.src = playerImage(id, data.players[id])
      }
  }, [teamsKey, rosters]) // eslint-disable-line react-hooks/exhaustive-deps

  const name = (t: number) => (t === me ? 'you' : (analysis.teamById[t]?.name ?? ''))
  const sorted = (rosters[shown] ?? []).filter((id) => data.players[id]).sort((a, b) => (perWeek[b] ?? 0) - (perWeek[a] ?? 0))
  const moving = new Map(deal.moves.map((m) => [m.player, m.to]))
  const single = deal.teams.length < 2
  // Three or four tabs leave a phone too little room to name them all, so there the chosen tab takes the room and
  // names its team in full; the others shrink to a face and a count.
  const crowd = deal.teams.length > 2

  return (
    <section aria-label="Rosters" className="flex min-h-0 flex-col">
      {/* The tabs are the top edge of the roster box: the chosen one opens into the list below it. */}
      <div ref={tabs} role="tablist" aria-label="Roster" onKeyDown={onTabKey} className="sticky top-0 z-10 flex bg-ff-panel">
        {deal.teams.map((t) => {
          const team = analysis.teamById[t]
          const picked = deal.moves.filter((m) => m.from === t).length
          const on = t === shown
          return (
            <button
              key={t}
              type="button"
              role="tab"
              data-team={t}
              aria-selected={on}
              aria-label={`${t === me ? 'You' : team?.name}, ${picked ? `${picked} picked` : `${rosters[t]?.length ?? 0} players`}`}
              title={t === me ? 'Your roster' : `${team?.name}'s roster`}
              aria-controls="tb-roster"
              tabIndex={on ? 0 : -1}
              onClick={() => go(t)}
              className={cx(
                // Neighbouring tabs share a hairline (each overlaps the last by 1px); the chosen one sits on top, open below.
                'relative flex h-14 min-w-0 flex-1 items-center gap-2 border-x border-t border-ff-line px-2.5 text-left [&:not(:first-child)]:-ml-px md:h-12',
                on ? 'z-[1] bg-ff-panel' : 'border-b bg-ff-sunken text-ff-muted hover:bg-ff-raised',
                crowd && !on && 'max-md:w-[52px] max-md:flex-none max-md:justify-center max-md:px-0',
              )}
            >
              {on && <span aria-hidden className="absolute inset-x-[-1px] -top-px h-[2px] bg-ff-accent" />}
              <span className="relative shrink-0">
                <span className={cx('block', !on && 'opacity-60 grayscale-[40%]')}>
                  <Avatar src={team?.avatar ?? null} name={team?.name ?? ''} size={26} />
                </span>
                {/* A shrunk tab's count, on its face. Accent ink on the panel, outlined: it holds its contrast in every theme. */}
                {picked > 0 && crowd && !on && (
                  <span key={picked} aria-hidden className="tb-pop num absolute -bottom-1.5 -right-2 min-w-[16px] border border-ff-accent bg-ff-panel px-[3px] text-center text-[10px] leading-[14px] text-ff-accent md:hidden">
                    {picked}
                  </span>
                )}
              </span>
              <span className={cx('min-w-0 flex-1 leading-tight', crowd && !on && 'max-md:hidden')}>
                <span className={cx('block truncate text-[13px]', on ? 'font-medium text-ff-text' : 'text-ff-text2')}>{t === me ? 'You' : team?.name}</span>
                <span className={cx('block truncate font-mono text-[10px]', picked ? 'text-ff-accent' : 'text-ff-muted')}>{picked ? `${picked} picked` : `${rosters[t]?.length ?? 0} players`}</span>
              </span>
            </button>
          )
        })}
        {single && <span className="flex-1 border-b border-ff-line" />}
      </div>
      <div
        id="tb-roster"
        role="tabpanel"
        aria-label={shown === me ? 'Your roster' : `${name(shown)}'s roster`}
        // Vertical panning only: a sideways swipe here changes team, and is never the browser's back gesture.
        className="min-h-0 touch-pan-y overflow-hidden border-x border-b border-ff-line bg-ff-panel"
        onTouchStart={(e) => (touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY })}
        onTouchEnd={(e) => {
          const t0 = touch.current
          touch.current = null
          if (!t0) return
          const dx = e.changedTouches[0].clientX - t0.x
          const dy = e.changedTouches[0].clientY - t0.y
          if (Math.abs(dx) > 56 && Math.abs(dx) > 2 * Math.abs(dy)) step(dx < 0 ? 1 : -1)
        }}
      >
        {single ? (
          <p className="px-3 py-6 text-center text-[12.5px] text-ff-muted">Pick a partner above and their roster opens here beside yours.</p>
        ) : (
          <ul
            key={shown}
            className={cx(
              'divide-y divide-ff-line',
              cols && 'xl:grid xl:grid-cols-2 xl:gap-px xl:divide-y-0 xl:bg-ff-line xl:[&>li]:bg-ff-panel',
              dir > 0 ? 'tb-slide-next' : 'tb-slide-prev',
            )}
          >
            {sorted.map((id) => {
              const to = moving.get(id)
              return <RosterRow key={id} id={id} movingTo={to == null ? null : name(to)} onToggle={toggle} />
            })}
            {cols && sorted.length % 2 === 1 && <li aria-hidden className="hidden xl:block" />}
          </ul>
        )}
      </div>
    </section>
  )
}

// ---- Review ----

/** The verdict for you, first and largest: what your lineup gains a week, how often, at what value, and the odds. */
const Hero = ({ side, odds, stale, many }: { side: DealSide; odds: number | null; stale: boolean; /** Two or more other teams, so "yes" is all of them. */ many: boolean }) => {
  const { data } = useFantasy()
  const v = side.faab ? side.net.mid : side.lineup
  const tone = toneOf(v)
  const word = tone === 'pos' ? 'Better for you' : tone === 'neg' ? 'Worse for you' : 'About even for you'
  const weeks = side.perWeek.length
  return (
    <section aria-label="What it does for you" aria-busy={stale || undefined} className={cx('border px-3.5 pb-3 pt-3 transition-opacity duration-150 md:px-4', WASH[tone], stale && 'opacity-60')}>
      <div className="flex items-baseline justify-between gap-2">
        <span className={cx('ff-label !text-current', TEXT[tone])}>{word}</span>
        <span className="font-mono text-[10.5px] text-ff-muted">{side.faab ? 'lineup + FAAB' : 'your lineup'}</span>
      </div>
      <div className="mt-2 flex items-end justify-between gap-3">
        <div className="leading-none">
          <span className={cx('num text-[40px] font-medium tracking-[-0.03em]', TEXT[tone])}>{fmtSigned(v, 1)}</span>
          <span className="ml-1 font-mono text-[11px] text-ff-muted">pts/wk</span>
          {side.faab !== 0 && Math.abs(side.net.high - side.net.low) >= 0.1 && (
            <span className="num mt-1.5 block text-[11px] text-ff-muted">
              {fmtSigned(side.net.low, 1)} to {fmtSigned(side.net.high, 1)} with the FAAB
            </span>
          )}
        </div>
        <span className="flex flex-col items-end pb-0.5">
          <WeekBars weeks={side.perWeek.map((w) => ({ week: w.week, value: w.delta }))} highlight={data.playoffWeeks} barWidth={weeks > 12 ? 5 : 7} height={30} />
          <span className="mt-0.5 font-mono text-[9.5px] text-ff-muted">
            wk {side.perWeek[0]?.week}–{side.perWeek[weeks - 1]?.week}
          </span>
        </span>
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-px border border-ff-line bg-ff-line">
        <div className="bg-ff-panel px-2.5 py-2">
          <dt className="ff-label">Weeks better</dt>
          <dd className="num mt-1 text-[16px] text-ff-text">
            {side.weeksBetter}
            <span className="text-[11px] text-ff-muted"> of {weeks}</span>
          </dd>
        </div>
        <div className="bg-ff-panel px-2.5 py-2" title="Trade value in minus out, as managers price players">
          <dt className="ff-label">Value</dt>
          <dd className={cx('num mt-1 text-[16px]', TEXT[toneOf(side.value, 0.2)])}>{fmtSigned(side.value, 1)}</dd>
        </div>
        <div className="bg-ff-panel px-2.5 py-2" title={many ? 'Every other team saying yes, taken as independent' : 'Their manager saying yes'}>
          <dt className="ff-label">{oddsLabel(many)}</dt>
          <dd className={cx('num mt-1 text-[16px]', odds == null ? 'text-ff-muted' : TEXT[oddsTone(odds)])}>{odds == null ? '–' : pct(odds)}</dd>
        </div>
      </dl>
      {(side.cuts.length > 0 || side.problems.length > 0) && (
        <div className="mt-2 space-y-0.5 text-[11.5px]">
          {side.cuts.length > 0 && <p className="text-ff-text2">You would cut {side.cuts.map((id) => data.players[id]?.name ?? id).join(', ')} to fit.</p>}
          {side.problems.map((p) => (
            <p key={p} className="text-ff-neg">
              {p}
            </p>
          ))}
        </div>
      )}
    </section>
  )
}

/** Players still on a team's roster, to add to what it sends, right where the side is being read. */
const InlinePicker = ({ team, deal, update, onDone }: { team: number; deal: Deal; update: DealUpdate; onDone: () => void }) => {
  const { data, analysis } = useFantasy()
  const me = analysis.myRosterId!
  const rosters = useMemo(() => rostersOf(analysis), [analysis])
  const perWeek = analysis.horizon.perWeek
  const moving = new Set(deal.moves.map((m) => m.player))
  const left = (rosters[team] ?? []).filter((id) => data.players[id] && !moving.has(id)).sort((a, b) => (perWeek[b] ?? 0) - (perWeek[a] ?? 0))
  return (
    <div className="tb-fade mt-1.5 border border-ff-line2 bg-ff-bg">
      <div className="flex h-10 items-center justify-between gap-2 border-b border-ff-line pl-3 md:h-9">
        <span className="ff-label truncate">{team === me ? 'Your roster' : `${analysis.teamById[team]?.name}'s roster`}</span>
        <button type="button" onClick={onDone} className="h-full px-3.5 text-[12.5px] font-medium text-ff-accent hover:bg-ff-raised">
          Done
        </button>
      </div>
      <ul className="ff-scroll max-h-[264px] divide-y divide-ff-line overflow-y-auto overscroll-contain">
        {left.map((id) => (
          <li key={id}>
            <button type="button" onClick={() => update((d) => togglePlayer(d, id, rosters, me))} className="flex h-11 w-full min-w-0 items-center gap-2.5 px-3 text-left hover:bg-ff-raised">
              <PlayerAvatar id={id} player={data.players[id]} size={26} />
              <span className="min-w-0 flex-1 truncate text-[13px] text-ff-text">{data.players[id]?.name}</span>
              <span className="font-mono text-[10.5px] text-ff-muted">
                {data.players[id]?.pos} · {fmt(perWeek[id])}
              </span>
              <span aria-hidden className="flex h-6 w-6 items-center justify-center border border-ff-line2 text-ff-text2">
                <AddIcon size={11} />
              </span>
            </button>
          </li>
        ))}
        {!left.length && <li className="px-3 py-3 text-[12px] text-ff-muted">Everyone on this roster is already in the trade.</li>}
      </ul>
    </div>
  )
}

/** One team's side of the deal, editable in place: what it sends (×, redirect, add), what it gets, its FAAB, its read. */
const SideCard = ({
  side,
  deal,
  update,
  accept,
  adding,
  setAdding,
}: {
  side: DealSide
  deal: Deal
  update: DealUpdate
  accept?: AcceptRead
  adding: boolean
  setAdding: (on: boolean) => void
}) => {
  const { data, analysis, models } = useFantasy()
  const me = analysis.myRosterId!
  const players = data.players
  const perWeek = analysis.horizon.perWeek
  const faab = data.tradeFaab ? models.faab : null
  const mine = side.rosterId === me
  const team = analysis.teamById[side.rosterId]
  const many = deal.teams.length > 2
  const out = deal.faab.find((x) => x.from === side.rosterId)
  const left = faab?.remaining[side.rosterId] ?? 0
  const tone = toneOf(side.net.mid)
  const nameOf = (t: number) => (t === me ? 'you' : (analysis.teamById[t]?.name ?? ''))
  const band = accept ? bandTone(accept.band) : 'neutral'

  return (
    <section aria-label={mine ? 'Your side' : `${team?.name}'s side`} className="border border-ff-line bg-ff-panel">
      <header className="flex min-h-[48px] items-center justify-between gap-2 border-b border-ff-line px-3 py-1.5">
        <span className="flex min-w-0 items-center gap-2">
          <TeamName id={side.rosterId} size={24} className="text-[13.5px] font-medium" />
          {mine && <span className="ff-label shrink-0">your side</span>}
        </span>
        {!mine && (
          <span className="shrink-0 text-right leading-tight">
            <span className={cx('num block text-[14px] font-medium', TEXT[tone])}>
              {fmtSigned(side.net.mid, 1)}
              <span className="ml-0.5 font-mono text-[9.5px] font-normal text-ff-muted">/wk</span>
            </span>
            <span className="block font-mono text-[10px] text-ff-muted">
              {side.weeksBetter}/{side.perWeek.length} wks · value {fmtSigned(side.value, 1)}
            </span>
          </span>
        )}
      </header>

      {!mine && accept && (
        <div className={cx('border-b px-3 py-2', WASH[band])}>
          <div className="flex items-baseline justify-between gap-2">
            <span className="ff-label">Would they?</span>
            <span className={cx('num text-[14px] font-medium', TEXT[band])}>
              {accept.index}% · {accept.band}
            </span>
          </div>
          {accept.signals[0] && (
            <p className="mt-0.5 text-[11.5px] leading-snug text-ff-text2">
              {accept.signals
                .map((x) => x.text)
                .slice(0, 2)
                .join('; ')}
            </p>
          )}
        </div>
      )}

      <div className="px-3 py-2.5">
        <div className="ff-label mb-1">{mine ? 'You send' : 'Sends'}</div>
        {side.sends.length > 0 && (
          <ul className="-mx-1 divide-y divide-ff-line/70">
            {side.sends.map((id) => {
              const to = deal.moves.find((m) => m.player === id)?.to
              return (
                // In a bigger trade the "to" picker wraps under the name when both cannot fit, rather than cut the name short.
                <li key={id} className="tb-fade flex min-h-[48px] flex-wrap items-center gap-x-1.5 px-1 md:min-h-[40px]">
                  <span className="min-w-0 flex-1 basis-[11rem]">
                    <PlayerName player={players[id]} id={id} size={28} sub={`${fmt(perWeek[id])}/wk`} />
                  </span>
                  <span className="ml-auto flex shrink-0 items-center gap-1.5">
                    {many && to != null && (
                      <DestPicker label={`Send ${players[id]?.name} to`} value={to} teams={deal.teams.filter((t) => t !== side.rosterId)} onChange={(t) => update((d) => redirectPlayer(d, id, t))} />
                    )}
                    <RemoveButton label={`Take ${players[id]?.name} out`} onClick={() => update((d) => ({ ...d, moves: d.moves.filter((m) => m.player !== id) }))} />
                  </span>
                </li>
              )
            })}
          </ul>
        )}
        {!side.sends.length && !adding && <p className="pb-1 text-[12px] text-ff-muted">Nothing yet</p>}
        {adding ? (
          <InlinePicker team={side.rosterId} deal={deal} update={update} onDone={() => setAdding(false)} />
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="ff-press mt-1.5 flex h-10 w-full min-w-0 items-center justify-center gap-1.5 border border-dashed border-ff-line2 px-2 text-[12.5px] text-ff-text2 hover:border-ff-text2 hover:text-ff-text md:h-8"
          >
            <AddIcon size={11} />
            <span className="truncate">{mine ? 'Add one of yours' : `Add from ${team?.name ?? 'their roster'}`}</span>
          </button>
        )}

        {faab && (
          <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[12px] text-ff-text2">
            <span className="ff-label">{mine ? 'You add' : 'Adds'} FAAB</span>
            <label className="flex h-10 items-center border border-ff-line bg-ff-bg focus-within:outline focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-ff-accent md:h-7">
              <span className="pl-2 font-mono text-[11px] text-ff-muted">$</span>
              <input
                type="number"
                inputMode="numeric"
                min={0}
                max={left}
                value={out?.dollars || ''}
                placeholder="0"
                onChange={(e) => {
                  const n = Math.max(0, Math.min(left, Math.round(Number(e.target.value) || 0)))
                  // Its destination passed through, so clearing the field to type a new figure keeps where it goes.
                  update((d) => setDealFaab(d, side.rosterId, n, d.faab.find((x) => x.from === side.rosterId)?.to))
                }}
                className="num h-full w-14 appearance-none bg-transparent px-1 text-[16px] text-ff-text outline-none [-moz-appearance:textfield] md:text-[12.5px] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                aria-label={mine ? 'You add FAAB' : `${team?.name} adds FAAB`}
              />
            </label>
            <span className="font-mono text-[10.5px] text-ff-muted">of ${left}</span>
            {many && (
              <DestPicker
                label={`Send ${team?.name}'s FAAB to`}
                value={out?.to ?? deal.teams.find((t) => t !== side.rosterId)!}
                teams={deal.teams.filter((t) => t !== side.rosterId)}
                onChange={(t) => update((d) => setDealFaab(d, side.rosterId, d.faab.find((x) => x.from === side.rosterId)?.dollars ?? 0, t))}
              />
            )}
          </div>
        )}

        {(side.receives.length > 0 || side.faab > 0) && (
          <div className="mt-2.5">
            <div className="ff-label mb-1">{mine ? 'You get' : 'Gets'}</div>
            <ul className="flex flex-wrap gap-1">
              {side.receives.map((id) => {
                const from = deal.moves.find((m) => m.player === id)?.from
                return (
                  <li key={id} className="flex h-8 max-w-full items-center gap-1.5 border border-ff-line bg-ff-sunken pl-1 pr-2 text-[12px] text-ff-text">
                    <PlayerAvatar id={id} player={players[id]} size={22} />
                    <span className="truncate">{players[id]?.name}</span>
                    {many && from != null && <span className="shrink-0 font-mono text-[10px] text-ff-muted">from {nameOf(from)}</span>}
                  </li>
                )
              })}
              {side.faab > 0 && <li className="flex h-8 items-center border border-ff-line bg-ff-sunken px-2 font-mono text-[12px] text-ff-text">+${side.faab} FAAB</li>}
            </ul>
          </div>
        )}
      </div>

      {!mine && (side.cuts.length > 0 || side.problems.length > 0) && (
        <div className="space-y-0.5 border-t border-ff-line px-3 py-2 text-[11.5px]">
          {side.cuts.length > 0 && <p className="text-ff-muted">Would cut {side.cuts.map((id) => players[id]?.name ?? id).join(', ')} to fit.</p>}
          {side.problems.map((p) => (
            <p key={p} className="text-ff-neg">
              {p}
            </p>
          ))}
        </div>
      )}
    </section>
  )
}

const Review = ({ deal, update, pricing, onPick, split }: { deal: Deal; update: DealUpdate; pricing: DealPricing; onPick: () => void; split: boolean }) => {
  const many = deal.teams.length > 2
  const { analysis } = useFantasy()
  const me = analysis.myRosterId!
  const { read, accept, odds, stale } = pricing
  const [adding, setAdding] = useState<number | null>(null)
  const mine = read?.sides.find((s) => s.rosterId === me)

  if (deal.teams.length < 2 || !dealActive(deal) || !read) {
    const none = deal.teams.length < 2
    // A deal with something in it but no weeks left to price it over: say so, rather than wait on a price that never comes.
    const unpriced = !none && dealActive(deal) && pricing.unpriced
    return (
      <div className="px-4 py-10 text-center">
        <span aria-hidden className="mx-auto mb-3 flex h-10 w-10 items-center justify-center border border-ff-line2 text-ff-muted">
          <TradeIcon size={16} />
        </span>
        <p className="text-[14px] font-medium text-ff-text">{none ? 'Pick a partner to start' : unpriced ? 'Nothing left to project' : dealActive(deal) ? 'Pricing…' : 'Pick players to move'}</p>
        <p className="mx-auto mt-1 max-w-[300px] text-[12.5px] text-ff-muted">
          {none
            ? 'Any team in the league; add more for a three- or four-way trade.'
            : unpriced
              ? 'Trades are priced over the weeks still to be played, and this season has none left.'
              : 'Pick players from the rosters. Each goes to the other side, or to the team you choose in a bigger trade. Add FAAB to any side.'}
        </p>
        {!split && (
          <button type="button" onClick={onPick} className="ff-press mt-4 h-10 border border-ff-line2 px-4 text-[13px] text-ff-text hover:bg-ff-raised">
            {none ? 'Pick a partner' : 'Open the rosters'}
          </button>
        )}
      </div>
    )
  }
  const sides = [...read.sides].sort((a, b) => Number(b.rosterId === me) - Number(a.rosterId === me))
  return (
    <div className="space-y-2.5 px-3 py-3 md:px-4">
      {mine && <Hero side={mine} odds={odds} stale={stale} many={many} />}
      <div className={cx('space-y-2.5 transition-opacity duration-150', stale && '[&_.num]:opacity-60')}>
        {sides.map((s) => (
          <SideCard key={s.rosterId} side={s} deal={deal} update={update} accept={accept[s.rosterId]} adding={adding === s.rosterId} setAdding={(on) => setAdding(on ? s.rosterId : null)} />
        ))}
      </div>
      <Disclosure summary="How it is priced" className="text-[11.5px] leading-relaxed text-ff-muted">
        Lineup: each team&apos;s best lineup week by week, before and after, extra bodies cut. Trade value: as managers price players (reputation, stars, streamers). FAAB counts at a fraction of what it buys on
        waivers, more for a team nearly out of it, shown as a range.
      </Disclosure>
    </div>
  )
}

// ---- The whole builder ----

const STEPS = ['pick', 'review'] as const

/**
 * The step switch under a phone header: Pick, then Review, with what is moving counted. One tab stop; the arrows,
 * Home and End move between the two.
 */
const StepTabs = ({ step, setStep, count, ids }: { step: BuilderStep; setStep: (s: BuilderStep) => void; count: number; ids: string }) => {
  const list = useRef<HTMLDivElement>(null)
  const onKey = (e: React.KeyboardEvent) => {
    const at = STEPS.indexOf(step)
    const i = e.key === 'ArrowRight' || e.key === 'ArrowLeft' ? 1 - at : e.key === 'Home' ? 0 : e.key === 'End' ? 1 : -1
    if (i < 0) return
    e.preventDefault()
    setStep(STEPS[i])
    requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`[data-step="${STEPS[i]}"]`)?.focus())
  }
  return (
    <div ref={list} role="tablist" aria-label="Steps" onKeyDown={onKey} className="grid shrink-0 grid-cols-2 border-b border-ff-line">
      {STEPS.map((s, i) => (
        <button
          key={s}
          id={`${ids}-${s}`}
          type="button"
          role="tab"
          data-step={s}
          aria-selected={step === s}
          aria-controls={`${ids}-panel`}
          tabIndex={step === s ? 0 : -1}
          onClick={() => setStep(s)}
          className={cx('relative flex h-11 items-center justify-center gap-2 text-[13px] focus-visible:-outline-offset-2', step === s ? 'font-medium text-ff-text' : 'text-ff-muted hover:text-ff-text2')}
        >
          <span aria-hidden className={cx('flex h-[18px] w-[18px] items-center justify-center border font-mono text-[10px]', step === s ? 'border-ff-text text-ff-text' : 'border-ff-line2')}>
            {i + 1}
          </span>
          {s === 'pick' ? 'Pick' : 'Review'}
          {/* Outlined in the accent rather than filled: light text on some themes' accent falls short of 4.5:1. */}
          {s === 'review' && count > 0 && (
            <span className="num min-w-[18px] border border-ff-accent px-1 text-center text-[10.5px] leading-[16px] text-ff-accent">
              {count}
              <span className="sr-only"> moving</span>
            </span>
          )}
          <span aria-hidden className={cx('absolute inset-x-4 bottom-[-1px] h-[2px]', step === s ? 'bg-ff-text' : 'bg-transparent')} />
        </button>
      ))}
    </div>
  )
}

/** While picking: the deal so far in one fixed line, never pushing the rosters about. */
const Tray = ({ deal, pricing, onReview }: { deal: Deal; pricing: DealPricing; onReview: () => void }) => {
  const { data, analysis } = useFantasy()
  const me = analysis.myRosterId!
  const n = deal.moves.length
  const mine = pricing.read?.sides.find((s) => s.rosterId === me)
  const v = mine ? (mine.faab ? mine.net.mid : mine.lineup) : null
  const ready = dealActive(deal)
  return (
    <div className="flex h-[60px] shrink-0 items-center gap-2.5 border-t border-ff-line bg-ff-panel px-3">
      {n > 0 ? (
        <>
          <span className="flex shrink-0 -space-x-2" aria-hidden>
            {deal.moves.slice(0, 4).map((m) => (
              <span key={m.player} className="tb-pop rounded-[2px] ring-2 ring-ff-panel">
                <PlayerAvatar id={m.player} player={data.players[m.player]} size={28} />
              </span>
            ))}
          </span>
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block text-[13.5px] font-medium text-ff-text">{n} moving</span>
            <span className={cx('num block truncate text-[11px] transition-opacity duration-150', v == null ? 'text-ff-muted' : TEXT[toneOf(v)], pricing.stale && 'opacity-50')}>
              {v == null ? (
                pricing.unpriced ? 'no weeks left to price' : 'pricing…'
              ) : (
                <>
                  {fmtSigned(v, 1)}/wk<span className="max-[359px]:hidden"> for you</span>
                </>
              )}
            </span>
          </span>
        </>
      ) : (
        <span className="min-w-0 flex-1 text-[12.5px] leading-snug text-ff-muted">{deal.teams.length < 2 ? 'Pick a partner to see their roster' : 'Pick players to put in the trade'}</span>
      )}
      {ready ? (
        <button type="button" onClick={onReview} className="ff-aqua ff-aqua-fab shrink-0">
          Review <span aria-hidden>→</span>
        </button>
      ) : (
        <button type="button" disabled className="flex h-11 shrink-0 items-center gap-1.5 border border-ff-line px-4 text-[13.5px] text-ff-muted">
          Review <span aria-hidden>→</span>
        </button>
      )}
    </div>
  )
}

/** Header: what this is, the deal in a line, and minimize and close. */
export const BuilderHeader = ({
  summary,
  onMinimize,
  onClose,
  titleId,
}: {
  summary: ReactNode
  onMinimize: () => void
  onClose: () => void
  titleId: string
}) => (
  <header className="flex h-14 shrink-0 items-center gap-2.5 border-b border-ff-line pl-3 pr-1.5 md:pl-4 md:pr-2">
    <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center border border-ff-accent/40 bg-ff-accent/10 text-ff-accent">
      <TradeIcon size={15} />
    </span>
    <div className="min-w-0 flex-1 leading-tight">
      <h2 id={titleId} className="text-[15px] font-medium text-ff-text">
        Trade builder
      </h2>
      <p className="truncate font-mono text-[10.5px] text-ff-muted">{summary}</p>
    </div>
    <button type="button" onClick={onMinimize} aria-label="Minimize the builder" title="Minimize (Esc)" className="ff-press flex h-10 w-10 items-center justify-center text-ff-text2 hover:bg-ff-raised hover:text-ff-text">
      <Glyph d={MINIMIZE} />
    </button>
    <button type="button" onClick={onClose} aria-label="Close and discard the trade" title="Close and discard the trade (you can undo)" className="ff-press flex h-10 w-10 items-center justify-center text-ff-text2 hover:bg-ff-raised hover:text-ff-neg">
      <Glyph d={CLOSE} />
    </button>
  </header>
)

/**
 * The builder. `steps`: Pick and Review as two steps of one panel, with a tray carrying the deal while picking
 * (phones, narrow windows). `split`: both at once, Pick on the left and Review on the right (wide screens).
 */
const TradeBuilder = ({
  deal,
  update,
  pricing,
  step,
  setStep,
  view,
  setView,
  layout,
  header,
  onClear,
}: {
  deal: Deal
  update: DealUpdate
  pricing: DealPricing
  step: BuilderStep
  setStep: (s: BuilderStep) => void
  view: number
  setView: (t: number) => void
  layout: BuilderLayout
  header: ReactNode
  onClear: () => void
}) => {
  const { analysis } = useFantasy()
  const me = analysis.myRosterId
  const ids = useId()
  const many = deal.teams.length > 2
  // The price, said to screen readers once it settles: one polite region that is always there, keeping the last
  // settled figure while a newer deal is priced, so each edit is heard once and never as a stale figure.
  const said = useRef('')
  if (!pricing.stale) {
    const mine = pricing.read?.sides.find((x) => x.rosterId === me)
    const v = mine ? (mine.faab ? mine.net.mid : mine.lineup) : null
    said.current =
      v == null
        ? ''
        : `${deal.moves.length} moving. ${fmtSigned(v, 1)} points a week for you.${pricing.odds != null ? ` ${oddsLabel(many)} ${pct(pricing.odds)}.` : ''}`
  }
  const live = (
    <p role="status" className="sr-only">
      {said.current}
    </p>
  )
  const scroller = useRef<HTMLDivElement>(null)
  const rosterTop = useRef<HTMLDivElement>(null)
  // Picking a team from its card brings its roster up, under the tabs.
  const showRoster = (t: number) => {
    setView(t)
    const box = scroller.current
    const top = rosterTop.current
    if (box && top && box.scrollTop < top.offsetTop) box.scrollTo({ top: top.offsetTop, behavior: reducedMotion() ? 'auto' : 'smooth' })
  }
  const goStep = (s: BuilderStep) => {
    setStep(s)
    scroller.current?.scrollTo({ top: 0 })
  }

  if (layout === 'split') {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {header}
        {live}
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
          <div className="ff-scroll flex min-h-0 flex-col overflow-y-auto overscroll-contain border-r border-ff-line">
            <TeamsSection deal={deal} update={update} onView={setView} onClear={onClear} />
            {deal.teams.length > 1 ? (
              <div className="px-4 pb-4 pt-3">
                <Rosters deal={deal} update={update} view={view} onView={setView} cols />
              </div>
            ) : (
              <div className="m-4 flex min-h-[160px] flex-1 items-center justify-center border border-dashed border-ff-line2 px-6 text-center text-[12.5px] text-ff-muted">
                Both rosters open here once you pick a partner, one tab each.
              </div>
            )}
          </div>
          <div className="ff-scroll min-h-0 overflow-y-auto overscroll-contain bg-ff-bg">
            <Review deal={deal} update={update} pricing={pricing} onPick={() => {}} split />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header}
      {live}
      <StepTabs step={step} setStep={goStep} count={deal.moves.length} ids={ids} />
      {/* Scroll chains to the sheet at the top, so pulling down from there minimizes it. */}
      <div ref={scroller} role="tabpanel" id={`${ids}-panel`} aria-labelledby={`${ids}-${step}`} className="ff-scroll relative min-h-0 flex-1 overflow-y-auto">
        {step === 'pick' ? (
          <div key="pick" className="tb-step-in">
            <TeamsSection deal={deal} update={update} onView={showRoster} onClear={onClear} />
            {deal.teams.length > 1 && (
              <div ref={rosterTop} className="px-3 pb-4 pt-3">
                <Rosters deal={deal} update={update} view={view} onView={setView} />
              </div>
            )}
          </div>
        ) : (
          <div key="review" className="tb-step-in bg-ff-bg">
            <Review deal={deal} update={update} pricing={pricing} onPick={() => goStep('pick')} split={false} />
          </div>
        )}
      </div>
      {step === 'pick' ? (
        <Tray deal={deal} pricing={pricing} onReview={() => goStep('review')} />
      ) : (
        <div className="flex h-[60px] shrink-0 items-center gap-2 border-t border-ff-line bg-ff-panel px-3">
          {/* Back to the first step, named as its tab is (the tray's "Review →" is the way forward). */}
          <button type="button" onClick={() => goStep('pick')} className="ff-press flex h-11 items-center gap-1.5 border border-ff-line2 px-3.5 text-[13px] text-ff-text hover:bg-ff-raised">
            <span aria-hidden>←</span> Pick
          </button>
          <span className="min-w-0 flex-1 truncate text-right font-mono text-[11px] text-ff-muted">
            {pricing.odds != null && (
              <>
                {oddsLabel(many).toLowerCase()} <span className={cx('num text-[12.5px]', TEXT[oddsTone(pricing.odds)])}>{pct(pricing.odds)}</span>
              </>
            )}
          </span>
        </div>
      )}
    </div>
  )
}

export default TradeBuilder
