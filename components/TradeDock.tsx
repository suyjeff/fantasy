import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { dealActive, dealFromIdea, dealSummary, emptyDeal, type Deal } from '../lib/deal'
import type { TradeIdea } from '../lib/trades'
import { useFantasy } from './FantasyContext'
import { TradeIcon } from './icons'
import { useModal } from './Sheet'
import SwipeSheet, { type SwipeSheetHandle } from './SwipeSheet'
import TradeBuilder, { BuilderHeader, CLOSE, Glyph, useDealPricing, type BuilderStep, type DealUpdate } from './TradeBuilder'
import { cx, fmtSigned, reducedMotion, useMedia, usePhone } from './ui'

// The trade builder's home: one deal for the whole app, kept above the pages so it survives being minimized and
// moving between sections. Open, it is a sheet from the bottom on a phone and a large dialog on a wide screen;
// minimized, a bar docked above the phone's tab bar or a card in the bottom-right corner. Anything that builds a
// deal ("Open in builder" on a trade card, the Build a trade buttons, an old #trades/builder link) opens it here.

type Mode = 'closed' | 'open' | 'min'

/** A deal as the builder held it, to put back. */
type Snapshot = { deal: Deal; step: BuilderStep; view: number; mode: Mode }
/**
 * What the last throwaway action took, so it can be undone: closing the builder on a deal, opening a suggested
 * trade over a draft, or clearing the players. Acting at once and offering the way back beats asking first.
 */
type Undo = { kind: 'discarded' | 'replaced' | 'cleared'; snap: Snapshot }

export type TradeDockApi = {
  mode: Mode
  /** Open the builder: with this deal (replacing the one in it), or with whatever it holds. */
  open: (deal?: Deal, step?: BuilderStep) => void
  /** Open a suggested trade in the builder, priced, at the review. */
  openIdea: (idea: TradeIdea) => void
  minimize: () => void
  /** Close and drop the deal; a deal with anything in it can be brought back from the notice that follows. */
  close: () => void
  /** The "Trade discarded · Undo" notice is up (the phone's build button steps aside for it). */
  toast: boolean
}

const DockCtx = createContext<TradeDockApi | null>(null)
/** The builder's dock, or null where there is none (no roster of yours in this league). */
export const useTradeDock = () => useContext(DockCtx)

type State = {
  league: string
  deal: Deal
  mode: Mode
  step: BuilderStep
  view: number
  /** Focus the minimized form once it shows. */
  focusMini: boolean
  undo: Undo | null
  /** The discard notice is showing (counted up, so a second discard restarts its timer). */
  toast: number
}

export const TradeDockProvider = ({ children }: { children: ReactNode }) => {
  const { data, analysis } = useFantasy()
  const me = analysis.myRosterId
  const league = data.league.league_id
  const fresh = useCallback((deal?: Deal): Pick<State, 'deal' | 'view'> => {
    const d = deal ?? emptyDeal(me != null ? [me] : [])
    return { deal: d, view: d.teams.find((t) => t !== me) ?? me ?? -1 }
  }, [me])
  const blank = (): State => ({ league, mode: 'closed', step: 'pick', focusMini: false, undo: null, toast: 0, ...fresh() })
  const [state, setState] = useState<State>(blank)
  // Another league's deal means nothing here: a switch starts over, closed.
  const cur = state.league === league ? state : blank()
  if (cur !== state) setState(cur)

  const snap = (s: State): Snapshot => ({ deal: s.deal, step: s.step, view: s.view, mode: s.mode })
  // An edit settles the last replace or clear (the notice goes with it); a discarded deal stays restorable until a
  // new one has something in it.
  const update: DealUpdate = useCallback(
    (fn) =>
      setState((s) => {
        const deal = fn(s.deal)
        const undo = s.undo?.kind === 'discarded' && !dealActive(deal) ? s.undo : null
        return { ...s, deal, undo }
      }),
    [],
  )
  // Opening a deal over a draft with something in it replaces the draft, and says so with an undo.
  const replace = (s: State, deal: Deal, step: BuilderStep): State => {
    const over = s.mode !== 'closed' && dealActive(s.deal) && JSON.stringify(s.deal) !== JSON.stringify(deal)
    // Otherwise the last undo is spent, except a discarded deal while the new one is still empty (as with an edit).
    const kept = s.undo?.kind === 'discarded' && !dealActive(deal) ? s.undo : null
    return { ...s, ...fresh(deal), mode: 'open', step, focusMini: false, toast: 0, undo: over ? { kind: 'replaced', snap: snap(s) } : kept }
  }
  const api = useMemo<TradeDockApi>(
    () => ({
      mode: cur.mode,
      toast: cur.toast > 0 && cur.mode === 'closed',
      open: (deal, step) =>
        setState((s) =>
          deal ? replace(s, deal, step ?? (dealActive(deal) ? 'review' : 'pick')) : { ...s, mode: 'open', step: step ?? s.step, focusMini: false, toast: 0 },
        ),
      openIdea: (idea) => {
        if (me == null) return
        setState((s) => replace(s, dealFromIdea(me, idea.partnerId, idea.give, idea.get), 'review'))
      },
      minimize: () => setState((s) => (s.mode === 'open' ? { ...s, mode: 'min', focusMini: true } : s)),
      close: () =>
        setState((s) => ({
          ...s,
          ...fresh(),
          mode: 'closed',
          step: 'pick',
          focusMini: false,
          // Closed on an empty deal, an earlier replace or clear has nothing left to put back into.
          ...(dealActive(s.deal) ? { undo: { kind: 'discarded' as const, snap: snap(s) }, toast: s.toast + 1 } : { undo: s.undo?.kind === 'discarded' ? s.undo : null, toast: 0 }),
        })),
    }),
    [cur.mode, cur.toast, fresh, me], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const undo = useCallback(
    () =>
      setState((s) => {
        if (!s.undo) return s
        const { snap: back, kind } = s.undo
        // From the notice after a discard, the deal comes back the way it was left (open or minimized); restored or
        // undone inside the builder, it comes back in place and the builder stays open.
        const mode = kind === 'discarded' && s.mode === 'closed' ? back.mode : s.mode
        return { ...s, ...back, mode, focusMini: mode === 'min', undo: null, toast: 0 }
      }),
    [],
  )
  const dismiss = useCallback(() => setState((s) => ({ ...s, undo: s.undo?.kind === 'discarded' ? s.undo : null, toast: 0 })), [])
  const clear = useCallback(() => setState((s) => (dealActive(s.deal) ? { ...s, deal: { ...s.deal, moves: [], faab: [] }, undo: { kind: 'cleared', snap: snap(s) } } : s)), [])

  const pricing = useDealPricing(cur.deal, me != null && cur.mode !== 'closed')
  // What a discard, replace or clear just did, said once to screen readers from a region that is always there.
  const u = cur.undo
  const said = !u ? '' : u.kind === 'discarded' ? (cur.toast > 0 ? 'Trade discarded.' : '') : cur.mode !== 'closed' ? (u.kind === 'replaced' ? 'Replaced your draft.' : 'Players cleared.') : ''
  // The provider and the page under it keep their place whether or not you have a roster here, so a roster coming
  // or going never remounts the page.
  return (
    <DockCtx.Provider value={me == null ? null : api}>
      {children}
      {me != null && (
        <>
          <p role="status" className="sr-only">
            {said && `${said} Undo is available.`}
          </p>
          {cur.mode === 'min' && <div aria-hidden className="h-14 md:h-16" />}
          <DockHost
            state={cur}
            api={api}
            update={update}
            pricing={pricing}
            setStep={(step) => setState((s) => ({ ...s, step }))}
            setView={(view) => setState((s) => ({ ...s, view }))}
            undo={undo}
            dismiss={dismiss}
            clear={clear}
          />
        </>
      )}
    </DockCtx.Provider>
  )
}

type HostProps = {
  state: State
  api: TradeDockApi
  update: DealUpdate
  pricing: ReturnType<typeof useDealPricing>
  setStep: (s: BuilderStep) => void
  setView: (v: number) => void
  undo: () => void
  dismiss: () => void
  clear: () => void
}

const DockHost = (props: HostProps) => {
  const { state, api, pricing } = props
  const { analysis } = useFantasy()
  const phone = usePhone()
  const me = analysis.myRosterId!
  const mine = pricing.read?.sides.find((s) => s.rosterId === me)
  const lineup = mine ? (mine.faab ? mine.net.mid : mine.lineup) : null
  const name = (t: number) => analysis.teamById[t]?.name ?? `#${t}`
  // The lineup figure has places of its own (the tray, the verdict, the end of the minimized bar), so the line in
  // the header and the bar leaves it out rather than have it cut off.
  const line = dealSummary(state.deal, me, name)
  const summary = dealSummary(state.deal, me, name, lineup)
  if (state.mode === 'open') return phone ? <PhoneSheet {...props} summary={line} /> : <DesktopDialog {...props} summary={line} />
  if (state.mode === 'closed' && state.toast > 0 && state.undo?.kind === 'discarded')
    return <Discarded key={state.toast} line={dealSummary(state.undo.snap.deal, me, name)} phone={phone} onUndo={props.undo} onDismiss={props.dismiss} />
  if (state.mode === 'min')
    return (
      <Minimized
        summary={summary}
        line={line}
        lineup={lineup}
        stale={pricing.stale}
        phone={phone}
        onOpen={() => api.open()}
        onClose={api.close}
        autoFocus={state.focusMini}
      />
    )
  return null
}

const Body = ({ state, update, pricing, setStep, setView, layout, summary, onMinimize, onClose, titleId, undo, dismiss, clear }: HostProps & { layout: 'steps' | 'split'; summary: string; onMinimize: () => void; onClose: () => void; titleId: string }) => {
  const { analysis } = useFantasy()
  const me = analysis.myRosterId!
  const name = (t: number) => analysis.teamById[t]?.name ?? `#${t}`
  const u = state.undo
  // In the builder: undo the replace or the clear just made, or (opened empty) bring back the deal last discarded.
  const notice =
    u && (u.kind !== 'discarded' || !dealActive(state.deal)) ? (
      <UndoNotice
        text={u.kind === 'replaced' ? 'Replaced your draft' : u.kind === 'cleared' ? 'Players cleared' : 'Discarded trade'}
        detail={u.kind === 'cleared' ? null : dealSummary(u.snap.deal, me, name)}
        action={u.kind === 'discarded' ? 'Restore' : 'Undo'}
        onAction={undo}
        onDismiss={dismiss}
      />
    ) : null
  return (
    <TradeBuilder
      deal={state.deal}
      update={update}
      pricing={pricing}
      step={state.step}
      setStep={setStep}
      view={state.view}
      setView={setView}
      layout={layout}
      onClear={clear}
      header={
        <>
          <BuilderHeader titleId={titleId} summary={summary} onMinimize={onMinimize} onClose={onClose} />
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
const PhoneSheet = (props: HostProps & { summary: string }) => {
  const { api } = props
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
      <Body {...props} layout="steps" titleId={titleId} onMinimize={() => leave('min')} onClose={() => leave('close')} />
    </SwipeSheet>
  )
}

/** Wide screens: a large dialog over the page. Minimizing shrinks it into the corner card it becomes. */
const DesktopDialog = (props: HostProps & { summary: string }) => {
  const { api } = props
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
        <Body {...props} layout={wide ? 'split' : 'steps'} titleId={titleId} onMinimize={() => leave('min')} onClose={() => leave('close')} />
      </div>
    </div>
  )
}

/** Where the minimized builder and the discard notice sit: a bar above the phone's tab bar, or a card in the corner. */
const slot = (phone: boolean) =>
  cx(
    'tb-mini fixed z-[31] flex items-stretch border border-ff-line2 bg-ff-panel',
    phone ? 'inset-x-0 bottom-[calc(48px+env(safe-area-inset-bottom))] h-14 border-x-0 border-b-0 pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] shadow-[0_-8px_24px_-8px_rgba(0,0,0,0.35)]' : 'bottom-4 right-4 h-[60px] w-[380px] max-w-[calc(100vw-32px)] shadow-[0_8px_28px_-6px_rgba(0,0,0,0.45)]',
  )

/**
 * The builder minimized. Phones: a bar docked just above the tab bar. Wide screens: a card in the bottom-right
 * corner. Either shows the deal in a line and reopens on a tap; × discards it.
 */
const Minimized = ({
  summary,
  line,
  lineup,
  stale,
  phone,
  onOpen,
  onClose,
  autoFocus,
}: {
  summary: string
  line: string
  lineup: number | null
  stale: boolean
  phone: boolean
  onOpen: () => void
  onClose: () => void
  autoFocus: boolean
}) => {
  const open = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (autoFocus) open.current?.focus({ preventScroll: true })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const tone = lineup == null ? 'text-ff-muted' : lineup > 0.25 ? 'text-ff-pos' : lineup < -0.25 ? 'text-ff-neg' : 'text-ff-text'
  return (
    <div
      role="region"
      aria-label="Trade builder, minimized"
      className={slot(phone)}
    >
      <span aria-hidden className="absolute inset-x-0 -top-px h-[2px] bg-ff-accent" />
      <button ref={open} type="button" onClick={onOpen} className="ff-press flex min-w-0 flex-1 items-center gap-2.5 pl-2.5 pr-2 text-left outline-none hover:bg-ff-raised focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ff-accent" aria-label={`Open the trade builder: ${summary}`}>
        <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center border border-ff-accent/40 bg-ff-accent/10 text-ff-accent">
          <TradeIcon size={15} />
        </span>
        <span className="min-w-0 flex-1 leading-tight">
          <span className="flex items-center gap-1.5 whitespace-nowrap">
            <span className="ff-label">Trade builder</span>
            {/* The hint goes first when the bar is narrow (320px), so the label never wraps. */}
            <span aria-hidden className="font-mono text-[10px] text-ff-muted max-[359px]:hidden">
              {phone ? 'tap to open' : '↗ open'}
            </span>
          </span>
          <span className="mt-0.5 block truncate text-[13px] text-ff-text">{line}</span>
        </span>
        {lineup != null && (
          <span className={cx('num shrink-0 text-right text-[15px] font-medium leading-none transition-opacity duration-150', tone, stale && 'opacity-50')}>
            {fmtSigned(lineup, 1)}
            <span className="block pt-0.5 font-mono text-[9.5px] font-normal text-ff-muted">/wk</span>
          </span>
        )}
      </button>
      <button type="button" onClick={onClose} aria-label="Discard the trade" title="Discard the trade (you can undo)" className="ff-press flex w-11 shrink-0 items-center justify-center border-l border-ff-line text-ff-muted hover:bg-ff-raised hover:text-ff-neg">
        <Glyph d={CLOSE} />
      </button>
    </div>
  )
}

/**
 * After a discard: a notice where the minimized builder sits, with the way back. It stays 8 seconds, held while a
 * pointer is over it or someone has moved focus into it, and the deal stays restorable from the builder after it goes.
 */
const Discarded = ({ line, phone, onUndo, onDismiss }: { line: string; phone: boolean; onUndo: () => void; onDismiss: () => void }) => {
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
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onFocus={() => !placing.current && setFocus(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setFocus(false)}
    >
      <p className="flex min-w-0 flex-1 flex-col justify-center pl-3 leading-tight">
        <span className="text-[13px] font-medium text-ff-text">Trade discarded</span>
        <span className="truncate font-mono text-[10.5px] text-ff-muted">{line}</span>
      </p>
      <button ref={undoRef} type="button" onClick={onUndo} className="ff-press shrink-0 px-4 text-[13.5px] font-medium text-ff-accent hover:bg-ff-raised focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ff-accent">
        Undo
      </button>
      <button type="button" onClick={onDismiss} aria-label="Dismiss" title="Dismiss" className="ff-press flex w-11 shrink-0 items-center justify-center border-l border-ff-line text-ff-muted hover:bg-ff-raised hover:text-ff-text focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ff-accent">
        <Glyph d={CLOSE} />
      </button>
    </div>
  )
}
