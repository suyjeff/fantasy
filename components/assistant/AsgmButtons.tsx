import React from 'react'
import type { AsgmContext } from '../../lib/assistant'
import { FootballIcon, Sparkle } from '../icons'
import { cx } from '../ui'
import { useAsgmControl, useAsgmMaybe } from './AsgmProvider'

/** Assistant GM's name as the app writes it: the words, then the AI mark. */
export const AsgmName = ({ className, live }: { className?: string; live?: boolean }) => (
  <span className={cx('inline-flex items-center gap-1', className)}>
    Assistant GM
    <Sparkle size={9} live={live} className="-mt-1.5" />
  </span>
)

/** The ball on a wash of the accent with registration ticks at two corners, as the reveal frames its crown. */
export const AsgmBadge = ({ size = 28, live, className }: { size?: number; live?: boolean; className?: string }) => (
  <span aria-hidden className={cx('asgm-badge relative flex shrink-0 items-center justify-center bg-ff-accent/[0.12] text-ff-accent', live && 'is-live', className)} style={{ width: size, height: size }}>
    <span className="absolute left-0 top-0 h-1.5 w-1.5 border-l border-t border-ff-accent" />
    <span className="absolute bottom-0 right-0 h-1.5 w-1.5 border-b border-r border-ff-accent" />
    <FootballIcon size={Math.round(size * 0.52)} />
  </span>
)

/**
 * Ask Assistant GM about the call in front of you. One small, quiet control, the same everywhere it appears: only
 * beside decisions that are genuinely close (a coin-flip start, a trade under review, a bid). It opens the GM and asks
 * `prompt` at once, with `context` attached. `leave` runs first, for a control inside a sheet or the trade builder,
 * which steps aside so the GM is not behind it.
 */
export const AskGm = ({
  prompt,
  context,
  label = 'Ask GM',
  leave,
  className,
}: {
  prompt: string
  context?: AsgmContext
  label?: string
  leave?: () => void
  className?: string
}) => {
  const control = useAsgmControl()
  const state = useAsgmMaybe()
  if (!control || !state?.ready) return null
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        leave?.()
        control.open({ prompt, context, send: true })
      }}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && e.stopPropagation()}
      title={`Ask Assistant GM: “${prompt}”`}
      aria-label={`${label}: ${prompt}`}
      className={cx(
        'asgm-ask transition-colors ff-hit group/ask relative inline-flex h-6 shrink-0 items-center gap-1 border border-ff-accent/30 bg-ff-accent/[0.04] px-1.5 font-mono text-[10.5px] font-medium uppercase tracking-[0.08em] text-ff-accent hover:border-ff-accent/60 hover:bg-ff-accent/[0.08] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ff-accent',
        className,
      )}
    >
      <FootballIcon size={11} />
      {label}
      <Sparkle size={7} className="-ml-0.5 -mt-1.5" />
    </button>
  )
}

/** The GM's always-there button: the top-right of every page on a wide screen. */
export const AsgmHeaderButton = () => {
  const control = useAsgmControl()
  const s = useAsgmMaybe()
  if (!control || !s?.ready || s.onPage) return null
  const shown = s.open
  return (
    <button
      type="button"
      data-asgm-trigger=""
      onClick={() => control.toggle()}
      // Named by its words (with the unread and working notes below), its state by aria-expanded: no aria-label to
      // override either.
      aria-expanded={shown}
      aria-keyshortcuts="G"
      title={shown ? 'Close Assistant GM (G)' : 'Ask Assistant GM (G)'}
      className={cx(
        'asgm-trigger transition-colors relative flex h-7 shrink-0 items-center gap-1.5 border pl-1.5 pr-2 text-[12px] font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ff-accent',
        shown ? 'border-ff-accent/60 bg-ff-accent/[0.08] text-ff-text' : 'border-ff-line bg-ff-panel text-ff-text hover:border-ff-line2 hover:bg-ff-raised',
      )}
    >
      <span className="flex h-5 w-5 items-center justify-center text-ff-accent">
        <FootballIcon size={13} />
      </span>
      <span className="hidden lg:inline">Assistant GM</span>
      <span className="lg:hidden">
        <span className="sr-only">Assistant </span>GM
      </span>
      <Sparkle size={8} live={!!s.running} className="-ml-0.5 -mt-2" />
      {/* On the panel's own ground, so the muted key keeps 4.5:1 over the open state's tint. */}
      <kbd aria-hidden className="ml-0.5 hidden h-[18px] min-w-[18px] items-center justify-center border border-ff-line bg-ff-panel px-1 font-mono text-[10px] font-normal text-ff-muted xl:inline-flex">
        G
      </kbd>
      {(s.unread || (s.running && !shown)) && (
        <span className="absolute -right-[3px] -top-[3px] flex h-[7px] w-[7px]">
          <span className={cx('h-full w-full bg-ff-accent', s.running && 'ff-pulse')} />
          <span className="sr-only">{s.running ? ', working on an answer' : ', new answer'}</span>
        </span>
      )}
    </button>
  )
}

/** The phone's way in: a cell at the right of the top bar, beside Find. */
export const AsgmTopBarButton = () => {
  const control = useAsgmControl()
  const s = useAsgmMaybe()
  if (!control || !s?.ready || s.onPage) return null
  return (
    <button
      type="button"
      data-asgm-trigger=""
      onClick={() => control.open()}
      aria-label={s.unread ? 'Assistant GM, new answer' : s.running ? 'Assistant GM, working' : 'Assistant GM'}
      className="relative flex h-full items-center gap-0.5 border-l border-ff-line px-3 text-ff-accent"
    >
      <FootballIcon size={16} />
      <Sparkle size={8} live={!!s.running} className="-mt-3" />
      {(s.unread || s.running) && <span aria-hidden className={cx('absolute right-1.5 top-2.5 h-[6px] w-[6px] bg-ff-accent', s.running && 'ff-pulse')} />}
    </button>
  )
}
