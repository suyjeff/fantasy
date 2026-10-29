import { describe, expect, it } from 'vitest'
import { dealFromIdea, emptyDeal, type Deal } from '../deal'
import { clearTrade, discard, dismissUndo, dockMode, editTrade, emptyDock, expand, MAX_TRADES, minimize, openTrade, startTrade, undoDock, type DockState } from '../dock'

const ME = 1
const deal = (partner: number, give = 'a1', get = `p${partner}`): Deal => dealFromIdea(ME, partner, [give], [get])
const ids = (s: DockState) => s.trades.map((t) => t.id)
/** Three trades with something in each, the last one open. */
const full = () => {
  let s = emptyDock()
  for (const p of [2, 3, 4]) s = startTrade(s, ME, deal(p))
  return s
}

describe('the trade dock', () => {
  it('opens a new trade for each deal, the others minimized, up to the limit', () => {
    let s = startTrade(emptyDock(), ME, deal(2))
    expect(dockMode(s)).toBe('open')
    expect(openTrade(s)?.step).toBe('review')
    expect(openTrade(s)?.view).toBe(2)
    s = startTrade(s, ME, deal(3))
    expect(s.trades).toHaveLength(2)
    expect(openTrade(s)?.deal.teams).toEqual([ME, 3])
    s = minimize(s)
    expect(dockMode(s)).toBe('min')
    expect(s.focus).toBe(s.trades[1].id)
    s = expand(s, s.trades[0].id)
    expect(openTrade(s)?.deal.teams).toEqual([ME, 2])
    expect(s.trades).toHaveLength(2)
  })

  it('brings up the same deal rather than opening it twice', () => {
    let s = startTrade(emptyDock(), ME, deal(2))
    s = minimize(startTrade(s, ME, deal(3)))
    const again = startTrade(s, ME, deal(2))
    expect(again.trades).toHaveLength(2)
    expect(again.open).toBe(s.trades[0].id)
  })

  it('reuses a trade with nothing in it, keeping its partner on a blank start', () => {
    let s = startTrade(emptyDock(), ME)
    expect(openTrade(s)?.step).toBe('pick')
    const id = s.open!
    s = editTrade(s, id, (d) => ({ ...d, teams: [ME, 5] }))
    s = minimize(s)
    const blank = startTrade(s, ME)
    expect(blank.trades).toHaveLength(1)
    expect(openTrade(blank)?.deal.teams).toEqual([ME, 5])
    const filled = startTrade(s, ME, deal(2))
    expect(filled.trades).toHaveLength(1)
    expect(filled.open).toBe(id)
    expect(openTrade(filled)?.deal).toEqual(deal(2))
  })

  it('past the limit, replaces the trade least recently touched, and undo puts it back', () => {
    let s = full()
    expect(s.trades).toHaveLength(MAX_TRADES)
    // Touch the first, so the second is now the least recent.
    s = expand(s, s.trades[0].id)
    const [, second] = s.trades
    s = startTrade(s, ME, deal(6))
    expect(s.trades).toHaveLength(MAX_TRADES)
    expect(s.trades[1].deal.teams).toEqual([ME, 6])
    expect(s.open).toBe(s.trades[1].id)
    expect(s.undo).toMatchObject({ kind: 'replaced', index: 1, trade: second })
    const back = undoDock(s)
    expect(back.trades[1]).toEqual(second)
    expect(back.open).toBe(second.id)
    expect(back.undo).toBeNull()
  })

  it('an edit to the new trade settles the replace', () => {
    let s = startTrade(full(), ME, deal(6))
    s = editTrade(s, s.open!, (d) => ({ ...d, faab: [{ from: ME, to: 6, dollars: 5 }] }))
    expect(s.undo).toBeNull()
  })

  it('discards a trade with an undo that puts it back where it stood', () => {
    let s = minimize(full())
    const mid = s.trades[1]
    s = discard(s, mid.id)
    expect(ids(s)).not.toContain(mid.id)
    expect(s.toast).toBe(1)
    expect(s.undo).toMatchObject({ kind: 'discarded', index: 1, wasOpen: false })
    s = undoDock(s)
    expect(s.trades[1]).toEqual(mid)
    expect(s.toast).toBe(0)
    expect(s.focus).toBe(mid.id)
    expect(dockMode(s)).toBe('min')
  })

  it('reopens a trade discarded while open', () => {
    let s = startTrade(emptyDock(), ME, deal(2))
    const id = s.open!
    s = discard(s, id)
    expect(dockMode(s)).toBe('closed')
    s = undoDock(s)
    expect(s.open).toBe(id)
  })

  it('closes an empty trade without a notice', () => {
    let s = startTrade(emptyDock(), ME)
    s = discard(s, s.open!)
    expect(s.trades).toEqual([])
    expect(s.undo).toBeNull()
    expect(s.toast).toBe(0)
  })

  it('restores a discarded trade from inside an empty one, in its place', () => {
    let s = startTrade(emptyDock(), ME, deal(2))
    const gone = openTrade(s)!
    s = dismissUndo(discard(s, gone.id))
    expect(s.undo?.kind).toBe('discarded')
    s = startTrade(s, ME)
    expect(s.undo?.kind).toBe('discarded')
    s = undoDock(s)
    expect(s.trades).toEqual([gone])
    expect(s.open).toBe(gone.id)
  })

  it('clears a trade’s players with an undo', () => {
    let s = startTrade(emptyDock(), ME, deal(2))
    const before = openTrade(s)!.deal
    s = clearTrade(s, s.open!)
    expect(openTrade(s)!.deal.moves).toEqual([])
    expect(s.undo?.kind).toBe('cleared')
    expect(openTrade(undoDock(s))!.deal).toEqual(before)
    // Nothing to clear: nothing happens.
    const empty = startTrade(emptyDock(), ME)
    expect(clearTrade(empty, empty.open!)).toBe(empty)
  })

  it('edits touch only their own trade', () => {
    let s = full()
    const [a, b] = s.trades
    s = editTrade(s, a.id, (d) => ({ ...d, moves: [] }))
    expect(s.trades[0].deal.moves).toEqual([])
    expect(s.trades[1]).toEqual(b)
    expect(s.trades[0].touched).toBeGreaterThan(s.trades[2].touched)
    expect(editTrade(s, 'nope', () => emptyDeal([ME]))).toBe(s)
  })

  it('keeps each trade’s number while it is open: a discard never renumbers the rest', () => {
    let s = full()
    const labels = () => s.trades.map((t) => t.label)
    expect(labels()).toEqual([1, 2, 3])
    s = discard(s, s.trades[0].id)
    expect(labels()).toEqual([2, 3])
    // The next new trade takes the lowest number free.
    s = startTrade(s, ME, deal(5))
    expect(labels()).toEqual([2, 3, 1])
    // A trade replaced at the limit hands its number to the one replacing it.
    const lo = s.trades.reduce((a, t) => (t.touched < a.touched ? t : a))
    s = startTrade(s, ME, deal(6))
    expect(s.trades.find((t) => t.deal.teams.includes(6))?.label).toBe(lo.label)
    expect(new Set(labels()).size).toBe(3)
  })

  it('gives a restored trade its number back, or a free one if it was taken', () => {
    let s = full()
    s = discard(s, s.trades[0].id)
    s = undoDock(s)
    expect(s.trades.map((t) => t.label)).toEqual([1, 2, 3])
    // Two open; Trade 1 discarded, and a new trade takes its number before the undo.
    s = startTrade(startTrade(emptyDock(), ME, deal(2)), ME, deal(3))
    s = discard(s, s.trades[0].id)
    s = minimize(startTrade(s, ME, deal(4)))
    expect(s.trades.map((t) => t.label)).toEqual([2, 1])
    s = undoDock(s)
    expect(s.trades.map((t) => [t.deal.teams[1], t.label])).toEqual([
      [2, 3],
      [3, 2],
      [4, 1],
    ])
  })
})
