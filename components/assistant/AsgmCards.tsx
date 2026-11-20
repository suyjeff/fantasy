import React, { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { AsgmCard } from '../../lib/assistant'
import type { Deal } from '../../lib/deal'
import { useFantasy } from '../FantasyContext'
import PlayerName from '../PlayerName'
import TeamName from '../TeamName'
import { headline, useDealRead } from '../TradeBuilder'
import { useTradeDock } from '../TradeDock'
import { BuildIcon } from '../icons'
import { Badge, DeltaChip, PlayerAvatar, cx, fmt, fmtSigned, pct, reducedMotion } from '../ui'

// The cards Assistant GM lays down as it finds things, drawn with the app's own pieces: player and team names that
// open their sheets, the trade builder's pricing, the odds bars and stat tiles. Each lands with its corners closing
// in on it and the frame settling from the accent to a hairline (styles/fantasy.css, .asgm-card), and its figures
// tick from where they were to where they land. Reduced motion: the card fades in, the figures are simply there.

/** A number that counts from `from` to `to` once, when it first shows. */
export const useTicker = (to: number, from: number, on = true, ms = 650) => {
  const [v, setV] = useState(on && !reducedMotion() ? from : to)
  useEffect(() => {
    if (!on || reducedMotion() || from === to) return setV(to)
    let raf = 0
    const t0 = performance.now()
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms)
      // Ease out: quick off the mark, settling onto the figure.
      setV(from + (to - from) * (1 - (1 - k) ** 3))
      if (k < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [to, from, on, ms])
  return v
}

/** Registration marks at the four corners; they close in as the card lands. */
const Corners = () => (
  <>
    {(['tl', 'tr', 'bl', 'br'] as const).map((c) => (
      <span key={c} aria-hidden className={cx('asgm-corner', `asgm-corner-${c}`)} />
    ))}
  </>
)

const KIND_LABEL: Record<AsgmCard['kind'], string> = { players: 'Players', lineup: 'Lineup', trade: 'Trade', odds: 'Odds', waivers: 'Waivers', compare: 'Compare' }

/** A card's frame: the Panel's header (a mono label and an aside), a hairline box, and the landing marks. */
export const CardFrame = ({ card, n, aside, children, fresh }: { card: AsgmCard; n: number; aside?: ReactNode; children: ReactNode; fresh: boolean }) => (
  <section aria-label={`${KIND_LABEL[card.kind]}: ${card.title}`} className={cx('asgm-card relative min-w-0 border border-ff-line bg-ff-panel', fresh && 'is-fresh')} style={{ '--d': `${Math.min(n, 4) * 40}ms` } as React.CSSProperties}>
    <Corners />
    <header className="flex min-h-8 items-center justify-between gap-3 border-b border-ff-line px-3 py-1">
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="num shrink-0 text-[10px] text-ff-muted">{String(n + 1).padStart(2, '0')}</span>
        <span className="ff-label shrink-0 !text-ff-accent">{KIND_LABEL[card.kind]}</span>
        <span className="min-w-0 truncate text-[12px] font-medium text-ff-text">{card.title}</span>
      </span>
      {aside && <span className="shrink-0 font-mono text-[10.5px] text-ff-muted">{aside}</span>}
    </header>
    {children}
  </section>
)

const TONE = { good: 'text-ff-pos', bad: 'text-ff-neg', neutral: 'text-ff-text' } as const
/** A tone is never colour alone: a mark beside the figure, and words for a screen reader. */
const TONE_MARK = { good: '▲', bad: '▼' } as const
const TONE_WORDS = { good: '(favorable)', bad: '(unfavorable)' } as const

/** The GM's note on a player, under his name and wrapped, never cut: it is the reason the row is there. */
const Note = ({ children, inset }: { children: ReactNode; inset: string }) => <p className={cx('mt-0.5 text-[11.5px] leading-snug text-ff-text2', inset)}>{children}</p>

const PlayersCard = ({ card }: { card: Extract<AsgmCard, { kind: 'players' }> }) => {
  const { data } = useFantasy()
  return (
    <ul className="divide-y divide-ff-line/70">
      {card.rows.map((r) => (
        <li key={r.id} className="flex items-start gap-3 px-3 py-1.5">
          <div className="min-w-0 flex-1">
            <PlayerName player={data.players[r.id]} id={r.id} size={24} className="min-w-0" />
            {r.note && <Note inset="pl-8">{r.note}</Note>}
          </div>
          {r.value && (
            <span className={cx('num flex shrink-0 items-baseline gap-1 pt-1 text-right text-[12.5px]', TONE[r.tone ?? 'neutral'])}>
              {r.value}
              {r.tone && r.tone !== 'neutral' && (
                <>
                  <span aria-hidden className="text-[9px]">
                    {TONE_MARK[r.tone]}
                  </span>
                  <span className="sr-only">{TONE_WORDS[r.tone]}</span>
                </>
              )}
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}

const LineupCard = ({ card, fresh }: { card: Extract<AsgmCard, { kind: 'lineup' }>; fresh: boolean }) => {
  const { data } = useFantasy()
  const total = useTicker(card.total.after, card.total.before, fresh)
  const gain = card.total.after - card.total.before
  return (
    <>
      <div className="flex items-end justify-between gap-3 border-b border-ff-line px-3 py-2.5">
        <div>
          <div className="ff-label">Projected</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="sr-only">from </span>
            <span className="num text-[13px] text-ff-muted line-through decoration-ff-muted/50">{fmt(card.total.before)}</span>
            <span aria-hidden className="font-mono text-[11px] text-ff-muted">→</span>
            <span className="sr-only"> to </span>
            <span className="num text-[21px] font-medium leading-none tracking-[-0.02em] text-ff-text">{fmt(total)}</span>
          </div>
        </div>
        <DeltaChip value={gain} suffix={<span className="ml-0.5 text-[9.5px]">pts</span>} title="Projected points gained by the changes" />
      </div>
      <ol className="divide-y divide-ff-line/70">
        {card.changes.map((c) => (
          <li key={`${c.out}-${c.in}`} className="grid grid-cols-[38px_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-1.5 px-3 py-2">
            <span className="row-span-2 self-start pt-[3px] font-mono text-[10.5px] font-semibold text-ff-text2">{c.slot.replace('SUPER_FLEX', 'SF')}</span>
            <span className="flex min-w-0 items-center gap-2">
              <Badge tone="pos" className="w-10 shrink-0 justify-center">
                START
              </Badge>
              <PlayerName player={data.players[c.in]} id={c.in} size={22} className="min-w-0" />
            </span>
            <span className="row-span-2 num self-center text-right text-[14px] font-medium text-ff-pos">{fmtSigned(c.gain, 1)}</span>
            {/* The SIT badge sets it apart; dimming the row would take its text under 4.5:1. */}
            <span className="flex min-w-0 items-center gap-2">
              <Badge tone="neg" className="w-10 shrink-0 justify-center">
                SIT
              </Badge>
              <PlayerName player={data.players[c.out]} id={c.out} size={22} className="min-w-0" />
            </span>
          </li>
        ))}
      </ol>
    </>
  )
}

/** A deal as the builder prices it: what each team gets, and what it does to their lineup a week. */
const TradeCardView = ({ card, onOpen }: { card: Extract<AsgmCard, { kind: 'trade' }>; onOpen?: (deal: Deal) => void }) => {
  const { data, analysis } = useFantasy()
  const read = useDealRead(card.deal)
  const me = analysis.myRosterId
  const teams = [...card.deal.teams].sort((a, b) => Number(b === me) - Number(a === me))
  return (
    <>
      <div className={cx('grid gap-px bg-ff-line', teams.length > 2 ? 'sm:grid-cols-3' : 'grid-cols-2')}>
        {teams.map((t) => {
          const gets = card.deal.moves.filter((m) => m.to === t).map((m) => m.player)
          const faab = card.deal.faab.filter((f) => f.to === t).reduce((a, f) => a + f.dollars, 0) - card.deal.faab.filter((f) => f.from === t).reduce((a, f) => a + f.dollars, 0)
          const side = read?.sides.find((s) => s.rosterId === t)
          const v = headline(side)
          return (
            <div key={t} className="min-w-0 bg-ff-panel px-3 py-2.5">
              <div className="flex min-w-0 items-center justify-between gap-2">
                <TeamName id={t} size={16} className="min-w-0 text-[12px] font-medium" />
              </div>
              <div className="ff-label mt-2">Gets</div>
              <ul className="mt-1 space-y-1">
                {gets.map((id) => (
                  <li key={id} className="min-w-0">
                    <PlayerName player={data.players[id]} id={id} size={20} />
                  </li>
                ))}
                {faab > 0 && <li className="num text-[12px] text-ff-text2">${faab} FAAB</li>}
                {!gets.length && faab <= 0 && <li className="text-[12px] text-ff-muted">nothing</li>}
              </ul>
              <div className="mt-2 flex items-baseline gap-1 border-t border-ff-line/70 pt-1.5" title="Points a week added to their best lineup, over the horizon">
                <span className={cx('num text-[16px] font-medium leading-none', v == null ? 'text-ff-muted' : v > 0.25 ? 'text-ff-pos' : v < -0.25 ? 'text-ff-neg' : 'text-ff-text')}>{v == null ? '…' : fmtSigned(v, 1)}</span>
                <span className="font-mono text-[10px] text-ff-muted">pts/wk</span>
              </div>
            </div>
          )
        })}
      </div>
      {(card.verdict || onOpen) && (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-ff-line px-3 py-2">
          {card.verdict && <p className="min-w-0 flex-1 text-[12.5px] leading-snug text-ff-text2">{card.verdict}</p>}
          {onOpen && (
            <button type="button" onClick={() => onOpen(card.deal)} className="ff-aqua ff-aqua-soft shrink-0">
              <BuildIcon size={12} />
              Open in builder
            </button>
          )}
        </div>
      )}
    </>
  )
}

const OddsRow = ({ label, before, after, fresh, wide }: { label: ReactNode; before?: number; after: number; fresh: boolean; /** Some row has a before: every row keeps room for the change. */ wide: boolean }) => {
  const v = useTicker(after, before ?? 0, fresh, 800)
  const [grown, setGrown] = useState(!fresh || reducedMotion())
  useEffect(() => {
    if (grown) return
    const r = requestAnimationFrame(() => requestAnimationFrame(() => setGrown(true)))
    return () => cancelAnimationFrame(r)
  }, [grown])
  const at = grown ? after : (before ?? 0)
  const d = before != null ? Math.round((after - before) * 100) : 0
  return (
    <li className="asgm-odds grid grid-cols-[minmax(0,1fr)_minmax(48px,112px)_auto] items-center gap-x-3 px-3 py-1.5">
      <span className="asgm-odds-name min-w-0 truncate text-[12.5px] text-ff-text">{label}</span>
      <span className="asgm-odds-bar relative h-1.5 bg-ff-accent/15" aria-hidden>
        <span className="absolute inset-y-0 left-0 w-full origin-left bg-ff-accent transition-transform duration-[800ms] ease-ff-out" style={{ transform: `scaleX(${Math.max(0, Math.min(1, at))})` }} />
        {before != null && <span className="absolute -inset-y-1 w-px bg-ff-text2" style={{ left: `${Math.max(0, Math.min(1, before)) * 100}%` }} title="Before" />}
      </span>
      <span className={cx('asgm-odds-figs flex items-baseline justify-end gap-1.5', wide && 'w-[84px]')}>
        <span className="num w-10 text-right text-[13px] font-medium text-ff-text">{pct(v)}</span>
        {before != null && (
          <span className={cx('num w-8 text-right text-[10.5px]', d > 0 ? 'text-ff-pos' : d < 0 ? 'text-ff-neg' : 'text-ff-muted')}>
            {d > 0 ? `+${d}` : d < 0 ? `−${-d}` : '±0'}
            <span className="sr-only"> points, from {pct(before)}</span>
          </span>
        )}
      </span>
    </li>
  )
}

const OddsCard = ({ card, fresh }: { card: Extract<AsgmCard, { kind: 'odds' }>; fresh: boolean }) => {
  const { analysis } = useFantasy()
  const byName = useMemo(() => new Map(analysis.teams.map((t) => [t.name, t.rosterId])), [analysis.teams])
  const any = card.rows.some((r) => r.before != null)
  return (
    <>
      <ul className="py-1">
        {card.rows.map((r) => {
          const team = byName.get(r.label)
          return <OddsRow key={r.label} label={team != null ? <TeamName id={team} size={16} /> : r.label} before={r.before} after={r.after} fresh={fresh} wide={any} />
        })}
      </ul>
      {any && (
        <p className="flex items-center gap-3 border-t border-ff-line px-3 py-1.5 font-mono text-[10px] text-ff-muted">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-2.5 w-px bg-ff-text2" />
            before
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-1.5 w-3 bg-ff-accent" />
            after
          </span>
        </p>
      )}
    </>
  )
}

const WaiversCard = ({ card }: { card: Extract<AsgmCard, { kind: 'waivers' }> }) => {
  const { data } = useFantasy()
  return (
    <ol className="divide-y divide-ff-line/70">
      {card.rows.map((r) => (
        <li key={r.add} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-3 py-2">
          <div className="min-w-0 space-y-1.5">
            <div className="flex min-w-0 items-start gap-2">
              <Badge tone="pos" className="mt-0.5 w-10 shrink-0 justify-center">
                ADD
              </Badge>
              <div className="min-w-0">
                <PlayerName player={data.players[r.add]} id={r.add} size={22} className="min-w-0" />
                {r.note && <Note inset="pl-[30px]">{r.note}</Note>}
              </div>
            </div>
            {r.drop && (
              <span className="flex min-w-0 items-center gap-2">
                <Badge tone="neg" className="w-10 shrink-0 justify-center">
                  DROP
                </Badge>
                <PlayerName player={data.players[r.drop]} id={r.drop} size={22} className="min-w-0" />
              </span>
            )}
          </div>
          <div className="text-right">
            <div className={cx('num text-[18px] font-medium leading-none', r.bid != null ? 'text-ff-text' : 'text-ff-muted')}>{r.bid != null ? `$${r.bid}` : '–'}</div>
            <div className="ff-label mt-1">bid</div>
          </div>
        </li>
      ))}
    </ol>
  )
}

/** Players side by side on the figures the app reads them by; the better figure in each row is marked. */
const CompareCard = ({ card }: { card: Extract<AsgmCard, { kind: 'compare' }> }) => {
  const { data, analysis } = useFantasy()
  const ids = card.ids.filter((id) => data.players[id]).slice(0, 3)
  const rows: { label: string; title: string; get: (id: string) => number | null; show: (v: number) => string; low?: boolean }[] = [
    { label: 'This week', title: 'Projected points this week', get: (id) => data.projections?.[id] ?? null, show: (v) => fmt(v) },
    { label: 'Exp / wk', title: 'Expected points a week, rest of season', get: (id) => analysis.horizon.perWeek[id] ?? null, show: (v) => fmt(v) },
    { label: 'Value', title: 'Points a week over a replacement player', get: (id) => analysis.market[id] ?? null, show: (v) => fmtSigned(v, 1) },
    { label: 'ECR', title: 'FantasyPros consensus rank at his position, rest of season', get: (id) => data.consensus?.byId[id]?.posRank ?? null, show: (v) => `#${Math.round(v)}`, low: true },
    { label: 'Plays', title: 'Chance he plays in a given week', get: (id) => data.context[id]?.play ?? null, show: (v) => pct(v) },
  ]
  const shown = rows.filter((r) => ids.some((id) => r.get(id) != null))
  const cols = { gridTemplateColumns: `84px repeat(${ids.length}, minmax(0, 1fr))` }
  return (
    <div className="text-[12px]">
      <div className="grid border-b border-ff-line" style={cols}>
        <span />
        {ids.map((id) => (
          <div key={id} className="flex min-w-0 flex-col items-start gap-1.5 border-l border-ff-line px-2.5 py-2">
            <PlayerAvatar id={id} player={data.players[id]} size={32} />
            <PlayerName player={data.players[id]} id={id} avatar={false} className="min-w-0 max-w-full" />
          </div>
        ))}
      </div>
      <dl>
        {shown.map((r) => {
          const vals = ids.map((id) => r.get(id))
          const nums = vals.filter((v): v is number => v != null)
          const best = nums.length > 1 ? (r.low ? Math.min(...nums) : Math.max(...nums)) : null
          const tie = best != null && vals.filter((v) => v === best).length > 1
          return (
            <div key={r.label} className="grid border-b border-ff-line/70 last:border-b-0" style={cols}>
              <dt className="ff-label flex items-center whitespace-nowrap px-3 py-1.5" title={r.title}>
                {r.label}
              </dt>
              {vals.map((v, i) => {
                const top = v != null && v === best && !tie
                return (
                  <dd key={ids[i]} className={cx('num flex items-center gap-1 border-l border-ff-line px-2.5 py-1.5 text-[13px]', top ? 'font-medium text-ff-pos' : 'text-ff-text')}>
                    {v == null ? <span className="text-ff-muted">–</span> : r.show(v)}
                    {top && (
                      <>
                        <span aria-hidden className="text-[9px]">▲</span>
                        <span className="sr-only">(better)</span>
                      </>
                    )}
                  </dd>
                )
              })}
            </div>
          )
        })}
      </dl>
    </div>
  )
}

/** One card, whichever kind. `fresh` cards land and tick; ones restored from an earlier visit are simply there. */
export const AsgmCardView = ({ card, n, fresh }: { card: AsgmCard; n: number; fresh: boolean }) => {
  const dock = useTradeDock()
  const { analysis } = useFantasy()
  const me = analysis.myRosterId
  const aside =
    card.kind === 'lineup'
      ? `wk ${card.week}`
      : card.kind === 'trade'
        ? `${card.deal.teams.length} teams`
        : card.kind === 'players' || card.kind === 'waivers'
          ? `${card.rows.length}`
          : card.kind === 'odds'
            ? 'playoffs'
            : undefined
  return (
    <CardFrame card={card} n={n} aside={aside} fresh={fresh}>
      {card.kind === 'players' ? (
        <PlayersCard card={card} />
      ) : card.kind === 'lineup' ? (
        <LineupCard card={card} fresh={fresh} />
      ) : card.kind === 'trade' ? (
        <TradeCardView card={card} onOpen={dock && card.deal.teams.includes(me ?? -1) ? (d) => dock.open(d, 'review') : undefined} />
      ) : card.kind === 'odds' ? (
        <OddsCard card={card} fresh={fresh} />
      ) : card.kind === 'waivers' ? (
        <WaiversCard card={card} />
      ) : (
        <CompareCard card={card} />
      )}
    </CardFrame>
  )
}
