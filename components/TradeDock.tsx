import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { dealActive, dealFromIdea, dealSummary, type Deal } from '../lib/deal'
import * as dock from '../lib/dock'
import { MAX_TRADES, type DockState, type DockStep, type DockTrade } from '../lib/dock'
import type { TradeIdea } from '../lib/trades'
import { useFantasy } from './FantasyContext'
import { TradeIcon } from './icons'
import { useModal } from './Sheet'
import SwipeSheet, { type SwipeSheetHandle } from './SwipeSheet'
import TradeBuilder, { BuilderHeader, CLOSE, Glyph, headline, useDealPricing, useDealRead, type DealUpdate } from './TradeBuilder'
import { AddIcon } from './icons'
import { CompareProvider, CompareToggle } from './useCompare'
import { cx, fmtSigned, reducedMotion, useMedia, usePhone } from './ui'

// The trade builder's home: up to three trades for the whole app, kept above the pages so they survive being
// minimized and moving between sections. One is open at a time: a sheet from the bottom on a phone, a large dialog
// on a wide screen. The rest are minimized: bars stacked above the phone's tab bar, or cards side by side in the
// bottom-right corner. Anything that builds a deal ("Open in builder" on a trade card, the Build a trade buttons, an
// old #trades/builder link) opens it here, as a trade of its own. The list itself, and what each action does to it,
// is lib/dock.
//
// Two hooks read it. useTradeDock: the actions and the dock's mode, steady while a trade is edited (so a page that
// only opens trades does not re-render on every tap in one). useOpenTrades: the trades themselves, for anything
// that shows or compares them.

export type { Deal } from '../lib/deal'
export { MAX_TRADES }

/** A trade open in the dock, as the rest of the app sees it. */
export type OpenTrade = {
  id: string
  deal: Deal
  step: DockStep
  /** Its number ("Trade 2"), kept for its life, as the minimized bars and the header's switcher show it. */
  label: number
  /** The one expanded; the rest are minimized. */
  open: boolean
}

export type TradeDockApi = {
  /** 'open': a trade is showing; 'min': trades are open, all minimized; 'closed': none. */
  mode: 'open' | 'min' | 'closed'
  /** How many trades are open (at most `limit`). */
  count: number
  limit: number
  /**
   * Start a trade: with this deal (at the review when it has something in it), or a blank one. The same deal
   * already open is brought up instead; past the limit, the trade least recently touched gives way, with an undo.
   */
  open: (deal?: Deal, step?: DockStep) => void
  /** Open a suggested trade in the builder, priced, at the review. */
  openIdea: (idea: TradeIdea) => void
  /** Bring up a trade already open (by `OpenTrade.id`); the one showing minimizes. */
  openTrade: (id: string) => void
  minimize: () => void
  /** Close a trade (the one showing, by default). One with anything in it can be brought back from the notice. */
  close: (id?: string) => void
  /** The "Trade discarded · Undo" notice is up (the phone's build button steps aside for it). */
  toast: boolean
}

const DockCtx = createContext<TradeDockApi | null>(null)
const TradesCtx = createContext<readonly OpenTrade[]>([])
/** The builder's dock, or null where there is none (no roster of yours in this league). */
export const useTradeDock = () => useContext(DockCtx)
/** The trades open in the dock, in the order they were started. Changes with every edit to any of them. */
export const useOpenTrades = () => useContext(TradesCtx)

type Set = (fn: (d: DockState) => DockState) => void

export const TradeDockProvider = ({ children }: { children: ReactNode }) => {
  const { data, analysis } = useFantasy()
  const me = analysis.myRosterId
  const league = data.league.league_id
  const [state, setState] = useState(() => ({ league, dock: dock.emptyDock() }))
  // Another league's trades mean nothing here: a switch starts over, with none.
  const cur = state.league === league ? state : { league, dock: dock.emptyDock() }
  if (cur !== state) setState(cur)
  const d = cur.dock
  const set: Set = useCallback((fn) => setState((s) => ({ ...s, dock: fn(s.dock) })), [])

  const mode = dock.dockMode(d)
  const toast = d.toast > 0 && mode !== 'open'
  const count = d.trades.length
  const api = useMemo<TradeDockApi | null>(
    () =>
      me == null
        ? null
        : {
            mode,
            count,
            limit: MAX_TRADES,
            toast,
            open: (deal, step) => set((s) => dock.startTrade(s, me, deal, step)),
            openIdea: (idea) => set((s) => dock.startTrade(s, me, dealFromIdea(me, idea.partnerId, idea.give, idea.get), 'review')),
            openTrade: (id) => set((s) => dock.expand(s, id)),
            minimize: () => set(dock.minimize),
            close: (id) =>
              set((s) => {
                const t = id ?? s.open
                return t ? dock.discard(s, t) : s
              }),
          },
    [mode, count, toast, me, set],
  )
  const trades = useMemo<readonly OpenTrade[]>(() => d.trades.map((t) => ({ id: t.id, deal: t.deal, step: t.step, label: t.label, open: t.id === d.open })), [d.trades, d.open])

  // The provider and the page under it keep their place whether or not you have a roster here, so a roster coming
  // or going never remounts the page.
  return (
    <DockCtx.Provider value={api}>
      <TradesCtx.Provider value={me == null ? NONE : trades}>
        <CompareProvider>
          {children}
          {api && <DockHost state={d} set={set} api={api} />}
        </CompareProvider>
      </TradesCtx.Provider>
    </DockCtx.Provider>
  )
}

const NONE: readonly OpenTrade[] = []

type HostProps = { state: DockState; set: Set; api: TradeDockApi }

const DockHost = ({ state, set, api }: HostProps) => {
  const { analysis } = useFantasy()
  const phone = usePhone()
  const me = analysis.myRosterId!
  const name = (t: number) => analysis.teamById[t]?.name ?? `#${t}`
  const open = dock.openTrade(state)
  const u = state.undo
  // In number order, so "Trade 2" is always the second bar, whatever order the trades were started in.
  const minimized = state.trades.filter((t) => t.id !== state.open).sort((a, b) => a.label - b.label)
  const toast = state.toast > 0 && !open && u?.kind === 'discarded' ? u : null
  const undo = useCallback(() => set(dock.undoDock), [set])
  const dismiss = useCallback(() => set(dock.dismissUndo), [set])
  const more = phone && !open && state.trades.length < MAX_TRADES
  // Named by its number while others are open, so the notice says which went even where its line is cut short.
  const gone = toast ? (state.trades.length > 0 ? `Trade ${toast.trade.label} discarded` : 'Trade discarded') : ''

  // What a discard, replace or clear just did, said once to screen readers from a region that is always there.
  const said = !u
    ? ''
    : u.kind === 'discarded'
      ? toast
        ? `${gone}.`
        : ''
      : open && (u.kind === 'replaced' ? u.by === open.id : u.trade.id === open.id)
        ? u.kind === 'replaced'
          ? `${MAX_TRADES} trades are open at most, so this one replaced your least recent.`
          : 'Players cleared.'
        : ''
  // The minimized stack, and the notice after a discard in the place the trade had.
  const items: ReactNode[] = minimized.map((t) => (
    <Minimized
      key={t.id}
      trade={t}
      label={state.trades.length > 1 ? `Trade ${t.label}` : 'Trade builder'}
      phone={phone}
      onOpen={() => api.openTrade(t.id)}
      onClose={() => api.close(t.id)}
      autoFocus={state.focus === t.id}
    />
  ))
  if (toast)
    items.splice(
      minimized.filter((t) => t.label < toast.trade.label).length,
      0,
      <Discarded key={`gone-${state.toast}`} text={gone} line={dealSummary(toast.trade.deal, me, name)} phone={phone} onUndo={undo} onDismiss={dismiss} />,
    )
  return (
    <>
      <p role="status" className="sr-only">
        {said && `${said} Undo is available.`}
      </p>
      {/* Room at the end of the page for the stack, so it never covers the last of it. */}
      {items.length > 0 && <div aria-hidden style={{ height: phone ? items.length * BAR + (more ? NEW_TAB : 0) : 76 }} />}
      {items.length > 0 && (
        <div
          role="region"
          aria-label={minimized.length > 1 ? 'Minimized trades' : 'Minimized trade'}
          className={cx(
            'fixed z-[31] flex',
            phone
              ? 'inset-x-0 bottom-[calc(48px+env(safe-area-inset-bottom))] flex-col shadow-[0_-10px_28px_-10px_rgba(0,0,0,0.5)]'
              : 'bottom-4 right-4 max-w-[calc(100vw-32px)] items-end justify-end gap-2',
          )}
        >
          {/* One accent rule across the top of the phone's stack, not one per bar. */}
          {phone && <span aria-hidden className="absolute inset-x-0 -top-px z-[1] h-[2px] bg-[color:var(--ink-accent)]" />}
          {/* On a phone the build button steps aside while trades are minimized; a tab on the stack starts another. */}
          {more && (
            <button
              type="button"
              onClick={() => api.open()}
              className="tb-ink tb-ink-btn ff-press absolute bottom-full right-[max(0px,env(safe-area-inset-right))] flex items-center gap-1.5 border-x border-t px-3 text-[12.5px] font-medium"
              style={{ height: NEW_TAB }}
            >
              <span className="text-[color:var(--ink-accent)]">
                <AddIcon size={11} />
              </span>
              New trade
            </button>
          )}
          {items}
        </div>
      )}
      {open && (phone ? <PhoneSheet state={state} set={set} api={api} trade={open} /> : <DesktopDialog state={state} set={set} api={api} trade={open} />)}
    </>
  )
}

type OpenProps = HostProps & { trade: DockTrade }

/** The trade showing, in the builder. Keyed by trade: switching trades starts its pricing and pickers afresh. */
const Body = ({ state, set, api, trade, layout, titleId, onMinimize, onClose }: OpenProps & { layout: 'steps' | 'split'; titleId: string; onMinimize: () => void; onClose: () => void }) => {
  const { analysis } = useFantasy()
  const me = analysis.myRosterId!
  const name = (t: number) => analysis.teamById[t]?.name ?? `#${t}`
  const id = trade.id
  const update: DealUpdate = useCallback((fn) => set((s) => dock.editTrade(s, id, fn)), [set, id])
  const setStep = useCallback((step: DockStep) => set((s) => dock.setTradeStep(s, id, step)), [set, id])
  const setView = useCallback((view: number) => set((s) => dock.setTradeView(s, id, view)), [set, id])
  const clear = useCallback(() => set((s) => dock.clearTrade(s, id)), [set, id])
  const undo = () => set(dock.undoDock)
  const dismiss = () => set(dock.dismissUndo)
  const pricing = useDealPricing(trade.deal, true)
  const u = state.undo
  // In the builder: undo the replace or the clear this trade just had, or (opened empty) bring back the trade last
  // discarded.
  const notice = !u ? null : u.kind === 'replaced' && u.by === id ? (
    <UndoNotice text={`${MAX_TRADES} trades at most: replaced`} detail={dealSummary(u.trade.deal, me, name)} action="Undo" onAction={undo} onDismiss={dismiss} />
  ) : u.kind === 'cleared' && u.trade.id === id ? (
    <UndoNotice text="Players cleared" detail={null} action="Undo" onAction={undo} onDismiss={dismiss} />
  ) : u.kind === 'discarded' && !dealActive(trade.deal) ? (
    <UndoNotice text="Discarded trade" detail={dealSummary(u.trade.deal, me, name)} action="Restore" onAction={undo} onDismiss={dismiss} />
  ) : null
  // Every open trade by its number, for the header's switcher.
  const tabs = useMemo(
    () => (state.trades.length > 1 ? [...state.trades].sort((a, b) => a.label - b.label).map((t) => ({ id: t.id, label: t.label, line: dealSummary(t.deal, me, name), current: t.id === id })) : null),
    [state.trades, id, me], // eslint-disable-line react-hooks/exhaustive-deps
  )
  // The lineup figure has places of its own (the tray, the verdict, the minimized card), so the header's line
  // leaves it out rather than have it cut off.
  return (
    <TradeBuilder
      deal={trade.deal}
      update={update}
      pricing={pricing}
      step={trade.step}
      setStep={setStep}
      view={trade.view}
      setView={setView}
      layout={layout}
      onClear={clear}
      reviewAction={<CompareToggle deal={trade.deal} tradeId={id} className="md:hidden" />}
      header={
        <>
          <BuilderHeader
            titleId={titleId}
            summary={dealSummary(trade.deal, me, name)}
            tabs={tabs}
            onSwitch={api.openTrade}
            actions={<CompareToggle deal={trade.deal} tradeId={id} className="max-md:hidden" />}
            onNew={() => api.open()}
            onMinimize={onMinimize}
            onClose={onClose}
          />
          {notice}
        </>
      }
    />
  )
}

/** A strip under the builder's header: what just happened, the way back, and × to let it be. */
const UndoNotice = ({ text, detail, action, onAction, onDismiss }: { text: string; detail: string | null; action: string; onAction: () => void; onDismiss: () => void }) => (
  <div className="tb-fade flex min-h-11 shrink-0 items-center gap-2 border-b border-ff-line bg-ff-sunken pl-3 md:pl-4">
    <p className="min-w-0 flex-1 truncate text-[12.5px] text-ff-text2">
      <span className="text-ff-text">{text}</span>
      {detail && <span className="font-mono text-[11px] text-ff-muted"> · {detail}</span>}
    </p>
    <button type="button" onClick={onAction} className="ff-press h-11 shrink-0 px-3 text-[13px] font-medium text-ff-accent hover:bg-ff-raised md:h-9">
      {action}
    </button>
    <button type="button" onClick={onDismiss} aria-label="Dismiss" title="Dismiss" className="ff-press flex h-11 w-11 shrink-0 items-center justify-center border-l border-ff-line text-ff-muted hover:bg-ff-raised hover:text-ff-text md:h-9 md:w-9">
      <Glyph d={CLOSE} size={12} />
    </button>
  </div>
)

/** Phones: a tall sheet from the bottom. Swiping it down (or tapping above it) minimizes; × closes. */
const PhoneSheet = (props: OpenProps) => {
  const { api, trade } = props
  const swipe = useRef<SwipeSheetHandle>(null)
  const panel = useRef<HTMLDivElement>(null)
  // What the slide away is for: a swipe or a tap outside minimizes, × closes.
  const intent = useRef<'min' | 'close'>('min')
  const leave = (why: 'min' | 'close') => {
    intent.current = why
    if (swipe.current) swipe.current.dismiss()
    else if (why === 'close') api.close()
    else api.minimize()
  }
  // × pressed, then the sheet caught and pulled back up: once it rests fully open again, the next slide away is a
  // swipe again, so it minimizes rather than carrying out the close the pull cancelled.
  useEffect(() => {
    const el = panel.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => e.intersectionRatio >= 0.99 && (intent.current = 'min'), { threshold: 0.99 })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  useModal(panel, () => leave('min'))
  const titleId = useId()
  return (
    <SwipeSheet
      ref={swipe}
      side="bottom"
      className="z-[45]"
      onDismissed={() => (intent.current === 'close' ? api.close() : api.minimize())}
      backdropClassName="bg-black/45"
      panelRef={panel}
      panelProps={{ role: 'dialog', 'aria-modal': true, 'aria-labelledby': titleId, tabIndex: -1 }}
      panelClassName="flex h-[calc(100dvh-40px)] w-full flex-col border-t border-ff-line2 bg-ff-panel pb-[env(safe-area-inset-bottom)] shadow-[0_-8px_40px_rgba(0,0,0,0.35)] outline-none"
    >
      <div className="flex h-3 shrink-0 items-end justify-center" aria-hidden>
        <span className="h-1 w-10 bg-ff-line2" />
      </div>
      <Body key={trade.id} {...props} layout="steps" titleId={titleId} onMinimize={() => leave('min')} onClose={() => leave('close')} />
    </SwipeSheet>
  )
}

/** Wide screens: a large dialog over the page. Minimizing shrinks it toward the corner cards it joins. */
const DesktopDialog = (props: OpenProps) => {
  const { api, trade } = props
  // Wide enough for Pick and Review side by side.
  const wide = useMedia('(min-width: 1024px)')
  const root = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const timer = useRef<number>()
  const leave = (why: 'min' | 'close') => {
    const el = root.current
    if (!el || reducedMotion()) return why === 'min' ? api.minimize() : api.close()
    if (el.dataset.leaving) return
    el.dataset.leaving = why
    timer.current = window.setTimeout(() => (why === 'min' ? api.minimize() : api.close()), why === 'min' ? 150 : 140)
  }
  useEffect(() => () => window.clearTimeout(timer.current), [])
  useModal(panel, () => leave('min'))
  const titleId = useId()
  return (
    <div ref={root} className="tb-dialog-root fixed inset-0 z-[45] flex items-center justify-center p-4 lg:p-6" role="presentation">
      <div className="tb-scrim absolute inset-0 bg-black/45" onClick={() => leave('min')} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx(
          'tb-dialog relative flex h-full max-h-[900px] w-full flex-col border border-ff-line2 bg-ff-panel shadow-[0_24px_80px_-12px_rgba(0,0,0,0.5)] outline-none',
          wide ? 'max-w-[1240px]' : 'max-w-[680px]',
        )}
      >
        <Body key={trade.id} {...props} layout={wide ? 'split' : 'steps'} titleId={titleId} onMinimize={() => leave('min')} onClose={() => leave('close')} />
      </div>
    </div>
  )
}

/** A phone bar's height, and the New trade tab's above the stack. */
const BAR = 44
const NEW_TAB = 36

/**
 * One place in the minimized stack: a single-line bar above the phone's tab bar (three of them take 132px), or a
 * card in the corner, on the dock's ink.
 */
const slot = (phone: boolean) =>
  cx(
    'tb-mini tb-ink relative flex items-stretch',
    phone
      ? 'h-11 w-full border-t pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]'
      : 'h-[60px] w-[300px] min-w-0 shrink border shadow-[0_10px_30px_-6px_rgba(0,0,0,0.55),0_2px_6px_rgba(0,0,0,0.25)]',
  )

const INK_TONE = (v: number | null) => (v == null ? 'text-[color:var(--ink-muted)]' : v > 0.25 ? 'text-[color:var(--ink-pos)]' : v < -0.25 ? 'text-[color:var(--ink-neg)]' : 'text-[color:var(--ink-text)]')

/**
 * A minimized trade. Shows the deal in a line and your lineup change, reopens on a tap; × discards it (undoable).
 * On a phone it is one line: its number, the deal, the figure.
 */
const Minimized = ({ trade, label, phone, onOpen, onClose, autoFocus }: { trade: DockTrade; label: string; phone: boolean; onOpen: () => void; onClose: () => void; autoFocus: boolean }) => {
  const { analysis } = useFantasy()
  const me = analysis.myRosterId!
  const name = (t: number) => analysis.teamById[t]?.name ?? `#${t}`
  // Priced once per deal and kept (TradeBuilder's useDealRead), so minimizing never prices a deal again.
  const read = useDealRead(trade.deal)
  const lineup = headline(read?.sides.find((s) => s.rosterId === me))
  const line = dealSummary(trade.deal, me, name)
  const what = label === 'Trade builder' ? 'the trade' : label
  const open = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (autoFocus) open.current?.focus({ preventScroll: true })
  }, [autoFocus])
  return (
    <div className={slot(phone)}>
      {!phone && <span aria-hidden className="absolute inset-x-0 -top-px h-[2px] bg-[color:var(--ink-accent)]" />}
      <button ref={open} type="button" onClick={onOpen} className={cx('tb-ink-btn ff-press flex min-w-0 flex-1 items-center text-left outline-none', phone ? 'gap-2.5 pl-3 pr-2' : 'gap-2.5 pl-2.5 pr-2')} aria-label={`Open ${what}: ${dealSummary(trade.deal, me, name, lineup)}`}>
        {phone ? (
          <>
            {/* Its number where there are several; the trade glyph where there is one. */}
            <span aria-hidden className="num flex h-6 min-w-6 shrink-0 items-center justify-center border border-[color:var(--ink-line)] px-1 text-[11.5px] text-[color:var(--ink-accent)]">
              {label === 'Trade builder' ? <TradeIcon size={12} /> : label.replace('Trade ', '')}
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px]">{line}</span>
          </>
        ) : (
          <>
            <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center border border-[color:var(--ink-line)] text-[color:var(--ink-accent)]">
              <TradeIcon size={15} />
            </span>
            <span className="min-w-0 flex-1 leading-tight">
              <span className="flex items-center gap-1.5 whitespace-nowrap">
                <span className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-[color:var(--ink-muted)]">{label}</span>
                <span aria-hidden className="font-mono text-[10px] text-[color:var(--ink-muted)]">
                  ↗
                </span>
              </span>
              <span className="mt-0.5 block truncate text-[13px]">{line}</span>
            </span>
          </>
        )}
        {lineup != null &&
          (phone ? (
            <span className={cx('num shrink-0 text-right text-[13.5px] font-medium', INK_TONE(lineup))}>
              {fmtSigned(lineup, 1)}
              <span className="ml-0.5 font-mono text-[9.5px] font-normal text-[color:var(--ink-muted)]">/wk</span>
            </span>
          ) : (
            <span className={cx('num shrink-0 text-right text-[15px] font-medium leading-none', INK_TONE(lineup))}>
              {fmtSigned(lineup, 1)}
              <span className="block pt-0.5 font-mono text-[9.5px] font-normal text-[color:var(--ink-muted)]">/wk</span>
            </span>
          ))}
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label={`Discard ${what}`}
        title="Discard the trade (you can undo)"
        className="tb-ink-btn ff-press flex w-11 shrink-0 items-center justify-center border-l border-[color:var(--ink-line)] text-[color:var(--ink-muted)] hover:text-[color:var(--ink-neg)]"
      >
        <Glyph d={CLOSE} />
      </button>
    </div>
  )
}

/**
 * After a discard: a notice where the trade sat in the stack, with the way back. It stays 8 seconds, held while a
 * mouse is over it or someone has moved focus into it, and the trade stays restorable from an empty one after it goes.
 */
const Discarded = ({ text, line, phone, onUndo, onDismiss }: { text: string; line: string; phone: boolean; onUndo: () => void; onDismiss: () => void }) => {
  const undoRef = useRef<HTMLButtonElement>(null)
  const [hover, setHover] = useState(false)
  const [focus, setFocus] = useState(false)
  // Focus this notice gives itself is not someone holding it: only focus moved here afterwards is.
  const placing = useRef(false)
  useEffect(() => {
    // The control that discarded it has gone, so focus comes here rather than falling to the page, or staying on the
    // phone's build button, which steps aside (hidden) while this shows.
    const at = document.activeElement
    if (at && at !== document.body && at.getAttribute('aria-hidden') !== 'true') return
    placing.current = true
    undoRef.current?.focus({ preventScroll: true })
    placing.current = false
  }, [])
  const held = hover || focus
  useEffect(() => {
    if (held) return
    const t = window.setTimeout(onDismiss, 8000)
    return () => window.clearTimeout(t)
  }, [held, onDismiss])
  return (
    <div
      className={slot(phone)}
      // Only a mouse holds it: a finger is never "over" it, and a tap that left it held would keep it up for good.
      onPointerEnter={(e) => e.pointerType === 'mouse' && setHover(true)}
      onPointerLeave={() => setHover(false)}
      onFocus={() => !placing.current && setFocus(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setFocus(false)}
    >
      <p className={cx('flex min-w-0 flex-1 justify-center pl-3 leading-tight', phone ? 'items-center gap-1.5 whitespace-nowrap' : 'flex-col')}>
        <span className="shrink-0 text-[13px] font-medium">{text}</span>
        <span className="truncate font-mono text-[10.5px] text-[color:var(--ink-muted)]">{line}</span>
      </p>
      <button ref={undoRef} type="button" onClick={onUndo} className="tb-ink-btn ff-press shrink-0 px-4 text-[13.5px] font-medium text-[color:var(--ink-accent)]">
        Undo
      </button>
      <button type="button" onClick={onDismiss} aria-label="Dismiss" title="Dismiss" className="tb-ink-btn ff-press flex w-11 shrink-0 items-center justify-center border-l border-[color:var(--ink-line)] text-[color:var(--ink-muted)]">
        <Glyph d={CLOSE} />
      </button>
    </div>
  )
}
