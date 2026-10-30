import React, { useMemo, useState } from 'react'
import type { Analysis } from '../../lib/analysis'
import { filterPlayers, POS_FILTERS, sortPlayers, type FaSort, type PosFilter } from '../../lib/availability'
import { suggestBid } from '../../lib/faab'
import type { LeagueData } from '../../lib/useLeagueData'
import { AvailabilityChip } from '../AvailabilityChip'
import { ContextNotes, contextReasons } from '../ContextNotes'
import { useFantasy } from '../FantasyContext'
import PlayerName from '../PlayerName'
import { useAvailability } from '../useAvailability'
import { Dropdown, FadeStrip, Num, Panel, Reasons, Segmented, Table, compact, fmt, pct, type Column, type Reason, type RowCap, type TableSort } from '../ui'

const PAGE = 50
/** The sorts with a best-first order of their own (lib/availability sortPlayers); the rest are the table's. */
const FA_SORTS: FaSort[] = ['week', 'value', 'trend', 'gain']

/**
 * Every player you can add, free agents and waiver claims alike: filter by position, sort by this week, the rest of
 * the season, what the rest of Sleeper is adding, or what he would do for your lineup, and search by name or team.
 * The pool is a few hundred rows; it is filtered and sorted in memory and drawn fifty at a time.
 */
const FreeAgentBrowser = ({ data, analysis, gains, trending }: { data: LeagueData; analysis: Analysis; gains: Record<string, number>; trending: Record<string, number> }) => {
  const { models } = useFantasy()
  const { status } = useAvailability(data, analysis)
  const players = data.players
  const [pos, setPos] = useState<PosFilter>('ALL')
  // One sort for the Sort menu and the table's headers: either sets it, and both show it.
  const [sort, setSort] = useState<TableSort>({ key: 'value', desc: true })
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(PAGE)
  // A new filter starts the list over at the first page (set during render, so the old length never paints).
  const filterKey = `${pos}|${sort.key}|${sort.desc}|${query}`
  const [lastKey, setLastKey] = useState(filterKey)
  if (lastKey !== filterKey) {
    setLastKey(filterKey)
    setLimit(PAGE)
  }

  const flex = useMemo(() => analysis.slots.find((s) => s.name === 'FLEX')?.eligible ?? ['RB', 'WR', 'TE'], [analysis.slots])
  const week = data.horizon[0]?.week ?? null
  const metrics = useMemo(
    () => ({ week: data.horizon[0]?.pts ?? {}, value: analysis.market, trend: trending, gain: gains }),
    [data.horizon, analysis.market, trending, gains],
  )
  const positions = useMemo(() => [...new Set(analysis.slots.flatMap((s) => s.eligible))], [analysis.slots])
  // Everyone you could add at a position this league starts, once; the filters below run on this smaller list.
  const available = useMemo(() => filterPlayers({ players, pos: 'ALL', own: 'available', query: '', positions, status }), [players, positions, status])
  // Players with no projection and no buzz are hundreds of practice-squad names: kept out of the list, found by search.
  const perWeek = analysis.horizon.perWeek
  const relevant = useMemo(() => (id: string) => (perWeek[id] ?? 0) > 0 || (trending[id] ?? 0) > 0, [perWeek, trending])
  const rows = useMemo(() => {
    const ids = filterPlayers({ players, pool: available, pos, own: 'all', query, flex, relevant, status })
    // Best first on the menu's number (ties by value, then name); the table then orders by the column chosen, keeping
    // that order among equals.
    return sortPlayers(ids, FA_SORTS.includes(sort.key as FaSort) ? (sort.key as FaSort) : 'value', metrics, players)
  }, [available, players, pos, query, flex, relevant, status, sort.key, metrics])
  const cap: RowCap = { limit, step: PAGE, more: () => setLimit((l) => l + PAGE) }

  const me = analysis.myRosterId
  const faab = models.faab
  const why = (id: string) => {
    const items: Reason[] = [...contextReasons(data.context[id], players)]
    if (faab && me != null && gains[id] > 0)
      items.push(...suggestBid(faab, me, { gain: gains[id], value: analysis.market[id] ?? 0, trending: trending[id] ?? 0, pos: players[id]?.pos ?? '' }).reasons)
    return items.length ? <Reasons items={items} /> : null
  }

  const cols: Column<string>[] = [
    {
      key: 'p',
      label: 'Player',
      sticky: true,
      sort: (id) => players[id]?.name ?? id,
      render: (id) => {
        const a = status(id)
        return <PlayerName player={players[id]} id={id} size={24} sub={a.kind === 'waivers' ? <AvailabilityChip a={a} short className="!py-0 !text-[10px] !leading-[14px]" /> : undefined} />
      },
    },
    {
      key: 'week',
      label: week ? `Wk ${week}` : 'Week',
      align: 'right',
      title: `Projected points this week, league scoring`,
      sort: (id) => metrics.week[id] ?? -1,
      render: (id) => (metrics.week[id] ? <span className="text-ff-text">{fmt(metrics.week[id])}</span> : <span className="text-ff-muted">–</span>),
    },
    {
      key: 'exp',
      label: 'Exp/wk',
      align: 'right',
      hideBelow: 'sm',
      title: 'Expected points a week over the rest of the season',
      sort: (id) => analysis.horizon.perWeek[id] ?? -1,
      render: (id) => fmt(analysis.horizon.perWeek[id]),
    },
    {
      key: 'value',
      label: 'Value',
      align: 'right',
      title: 'Rest-of-season value: points a week over a replacement player at his position',
      sort: (id) => analysis.market[id] ?? -99,
      render: (id) => (analysis.market[id] != null ? <Num value={analysis.market[id]} signed /> : <span className="text-ff-muted">–</span>),
    },
    ...(me != null
      ? [
          {
            key: 'gain',
            label: 'For you',
            align: 'right' as const,
            title: 'Points a week he would add to your best lineup over the rest of the season, after the drop it forces. Blank: he would not start for you, or has no projection.',
            sort: (id: string) => gains[id] ?? -99,
            render: (id: string) => (gains[id] ? <Num value={gains[id]} signed /> : <span className="text-ff-muted">–</span>),
          },
        ]
      : []),
    {
      key: 'trend',
      label: 'Adds 24h',
      align: 'right',
      hideBelow: 'sm',
      title: 'Sleeper managers, across all leagues, who added him in the last 24 hours',
      sort: (id) => trending[id] ?? 0,
      render: (id) => (trending[id] ? <span className={trending[id] >= 5000 ? 'text-ff-pos' : undefined}>{compact(trending[id])}</span> : <span className="text-ff-muted">–</span>),
    },
    ...(data.consensus
      ? [
          {
            key: 'ecr',
            label: 'ECR',
            align: 'right' as const,
            hideBelow: 'md' as const,
            title: 'FantasyPros consensus rank at his position, rest of season',
            sort: (id: string) => -(data.consensus!.byId[id]?.posRank ?? 999),
            render: (id: string) => {
              const r = data.consensus!.byId[id]?.posRank
              return r != null ? `${players[id]?.pos}${Math.round(r)}` : <span className="text-ff-muted">–</span>
            },
          },
        ]
      : []),
    { key: 'play', label: 'Plays', align: 'right', hideBelow: 'md', title: 'Chance he plays in the weeks ahead', sort: (id) => data.context[id]?.play ?? 1, render: (id) => pct(data.context[id]?.play) },
    { key: 'why', label: 'Context', hideBelow: 'xl', render: (id) => <ContextNotes context={data.context[id]} players={players} max={2} /> },
  ]

  // The menu names every sort the headers offer, so it always says how the table is ordered.
  const SORTS: { key: string; label: string; title: string }[] = [
    { key: 'value', label: 'Rest of season', title: 'Rest-of-season value over replacement' },
    { key: 'week', label: week ? `Week ${week}` : 'This week', title: 'Projected points this week' },
    ...(me != null ? [{ key: 'gain', label: 'For you', title: 'Gain to your best lineup' }] : []),
    { key: 'trend', label: 'Trending', title: 'Sleeper adds in the last 24 hours' },
    { key: 'exp', label: 'Exp/wk', title: 'Expected points a week, rest of season' },
    ...(data.consensus ? [{ key: 'ecr', label: 'ECR', title: 'FantasyPros rank at his position' }] : []),
    { key: 'play', label: 'Plays', title: 'Chance he plays in the weeks ahead' },
    { key: 'p', label: 'Name', title: 'Player name' },
  ]

  return (
    <div className="ff-stack">
      {/* Position first (the filter people reach for), then the sort and the search, which share a row at every width. */}
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <FadeStrip className="no-scrollbar ff-bleed ff-gutter flex overflow-x-auto md:!mx-0 md:!px-0">
          <Segmented<PosFilter> label="Position" value={pos} onChange={setPos} options={POS_FILTERS.filter((p) => p === 'ALL' || (p === 'FLEX' ? flex.length > 1 : positions.includes(p))).map((p) => ({ key: p, label: p === 'ALL' ? 'All' : p }))} />
        </FadeStrip>
        <div className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-2 lg:flex lg:flex-1 lg:items-center">
        <Dropdown
          label="Sort by"
          value={sort.key ?? 'value'}
          onChange={(v) => setSort({ key: v, desc: v !== 'p' })}
          options={SORTS.map((o) => ({
            value: o.key,
            label: o.label,
            sub: o.title,
            face: (
              <>
                {/* The narrowest phones drop the word (the menu is named "Sort by"), so the search keeps room for its text. */}
                <span className="text-ff-muted max-[359px]:sr-only">Sort </span>
                {o.label}
                {/* The way it runs, as the header's arrow shows it. */}
                <span aria-hidden className="ml-1 text-ff-muted">
                  {sort.desc ? '↓' : '↑'}
                </span>
                <span className="sr-only">{sort.desc ? ', high to low' : ', low to high'}</span>
              </>
            ),
          }))}
          className="lg:w-[200px]"
          buttonClassName="max-md:h-10"
        />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Name or team"
          aria-label="Search available players by name or team"
          className="h-8 min-w-0 rounded-sm border border-ff-line bg-ff-panel px-2.5 text-[13px] text-ff-text outline-none placeholder:text-ff-muted focus-visible:border-ff-accent focus-visible:ring-1 focus-visible:ring-ff-accent max-md:h-10 lg:w-[260px]"
        />
        </div>
      </div>
      <Panel
        title={pos === 'ALL' ? 'Available players' : pos === 'FLEX' ? `Available ${flex.join('/')}` : `Available ${pos}s`}
        actions={
          <span aria-live="polite">
            {rows.length > limit ? `${limit} of ${rows.length}` : `${rows.length} ${rows.length === 1 ? 'player' : 'players'}`}
          </span>
        }
        pad={false}
      >
        <Table
          rows={rows}
          cap={cap}
          rowKey={(id) => id}
          columns={cols}
          sort={sort}
          onSort={setSort}
          canExpand={(id) => !!data.context[id]?.notes.length || (!!faab && gains[id] > 0)}
          expand={why}
          empty={query ? `Nobody available matches “${query}”.` : 'No one available at this position.'}
        />
      </Panel>
    </div>
  )
}

export default FreeAgentBrowser
