import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AsgmAction, AsgmMessage } from '../../lib/assistant'
import { useFantasy } from '../FantasyContext'
import { SECTION_KEYS, type SectionKey } from '../Shell'
import { CLOSE, Glyph } from '../TradeBuilder'
import { useTradeDock } from '../TradeDock'
import { AddIcon, BuildIcon, ChevronIcon, GearIcon, OpenIcon } from '../icons'
import { cx, reducedMotion } from '../ui'
import { AsgmBadge, AsgmName } from './AsgmButtons'
import { AsgmCardView } from './AsgmCards'
import { useAsgm } from './AsgmProvider'
import AsgmSettings, { providerLine } from './AsgmSettings'
import { nextUtcMidnight, resetTime } from './store'
import { blocks, nameIndex, plain, spans, type NameIndex } from './text'

// The conversation, one component for every way it is shown: `float` (the window in the corner), `dock` (the panel at
// the right), `page` (Assistant GM's own page) and `sheet` (the phone's). A question is a wash of the accent at the
// right; an answer is the GM at work (a slim log of steps, each running then done, that folds away), then the call,
// then the cards it found, then buttons that take you to the part of the app that acts on it. It groups by space and
// tone, not frames: see "Surfaces" in styles/fantasy.css (Assistant GM).

type Gm = Extract<AsgmMessage, { role: 'gm' }>
export type ChatVariant = 'float' | 'dock' | 'page' | 'sheet'

/** When this visit began: answers from before it are history and are drawn settled, not landing. */
const VISIT = Date.now()
/** Answers that have already landed once this visit: shown again (the window docked, the page opened), they stay put. */
const landed = new Set<string>()

const DOCK = 'M2.5 2.5h9v9h-9zM8.5 2.5v9'
const FLOAT = 'M2.5 2.5h9v9h-9zM6.5 7.5h5v4'
const EXPAND = 'M8.5 2.5h3v3M11.5 2.5 8 6M5.5 11.5h-3v-3M2.5 11.5 6 8'
const COPY = 'M4.5 4.5h7v7h-7zM2.5 9.5v-7h7'
const RETRY = 'M11 5.5A4.5 4.5 0 1 0 11.5 8M11.5 2.5v3h-3'
const STOP = 'M4.5 4.5h5v5h-5z'
const SEND = 'M7 11.5v-9M3.5 6 7 2.5 10.5 6'
const CHECK = 'M3.5 7.2l2.4 2.4 4.6-5'

/** A square glyph button for the header and the message footer. */
const IconBtn = ({ d, label, title, onClick, pressed, className, children }: { d?: string; label: string; /** The tooltip, where it says more than the name (a shortcut). */ title?: string; onClick: () => void; pressed?: boolean; className?: string; children?: ReactNode }) => (
  <button
    type="button"
    onClick={onClick}
    aria-label={label}
    aria-pressed={pressed}
    title={title ?? label}
    className={cx(
      'asgm-press asgm-wash-btn flex h-10 w-10 shrink-0 items-center justify-center text-ff-text2 hover:text-ff-text focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ff-accent md:h-8 md:w-8',
      pressed && 'bg-[var(--asgm-wash-hover)] text-ff-text',
      className,
    )}
  >
    {children ?? <Glyph d={d!} size={13} />}
  </button>
)

// ---- The header ----

const Header = ({ variant, titleId, onClose, onDock, onExpand }: { variant: ChatVariant; titleId: string; onClose?: () => void; onDock?: () => void; onExpand?: () => void }) => {
  const s = useAsgm()
  const live = !!s.running
  return (
    <header className={cx('relative flex shrink-0 items-center gap-2.5 pl-3 pr-1', variant === 'page' || variant === 'dock' ? 'h-11' : 'h-12')}>
      {/* Under 360px the badge gives its room to the name, so the title is never cut. */}
      {variant !== 'page' && <AsgmBadge size={28} live={live} className="max-[359px]:hidden" />}
      <div className="min-w-0 flex-1 leading-tight">
        {variant === 'page' ? (
          <span className="ff-label">{live ? <span className="text-ff-accent">Working…</span> : 'Conversation'}</span>
        ) : (
          <>
            <h2 id={titleId} className="truncate text-[14px] font-semibold tracking-[-0.005em] text-ff-text">
              <AsgmName live={live} />
            </h2>
            <p className="truncate font-mono text-[10.5px] text-ff-muted">{live ? <span className="text-ff-accent">working…</span> : providerLine(s)}</p>
          </>
        )}
      </div>
      {/* Flush, as a toolbar: each is its own 40px (32px with a pointer) square, so no gap is needed between them. */}
      <div className="flex shrink-0 items-center">
        {s.messages.length > 0 && (
          <IconBtn label="New conversation" onClick={s.clear} className={variant === 'page' ? 'md:hidden' : undefined}>
            <AddIcon size={12} />
          </IconBtn>
        )}
        {/* One name whatever its state: aria-pressed says whether the settings are showing. */}
        <IconBtn label="Settings" title={s.settings ? 'Settings (showing): press to go back to the conversation' : 'Settings: model and key'} pressed={s.settings} onClick={() => s.setSettings(!s.settings)}>
          <GearIcon size={14} />
        </IconBtn>
        {onDock && <IconBtn d={variant === 'dock' ? FLOAT : DOCK} label={variant === 'dock' ? 'Float the window' : 'Dock to the right'} onClick={onDock} />}
        {onExpand && <IconBtn d={EXPAND} label="Open as a page" onClick={onExpand} />}
        {onClose && <IconBtn d={CLOSE} label="Close Assistant GM" title="Close (Esc)" onClick={onClose} className="hover:!text-ff-text" />}
      </div>
      {/* The accent rule along the top, as the dock's minimized trades carry. */}
      {(variant === 'float' || variant === 'dock') && <span aria-hidden className="absolute inset-x-0 -top-px h-[2px] bg-ff-accent" />}
    </header>
  )
}

// ---- One answer ----

/** The running clock in the work log, to the tenth of a second. */
const useElapsed = (live: boolean) => {
  const [t0] = useState(() => performance.now())
  const [ms, setMs] = useState(0)
  useEffect(() => {
    if (!live) return
    const id = window.setInterval(() => setMs(performance.now() - t0), 100)
    return () => window.clearInterval(id)
  }, [live, t0])
  return ms
}
const clock = (ms: number) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor((ms / 1000) % 60)).padStart(2, '0')}.${Math.floor((ms / 100) % 10)}`

/** The state of a step, drawn: a ticking square while it runs, a check once done, a cross if it failed. Never motion alone. */
const StepGlyph = ({ status }: { status: 'running' | 'done' | 'error' }) =>
  status === 'running' ? (
    <span aria-hidden className="asgm-tick relative flex h-3 w-3 items-center justify-center">
      <span className="h-2 w-2 border border-ff-accent" />
      <span className="absolute h-1 w-1 bg-ff-accent" />
    </span>
  ) : status === 'done' ? (
    <span aria-hidden className="flex h-3 w-3 items-center justify-center text-ff-pos">
      <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square">
        <path d={CHECK} />
      </svg>
    </span>
  ) : (
    <span aria-hidden className="flex h-3 w-3 items-center justify-center text-ff-muted">
      <Glyph d={CLOSE} size={11} />
    </span>
  )

/**
 * The GM at work: each tool it runs as a line, running then done with what it found, on a slim strip with a pip per
 * step. Open while it works; once the answer is in it folds to one line ("Worked 5 steps · 3.2s"), to open again on a
 * click.
 */
const WorkLog = ({ m, live, fresh }: { m: Gm; live: boolean; fresh: boolean }) => {
  const [open, setOpen] = useState(live)
  useEffect(() => setOpen(live), [live])
  const elapsed = useElapsed(live)
  const [took, setTook] = useState<number | null>(null)
  useEffect(() => {
    if (!live && fresh && elapsed > 0) setTook(elapsed)
  }, [live]) // eslint-disable-line react-hooks/exhaustive-deps
  const id = useId()
  const steps = m.steps
  const writing = live && steps.length > 0 && steps.every((s) => s.status !== 'running')
  if (!live && !steps.length) return null
  const done = steps.filter((s) => s.status === 'done').length
  return (
    <div className={cx('asgm-log', live && 'is-live')}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={id}
        disabled={live}
        className="asgm-wash-btn group flex h-8 w-full items-center gap-2.5 pl-3 pr-2.5 text-left font-mono text-[10.5px] uppercase tracking-[0.08em] text-ff-text2 transition-colors enabled:hover:text-ff-text max-md:h-10"
      >
        {live ? (
          <span className="flex items-baseline text-ff-accent">
            {writing ? 'Writing' : 'Working'}
            <span aria-hidden className="asgm-dots" />
          </span>
        ) : (
          <>
            <ChevronIcon dir="right" size={9} open={open} className="-ml-0.5 text-ff-muted group-enabled:group-hover:text-ff-text2" />
            <span>
              {m.error && m.error.code !== 'aborted' ? 'Stopped at' : 'Worked'} {done} step{done === 1 ? '' : 's'}
            </span>
          </>
        )}
        {/* A pip a step: what the count says, drawn. */}
        <span aria-hidden className="flex min-w-0 items-center gap-[3px] overflow-hidden">
          {steps.map((x) => (
            <span key={x.id} className={cx('asgm-pip', x.status === 'running' && 'is-running', x.status === 'error' && 'is-error', fresh && 'is-fresh')} />
          ))}
        </span>
        {/* Muted at rest; under the pointer's darker wash it steps up to keep 4.5:1. */}
        <span className="num ml-auto shrink-0 normal-case tracking-normal text-ff-muted group-enabled:group-hover:text-ff-text2">{live ? clock(elapsed) : took != null ? `${(took / 1000).toFixed(1)}s` : ''}</span>
      </button>
      <div className="asgm-fold" data-open={open}>
        <div>
          <ol id={id} className="pb-1.5" aria-label="Steps">
            {steps.map((s) => (
              <li key={s.id} className={cx('asgm-step relative grid grid-cols-[12px_minmax(0,1fr)_auto] items-start gap-x-2.5 overflow-hidden py-[5px] pl-3 pr-2.5', s.status === 'running' && 'is-running', fresh && 'is-fresh')}>
                <span className="flex h-[18px] items-center">
                  <StepGlyph status={s.status} />
                </span>
                {/* Wrapped, never cut: a step's label and what it found (an error's reason included) are read whole. */}
                <span className={cx('min-w-0 text-[12.5px] leading-[18px] [overflow-wrap:anywhere]', s.status === 'running' ? 'text-ff-text' : 'text-ff-text2')}>
                  {s.label}
                  <span className="sr-only">{s.status === 'running' ? ', running' : s.status === 'done' ? ', done' : ', stopped'}</span>
                </span>
                <span className={cx('asgm-detail max-w-[150px] text-right font-mono text-[10.5px] leading-[18px] [overflow-wrap:anywhere]', s.status === 'error' ? 'text-ff-muted' : 'text-ff-text2')}>{s.detail ?? ''}</span>
              </li>
            ))}
            {live && !steps.length && (
              <li className="asgm-step is-running relative grid grid-cols-[12px_minmax(0,1fr)] items-start gap-x-2.5 overflow-hidden py-[5px] pl-3 pr-2.5">
                <span className="flex h-[18px] items-center">
                  <StepGlyph status="running" />
                </span>
                <span className="text-[12.5px] leading-[18px] text-ff-text">Reading the question</span>
              </li>
            )}
          </ol>
        </div>
      </div>
    </div>
  )
}

/** One line of the answer, names linked to their sheets. */
const Line = ({ text, index }: { text: string; index: NameIndex | null }) => {
  const { openPlayer, openTeam, analysis } = useFantasy()
  return (
    <>
      {spans(text, index).map((x, i) =>
        x.t === 'text' ? (
          <React.Fragment key={i}>{x.s}</React.Fragment>
        ) : x.t === 'bold' ? (
          <strong key={i} className="font-semibold text-ff-text">
            {x.s}
          </strong>
        ) : (
          <button
            key={i}
            type="button"
            onClick={() => (x.t === 'player' ? openPlayer(x.id) : openTeam(x.id))}
            className={cx('asgm-link', x.t === 'team' && x.id === analysis.myRosterId && 'text-ff-accent')}
            title={x.t === 'player' ? `${x.s}: details and your read` : `${x.s}: open summary`}
          >
            {x.s}
          </button>
        ),
      )}
    </>
  )
}

/** The answer: the call first, larger and bold, then the reasons, quieter; lists as square-bulleted lines; a labelled
 *  line (Risk:) quieter still; a caret while it streams. */
const Answer = ({ text, live, index }: { text: string; live: boolean; index: NameIndex | null }) => {
  const bs = useMemo(() => blocks(text), [text])
  const caret = live ? <span aria-hidden className="asgm-caret" /> : null
  if (!bs.length) return live ? <p className="text-[16px] leading-snug">{caret}</p> : null
  return (
    <div className="space-y-2 text-[13.5px] leading-[1.55] text-ff-text2">
      {bs.map((b, i) => {
        const last = i === bs.length - 1
        if (b.t === 'ul')
          return (
            <ul key={i} className="space-y-1">
              {b.items.map((it, j) => (
                <li key={j} className="relative pl-4">
                  <span aria-hidden className="absolute left-[3px] top-[0.66em] h-[4px] w-[4px] bg-ff-accent/70" />
                  <Line text={it} index={index} />
                  {last && j === b.items.length - 1 && caret}
                </li>
              ))}
            </ul>
          )
        const call = i === 0 && !b.label
        return (
          <p
            key={i}
            className={cx(
              call && 'pb-0.5 text-[16px] font-semibold leading-[1.35] tracking-[-0.012em] text-ff-text [text-wrap:pretty]',
              b.label && 'text-[12.5px] leading-[1.5]',
            )}
          >
            {b.label && (
              <span className={cx('ff-label mr-1.5 align-[1px]', /risk|caveat|watch/i.test(b.label) ? '!text-ff-warn' : '!text-ff-text2')}>
                {b.label}
                <span className="sr-only">: </span>
              </span>
            )}
            <Line text={b.text} index={index} />
            {last && caret}
          </p>
        )
      })}
    </div>
  )
}

/** By error code; 'rate' (a 429, a provider's rate limit) is kept here as a string so it reads before and after the
 * brain's types carry it. */
const ERROR_TITLE: Record<NonNullable<Gm['error']>['code'] | 'rate', string> = {
  // A 429 from a provider or the relay: too many in a minute, or one question that took too many steps.
  rate: 'Too many requests',
  quota: 'Out of free questions today',
  budget: 'The free model is out for today',
  offline: "Can't connect",
  provider: 'The model had a problem',
  key: 'Your key did not work',
  aborted: 'Stopped',
}

/** What went wrong, in words that say what to do, and the button that does it. */
const ErrorNote = ({ m, onRetry }: { m: Gm; onRetry?: () => void }) => {
  const s = useAsgm()
  const e = m.error!
  if (e.code === 'aborted')
    return (
      <p className="flex items-center gap-2 font-mono text-[11px] text-ff-muted">
        <span>Stopped.</span>
        {onRetry && (
          <button type="button" onClick={onRetry} className="ff-hit text-ff-text2 underline decoration-ff-muted/60 underline-offset-2 transition-colors hover:text-ff-text">
            Ask again
          </button>
        )}
      </p>
    )
  // The house's allowance resets at midnight UTC: said in this browser's own time.
  const reset = resetTime(s.house?.resetsAt || nextUtcMidnight())
  const code = e.code as string
  // The provider's own words where they say what happened (a rate limit, a question that took too many steps); the
  // allowance in this browser's time where it is the house's.
  const body =
    e.code === 'quota'
      ? `Free questions come back at ${reset}. Add your own key to keep going.`
      : e.code === 'budget'
        ? `Everyone's free questions are used up for today; they come back at ${reset}. Add your own key to keep going now.`
        : e.message || (code === 'rate' ? 'Wait a moment, then ask again.' : 'Ask again in a minute.')
  const needKey = e.code === 'quota' || e.code === 'budget' || e.code === 'key'
  return (
    // Not an alert: the conversation's one status region (Announcer) says it once, and an answer restored from an earlier
    // visit must not announce itself again.
    // A wash of the warning with its rule down the left, as the app marks a row that needs you; the mark and the title
    // say it, not the colour.
    <div className="bg-ff-warn/[0.08] py-2.5 pl-3.5 pr-3 shadow-[inset_2px_0_0_rgb(var(--ff-warn))]">
      <p className="flex items-center gap-1.5 text-[13px] font-semibold text-ff-text">
        <span aria-hidden className="font-mono text-ff-warn">!</span>
        {ERROR_TITLE[e.code] ?? ERROR_TITLE.provider}
      </p>
      <p className="mt-0.5 text-[12.5px] leading-snug text-ff-text2">{body}</p>
      {(needKey || (onRetry && e.code !== 'quota' && e.code !== 'budget')) && (
        <div className="mt-2.5 flex flex-wrap gap-2">
          {needKey && (
            <button type="button" onClick={() => s.setSettings(true)} className="asgm-press h-8 border border-transparent bg-ff-text px-3 text-[12.5px] font-medium text-ff-panel hover:bg-ff-text/85 max-md:h-10">
              {e.code === 'key' ? 'Check your key' : 'Add your own key'}
            </button>
          )}
          {onRetry && e.code !== 'quota' && e.code !== 'budget' && (
            <button type="button" onClick={onRetry} className="asgm-press h-8 border border-transparent bg-ff-text/[0.07] px-3 text-[12.5px] font-medium text-ff-text hover:bg-ff-text/[0.12] max-md:h-10">
              Ask again
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** The way from an answer to the app: open the trade in the builder, a player's or team's sheet, a page. */
const Actions = ({ actions, skipDeals, onGoto }: { actions: AsgmAction[]; skipDeals: Set<string>; onGoto?: () => void }) => {
  const { openPlayer, openTeam, go } = useFantasy()
  const dock = useTradeDock()
  const shown = actions.filter((a) => !(a.kind === 'openTrade' && skipDeals.has(JSON.stringify(a.deal))))
  if (!shown.length) return null
  const run = (a: AsgmAction) => {
    if (a.kind === 'openTrade') dock?.open(a.deal, 'review')
    else if (a.kind === 'openPlayer') openPlayer(a.id)
    else if (a.kind === 'openTeam') openTeam(a.rosterId)
    else {
      const [section, sub] = a.view.split('/')
      if (!(SECTION_KEYS as readonly string[]).includes(section)) return
      go(section as SectionKey, sub || null)
      window.scrollTo({ top: 0 })
      onGoto?.()
    }
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {shown.map((a, i) =>
        a.kind === 'openTrade' && dock ? (
          <button key={i} type="button" onClick={() => run(a)} className="ff-aqua ff-aqua-soft">
            <BuildIcon size={12} />
            {a.label}
          </button>
        ) : (
          <button
            key={i}
            type="button"
            onClick={() => run(a)}
            className="asgm-press asgm-wash inline-flex h-7 max-w-full items-center gap-1.5 border border-transparent pl-2.5 pr-2 text-[12px] font-medium text-ff-text max-md:h-10"
          >
            <span className="truncate">{a.label}</span>
            <span aria-hidden className="flex text-ff-text2">
              {a.kind === 'goto' ? <ChevronIcon dir="right" size={10} /> : <OpenIcon size={11} />}
            </span>
          </button>
        ),
      )}
    </div>
  )
}

const GmMessageView = ({ m, last, index, onGoto }: { m: Gm; last: boolean; index: NameIndex | null; onGoto?: () => void }) => {
  const s = useAsgm()
  const live = s.running === m.id
  const [fresh] = useState(() => m.at >= VISIT && !landed.has(m.id))
  useEffect(() => {
    if (!live) landed.add(m.id)
  }, [live, m.id])
  const [copied, setCopied] = useState(false)
  const deals = useMemo(() => new Set(m.cards.filter((c) => c.kind === 'trade').map((c) => JSON.stringify((c as Extract<typeof c, { kind: 'trade' }>).deal))), [m.cards])
  const retry = !live && !s.running ? () => s.retry(m.id) : undefined
  const copy = () => {
    navigator.clipboard?.writeText(plain(m.text)).then(
      () => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1600)
      },
      () => {},
    )
  }
  return (
    <article className="asgm-gm min-w-0 space-y-3" aria-label="Assistant GM" aria-busy={live || undefined}>
      <WorkLog m={m} live={live} fresh={fresh} />
      {(m.text || (live && m.steps.length > 0 && m.steps.every((x) => x.status !== 'running'))) && <Answer text={m.text} live={live} index={index} />}
      {m.cards.length > 0 && (
        <div className="space-y-2.5">
          {m.cards.map((c, i) => (
            <AsgmCardView key={i} card={c} n={i} fresh={fresh} />
          ))}
        </div>
      )}
      {!live && <Actions actions={m.actions} skipDeals={deals} onGoto={onGoto} />}
      {m.error && <ErrorNote m={m} onRetry={retry} />}
      {!live && (m.text || m.error) && (
        <footer className={cx('-ml-2 -mt-1 flex items-center gap-0.5 text-ff-muted', fresh && 'asgm-enter')}>
          {m.text && (
            <IconBtn d={copied ? CHECK : COPY} label={copied ? 'Copied' : 'Copy the answer'} onClick={copy} className={cx('!h-7 !w-7 max-md:!h-10 max-md:!w-10', copied && '!text-ff-pos')} />
          )}
          {/* An error carries its own way on (Ask again, or the key), so the footer doesn't offer a second one. */}
          {retry && last && !m.error && <IconBtn d={RETRY} label="Ask again" onClick={retry} className="!h-7 !w-7 max-md:!h-10 max-md:!w-10" />}
          {m.provider && <span className="ml-1.5 truncate font-mono text-[10px] text-ff-muted">{m.provider.replace(/^house:/, 'free model · ')}</span>}
        </footer>
      )}
    </article>
  )
}

/** A question: a wash of the accent at the right, square like everything else here, what it was about under it. */
const UserMessageView = ({ m }: { m: Extract<AsgmMessage, { role: 'user' }> }) => {
  const [fresh] = useState(() => m.at >= VISIT && !landed.has(m.id))
  useEffect(() => void landed.add(m.id), [m.id])
  return (
    <div className={cx('flex flex-col items-end gap-1 pl-8', fresh && 'asgm-enter')}>
      <p className="max-w-full whitespace-pre-wrap bg-ff-accent/[0.1] px-3 py-2 text-[13.5px] leading-[1.45] text-ff-text [overflow-wrap:anywhere]">{m.text}</p>
      {m.context && (
        <span className="max-w-full text-right font-mono text-[10px] text-ff-muted [overflow-wrap:anywhere]">
          <span className="sr-only">Asked about: </span>
          <span aria-hidden>re: </span>
          {m.context.label}
        </span>
      )}
    </div>
  )
}

// ---- The empty state ----

/** The empty state: who you are asking about, the promise, and questions to start from; it arrives in that order. */
const Welcome = ({ variant }: { variant: ChatVariant }) => {
  const s = useAsgm()
  const { data, analysis } = useFantasy()
  const me = analysis.myRosterId != null ? analysis.teamById[analysis.myRosterId] : null
  const d = (ms: number) => ({ '--d': `${ms}ms` }) as React.CSSProperties
  return (
    <div className={cx('flex flex-1 flex-col', variant === 'page' ? 'justify-center py-6' : 'justify-end')}>
      <div className="asgm-hero relative mb-5 overflow-hidden px-4 pb-5 pt-5">
        <span aria-hidden className="asgm-grid absolute inset-0" />
        <span aria-hidden className="asgm-reg asgm-reg-br" />
        <div className="relative flex items-start gap-3.5">
          <AsgmBadge size={40} className="asgm-enter" />
          <div className="min-w-0">
            <p className="asgm-enter font-mono text-[10.5px] uppercase tracking-[0.1em] text-ff-text2">
              {me ? me.name : data.league.name}
              {data.state.season_type === 'regular' ? ` · wk ${data.state.week}` : ''}
            </p>
            <p className="asgm-enter mt-1 text-[19px] font-semibold leading-tight tracking-[-0.015em] text-ff-text" style={d(100)}>
              Ask for the call.
            </p>
            <p className="asgm-enter mt-1.5 text-[12.5px] leading-snug text-ff-text2 [text-wrap:pretty]" style={d(200)}>
              Lineups, trades, waivers and the playoff race. Every number comes from this app&apos;s own models, run on your league.
            </p>
          </div>
        </div>
      </div>
      {s.suggestions.length > 0 && (
        <div className="asgm-enter" style={d(300)}>
          <p className="ff-label mb-2">Try asking</p>
          <ul className="flex flex-col gap-[3px]">
            {s.suggestions.map((q) => (
              <li key={q}>
                <button type="button" onClick={() => s.send(q)} className="asgm-suggest asgm-press asgm-wash group flex min-h-10 w-full items-center gap-2.5 border border-transparent px-3 py-2 text-left text-[13px] text-ff-text md:min-h-9">
                  <ChevronIcon dir="right" size={10} className="asgm-chev text-ff-accent" />
                  <span className="min-w-0 flex-1">{q}</span>
                  <span aria-hidden className="font-mono text-[11px] text-ff-text2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                    ask ↵
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

// ---- The thread ----

/** Where the thread sits under the header and the composer: scrolled from its top, and with more below. */
type Edges = { top: boolean; more: boolean }

const Thread = ({ variant, onGoto, onEdges }: { variant: ChatVariant; onGoto?: () => void; onEdges: (e: Edges) => void }) => {
  const s = useAsgm()
  const { data, analysis } = useFantasy()
  const scroller = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  // The names an answer may link: every rostered player in full; surnames alone for yours and the ones in the cards.
  const base = useMemo(() => Object.keys(analysis.rosteredBy), [analysis.rosteredBy])
  const mine = useMemo(() => (analysis.myRosterId != null ? (analysis.teamById[analysis.myRosterId]?.players ?? []) : []), [analysis])
  const indexFor = useMemo(() => {
    const cache = new Map<string, NameIndex>()
    return (m: Gm) => {
      const ids = new Set<string>()
      for (const c of m.cards) {
        if (c.kind === 'players') c.rows.forEach((r) => ids.add(r.id))
        else if (c.kind === 'lineup') c.changes.forEach((x) => (ids.add(x.in), ids.add(x.out)))
        else if (c.kind === 'trade') c.deal.moves.forEach((x) => ids.add(x.player))
        else if (c.kind === 'waivers') c.rows.forEach((r) => (ids.add(r.add), r.drop && ids.add(r.drop)))
        else if (c.kind === 'compare') c.ids.forEach((x) => ids.add(x))
      }
      for (const a of m.actions) if (a.kind === 'openPlayer') ids.add(a.id)
      const key = [...ids].sort().join()
      let hit = cache.get(key)
      if (!hit) cache.set(key, (hit = nameIndex(data.players, [...base, ...ids], [...mine, ...ids], analysis.teams)))
      return hit
    }
  }, [data.players, base, mine, analysis.teams])

  // A new question goes to the top of the view and its answer grows down from it, so the call is read first and the
  // cards it found land under it. The last exchange is at least the view's height, so there is room to do that.
  // Opening onto an earlier conversation starts at its end.
  const [viewH, setViewH] = useState(0)
  // The header and the composer draw their edges only while the thread runs under them.
  const edges = useRef(onEdges)
  edges.current = onEdges
  const measure = () => {
    const el = scroller.current
    if (el) edges.current({ top: el.scrollTop > 2, more: el.scrollTop + el.clientHeight < el.scrollHeight - 2 })
  }
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setViewH(el.clientHeight)
      measure()
    })
    ro.observe(el)
    if (inner.current) ro.observe(inner.current)
    el.scrollTop = el.scrollHeight
    return () => ro.disconnect()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const count = s.messages.length
  const seen = useRef(count)
  useLayoutEffect(() => {
    const el = scroller.current
    const was = seen.current
    seen.current = count
    if (!el || count <= was) return
    const turn = inner.current?.lastElementChild as HTMLElement | null
    if (!turn) return
    const to = turn.offsetTop - 12
    el.scrollTo({ top: to, behavior: reducedMotion() ? 'auto' : 'smooth' })
  }, [count])

  // Questions with their answers, as exchanges.
  const turns: AsgmMessage[][] = []
  for (const m of s.messages) if (m.role === 'user' || !turns.length) turns.push([m])
  else turns[turns.length - 1].push(m)
  const lastGm = [...s.messages].reverse().find((m) => m.role === 'gm')?.id
  return (
    <div
      ref={scroller}
      className={cx('ff-scroll relative min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]', variant === 'sheet' ? 'overscroll-auto' : 'overscroll-contain')}
      role="log"
      aria-label="Conversation with Assistant GM"
      aria-live="off"
      onScroll={measure}
    >
      <div ref={inner} className={cx('flex min-h-full flex-col gap-7 px-3 pb-4 pt-2', variant === 'page' && 'mx-auto max-w-[760px] md:px-5 md:pb-5 md:pt-4')}>
        {count === 0 ? (
          <Welcome variant={variant} />
        ) : (
          turns.map((t, i) => (
            <div key={t[0].id} className="flex flex-col gap-3.5" style={i === turns.length - 1 && viewH ? { minHeight: viewH - 24 } : undefined}>
              {t.map((m) => (m.role === 'user' ? <UserMessageView key={m.id} m={m} /> : <GmMessageView key={m.id} m={m} last={m.id === lastGm} index={indexFor(m)} onGoto={onGoto} />))}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

// ---- The composer ----

const Composer = ({ variant, autoFocus, over }: { variant: ChatVariant; autoFocus: boolean; /** The thread runs on under it: draw its edge. */ over: boolean }) => {
  const s = useAsgm()
  const box = useRef<HTMLTextAreaElement>(null)
  const hintId = useId()
  // Grow with what is typed, to six lines, then scroll.
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 148)}px`
  }, [s.draft])
  useEffect(() => {
    if (!autoFocus || !s.focusTick) return
    const el = box.current
    if (!el) return
    el.focus({ preventScroll: true })
    el.setSelectionRange(el.value.length, el.value.length)
  }, [s.focusTick, autoFocus])
  const empty = !s.draft.trim()
  const submit = () => {
    // Nothing to send: the cursor goes where the question is written, rather than the button being dead.
    if (empty) return box.current?.focus()
    if (s.running) return
    s.send(s.draft)
  }
  const ctx = s.context
  return (
    <form
      className={cx('asgm-composer shrink-0 bg-ff-panel px-3 pb-2.5 pt-2.5', over && 'is-over', variant === 'sheet' && 'pb-[max(10px,env(safe-area-inset-bottom))]', variant === 'page' && 'md:px-5')}
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <div className={cx(variant === 'page' && 'mx-auto max-w-[760px]')}>
        {ctx && (
          <div className="mb-2 flex min-w-0 items-center gap-1.5">
            {/* The label wraps rather than being cut: it is what the question will be about, read whole. A wash of the
                accent with its square, no frame; transparent edges for forced colours. */}
            <span className="asgm-chip inline-flex min-h-6 min-w-0 max-w-full items-stretch border border-transparent bg-ff-accent/[0.09] font-mono text-[10.5px] text-ff-text2">
              <span className="flex min-w-0 items-center gap-1.5 py-[3px] pl-2 pr-1 leading-[16px]">
                <span aria-hidden className="h-1.5 w-1.5 shrink-0 bg-ff-accent" />
                <span className="sr-only">Asking about: </span>
                <span className="min-w-0 [overflow-wrap:anywhere]">{ctx.label}</span>
              </span>
              <button
                type="button"
                onClick={() => {
                  s.dropContext()
                  // The chip goes with its button: focus moves to where the question is written, not to the page.
                  box.current?.focus()
                }}
                aria-label={`Don't send ${ctx.label} as context`}
                title="Ask without this context"
                className="ff-hit asgm-press flex min-h-6 w-6 shrink-0 items-center justify-center text-ff-text2 hover:bg-ff-accent/[0.12] hover:text-ff-text"
              >
                <Glyph d={CLOSE} size={10} />
              </button>
            </span>
          </div>
        )}
        {/* A field keeps its edge (it is a control); it sits on the wash until it has the cursor. */}
        <div className="asgm-input flex items-end border border-ff-line2 bg-[var(--asgm-wash)] transition-[border-color,background-color,box-shadow] duration-ff-quick focus-within:border-ff-accent/70 focus-within:bg-ff-panel focus-within:shadow-[0_0_0_3px_rgb(var(--ff-accent)/0.14)]">
          <textarea
            ref={box}
            rows={1}
            value={s.draft}
            onChange={(e) => s.setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                submit()
              }
            }}
            placeholder={s.messages.length ? 'Ask a follow-up…' : 'Ask your GM…'}
            aria-label="Message Assistant GM"
            aria-describedby={hintId}
            maxLength={2000}
            className="ff-scroll min-h-[38px] flex-1 resize-none bg-transparent px-2.5 py-[9px] text-[13.5px] leading-[20px] text-ff-text placeholder:text-ff-muted focus:outline-none"
          />
          {s.running ? (
            <button type="button" onClick={s.stop} aria-label="Stop the answer" title="Stop" className="asgm-press m-1 flex h-[30px] w-[30px] shrink-0 items-center justify-center border border-transparent bg-ff-text/[0.08] text-ff-text hover:bg-ff-text/[0.14] max-md:h-9 max-md:w-9">
              <svg aria-hidden width="12" height="12" viewBox="0 0 14 14">
                <path d={STOP} fill="currentColor" />
              </svg>
            </button>
          ) : (
            <button
              type="submit"
              // Unavailable until there is a question, but still in reach: pressing it then puts the cursor in the box.
              aria-disabled={empty || !s.ready || undefined}
              aria-label="Send"
              title="Send (Enter)"
              className="asgm-press m-1 flex h-[30px] w-[30px] shrink-0 items-center justify-center border border-transparent bg-ff-accent text-white hover:bg-[rgb(var(--ff-accent-deep))] aria-disabled:bg-ff-text/[0.07] aria-disabled:text-ff-muted max-md:h-9 max-md:w-9"
            >
              <Glyph d={SEND} size={13} />
            </button>
          )}
        </div>
        <p id={hintId} className="mt-1.5 flex items-center justify-between gap-3 font-mono text-[10px] text-ff-muted max-md:sr-only">
          <span className="truncate">
            <kbd className="text-ff-text2">Enter</kbd> sends · <kbd className="text-ff-text2">Shift Enter</kbd> new line
          </span>
          {variant === 'page' && <span className="truncate">numbers from this app&apos;s models</span>}
        </p>
      </div>
    </form>
  )
}

/**
 * Screen readers hear the conversation without the stream: "Working" once when a question goes, then the whole
 * answer (or what went wrong) once it is in. Always in the page, so the announcements land.
 */
const Announcer = () => {
  const s = useAsgm()
  const [say, setSay] = useState('')
  const was = useRef<string | null>(null)
  useEffect(() => {
    const prev = was.current
    was.current = s.running
    if (s.running && !prev) setSay('Assistant GM is working on it.')
    else if (!s.running && prev) {
      const m = s.messages.find((x) => x.id === prev)
      if (m?.role === 'gm') setSay(m.error ? `${ERROR_TITLE[m.error.code] ?? ERROR_TITLE.provider}. ${m.error.code === 'aborted' ? '' : m.error.message}` : `Assistant GM: ${plain(m.text)}${m.cards.length ? ` ${m.cards.length} card${m.cards.length === 1 ? '' : 's'} below.` : ''}`)
    }
  }, [s.running, s.messages])
  return (
    <p role="status" aria-live="polite" className="sr-only">
      {say}
    </p>
  )
}

export const AsgmChat = ({
  variant,
  titleId,
  onClose,
  onDock,
  onExpand,
  onGoto,
}: {
  variant: ChatVariant
  titleId: string
  onClose?: () => void
  onDock?: () => void
  onExpand?: () => void
  /** A button in an answer took the reader somewhere else in the app. */
  onGoto?: () => void
}) => {
  const s = useAsgm()
  const [edges, setEdges] = useState<Edges>({ top: false, more: false })
  const onEdges = (e: Edges) => setEdges((x) => (x.top === e.top && x.more === e.more ? x : e))
  return (
    <div className="flex h-full min-h-0 flex-col" data-asgm="">
      {/* The header (and the mock's note under it) draw their bottom edge only while the thread is scrolled under them. */}
      <div className={cx('asgm-head shrink-0 bg-ff-panel', edges.top && !s.settings && 'is-stuck')}>
        <Header variant={variant} titleId={titleId} onClose={onClose} onDock={onDock} onExpand={onExpand} />
        {s.mock && (
          <p className="bg-ff-warn/[0.08] px-3 py-1 font-mono text-[10px] text-ff-text2">
            <span className="font-semibold text-ff-warn">MOCK</span> · canned answers<span className="max-sm:hidden">, your league&apos;s real players</span>
          </p>
        )}
      </div>
      {s.settings ? (
        <div className="ff-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <AsgmSettings onDone={() => s.setSettings(false)} />
        </div>
      ) : (
        <>
          <Thread variant={variant} onGoto={onGoto} onEdges={onEdges} />
          <Composer variant={variant} autoFocus={variant !== 'sheet'} over={edges.more} />
        </>
      )}
      <Announcer />
    </div>
  )
}
