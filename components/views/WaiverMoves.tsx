import React, { useMemo, useState } from 'react'
import type { Analysis } from '../../lib/analysis'
import { suggestBid, type BidAdvice } from '../../lib/faab'
import type { LeagueData } from '../../lib/useLeagueData'
import { planWaivers, type PlanTarget } from '../../lib/waivers'
import { contextReasons } from '../ContextNotes'
import { useFantasy } from '../FantasyContext'
import PlayerName from '../PlayerName'
import { Badge, Button, Empty, N, Panel, Reasons, Stat, StatGrid, cx, fmt, fmtSigned, usePhone, type Reason } from '../ui'
import { Callout } from '../Callout'
import { InsightMark } from '../InsightMark'
import { Disclosure } from '../Disclosure'

/** The bid's basis in words, so a range of "$1-1" never has to explain itself. */
const bidNote = (b: BidAdvice, min: number) =>
  b.tier === 'stream' ? 'the minimum: these turn over weekly' : b.low === b.high ? (b.bid <= min ? 'the league minimum' : `league pays about $${b.low}`) : `league pays $${b.low}–${b.high}`

// Bid reasons the outcome block already says in its own words; the rest stay with the case for the move.
const SHOWN_IN_BID = /^(League pays|Kickers and defenses)/

/**
 * One move, in four parts read top to bottom: who comes and goes, what it buys you and what to bid, why, and who
 * else would do. The swap and the outcome share a row on wide screens; on a phone the outcome is a full-width strip
 * under the swap, so the two figures sit side by side at any width.
 */
const MoveCard = ({
  rank,
  add,
  addSub,
  drop,
  dropSub,
  gain,
  gainUnit,
  gainNote,
  bid,
  why,
  alts,
  mark,
}: {
  rank: number
  add: string
  addSub?: React.ReactNode
  drop: string | null
  dropSub?: React.ReactNode
  gain: number
  gainUnit: string
  gainNote: React.ReactNode
  bid: { amount: number; note: string; title?: string } | null
  why: Reason[]
  alts: { id: string; text: React.ReactNode }[]
  mark?: React.ReactNode
}) => {
  const { data } = useFantasy()
  const players = data.players
  return (
    <li className="px-3 py-4 sm:px-4">
      <div className="grid grid-cols-[22px_minmax(0,1fr)] gap-x-2 gap-y-3 sm:grid-cols-[26px_minmax(0,1fr)_auto] sm:gap-x-3">
        <span className="num pt-[5px] text-[11px] text-ff-muted">{String(rank).padStart(2, '0')}</span>
        {/* The swap: the add leads, the drop sits right under it on the same edge. */}
        <div className="min-w-0 space-y-2">
          <div className="flex min-w-0 items-center gap-2">
            <Badge tone="pos" className="w-11 shrink-0 justify-center">
              ADD
            </Badge>
            <PlayerName player={players[add]} id={add} size={28} sub={addSub} />
            {mark}
          </div>
          {drop && (
            <div className="flex min-w-0 items-center gap-2">
              <Badge tone="neg" className="w-11 shrink-0 justify-center">
                DROP
              </Badge>
              <PlayerName player={players[drop]} id={drop} size={28} sub={dropSub} />
            </div>
          )}
        </div>
        {/* The outcome: two labelled figures, each with its basis in words under it. */}
        <dl className="col-span-2 grid grid-cols-2 self-start border border-ff-line sm:col-span-1 sm:row-span-2 sm:w-[272px]">
          <div className="min-w-0 px-3 py-2">
            <dt className="ff-label">Gain</dt>
            <dd className="mt-1 flex items-baseline gap-1.5">
              <span className={cx('num text-[20px] font-medium leading-none', gain > 0 ? 'text-ff-pos' : 'text-ff-text')}>{fmtSigned(gain, 1)}</span>
              <span className="font-mono text-[10.5px] text-ff-muted">{gainUnit}</span>
            </dd>
            <dd className="mt-1 text-[11px] leading-snug text-ff-muted">{gainNote}</dd>
          </div>
          <div className="min-w-0 border-l border-ff-line px-3 py-2" title={bid?.title}>
            <dt className="ff-label">Bid</dt>
            <dd className={cx('num mt-1 text-[20px] font-medium leading-none', bid ? 'text-ff-text' : 'text-ff-muted')}>{bid ? `$${bid.amount}` : '–'}</dd>
            <dd className="mt-1 text-[11px] leading-snug text-ff-muted">{bid ? bid.note : 'no FAAB in this league'}</dd>
          </div>
        </dl>
        {(why.length > 0 || alts.length > 0) && (
          <div className="col-span-2 min-w-0 space-y-3 border-t border-ff-line/60 pt-3 sm:col-span-1 sm:col-start-2">
            {why.length > 0 && (
              <section className="min-w-0 sm:grid sm:grid-cols-[48px_minmax(0,1fr)] sm:gap-x-2">
                <h4 className="ff-label pb-0.5 sm:pt-2.5">Why</h4>
                <MoveWhy items={why} />
              </section>
            )}
            {alts.length > 0 && (
              <section className="min-w-0 sm:grid sm:grid-cols-[48px_minmax(0,1fr)] sm:gap-x-2">
                <h4 className="ff-label pb-1.5 sm:pb-0 sm:pt-2">Or</h4>
                <ul className="flex min-w-0 flex-wrap gap-2">
                  {alts.map((a) => (
                    <li key={a.id} className="flex min-w-0 max-w-full items-center gap-2 border border-ff-line py-1 pl-1.5 pr-2">
                      <PlayerName player={players[a.id]} id={a.id} avatar={false} />
                      <span className="shrink-0">{a.text}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </div>
    </li>
  )
}

/** A light move (a stash, a handcuff): the player, the one reason, and the number it is ranked by, labelled. */
const PickRow = ({ id, why, figure, label }: { id: string; why: React.ReactNode; figure: React.ReactNode; label: string }) => {
  const { data } = useFantasy()
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 px-3 py-2.5">
      <div className="min-w-0">
        <PlayerName player={data.players[id]} id={id} size={26} />
        <p className="mt-1 pl-[34px] text-[12px] leading-snug text-ff-text2 [overflow-wrap:anywhere]">{why}</p>
      </div>
      <div className="pt-0.5 text-right">
        <div className="num text-[15px] leading-none text-ff-text">{figure}</div>
        <div className="ff-label mt-1">{label}</div>
      </div>
    </li>
  )
}

/**
 * The waiver moves worth making, grouped by the decision each one is: lineup upgrades for the rest of the season,
 * this week's streams, stashes for later and handcuffs for the backs you start. Each group ranks on its own number.
 */
const WaiverMoves = ({
  data,
  analysis,
  adds,
  trending,
  drops,
  onBrowse,
  onStream,
}: {
  data: LeagueData
  analysis: Analysis
  adds: PlanTarget[]
  trending: Record<string, number>
  drops: string[]
  onBrowse: () => void
  onStream: () => void
}) => {
  const { models } = useFantasy()
  const phone = usePhone()
  const faab = models.faab
  const me = analysis.myRosterId
  const players = data.players
  const week = data.horizon[0]?.week ?? null

  // Model rank at the position, by rest-of-season value, to set beside FantasyPros'.
  const modelRank = useMemo(() => {
    const out: Record<string, number> = {}
    const byPos: Record<string, string[]> = {}
    for (const id of Object.keys(analysis.market)) {
      const pos = players[id]?.pos
      if (pos) (byPos[pos] ??= []).push(id)
    }
    for (const ids of Object.values(byPos)) ids.sort((a, b) => analysis.market[b] - analysis.market[a]).forEach((id, i) => (out[id] = i + 1))
    return out
  }, [analysis.market, players])

  const plan = useMemo(() => {
    if (me == null) return null
    const startable = [...new Set(analysis.slots.flatMap((s) => s.eligible))]
    const starts: Record<string, number> = {}
    for (const s of analysis.slots) if (s.eligible.length === 1) starts[s.eligible[0]] = (starts[s.eligible[0]] ?? 0) + 1
    return planWaivers({
      targets: adds,
      players,
      rosteredBy: analysis.rosteredBy,
      myPlayers: analysis.teamById[me]?.players ?? [],
      myStarters: (analysis.needs[me]?.slots.map((s) => s.starter).filter(Boolean) as string[]) ?? [],
      drops,
      weekPts: data.horizon[0]?.pts ?? {},
      perWeek: analysis.horizon.perWeek,
      value: analysis.market,
      trending,
      startable,
      starts,
    })
  }, [me, adds, players, analysis, drops, data.horizon, trending])

  const others = useMemo(() => (me == null ? [] : analysis.teams.map((t) => t.rosterId).filter((r) => r !== me)), [analysis.teams, me])

  // The case for an upgrade: what the experts and the rest of Sleeper think, who else wants him, his role, the bid's own reasons.
  const caseFor = (id: string, pos: string, bid: BidAdvice | null): Reason[] => {
    const why: Reason[] = []
    const ecr = data.consensus?.byId[id]
    if (ecr?.posRank != null) {
      const m = modelRank[id]
      const ahead = m != null && ecr.posRank < m - 3
      why.push({
        text: (
          <>
            FantasyPros ranks him{' '}
            <N>
              {pos}
              {Math.round(ecr.posRank)}
            </N>{' '}
            rest of season
            {m ? (
              <>
                , this model{' '}
                <N>
                  {pos}
                  {m}
                </N>
              </>
            ) : null}
            {ahead ? ': experts like him more than projections do' : ''}
          </>
        ),
        tone: ahead ? 'pos' : 'neutral',
      })
    }
    if ((trending[id] ?? 0) >= 200)
      why.push({
        text: (
          <>
            <N>{trending[id].toLocaleString()}</N> Sleeper adds in the last day
          </>
        ),
        tone: trending[id] >= 5000 ? 'warn' : 'neutral',
      })
    const rivals = others.filter((r) => analysis.needs[r]?.worstPos === pos).length
    if (rivals) why.push({ text: `${rivals} other ${rivals === 1 ? 'team is' : 'teams are'} weakest at ${pos} and may bid`, tone: 'warn' })
    why.push(...contextReasons(data.context[id], players))
    if (bid) why.push(...bid.reasons.filter((r) => !SHOWN_IN_BID.test(r.text)).map((r) => ({ text: r.text, tone: r.tone })))
    return why
  }

  if (me == null || !plan) return null
  const bidFor = (id: string, gain: number, pos: string) => (faab ? suggestBid(faab, me, { gain, value: analysis.market[id] ?? 0, trending: trending[id] ?? 0, pos }) : null)
  const bidBlock = (b: BidAdvice | null) =>
    b && faab
      ? {
          amount: b.bid,
          note: bidNote(b, faab.minBid),
          title: `This league has paid $${b.low}–${b.high} for similar value. The bid is the lower of his worth to you and that price, capped $1 over the richest rival.`,
        }
      : null
  const mine = faab ? (faab.remaining[me] ?? 0) : 0
  const richer = faab ? Object.entries(faab.remaining).filter(([r, v]) => Number(r) !== me && v > mine).length : 0
  const rich = faab
    ? Object.entries(faab.remaining)
        .filter(([r]) => Number(r) !== me)
        .sort((a, b) => b[1] - a[1])[0]
    : null
  const best = plan.upgrades[0]?.gain ?? 0
  // The note below is about the best add and what to bid on him, so that move carries the mark.
  const lowValue = !!faab && best < 0.75 && plan.upgrades.length > 0
  const minBid = faab?.minBid ?? 0
  const total = plan.upgrades.length + plan.streams.length + plan.stashes.length + plan.handcuffs.length
  const valueText = (v: number) => `${fmtSigned(v, 1)}/wk value`
  const lastName = (id: string) => players[id]?.name.split(' ').slice(-1)[0] ?? 'yours'

  return (
    <div className="ff-stack">
      {faab && (
        <StatGrid>
          <Stat
            label="Your FAAB"
            value={`$${mine}`}
            meter={mine / faab.budget}
            sub={`of $${faab.budget} · ${richer === 0 ? 'most in the league' : `${richer} ${richer === 1 ? 'team has' : 'teams have'} more`}`}
          />
          <Stat
            label="League going rate"
            value={faab.going.n ? `$${faab.going.p50}` : '–'}
            sub={faab.going.n ? `median winning bid · top 25% $${faab.going.p75}+` : 'no winning bids yet'}
          />
          {!phone && <Stat label="Richest rival" value={rich ? `$${rich[1]}` : '–'} sub={rich ? (analysis.teamById[Number(rich[0])]?.name ?? '–') : '–'} />}
          {!phone && (
            <Stat
              label="Weeks left"
              value={faab.weeksLeft}
              tone={faab.weeksLeft <= 3 ? 'warn' : undefined}
              sub={faab.weeksLeft <= 3 ? 'spend it: leftover FAAB is worth nothing' : `regular season · ~$${Math.round(mine / Math.max(1, faab.weeksLeft))} a week to spend`}
            />
          )}
        </StatGrid>
      )}

      {total === 0 && (
        <Empty title="No move is worth making">
          Nobody on the wire beats your starters by enough to matter.{faab ? ' Hold your FAAB: it buys the most right after the next injury.' : ''}
        </Empty>
      )}

      {plan.upgrades.length > 0 && (
        <Panel title="Lineup upgrades" actions={
            <span>
              rest of season<span className="max-sm:hidden"> · best first</span>
            </span>
          } pad={false}>
          <ol className="divide-y divide-ff-line">
            {plan.upgrades.map((u, i) => {
              const bid = bidFor(u.id, u.gain, u.pos)
              const slot = u.slot?.replace('SUPER_FLEX', 'SF')
              return (
                <MoveCard
                  key={u.id}
                  rank={i + 1}
                  add={u.id}
                  addSub={slot ? `starts at ${slot}` : undefined}
                  drop={u.drop}
                  dropSub={u.drop ? valueText(analysis.market[u.drop] ?? 0) : undefined}
                  gain={u.gain}
                  gainUnit="pts/wk"
                  gainNote="to your lineup, rest of season"
                  bid={bidBlock(bid)}
                  why={caseFor(u.id, u.pos, bid)}
                  alts={u.alts.map((a) => ({ id: a.id, text: <N tone="pos">{fmtSigned(a.add, 1)}</N> }))}
                  mark={lowValue && i === 0 ? <InsightMark label="best add" title="The note below is about this add" /> : undefined}
                />
              )
            })}
          </ol>
        </Panel>
      )}

      {plan.streams.length > 0 && (
        <Panel
          title={`Streams for week ${week ?? ''}`}
          pad={false}
          actions={
            <button type="button" onClick={onStream} className="text-ff-accent underline-offset-2 hover:underline">
              All streamers ›
            </button>
          }
        >
          <ol className="divide-y divide-ff-line">
            {plan.streams.map((s, i) => {
              const team = players[s.id]?.team ?? ''
              const opp = week != null ? (data.schedule?.opp[team]?.[week] ?? null) : null
              const away = week != null && data.schedule?.home?.[team]?.[week] === false
              const where = opp ? ` ${away ? 'at' : 'vs'} ${opp}` : ''
              const why: Reason[] = [
                {
                  text: s.vs ? (
                    <>
                      Projects <N>{fmt(s.proj)}</N>
                      {where}; {players[s.vs]?.name ?? 'yours'} projects <N>{fmt(data.horizon[0]?.pts[s.vs] ?? 0)}</N>
                    </>
                  ) : (
                    <>
                      Projects <N>{fmt(s.proj)}</N>
                      {where}, and you have no {s.pos} who plays
                    </>
                  ),
                  tone: 'pos',
                },
                ...contextReasons(data.context[s.id], players).slice(0, 2),
              ]
              return (
                <MoveCard
                  key={s.id}
                  rank={i + 1}
                  add={s.id}
                  addSub={opp ? `${away ? '@' : 'vs'} ${opp}` : undefined}
                  drop={s.drop}
                  dropSub={s.drop ? valueText(analysis.market[s.drop] ?? 0) : undefined}
                  gain={s.gain}
                  gainUnit="pts"
                  gainNote={s.vs ? `wk ${week ?? ''}, over ${lastName(s.vs)}` : `wk ${week ?? ''}: you have no ${s.pos}`}
                  bid={faab ? { amount: minBid, note: 'the minimum: a one-week rental' } : null}
                  why={why}
                  alts={s.alts.map((a) => ({ id: a.id, text: <N>{fmt(a.proj)}</N> }))}
                />
              )
            })}
          </ol>
        </Panel>
      )}

      {(plan.stashes.length > 0 || plan.handcuffs.length > 0) && (
        <div className="ff-grid-gap grid items-start lg:grid-cols-2">
          {plan.stashes.length > 0 && (
            <Panel
              title="Stash for later"
              actions={
                // Ranked on value with a nudge for Sleeper buzz, so the figure on each row is not the whole order.
                <span>
                  value + buzz<span className="max-sm:hidden"> · {faab ? 'bid the minimum' : 'bench bets'}</span>
                </span>
              }
              pad={false}
            >
              <ol className="divide-y divide-ff-line">
                {plan.stashes.map((s) => {
                  const ctx = contextReasons(data.context[s.id], players)[0]
                  const why =
                    s.trend >= 1000
                      ? `${s.trend.toLocaleString()} Sleeper adds in the last day: grab him before the room does`
                      : ctx
                        ? ctx.text
                        : `Among the most rest-of-season value left at ${s.pos}; would not start for you yet`
                  return <PickRow key={s.id} id={s.id} why={why} figure={fmtSigned(s.value, 1)} label="value/wk" />
                })}
              </ol>
            </Panel>
          )}
          {plan.handcuffs.length > 0 && (
            <Panel title="Handcuffs" actions={<span>for the backs you start</span>} pad={false}>
              <ol className="divide-y divide-ff-line">
                {plan.handcuffs.map((h) => (
                  <PickRow
                    key={h.id}
                    id={h.id}
                    why={
                      <>
                        Next up behind <span className="text-ff-text">{players[h.starter]?.name ?? h.starter}</span>: insurance if he goes down
                      </>
                    }
                    figure={fmt(analysis.horizon.perWeek[h.id] ?? 0)}
                    label="exp/wk"
                  />
                ))}
              </ol>
            </Panel>
          )}
        </div>
      )}

      <div className="flex flex-col items-stretch gap-2 border border-dashed border-ff-line2 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-[12.5px] text-ff-text2">Want someone else? Browse every free agent by position, projection and trend.</p>
        <Button onClick={onBrowse} className="shrink-0 max-md:h-11">
          Browse free agents ›
        </Button>
      </div>

      {lowValue && (
        <Callout kind="insight">
          The best add is worth under <N>0.75</N> pts/wk to you: bid the minimum or hold. FAAB buys the most right after injuries.
        </Callout>
      )}
      <Disclosure from="md" summary="How gain and bids work" className="max-w-[75ch] text-[11.5px] leading-relaxed text-ff-muted">
        Gain for an upgrade: your best lineup re-solved each week with him in and the drop out. For a stream: his projection this
        week against the weakest starter you have at the spot. Bids weigh his worth to you against what this league pays for similar
        value
        {faab ? `, at about $${Math.round(faab.rate)} per pt/wk${faab.rateN ? ` (${faab.rateN} of this season's bids)` : ' (a default until more bids land)'}` : ''}, and never go
        past $1 over the richest rival. Streams, stashes and handcuffs are one-week or long-shot bets: bid the minimum.
      </Disclosure>
    </div>
  )
}

/** The case for a move: the first few reasons, the rest a tap away. */
const MoveWhy = ({ items }: { items: Reason[] }) => {
  const phone = usePhone()
  const [open, setOpen] = useState(false)
  const show = phone ? 2 : 4
  const long = items.length > show + 1
  return (
    <div className="min-w-0 [--ff-reason-pl:0px]">
      <Reasons items={long && !open ? items.slice(0, show) : items} />
      {long && (
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="py-1 font-mono text-[11px] text-ff-accent hover:underline">
          {open ? 'Fewer reasons' : `${items.length - show} more reasons`}
        </button>
      )}
    </div>
  )
}

export default WaiverMoves
