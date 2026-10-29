import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as cmp from '../lib/compare'
import { MAX_COMPARE, type CompareItem, type CompareSet } from '../lib/compare'
import { dealActive, type Deal } from '../lib/deal'
import { writeStored } from '../lib/storage'
import { useFantasy } from './FantasyContext'
import { AddIcon } from './icons'
import { cx } from './ui'

// The comparison set (lib/compare), for the whole app: the Trades page's Compare tab shows it; the builder, the
// trade cards and the minimized trades add to it. Kept per league in localStorage, as deals, so it survives a
// reload and prices afresh on new data.

export type CompareApi = {
  items: CompareSet
  full: boolean
  /** Add a deal; the item it went in as (or already was), or null when it could not go in. */
  add: (deal: Deal) => CompareItem | null
  remove: (id: string) => void
  move: (id: string, by: -1 | 1) => void
  replace: (id: string, deal: Deal) => void
  find: (deal: Deal) => CompareItem | null
  /**
   * The comparison item a builder trade came from or went to (by the dock's trade id), so a trade changed after it
   * was added can update its column rather than only add another.
   */
  link: (tradeId: string, itemId: string) => void
  linkOf: (tradeId: string) => CompareItem | null
}

const Ctx = createContext<CompareApi | null>(null)
/** The comparison, or null outside a league view. */
export const useCompare = () => useContext(Ctx)

const read = (key: string): CompareSet => {
  try {
    return cmp.parseCompare(window.localStorage.getItem(key))
  } catch {
    return []
  }
}

export const CompareProvider = ({ children }: { children: ReactNode }) => {
  const { data } = useFantasy()
  const key = cmp.compareKey(data.league.league_id)
  // Read after mounting (the page is prerendered without storage), then kept in step with it.
  const [state, setState] = useState<{ key: string; items: CompareSet } | null>(null)
  useEffect(() => setState({ key, items: read(key) }), [key])
  // Another tab changed it: take its version.
  useEffect(() => {
    const on = (e: StorageEvent) => e.key === key && setState({ key, items: cmp.parseCompare(e.newValue) })
    window.addEventListener('storage', on)
    return () => window.removeEventListener('storage', on)
  }, [key])
  const items = state && state.key === key ? state.items : NONE
  const [said, setSaid] = useState('')
  const links = useRef(new Map<string, string>())

  const set = useCallback(
    (fn: (s: CompareSet) => CompareSet) =>
      setState((cur) => {
        const base = cur && cur.key === key ? cur.items : read(key)
        const next = fn(base)
        if (next === base) return cur
        writeStored(key, cmp.serializeCompare(next))
        return { key, items: next }
      }),
    [key],
  )

  const api = useMemo<CompareApi>(() => {
    const find = (deal: Deal) => cmp.findDeal(items, deal)
    return {
      items,
      full: items.length >= MAX_COMPARE,
      find,
      add: (deal) => {
        const r = cmp.addCompare(items, deal)
        if (r.status === 'added') {
          set(() => r.set)
          setSaid(`Added to compare as trade ${cmp.slotLetter(r.item!.slot)}.`)
        } else if (r.status === 'full') setSaid(`Compare holds ${MAX_COMPARE} trades at most. Remove one to add this.`)
        return r.item
      },
      remove: (id) => {
        const it = items.find((i) => i.id === id)
        set((s) => cmp.removeCompare(s, id))
        if (it) setSaid(`Trade ${cmp.slotLetter(it.slot)} removed from compare.`)
      },
      move: (id, by) => set((s) => cmp.moveCompare(s, id, by)),
      replace: (id, deal) => {
        set((s) => cmp.replaceCompare(s, id, deal))
        setSaid('Compare updated.')
      },
      link: (tradeId, itemId) => void links.current.set(tradeId, itemId),
      linkOf: (tradeId) => {
        const id = links.current.get(tradeId)
        return (id && items.find((i) => i.id === id)) || null
      },
    }
  }, [items, set])

  return (
    <Ctx.Provider value={api}>
      {children}
      <p role="status" className="sr-only">
        {said}
      </p>
    </Ctx.Provider>
  )
}

const NONE: CompareSet = []

const CHECK = 'M3.5 7.2l2.4 2.4 4.6-5'
const CROSS = 'M3.5 3.5l7 7M10.5 3.5l-7 7'
const Check = ({ size = 12, d = CHECK }: { size?: number; d?: string }) => (
  <svg aria-hidden width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" className="block shrink-0">
    <path d={d} />
  </svg>
)

/** The colour of a comparison slot, as a small square: the same colour its column and line carry. */
export const SlotKey = ({ slot, className }: { slot: number; className?: string }) => (
  <span aria-hidden className={cx('inline-block h-2 w-2 shrink-0', className)} style={{ background: `rgb(var(--ff-k${slot + 1}))` }} />
)

/**
 * Add a deal to the comparison, or see that it is in (and take it out). Where the deal came from the comparison and
 * has changed since (`tradeId` links it), it offers to update that column, or add the change as a column of its own.
 * `size`: 'sm' on a trade card, 'md' in the builder.
 */
export const CompareToggle = ({ deal, tradeId, size = 'md', className }: { deal: Deal; tradeId?: string; size?: 'sm' | 'md'; className?: string }) => {
  const c = useCompare()
  const item = c?.find(deal) ?? null
  useEffect(() => {
    if (c && item && tradeId) c.link(tradeId, item.id)
  }, [c, item, tradeId])
  if (!c) return null
  const linked = !item && tradeId ? c.linkOf(tradeId) : null
  const ready = dealActive(deal) && deal.teams.length > 1
  const h = size === 'sm' ? 'h-7 px-2 text-[11.5px] max-md:h-10 max-[359px]:min-w-10' : 'h-10 px-3 text-[12.5px] md:h-8'
  const base = cx('ff-press inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap border', h, className)
  if (item)
    return (
      <button
        type="button"
        aria-pressed
        onClick={() => c.remove(item.id)}
        title={`In compare as trade ${cmp.slotLetter(item.slot)}. Press to take it out.`}
        className={cx(base, 'group border-ff-pos/40 bg-ff-pos/[0.08] text-ff-text hover:border-ff-neg/40 hover:bg-ff-neg/[0.06]')}
      >
        <SlotKey slot={item.slot} />
        {/* On a narrow card the tick says it; the words stay for screen readers. */}
        <span className={cx(size === 'sm' && 'max-[359px]:sr-only')}>In compare</span>
        {/* The tick turns to a cross under the pointer, the same size, so nothing shifts. */}
        <span className="text-ff-pos group-hover:hidden">
          <Check />
        </span>
        <span className="hidden text-ff-neg group-hover:inline">
          <Check d={CROSS} />
        </span>
      </button>
    )
  if (linked)
    return (
      <span className={cx('inline-flex shrink-0', className)}>
        <button
          type="button"
          onClick={() => c.replace(linked.id, deal)}
          title={`Put this version in place of trade ${cmp.slotLetter(linked.slot)} in compare`}
          className={cx(base, '!ml-0 border-ff-accent/40 bg-ff-accent/[0.08] text-ff-text hover:bg-ff-accent/[0.14]')}
        >
          <SlotKey slot={linked.slot} />
          Update compare
        </button>
        {!c.full && (
          <button
            type="button"
            onClick={() => c.add(deal)}
            aria-label="Add this version to compare as a trade of its own"
            title="Add this version as a trade of its own"
            className={cx(base, '-ml-px w-10 !px-0 border-ff-line2 text-ff-text2 hover:bg-ff-raised hover:text-ff-text md:w-8')}
          >
            <AddIcon size={12} />
          </button>
        )}
      </span>
    )
  if (c.full)
    return (
      <button type="button" disabled title={`Compare holds ${MAX_COMPARE} trades. Remove one there to add this.`} className={cx(base, 'border-ff-line text-ff-muted')}>
        Compare full
      </button>
    )
  return (
    <button
      type="button"
      disabled={!ready}
      onClick={() => c.add(deal)}
      title={ready ? 'Add to the comparison on the Trades page' : 'Put players in the trade to compare it'}
      className={cx(base, 'border-ff-line2 bg-ff-panel text-ff-text hover:bg-ff-raised disabled:text-ff-muted disabled:hover:bg-ff-panel')}
    >
      <AddIcon size={size === 'sm' ? 11 : 12} />
      <span className={cx(size === 'sm' && 'max-[359px]:sr-only')}>{size === 'sm' ? 'Compare' : 'Add to compare'}</span>
    </button>
  )
}
