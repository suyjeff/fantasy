import React, { useState } from 'react'
import { useFantasy } from './FantasyContext'
import GameSheet from './GameSheet'
import MatchupSheet from './MatchupSheet'
import PlayerSheet from './PlayerSheet'
import Sheet, { SheetNavContext } from './Sheet'
import TeamSheet from './TeamSheet'
import { useAsgmContext } from './assistant/AsgmProvider'
import type { AsgmContext } from '../lib/assistant'

/** What a sheet can show. Every entity in the app opens one of these. */
export type SheetRef = { kind: 'player'; id: string } | { kind: 'team'; id: number } | { kind: 'game'; key: string } | { kind: 'matchup'; week: number; a: number; b: number }

export const sheetKey = (r: SheetRef) =>
  r.kind === 'player' ? `p:${r.id}` : r.kind === 'team' ? `t:${r.id}` : r.kind === 'game' ? `g:${r.key}` : `m:${r.week}:${Math.min(r.a, r.b)}:${Math.max(r.a, r.b)}`

/**
 * The one sheet: whatever is open shows here, always the same width, and opening something from inside it (a player
 * from a team, a manager from a matchup) swaps the content in place, with a way back, rather than stacking panels.
 */
const SheetHost = ({ stack, onBack, onClose }: { stack: SheetRef[]; onBack: () => void; onClose: () => void }) => {
  const { data, analysis } = useFantasy()
  const top = stack[stack.length - 1]
  // How the sheet got to what it shows now, decided once per change of content: a shorter trail is a step back.
  // Kept as state updated during render (React's pattern for deriving from a change in props), so a render React
  // throws away never leaves a half-made decision behind.
  const [seen, setSeen] = useState<{ key: string; depth: number; step: 'open' | 'push' | 'back' } | null>(null)
  const key = top ? sheetKey(top) : null
  if (!key && seen) setSeen(null)
  else if (key && seen?.key !== key) setSeen({ key, depth: stack.length, step: !seen ? 'open' : stack.length < seen.depth ? 'back' : 'push' })
  // What the sheet shows is what Assistant GM is asked about while it is open.
  const pl = top?.kind === 'player' ? data.players[top.id] : null
  const asgm: AsgmContext | null = !top
    ? null
    : top.kind === 'player'
      ? pl
        ? { view: 'sheet/player', label: pl.name, focus: { kind: 'player', id: top.id, label: pl.name } }
        : null
      : top.kind === 'team'
        ? analysis.teamById[top.id]
          ? { view: 'sheet/team', label: analysis.teamById[top.id].name, focus: { kind: 'team', rosterId: top.id, label: analysis.teamById[top.id].name } }
          : null
        : top.kind === 'matchup'
          ? (() => {
              const label = `${analysis.teamById[top.a]?.name ?? '?'} vs ${analysis.teamById[top.b]?.name ?? '?'}, wk ${top.week}`
              return { view: 'sheet/matchup', label, focus: { kind: 'matchup', week: top.week, rosterIds: [top.a, top.b], label } }
            })()
          : null
  useAsgmContext(asgm)
  // A ref to something no longer in the league (a switch mid-render, a stale link) opens nothing rather than an empty sheet.
  if (!top || (top.kind === 'player' && !data.players[top.id]) || (top.kind === 'team' && !analysis.teamById[top.id])) return null
  const name = (r: SheetRef | undefined): string => {
    if (!r) return ''
    if (r.kind === 'player') return data.players[r.id]?.name.split(' ').slice(-1)[0] ?? 'player'
    if (r.kind === 'team') return analysis.teamById[r.id]?.name ?? 'team'
    if (r.kind === 'game') return r.key.split(':')[1]?.replace('@', ' @ ') ?? 'game'
    return 'matchup'
  }
  const label =
    top.kind === 'player'
      ? `${data.players[top.id]?.name ?? 'Player'} details`
      : top.kind === 'team'
        ? `${name(top)} summary`
        : top.kind === 'game'
          ? `${name(top)} game`
          : `${analysis.teamById[top.a]?.name ?? ''} vs ${analysis.teamById[top.b]?.name ?? ''}`
  const prev = stack[stack.length - 2]
  return (
    <Sheet label={label} onClose={onClose} contentKey={sheetKey(top)}>
      {({ close, phone }) => (
        <SheetNavContext.Provider value={{ close, phone, back: prev ? onBack : undefined, backLabel: prev ? name(prev) : undefined, step: seen?.step }}>
          {top.kind === 'player' ? (
            <PlayerSheet key={sheetKey(top)} id={top.id} />
          ) : top.kind === 'team' ? (
            <TeamSheet key={sheetKey(top)} rosterId={top.id} />
          ) : top.kind === 'game' ? (
            <GameSheet key={sheetKey(top)} gameKey={top.key} />
          ) : (
            <MatchupSheet key={sheetKey(top)} week={top.week} a={top.a} b={top.b} />
          )}
        </SheetNavContext.Provider>
      )}
    </Sheet>
  )
}

export default SheetHost
