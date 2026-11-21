import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { CLOSE, Glyph } from '../TradeBuilder'
import { ChevronIcon, HistoryIcon } from '../icons'
import { cx } from '../ui'
import type { ChatVariant } from './AsgmChat'
import { useAsgm } from './AsgmProvider'
import { contextOf, groupOf, joinRemoved, matches, questionsIn, whenOf, type AsgmConvo, type AsgmGroup, type AsgmRemoved } from './store'

// Past conversations, in place of the conversation (as the settings are): this league's conversations, newest first,
// grouped by day, to open again and carry on in. Rows sit on the panel with no frame; the open one takes the accent's
// wash and its rule down the left, as a chosen row does across the app. Arrow keys move through the rows (one tab stop
// for the list), Enter opens, Delete deletes (at once, with Undo), Escape goes back to the conversation.

/** Search shows once the list is longer than this. */
const SEARCH_FROM = 8
const GROUPS: AsgmGroup[] = ['Today', 'Yesterday', 'Earlier this week', 'Older']

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/** One conversation: its first question, when it was last asked in, how many questions, what the first was about. */
const Row = ({
  c,
  open,
  now,
  tab,
  setRef,
  onOpen,
  onDelete,
  onFocus,
}: {
  c: AsgmConvo
  open: boolean
  now: number
  tab: boolean
  setRef: (el: HTMLButtonElement | null) => void
  onOpen: () => void
  onDelete: () => void
  onFocus: () => void
}) => {
  const n = questionsIn(c)
  const about = contextOf(c)
  return (
    <li className={cx('group relative flex items-stretch transition-colors duration-ff-quick', open ? 'bg-ff-accent/[0.07] shadow-[inset_2px_0_0_rgb(var(--ff-accent))]' : 'hover:bg-[var(--asgm-wash-hover)]')}>
      <button
        ref={setRef}
        type="button"
        data-convo={c.id}
        tabIndex={tab ? 0 : -1}
        onClick={onOpen}
        onFocus={onFocus}
        aria-current={open || undefined}
        aria-keyshortcuts="Delete"
        className="flex min-h-11 min-w-0 flex-1 flex-col gap-[3px] py-2 pl-3 pr-1 text-left focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ff-accent"
      >
        <span className="flex w-full items-start gap-3">
          <span className="line-clamp-2 min-w-0 flex-1 text-[13px] leading-[18px] text-ff-text [overflow-wrap:anywhere]">{c.title}</span>
          <span className="sr-only">, </span>
          <span className="num shrink-0 pt-px font-mono text-[10.5px] leading-[17px] text-ff-muted">{whenOf(c.updatedAt, now)}</span>
        </span>
        <span className="flex w-full min-w-0 items-center gap-1.5 font-mono text-[10.5px] leading-[14px] text-ff-text2">
          <span className="sr-only">, </span>
          {open && (
            <>
              <span aria-hidden className="h-1.5 w-1.5 shrink-0 bg-ff-accent" />
              <span className="shrink-0 text-ff-accent">open</span>
              <span className="sr-only"> now, </span>
              <span aria-hidden className="text-ff-muted">·</span>
            </>
          )}
          <span className="shrink-0">{plural(n, 'question')}</span>
          {about && (
            <>
              <span aria-hidden className="text-ff-muted">·</span>
              <span className="min-w-0 truncate text-ff-muted">
                <span className="sr-only">, about </span>
                <span aria-hidden>re: </span>
                {about}
              </span>
            </>
          )}
        </span>
      </button>
      {/* Out of the tab order but for the row in reach: Delete on the row does the same. Shown under a pointer when the
          row is, always on touch. */}
      <button
        type="button"
        tabIndex={tab ? 0 : -1}
        onClick={onDelete}
        aria-label={`Delete “${c.title}”`}
        title="Delete (Del)"
        className="asgm-press flex w-10 shrink-0 items-center justify-center text-ff-muted hover:bg-ff-neg/[0.08] hover:text-ff-neg focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ff-accent group-hover:opacity-100 group-focus-within:opacity-100 md:w-8 [@media(hover:hover)_and_(pointer:fine)]:opacity-0"
      >
        <Glyph d={CLOSE} size={11} />
      </button>
    </li>
  )
}

const AsgmHistory = ({ variant, onBack, onStuck }: { variant: ChatVariant; onBack: () => void; /** The list is scrolled under the header. */ onStuck: (on: boolean) => void }) => {
  const s = useAsgm()
  // Read on every render, so a list left open over midnight (or for an hour) files and dates its rows right.
  const now = Date.now()
  const [q, setQ] = useState('')
  const [confirm, setConfirm] = useState(false)
  // What the last delete took away, for Undo; and what the status line says.
  // Every delete since the note last went (Undo, leaving the list) is one Undo.
  const [undo, setUndo] = useState<AsgmRemoved | null>(null)
  const [note, setNote] = useState('')
  // Another league: its list is another list, and nothing from this one may be put back into it.
  const league = useRef(s.leagueKey)
  useEffect(() => {
    if (league.current === s.leagueKey) return
    league.current = s.leagueKey
    setUndo(null)
    setNote('')
    setConfirm(false)
    setQ('')
  }, [s.leagueKey])
  const all = s.convos
  const searching = all.length > SEARCH_FROM
  const shown = useMemo(() => (searching && q.trim() ? all.filter((c) => matches(c, q)) : all), [all, q, searching])
  const groups = GROUPS.map((g) => ({ g, rows: shown.filter((c) => groupOf(c.updatedAt, now) === g) })).filter((x) => x.rows.length)
  const order = groups.flatMap((x) => x.rows.map((c) => c.id))

  // One tab stop for the list: the row last moved to (the open conversation at first), its delete button with it.
  const [active, setActive] = useState<string | null>(() => (all.some((c) => c.id === s.currentId) ? s.currentId : (all[0]?.id ?? null)))
  const tabbed = active && order.includes(active) ? active : (order[0] ?? null)
  const rows = useRef(new Map<string, HTMLButtonElement>())
  const search = useRef<HTMLInputElement>(null)
  const back = useRef<HTMLButtonElement>(null)
  const undoBtn = useRef<HTMLButtonElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const [focusTo, setFocusTo] = useState<{ id: string | null } | null>(null)
  const ids = { title: useId(), search: useId(), hint: useId() }
  // The foot draws its edge only while rows run on under it, as the composer does.
  const scroller = useRef<HTMLDivElement>(null)
  const [over, setOver] = useState(false)
  const measure = () => {
    const el = scroller.current
    if (!el) return
    onStuck(el.scrollTop > 2)
    setOver(el.scrollTop + el.clientHeight < el.scrollHeight - 2)
  }
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    return () => ro.disconnect()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const focusRow = (id: string | null | undefined) => {
    const el = id ? rows.current.get(id) : null
    if (!el) return false
    setActive(id!)
    el.focus()
    el.scrollIntoView({ block: 'nearest' })
    return true
  }
  // In, focus goes where the reader will act: the search (with a keyboard to type in it), else the open conversation's
  // row, else back.
  useLayoutEffect(() => {
    const touch = window.matchMedia('(pointer: coarse)').matches
    if (searching && !touch && variant !== 'sheet') search.current?.focus({ preventScroll: true })
    else if (!focusRow(tabbed)) back.current?.focus({ preventScroll: true })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  // After a delete or an undo has rendered: the row that took its place, the one put back, or else what is left.
  useEffect(() => {
    if (!focusTo) return
    setFocusTo(null)
    if (focusRow(focusTo.id)) return
    if (undoBtn.current) return undoBtn.current.focus()
    ;(search.current ?? back.current)?.focus()
  }, [focusTo]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (confirm) cancel.current?.focus()
  }, [confirm])

  const remove = (target: string[], next: string | null) => {
    const r = s.removeConvos(target)
    if (!r.convos.length) return
    const joined = joinRemoved(undo, r)
    setUndo(joined)
    setNote(joined.convos.length === 1 ? `Deleted “${joined.convos[0].title}”.` : `Deleted ${plural(joined.convos.length, 'conversation')}.`)
    setConfirm(false)
    setFocusTo({ id: next })
  }
  const removeOne = (c: AsgmConvo) => {
    const i = order.indexOf(c.id)
    remove([c.id], order[i + 1] ?? order[i - 1] ?? null)
  }
  const putBack = () => {
    if (!undo || undo.league !== s.leagueKey) return setUndo(null)
    s.restoreConvos(undo)
    setNote(undo.convos.length === 1 ? 'Conversation put back.' : `${plural(undo.convos.length, 'conversation')} put back.`)
    setFocusTo({ id: undo.convos[0]?.id ?? null })
    setUndo(null)
  }

  const onListKey = (e: React.KeyboardEvent) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>('[data-convo]')?.dataset.convo ?? (e.target as HTMLElement).closest('li')?.querySelector<HTMLElement>('[data-convo]')?.dataset.convo
    if (!id) return
    const i = order.indexOf(id)
    const go = (to: string | undefined) => {
      e.preventDefault()
      if (to) focusRow(to)
    }
    if (e.key === 'ArrowDown') go(order[i + 1])
    else if (e.key === 'ArrowUp') {
      if (i === 0 && search.current) {
        e.preventDefault()
        search.current.focus()
      } else go(order[i - 1])
    } else if (e.key === 'Home') go(order[0])
    else if (e.key === 'End') go(order[order.length - 1])
    else if ((e.key === 'Delete' || e.key === 'Backspace') && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      const c = all.find((x) => x.id === id)
      if (c) removeOne(c)
    }
  }

  const page = variant === 'page'
  // The keys, where there is a keyboard and rows to use them on.
  const hint = variant !== 'sheet' && all.length > 0
  return (
    <div className="asgm-pane flex min-h-0 flex-1 flex-col">
      <div ref={scroller} className="ff-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]" onScroll={measure}>
        <div className={cx('px-3 pb-4 pt-3', page && 'mx-auto max-w-[760px] md:px-5 md:pt-4')}>
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <h3 id={ids.title} className="ff-label">
              Past conversations
              {all.length > 0 && <span className="num ml-1.5 text-ff-muted">{all.length}</span>}
            </h3>
            <button ref={back} type="button" onClick={onBack} className="ff-hit asgm-press inline-flex items-center gap-1 font-mono text-[11px] text-ff-text2 hover:text-ff-text">
              <ChevronIcon dir="left" size={10} />
              back<span className="sr-only"> to the conversation</span>
            </button>
          </div>
          {searching && (
            <div className="mb-1 pt-1">
              <label htmlFor={ids.search} className="sr-only">
                Search past conversations
              </label>
              <input
                ref={search}
                id={ids.search}
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown' && order.length) {
                    e.preventDefault()
                    focusRow(order[0])
                  } else if (e.key === 'Enter' && order.length) {
                    e.preventDefault()
                    s.openConvo(order[0])
                  } else if (e.key === 'Escape' && q) {
                    // The first Escape clears the search; the next goes back.
                    e.preventDefault()
                    e.stopPropagation()
                    setQ('')
                  }
                }}
                placeholder="Search questions and answers"
                autoComplete="off"
                aria-describedby={hint ? ids.hint : undefined}
                className="h-9 w-full border border-ff-line2 bg-[var(--asgm-wash)] px-2.5 text-[13px] text-ff-text transition-[border-color,background-color,box-shadow] duration-ff-quick placeholder:text-ff-muted focus:border-ff-accent/70 focus:bg-ff-panel focus:shadow-[0_0_0_3px_rgb(var(--ff-accent)/0.14)] focus:outline-none max-md:h-11 [&::-webkit-search-cancel-button]:hidden"
              />
            </div>
          )}
          {s.running && all.length > 0 && <p className="mb-1 pt-1 font-mono text-[10.5px] leading-snug text-ff-muted">An answer is being written: opening another conversation stops it.</p>}
          {all.length === 0 ? (
            <div className="mt-1 flex items-start gap-2.5 bg-[var(--asgm-wash)] px-3 py-3">
              <HistoryIcon size={14} className="mt-[2px] text-ff-muted" />
              <p className="text-[13px] leading-snug text-ff-text2 [text-wrap:pretty]">No past conversations yet. Ask something and it&apos;ll show up here.</p>
            </div>
          ) : !order.length ? (
            <p className="py-6 text-[13px] leading-snug text-ff-text2 [overflow-wrap:anywhere]">
              No conversations match “{q.trim()}”.{' '}
              <button type="button" onClick={() => (setQ(''), search.current?.focus())} className="ff-hit text-ff-text underline decoration-ff-muted/60 underline-offset-2 hover:decoration-ff-text">
                Clear the search
              </button>
            </p>
          ) : (
            <div onKeyDown={onListKey} aria-labelledby={ids.title} role="group">
              {groups.map(({ g, rows: rs }) => (
                <section key={g} aria-label={g}>
                  <h4 aria-hidden className="ff-label px-3 pb-1 pt-3 !text-ff-muted">
                    {g}
                  </h4>
                  <ul className="flex flex-col gap-px">
                    {rs.map((c) => (
                      <Row
                        key={c.id}
                        c={c}
                        now={now}
                        open={c.id === s.currentId}
                        tab={c.id === tabbed}
                        setRef={(el) => (el ? rows.current.set(c.id, el) : rows.current.delete(c.id))}
                        onOpen={() => s.openConvo(c.id)}
                        onDelete={() => removeOne(c)}
                        onFocus={() => setActive(c.id)}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
      {/* The foot: what a delete did and its Undo, then Clear all (asked once, naming how many). */}
      <div className={cx('asgm-composer shrink-0 bg-ff-panel px-3 pb-2.5 pt-2', over && 'is-over', variant === 'sheet' && 'pb-[max(10px,env(safe-area-inset-bottom))]', page && 'md:px-5')}>
        <div className={cx('flex flex-col gap-2', page && 'mx-auto max-w-[760px]')}>
          <div role="status" className={cx('flex min-w-0 items-center gap-2', !note && 'sr-only')}>
            {note && (
              <>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ff-text2">{note}</span>
                {undo && (
                  <button ref={undoBtn} type="button" onClick={putBack} className="asgm-press h-8 shrink-0 border border-transparent bg-ff-text/[0.07] px-3 text-[12.5px] font-medium text-ff-text hover:bg-ff-text/[0.12] max-md:h-10">
                    Undo
                  </button>
                )}
              </>
            )}
          </div>
          {confirm ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 text-[12.5px] text-ff-text">Delete all {plural(all.length, 'conversation')}?</span>
              <button
                type="button"
                onClick={() => remove(all.map((c) => c.id), null)}
                className="asgm-press h-8 border border-transparent bg-ff-neg/[0.12] px-3 text-[12.5px] font-medium text-ff-neg hover:bg-ff-neg/[0.18] max-md:h-10"
              >
                Delete all {all.length}
              </button>
              <button ref={cancel} type="button" onClick={() => setConfirm(false)} className="asgm-press h-8 border border-transparent bg-ff-text/[0.07] px-3 text-[12.5px] font-medium text-ff-text hover:bg-ff-text/[0.12] max-md:h-10">
                Cancel
              </button>
            </div>
          ) : (
            all.length > 0 && (
              <div className="flex items-center justify-between gap-3">
                {hint ? (
                  <p id={ids.hint} className="min-w-0 truncate font-mono text-[10px] text-ff-muted max-md:sr-only">
                    <kbd className="text-ff-text2">↑↓</kbd> move · <kbd className="text-ff-text2">Enter</kbd> opens · <kbd className="text-ff-text2">Del</kbd> deletes · <kbd className="text-ff-text2">Esc</kbd> back
                  </p>
                ) : (
                  <span />
                )}
                {all.length > 1 && (
                  <button type="button" onClick={() => setConfirm(true)} className="asgm-press h-8 shrink-0 px-2 text-[12px] text-ff-text2 hover:bg-ff-neg/[0.08] hover:text-ff-neg max-md:h-10">
                    Clear all
                  </button>
                )}
              </div>
            )
          )}
        </div>
      </div>
    </div>
  )
}

export default AsgmHistory
