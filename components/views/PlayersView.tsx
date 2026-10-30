import React, { useEffect, useMemo, useState } from 'react'
import { pastProjection, type Analysis } from '../../lib/analysis'
import { applyTrade, makeHorizonEval } from '../../lib/trades'
import type { LeagueData } from '../../lib/useLeagueData'
import type { PlayerContext } from '../../lib/context'
import { ContextNotes, PlayoffSchedule, contextReasons } from '../ContextNotes'
import { useFantasy } from '../FantasyContext'
import PlayerName from '../PlayerName'
import { ShowMore } from './ShowMore'
import { AvailabilityChip } from '../AvailabilityChip'
import { useAvailability } from '../useAvailability'
import { clearsLabel, filterPlayers, POS_FILTERS, type Availability, type OwnFilter, type PosFilter } from '../../lib/availability'
import { Badge, FadeStrip, Num, PageHeader, Panel, Reasons, Segmented, Sparkline, Table, compact, cx, fmt, fmtSigned, pct, signedPct, PlayerAvatar, usePhone, type Column } from '../ui'

type Basis = 'ahead' | 'todate'
const PAGE = 60

/**
 * A note worth reading without a click: he is back from injury, covering for an injured starter, likely out,
 * gaining a real share of an absent teammate's work, or his role just swung.
 */
const prominent = (notes: PlayerContext['notes'] | undefined) =>
  !!notes?.some(
    (n) =>
      n.kind === 'returns' ||
      n.kind === 'temporary' ||
      (n.kind === 'status' && n.play <= 0.5) ||
      (n.kind === 'bump' && n.pts >= 1.5) ||
      (n.kind === 'usage' && Math.abs(n.last - n.prior) >= 8),
  )

const PlayersView = ({ data, analysis, sub, onSub }: { data: LeagueData; analysis: Analysis; sub: string | null; onSub: (s: string) => void }) => {
  const basis: Basis = sub === 'todate' ? 'todate' : 'ahead'
  const [pos, setPos] = useState<PosFilter>('ALL')
  const [own, setOwn] = useState<OwnFilter>('all')
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(PAGE)
  const { values, rosteredBy, myRosterId, teamById, posRanks, market } = analysis
  const players = data.players
  const perWeek = analysis.horizon.perWeek
  const trending = useMemo(() => Object.fromEntries(data.trending.map((t) => [t.player_id, t.count])), [data.trending])
  useEffect(() => setLimit(PAGE), [pos, own, query, basis])
  const { adjust, openPlayer } = useFantasy()
  const phone = usePhone()
  const adjusted = Object.entries(adjust.all)
  const { status } = useAvailability(data, analysis)
  const positions = useMemo(() => [...new Set(analysis.slots.flatMap((s) => s.eligible))], [analysis.slots])
  const flex = useMemo(() => analysis.slots.find((s) => s.name === 'FLEX')?.eligible ?? ['RB', 'WR', 'TE'], [analysis.slots])

  // Everyone at a position this league starts: every rostered player (injured ones included), every free agent with a
  // projection or a following, and anyone else a search names. Season to date lists those who have played.
  const ids = useMemo(() => {
    const relevant = (id: string) => (perWeek[id] ?? 0) > 0 || values[id] != null || (trending[id] ?? 0) > 0
    const pool = basis === 'ahead' ? undefined : Object.keys(values)
    // A player released since stays on the list his numbers belong to: his season so far, or a projection.
    const keep = (id: string) => (basis === 'ahead' ? (perWeek[id] ?? 0) > 0 : values[id] != null)
    return filterPlayers({ players, pool, pos, own, query, flex, positions, relevant, keep, status }).sort((a, b) =>
      basis === 'ahead' ? (market[b] ?? -99) - (market[a] ?? -99) || (perWeek[b] ?? 0) - (perWeek[a] ?? 0) : (values[b]?.war ?? -99) - (values[a]?.war ?? -99),
    )
  }, [basis, perWeek, values, players, pos, own, query, flex, positions, status, trending, market])

  // Positional rank on the forward-looking number.
  const aheadRank = useMemo(() => {
    const byPos: Record<string, string[]> = {}
    for (const id of Object.keys(perWeek)) {
      const p = players[id]?.pos
      if (p) (byPos[p] ??= []).push(id)
    }
    const out: Record<string, number> = {}
    for (const p of Object.keys(byPos)) byPos[p].sort((a, b) => (market[b] ?? 0) - (market[a] ?? 0)).forEach((id, i) => (out[id] = i + 1))
    return out
  }, [perWeek, players, market])

  const visible = ids.slice(0, limit)
  const toYou = useMemo(() => {
    if (basis !== 'ahead' || myRosterId == null || !data.horizon.length) return {}
    const mine = teamById[myRosterId].players
    const ev = makeHorizonEval(analysis.slots, players, data.horizon, analysis.horizonReplacement)
    const base = ev.total(mine)
    const out: Record<string, number> = {}
    for (const id of visible) if (rosteredBy[id] !== myRosterId) out[id] = base === 0 ? 0 : ev.total(applyTrade(mine, [], [id], analysis.capacity, perWeek)) - base
    return out
  }, [basis, myRosterId, data.horizon, teamById, analysis, players, visible.join(','), rosteredBy, perWeek]) // eslint-disable-line react-hooks/exhaustive-deps

  const teamName = (r: number) => teamById[r]?.name
  // On a phone the standing rides under the name, in words; wider screens give it a column of its own.
  const ownerText = (a: Availability) =>
    a.kind === 'mine' ? (
      <span className="text-ff-accent">your team</span>
    ) : a.kind === 'team' ? (
      teamName(a.rosterId)
    ) : a.kind === 'waivers' ? (
      <span className="text-ff-warn">on waivers · {clearsLabel(a.clears)}</span>
    ) : (
      <span className="text-ff-pos">free agent</span>
    )
  const owner = (id: string) => (phone ? ownerText(status(id)) : undefined)
  const availCol: Column<string> = {
    key: 'own',
    label: 'Availability',
    hideBelow: 'md',
    title: 'Free agent, on waivers (dropped lately: a claim until he clears), your team, or the team that has him',
    sort: (id) => {
      const a = status(id)
      return a.kind === 'fa' ? 3 : a.kind === 'waivers' ? 2 : a.kind === 'mine' ? 1 : 0
    },
    render: (id) => <AvailabilityChip a={status(id)} teamName={teamName} />,
  }

  const ahead: Column<string>[] = [
    {
      key: 'rk',
      label: 'Rk',
      sort: (id) => -(aheadRank[id] ?? 999),
      render: (id) => (
        <span className="font-mono text-[11px] text-ff-muted">
          {players[id].pos}
          {aheadRank[id]}
        </span>
      ),
    },
    { key: 'p', label: 'Player', sticky: true, sort: (id) => players[id].name, render: (id) => <PlayerName player={players[id]} id={id} sub={owner(id)} /> },
    availCol,
    {
      key: 'hot',
      label: '',
      hideBelow: 'md',
      render: (id) =>
        trending[id] ? (
          <Badge tone="pos" title={`${trending[id].toLocaleString()} adds across Sleeper in the last 24h`}>
            ↑{compact(trending[id])}
          </Badge>
        ) : null,
    },
    {
      key: 'exp',
      label: 'Exp/wk',
      align: 'right',
      title: 'Expected points per week over the horizon',
      sort: (id) => perWeek[id] ?? 0,
      render: (id) => <span className="text-ff-text">{fmt(perWeek[id])}</span>,
    },
    { key: 'raw', label: 'Base', align: 'right', hideBelow: 'sm', title: 'Per week before injury and role adjustments: Sleeper, with the coming week blended with prop lines', sort: (id) => data.context[id]?.raw ?? perWeek[id] ?? 0, render: (id) => fmt(data.context[id]?.raw ?? perWeek[id]) },
    ...(data.market
      ? [
          {
            key: 'lines',
            label: `Wk${data.market.week} lines`,
            align: 'right' as const,
            hideBelow: 'md' as const,
            title: `Fantasy points implied by this week's prop lines, league scoring, next to Sleeper's own week ${data.market.week} number`,
            sort: (id: string) => data.market!.byId[id]?.pts ?? -1,
            render: (id: string) => {
              const m = data.market!.byId[id]
              if (!m) return <span className="text-ff-muted">–</span>
              const gap = m.pts - m.sleeper
              return (
                <span title={`Sleeper ${fmt(m.sleeper)} · lines ${fmt(m.pts)}`}>
                  <span className="text-ff-text">{fmt(m.pts)}</span>
                  <span className={cx('ml-1 text-[10.5px]', Math.abs(gap) < 0.5 ? 'text-ff-muted' : gap > 0 ? 'text-ff-pos' : 'text-ff-neg')}>{fmtSigned(gap)}</span>
                </span>
              )
            },
          },
        ]
      : []),
    {
      key: 'play',
      label: 'Plays',
      align: 'right',
      hideBelow: 'sm',
      sort: (id) => data.context[id]?.play ?? 1,
      render: (id) => <span className={(data.context[id]?.play ?? 1) < 0.8 ? 'text-ff-neg' : ''}>{pct(data.context[id]?.play)}</span>,
    },
    { key: 'val', label: 'Value', align: 'right', title: 'Points per week above replacement at the position', sort: (id) => market[id] ?? -99, render: (id) => <Num value={market[id]} /> },
    ...(data.consensus
      ? [
          {
            key: 'ecr',
            label: 'ECR',
            align: 'right' as const,
            title: 'FantasyPros expert consensus, rank at the position, rest of season',
            sort: (id: string) => -(data.consensus!.byId[id]?.posRank ?? 999),
            render: (id: string) => {
              const e = data.consensus!.byId[id]
              return e?.posRank ? (
                <span className="text-ff-text2" title={e.sd != null ? `overall ${e.rank ?? '–'} · spread ±${e.sd} (best ${e.best}, worst ${e.worst})` : undefined}>
                  {players[id].pos}
                  {Math.round(e.posRank)}
                </span>
              ) : (
                <span className="text-ff-muted">–</span>
              )
            },
          },
          {
            key: 'gap',
            label: 'vs ECR',
            align: 'right' as const,
            hideBelow: 'md' as const,
            title: 'Consensus position rank minus the model’s. Positive: the model likes this player more than the experts do.',
            sort: (id: string) => (data.consensus!.byId[id]?.posRank != null && aheadRank[id] ? data.consensus!.byId[id].posRank! - aheadRank[id] : -999),
            render: (id: string) => {
              const e = data.consensus!.byId[id]?.posRank
              return e != null && aheadRank[id] ? <Num value={e - aheadRank[id]} signed digits={0} /> : <span className="text-ff-muted">–</span>
            },
          },
        ]
      : []),
    ...(myRosterId != null
      ? [
          {
            key: 'you',
            label: 'To you',
            align: 'right' as const,
            title: 'Points per week he would add to your optimal lineup, after cutting your least useful player',
            sort: (id: string) => toYou[id] ?? -99,
            render: (id: string) => (rosteredBy[id] === myRosterId ? <span className="text-ff-muted">yours</span> : <Num value={toYou[id]} signed digits={2} />),
          },
        ]
      : []),
    ...(data.playoffWeeks.length
      ? [{ key: 'po', label: 'Playoff opp', hideBelow: 'lg' as const, render: (id: string) => <PlayoffSchedule context={data.context[id]} weeks={data.playoffWeeks} /> }]
      : []),
    { key: 'why', label: 'Context', hideBelow: 'lg', render: (id) => <ContextNotes context={data.context[id]} players={players} max={2} /> },
  ]

  const todate: Column<string>[] = [
    {
      key: 'rk',
      label: 'Rk',
      sort: (id) => -(posRanks[id] ?? 999),
      render: (id) => (
        <span className="font-mono text-[11px] text-ff-muted">
          {players[id].pos}
          {posRanks[id]}
        </span>
      ),
    },
    { key: 'p', label: 'Player', sticky: true, sort: (id) => players[id].name, render: (id) => <PlayerName player={players[id]} id={id} sub={owner(id)} /> },
    availCol,
    { key: 'g', label: 'G', align: 'right', sort: (id) => values[id].games, render: (id) => values[id].games },
    { key: 'ppg', label: 'PPG', align: 'right', sort: (id) => values[id].ppg, render: (id) => <span className="text-ff-text">{fmt(values[id].ppg)}</span> },
    {
      key: 'risk',
      label: 'Risk-adj',
      align: 'right',
      hideBelow: 'md',
      title: 'PPG minus a penalty for week-to-week variance (Model)',
      sort: (id) => values[id].riskAdjPpg,
      render: (id) => fmt(values[id].riskAdjPpg),
    },
    { key: 'range', label: 'Floor–Ceil', align: 'right', hideBelow: 'lg', render: (id) => `${fmt(values[id].floor)}–${fmt(values[id].ceiling)}` },
    { key: 'par', label: 'PAR/G', align: 'right', hideBelow: 'sm', sort: (id) => values[id].parPerGame, render: (id) => fmtSigned(values[id].parPerGame) },
    { key: 'war', label: 'WAR', align: 'right', sort: (id) => values[id].war, render: (id) => <Num value={values[id].war} signed digits={2} className="font-medium" /> },
    {
      key: 'now',
      label: 'Now',
      align: 'right',
      hideBelow: 'md',
      title: 'Recency-weighted WAR per game',
      sort: (id) => values[id].recentWarPerGame,
      render: (id) => fmtSigned(values[id].recentWarPerGame, 3),
    },
    { key: 'spark', label: 'Weekly', hideBelow: 'sm', render: (id) => <Sparkline points={values[id].weekly.map((w) => w.pts)} projected={pastProjection(data, id, values[id].weekly.map((w) => w.week))} labels={values[id].weekly.map((w) => `Wk ${w.week}`)} width={84} /> },
  ]

  return (
    <>
      <PageHeader
        title="Players"
        tabs={<div className="h-px" />}
      />
      <div className="ff-page-body ff-stack">
        <div className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center">
          <FadeStrip className="no-scrollbar ff-bleed ff-gutter flex gap-2 overflow-x-auto md:!mx-0 md:flex-wrap md:overflow-visible md:!px-0">
            <Segmented<Basis>
              label="Basis"
              value={basis}
              onChange={(b) => onSub(b)}
              options={[
                { key: 'ahead', label: 'Rest of season' },
                { key: 'todate', label: 'Season to date' },
              ]}
            />
            <Segmented<PosFilter>
              label="Position"
              value={pos}
              onChange={setPos}
              options={POS_FILTERS.filter((p) => p === 'ALL' || (p === 'FLEX' ? flex.length > 1 : positions.includes(p))).map((p) => ({ key: p, label: p === 'ALL' ? 'All' : p }))}
            />
            <Segmented<OwnFilter>
              label="Availability"
              value={own}
              onChange={setOwn}
              options={[
                { key: 'all', label: 'All' },
                { key: 'available', label: 'Available', title: 'Free agents and players on waivers' },
                { key: 'rostered', label: 'Rostered' },
                ...(myRosterId != null ? [{ key: 'mine' as const, label: 'Mine' }] : []),
              ]}
            />
          </FadeStrip>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name or team"
            aria-label="Search players"
            className="h-8 min-w-[160px] rounded-sm md:max-w-[260px] md:flex-1 border border-ff-line bg-ff-panel px-2.5 text-[13px] text-ff-text outline-none placeholder:text-ff-muted focus-visible:border-ff-accent focus-visible:ring-1 focus-visible:ring-ff-accent"
          />
        </div>
        {adjusted.length > 0 && (
          <section aria-label="Your reads" className="flex flex-col gap-2 border border-ff-line bg-ff-panel px-3 py-2.5 sm:flex-row sm:items-start">
            <div className="shrink-0 sm:w-[112px] sm:pt-1.5">
              <div className="ff-label text-ff-text2">Your reads</div>
              <div className="text-[11px] text-ff-muted">{adjusted.length} on file</div>
            </div>
            <ul className="flex min-w-0 flex-1 flex-wrap gap-1.5">
              {adjusted.map(([id, a]) => (
                <li key={id} className="flex h-9 items-center gap-2 border border-ff-line bg-ff-bg pl-1.5 pr-0.5">
                  <button type="button" onClick={() => openPlayer(id)} className="flex min-w-0 items-center gap-1.5 hover:[&>span]:underline">
                    <PlayerAvatar id={id} player={players[id]} size={22} />
                    <span className="max-w-[140px] truncate text-[12.5px] text-ff-text underline-offset-2">{players[id]?.name ?? id}</span>
                  </button>
                  <span
                    className={cx('num px-1.5 py-0.5 text-[12.5px] font-semibold leading-none', a.pct >= 0 ? 'bg-ff-pos/12 text-ff-pos' : 'bg-ff-neg/10 text-ff-neg')}
                    title={`Your read: ${signedPct(a.pct)} on his projection`}
                  >
                    {signedPct(a.pct)}
                  </span>
                  <span className="font-mono text-[10px] text-ff-muted">{a.scope === 'week' ? `wk ${a.week}` : 'season'}</span>
                  <button
                    type="button"
                    onClick={() => adjust.set(id, null)}
                    aria-label={`Clear your read on ${players[id]?.name ?? id}`}
                    className="flex h-8 w-7 items-center justify-center font-mono text-[12px] text-ff-muted hover:bg-ff-raised hover:text-ff-neg"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        <Panel pad={false}>
          <Table
            rows={visible}
            rowKey={(id) => id}
            columns={basis === 'ahead' ? ahead : todate}
            defaultSort={basis === 'ahead' ? 'val' : 'war'}
            rowClass={(id) => cx(rosteredBy[id] === myRosterId && 'ff-mine')}
            onRowClick={(id) => openPlayer(id)}
            canExpand={(id) => !!data.context[id]?.notes.length}
            // On a phone the notes stay closed until asked for: a few open ones push the list a screen apart.
            defaultOpen={(id) => !phone && prominent(data.context[id]?.notes)}
            expand={(id) => {
              const items = contextReasons(data.context[id], players)
              return items.length ? <Reasons items={items} /> : null
            }}
            empty="No players match."
          />
        </Panel>
        {ids.length > limit && (
          <ShowMore step={PAGE} left={ids.length - limit} onMore={() => setLimit((l) => l + PAGE)} rows="tbody > tr:not([id])" />
        )}
      </div>
    </>
  )
}

export default PlayersView
