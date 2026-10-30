import React, { useEffect, useMemo, useState } from 'react'
import type { Analysis } from '../../lib/analysis'
import { waiverTargets } from '../../lib/search'
import { dropCandidates } from '../../lib/moves'
import type { LeagueData } from '../../lib/useLeagueData'
import {
  impliedTotals,
  pointsAllowed,
  positionSpread,
  streamReasons,
  streamRows,
  WEEKLY_STREAM,
  type Allowed,
  type StreamPos,
  type StreamRow,
  type TeamTotal,
} from '../../lib/waivers'
import { contextReasons } from '../ContextNotes'
import { useFantasy } from '../FantasyContext'
import WaiverMoves from './WaiverMoves'
import FreeAgentBrowser from './FreeAgentBrowser'
import { Disclosure } from '../Disclosure'
import { useStatLines } from '../useStatLines'
import PlayerName from '../PlayerName'
import { DeltaChip, Badge, CenterMeter, Empty, N, Num, PageHeader, Panel, Reasons, Segmented, Stat, StatGrid, Table, TabSection, Tabs, usePhone, usePhoneCap, cx, fmt, pct, type Column, type PageChange, type Reason } from '../ui'

// Moves: what to do, grouped. Free agents: everyone you can add, to browse. Streamers: this week's matchups at the
// positions you churn. The old "All adds" page (#waivers/adds) is the free-agent browser now.
type Sub = 'moves' | 'available' | 'stream'
const SUBS: Sub[] = ['moves', 'available', 'stream']
const MOVED: Record<string, Sub> = { adds: 'available' }
const AHEAD = 3
const POS_LABEL: Record<StreamPos, string> = { QB: 'quarterback', RB: 'running back', WR: 'receiver', TE: 'tight end', K: 'kicker', DEF: 'defense' }

/** Stat lines (pts_allow, sacks, FGA, rush yards) for the weeks on screen. Cached a few hours, a few dozen KB a week. */

/** A matchup as a short tier word with its tone: easy, neutral, tough. */
const tier = (m: Allowed | null | undefined) => (!m ? null : m.index >= 1.12 ? 'easy' : m.index <= 0.88 ? 'tough' : 'avg')

const MatchupCell = ({ m }: { m: Allowed | null }) =>
  m ? (
    <span className="inline-flex items-center justify-end gap-2" title={`${fmt(m.ppg)} pts/g allowed over ${m.games} games; #${m.rank} after regressing toward average`}>
      <CenterMeter value={(m.index - 1) / 0.4} width={36} />
      <span className={cx('w-9', m.index >= 1.12 ? 'text-ff-pos' : m.index <= 0.88 ? 'text-ff-neg' : 'text-ff-text2')}>
        {m.index >= 1 ? '+' : '−'}
        {Math.round(Math.abs(m.index - 1) * 100)}%
      </span>
    </span>
  ) : (
    <span className="text-ff-muted">–</span>
  )

const TotalCell = ({ t, low }: { t: TeamTotal | null; low?: boolean }) =>
  t ? (
    <span
      title={t.source === 'market' ? 'From the kicker’s extra-point and field-goal props' : 'Sleeper’s projected points allowed by the opposing defense, built on the Vegas line'}
    >
      <span className={cx(low ? (t.pts <= 19 ? 'text-ff-pos' : t.pts >= 26 ? 'text-ff-neg' : '') : t.pts >= 26 ? 'text-ff-pos' : t.pts <= 19 ? 'text-ff-neg' : '')}>
        {fmt(t.pts)}
      </span>
      {t.source === 'market' && <span className="ml-0.5 text-[9px] text-ff-accent">m</span>}
    </span>
  ) : (
    <span className="text-ff-muted">–</span>
  )

const WaiversView = ({ data, analysis, sub, onSub }: { data: LeagueData; analysis: Analysis; sub: string | null; onSub: PageChange }) => {
  const moved = sub ? MOVED[sub] : undefined
  const tab: Sub = moved ?? (SUBS.includes(sub as Sub) ? (sub as Sub) : 'moves')
  // An old link to a page that moved lands on its new name, without leaving the old one in history.
  useEffect(() => {
    if (moved) onSub(moved, { replace: true })
  }, [moved]) // eslint-disable-line react-hooks/exhaustive-deps
  // On a phone each tab is its own page, so pages are kept short and the small print folds away.
  const phone = usePhone()
  const { models } = useFantasy()
  const { players } = data
  const me = analysis.myRosterId != null ? analysis.teamById[analysis.myRosterId] : null
  const startable = useMemo(() => new Set(analysis.slots.flatMap((s) => s.eligible)), [analysis.slots])
  // Streaming is a weekly call at the spots the matchup moves most; backs and receivers are found in Free agents.
  const positions = WEEKLY_STREAM.filter((p) => startable.has(p))
  const [pos, setPos] = useState<StreamPos>(positions[positions.length - 1] ?? 'DEF')
  // A phone gets the top of each long table, and asks for more; a new position starts the streamers over.
  const streamCap = usePhoneCap(12, pos)
  const weeks = useMemo(
    () =>
      data.horizon
        .map((h) => h.week)
        .filter((w) => !data.playoffWeeks.length || w <= Math.max(...data.playoffWeeks))
        .slice(0, AHEAD),
    [data.horizon, data.playoffWeeks],
  )
  const [picked, setWeek] = useState<number | null>(null)
  // The weeks roll over on a refresh; a pick that has passed falls back to the coming week.
  const week = picked != null && weeks.includes(picked) ? picked : (weeks[0] ?? 0)
  const lines = useStatLines(data.league.season, weeks)

  // Season-to-date matchup tables need this season's results against this season's schedule.
  const ownSeason = !data.pointsSource.startsWith('proxy')
  const allowed = useMemo(
    () => (ownSeason ? pointsAllowed(data.weekPoints, data.valueWeeks, players, data.schedule, pos) : {}),
    [ownSeason, data.weekPoints, data.valueWeeks, players, data.schedule, pos],
  )
  const starter = analysis.horizonStarter[pos] ?? 0
  const sd = useMemo(
    () => positionSpread(ownSeason ? data.weekPoints : {}, data.valueWeeks, players, pos, starter),
    [ownSeason, data.weekPoints, data.valueWeeks, players, pos, starter],
  )
  const totals = useMemo(
    () =>
      impliedTotals({
        week,
        schedule: data.schedule,
        statLines: lines[week] ?? null,
        market: data.market,
        players,
      }),
    [week, data.schedule, lines, data.market, players],
  )
  const posSlots = (data.league.roster_positions ?? []).filter((s) => s === pos).length || 1
  const mineLabel = posSlots > 1 ? `your weakest starting ${POS_LABEL[pos]}` : `your ${POS_LABEL[pos]}`
  const stream = useMemo(
    () =>
      streamRows({
        pos,
        week,
        aheadWeeks: weeks,
        players,
        rosteredBy: analysis.rosteredBy,
        myPlayers: me?.players ?? [],
        horizon: data.horizon,
        schedule: data.schedule,
        totals,
        allowed,
        statLines: lines[week] ?? null,
        starter,
        sd,
        trending: data.trending,
        starts: posSlots,
      }),
    [pos, week, weeks, players, analysis.rosteredBy, me, data.horizon, data.schedule, totals, allowed, lines, starter, sd, data.trending, posSlots],
  )
  const teamCount = Object.keys(data.schedule?.opp ?? {}).length || 32

  const picks = useMemo(() => {
    const r = stream.rows
    if (!r.length) return null
    const by = (f: (x: StreamRow) => number) => [...r].sort((a, b) => f(b) - f(a))[0]
    return {
      week: r[0],
      upside: by((x) => x.boom),
      hold: by((x) => x.ahead.reduce((a, w) => a + w.proj, 0)),
    }
  }, [stream.rows])

  // Everyone off the wire who would start for you, with the cut it forces already priced in.
  const adds = useMemo(() => ((tab === 'available' || tab === 'moves') && me ? waiverTargets(data, analysis) : []), [tab, me, data, analysis])
  const gains = useMemo(() => Object.fromEntries(adds.map((t) => [t.id, t.add])) as Record<string, number>, [adds])
  const trending = useMemo(() => Object.fromEntries(data.trending.map((t) => [t.player_id, t.count])), [data.trending])
  // Bench players to cut, weakest first, with the consensus price as a floor (lib/moves).
  const drops = useMemo(() => (me ? dropCandidates(analysis, me.rosterId, models.perceived) : []), [me, analysis, models.perceived])

  const posLabel = POS_LABEL[pos]
  const myProj = stream.mine
  const myOnBye = myProj && !(myProj.proj > 0)

  const streamCols: Column<StreamRow>[] = [
    {
      key: 'player',
      label: 'Player',
      sticky: true,
      sort: (r) => players[r.id]?.name ?? r.id,
      render: (r) => <PlayerName id={r.id} player={players[r.id]} size={24} sub={<span className="font-mono text-[10px]">{r.opp ? `${r.home === false ? '@' : 'vs'} ${r.opp}` : 'BYE'}</span>} />,
    },
    {
      key: 'proj',
      label: 'Proj',
      align: 'right',
      sort: (r) => r.proj,
      render: (r) => <span className="text-ff-text">{fmt(r.proj)}</span>,
    },
    {
      key: 'vs',
      label: 'vs yours',
      align: 'right',
      // A constant offset from the projection: the headline tile carries it on phones.
      hideBelow: 'sm',
      title: `Projection minus ${mineLabel} this week`,
      sort: (r) => r.vsMine ?? -99,
      render: (r) => (r.vsMine != null ? <Num value={r.vsMine} signed /> : <span className="text-ff-muted">–</span>),
    },
    {
      key: 'boom',
      label: 'Boom',
      align: 'right',
      title: `Chance of a starter-level week: ${fmt(starter)}+ pts, the average starting ${posLabel} in this league (spread ±${fmt(sd)})`,
      sort: (r) => r.boom,
      render: (r) => pct(r.boom),
    },
    pos === 'DEF'
      ? {
          key: 'oppTotal',
          label: 'Opp total',
          align: 'right',
          title: 'Points the opponent is expected to score; lower is better for a defense. m = from betting props',
          sort: (r) => -(r.oppTotal?.pts ?? 99),
          render: (r) => <TotalCell t={r.oppTotal} low />,
        }
      : {
          key: 'teamTotal',
          label: 'Team total',
          align: 'right',
          title: 'Points his team is expected to score. m = from betting props',
          sort: (r) => r.teamTotal?.pts ?? 0,
          render: (r) => <TotalCell t={r.teamTotal} />,
        },
    {
      key: 'matchup',
      label: 'Matchup',
      align: 'right',
      hideBelow: 'sm',
      title:
        pos === 'DEF'
          ? 'Fantasy points this opponent’s offense has handed defenses, vs the league average'
          : `Fantasy points this defense has allowed to ${pos}s, vs the league average`,
      sort: (r) => r.matchup?.index ?? 0,
      render: (r) => <MatchupCell m={r.matchup} />,
    },
    {
      key: 'ahead',
      label: `Next ${weeks.length}`,
      hideBelow: 'md',
      title: 'Opponent and projection each week: worth holding, or one and done',
      sort: (r) => r.ahead.reduce((a, w) => a + w.proj, 0),
      render: (r) => (
        <span className="flex gap-1">
          {r.ahead.map((w) => {
            const t = tier(w.matchup)
            return (
              <span
                key={w.week}
                title={`Wk ${w.week}: ${w.opp ?? 'bye'} · proj ${fmt(w.proj)}`}
                className={cx(
                  'inline-flex w-[52px] flex-col items-center border px-1 py-0.5 font-mono text-[10px] leading-tight',
                  w.week === week ? 'border-ff-accent/60' : 'border-ff-line',
                  t === 'easy' ? 'bg-ff-pos/10' : t === 'tough' ? 'bg-ff-neg/10' : '',
                )}
              >
                <span className="text-ff-text2">{w.opp ?? 'BYE'}</span>
                <span className="text-ff-muted">{w.proj > 0 ? fmt(w.proj) : '–'}</span>
              </span>
            )
          })}
        </span>
      ),
    },
    {
      key: 'adds',
      label: 'Sleeper adds',
      align: 'right',
      hideBelow: 'lg',
      title: 'Sleeper managers (all leagues) who added him in the last 24 hours',
      sort: (r) => r.trending,
      render: (r) => (r.trending ? r.trending.toLocaleString() : <span className="text-ff-muted">–</span>),
    },
  ]

  return (
    <>
      <PageHeader
        title="Waivers"
        tabs={
          <Tabs<Sub>
            items={[
              { key: 'moves', label: 'Moves' },
              { key: 'available', label: 'Free agents' },
              { key: 'stream', label: 'Streamers' },
            ]}
            value={tab}
            onChange={onSub}
            stacked={phone && !!me}
          />
        }
      />
      <div className="ff-page-body ff-stack">
        {!me && <Empty title="You are not in this league">Waiver picks are read against your roster.</Empty>}

        {me && (
          <TabSection id="moves" active={tab === 'moves'}>
            <WaiverMoves data={data} analysis={analysis} adds={adds} trending={trending} drops={drops} onBrowse={() => onSub('available')} onStream={() => onSub('stream')} />
          </TabSection>
        )}

        {me && (
          <TabSection id="available" active={tab === 'available'}>
            <FreeAgentBrowser data={data} analysis={analysis} gains={gains} trending={trending} />
          </TabSection>
        )}

        {me && (
          <TabSection id="stream" active={tab === 'stream'}>
            {data.horizonSource !== 'projections' ? (
              <Empty title="No projections to stream from">Streaming reads Sleeper&apos;s projections for the weeks ahead, and there are none right now (the season may be over).</Empty>
            ) : (
          <div className="ff-stack">
            <div className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center md:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <Segmented<StreamPos> label="Position" value={pos} onChange={setPos} options={positions.map((p) => ({ key: p, label: p }))} />
              {weeks.length > 1 && (
                <Segmented<string>
                  label="Week"
                  value={String(week)}
                  onChange={(w) => setWeek(Number(w))}
                  options={weeks.map((w) => ({
                    key: String(w),
                    label: `Wk ${w}`,
                  }))}
                />
              )}
            </div>
              <p className="text-[12px] leading-snug text-ff-muted md:max-w-[440px] md:text-right">
                One-week pickups where the matchup moves the number most. For backs and receivers, see{' '}
                {/* Underlined at rest: in a sentence the accent alone sits too close to the text around it (1.4.1). */}
                <button type="button" onClick={() => onSub('available')} className="text-ff-accent underline decoration-ff-accent/50 underline-offset-2 hover:decoration-current">
                  Free agents
                </button>
                .
              </p>
            </div>
            {!positions.length ? (
              <Empty title="No positions to stream">This league&apos;s lineup has no slot these positions fill.</Empty>
            ) : (
              <>
                <StatGrid>
                  <Stat
                    label={posSlots > 1 ? `Your ${pos}${posSlots}` : `Your ${posLabel}`}
                    value={myProj ? fmt(myProj.proj) : '–'}
                    sub={myProj ? `${players[myProj.id]?.name ?? myProj.id}${myOnBye ? ' · bye or out' : ''}` : 'none rostered'}
                    delta={myOnBye ? <Badge tone="warn">need one</Badge> : undefined}
                  />
                  <Stat
                    label="Best this week"
                    value={picks ? fmt(picks.week.proj) : '–'}
                    sub={picks ? players[picks.week.id]?.name : 'no free agents projected'}
                    delta={picks?.week.vsMine != null ? <DeltaChip value={picks.week.vsMine} title={`Against ${mineLabel}`} /> : undefined}
                  />
                  {!phone && <Stat label="Most upside" value={picks ? pct(picks.upside.boom) : '–'} sub={picks ? `${players[picks.upside.id]?.name} · boom odds` : '–'} />}
                  {!phone && (
                    <Stat
                      label={`Best ${weeks.length}-wk hold`}
                      value={picks ? fmt(picks.hold.ahead.reduce((a, w) => a + w.proj, 0)) : '–'}
                      sub={picks ? `${players[picks.hold.id]?.name} · wks ${weeks[0]}–${weeks[weeks.length - 1]}` : '–'}
                    />
                  )}
                </StatGrid>
                <Panel title={`Free-agent ${posLabel}s · week ${week}`} pad={false} actions={<span>{stream.rows.length > streamCap.limit ? `${streamCap.limit} of ${stream.rows.length}` : `${stream.rows.length} shown`}</span>}>
                  {stream.rows.length ? (
                    <Table
                      rows={stream.rows}
                      cap={streamCap}
                      rowKey={(r) => r.id}
                      columns={streamCols}
                      defaultSort="proj"
                      expand={(r) => {
                        const items: Reason[] = [...streamReasons(r, pos, teamCount), ...contextReasons(data.context[r.id], players)]
                        return items.length ? <Reasons items={items} /> : null
                      }}
                    />
                  ) : (
                    <div className="p-4 text-[13px] text-ff-muted">No free agent at this position has a projection for week {week}.</div>
                  )}
                </Panel>
                <Disclosure from="md" summary="What the columns mean" className="max-w-[75ch] text-[11.5px] leading-relaxed text-ff-muted">
                  <span className="text-ff-text2">Proj</span> blends prop lines into next week. <span className="text-ff-text2">{pos === 'DEF' ? 'Opp total' : 'Team total'}</span>{' '}
                  {pos === 'DEF' ? 'is what the offense he faces should score' : 'is what his offense should score'} (<N>m</N> = from props, else Vegas via Sleeper).{' '}
                  <span className="text-ff-text2">Matchup</span> is what this opponent {pos === 'DEF' ? 'gives up to defenses' : `allows ${pos}s`} vs average
                  {!ownSeason ? ' (needs this season’s results)' : ''}. <span className="text-ff-text2">Boom</span> is the chance of <N>{fmt(starter)}+</N>, an average starter
                  (<N>±{fmt(sd)}</N> weekly). Green weeks ahead are easy, red tough.
                </Disclosure>
              </>
            )}
          </div>
            )}
          </TabSection>
        )}

      </div>
    </>
  )
}

export default WaiversView
