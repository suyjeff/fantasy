import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  buildAsgmLeague,
  houseStatus,
  keys,
  mockForced,
  runTurn,
  suggestions as suggest,
  type AsgmContext,
  type AsgmEvent,
  type AsgmHouseStatus,
  type AsgmLeague,
  type AsgmMessage,
  type AsgmOpen,
  type AsgmProvider as Provider,
  type StoredKey,
} from '../../lib/assistant'
import type { Analysis } from '../../lib/analysis'
import type { Models } from '../../lib/models'
import type { LeagueData } from '../../lib/useLeagueData'
import { loadChat, loadUse, saveChat, saveUse, uid, type AsgmUse } from './store'

// Assistant GM's one conversation, whichever way it is shown: the floating window, the panel docked at the right, its
// own page, or the phone's sheet. It lives here, above the page (and the shell, so the shell's buttons can open it),
// with what the GM knows about where you are: each view publishes its context (useAsgmContext), the latest one wins,
// and the composer shows it as a chip you can take off.

type GmMessage = Extract<AsgmMessage, { role: 'gm' }>

/** The steady half: opening, closing and publishing context. Never changes, so a button or a view using it never re-renders for the chat. */
export type AsgmControl = {
  /** Open the GM, optionally with a question (asked at once with `send`) and the context it is about. */
  open: (o?: AsgmOpen) => void
  close: () => void
  /** Put the cursor in the composer, wherever the conversation is showing. */
  focus: () => void
  /** The shortcut and the top-right button: open it, or close it when it is already in front of you. */
  toggle: () => void
  /** Publish where the reader is. The latest published context is the GM's; the handle drops it. */
  publish: (ctx: AsgmContext) => { update: (ctx: AsgmContext) => void; drop: () => void }
}

export type AsgmState = {
  /** A league is loaded, so there is something to ask about. */
  ready: boolean
  open: boolean
  /** Docked at the right on a wide screen, rather than floating. */
  docked: boolean
  setDocked: (on: boolean) => void
  /** The page is Assistant GM's own: the conversation shows there, not in a window. */
  onPage: boolean
  goPage: () => void
  messages: AsgmMessage[]
  /** The answer being written, by message id. */
  running: string | null
  send: (text: string, context?: AsgmContext) => void
  stop: () => void
  /** Ask the question behind an answer again, in its place. */
  retry: (gmId: string) => void
  clear: () => void
  draft: string
  setDraft: (s: string) => void
  /** The context the next question carries: one handed in by open(), else the page's, unless taken off. */
  context: AsgmContext | undefined
  dropContext: () => void
  suggestions: string[]
  league: AsgmLeague | null
  /** Bumped whenever the composer should take focus. */
  focusTick: number
  /** An answer landed while the GM was closed. */
  unread: boolean
  settings: boolean
  setSettings: (on: boolean) => void
  // Where questions go.
  provider: Provider
  mock: boolean
  use: AsgmUse
  setUse: (u: AsgmUse) => void
  storedKey: StoredKey | null
  setStoredKey: (k: StoredKey | null) => void
  /** Today's free questions: undefined until asked, null when the house can't say. */
  house: AsgmHouseStatus | null | undefined
  /** The element focus returns to when the GM closes. */
  opener: React.MutableRefObject<HTMLElement | null>
}

const ControlCtx = createContext<AsgmControl | null>(null)
const StateCtx = createContext<AsgmState | null>(null)

export const useAsgmControl = () => useContext(ControlCtx)
export const useAsgm = () => {
  const s = useContext(StateCtx)
  if (!s) throw new Error('useAsgm outside AsgmProvider')
  return s
}
export const useAsgmMaybe = () => useContext(StateCtx)

/** A context's identity, for telling one from another (two renders of the same view are the same context). */
export const contextKey = (c: AsgmContext | undefined) => (c ? JSON.stringify([c.view, c.focus ?? null]) : '')

/**
 * Tell the GM where the reader is: call it in a view with what the view shows (null for nothing). The latest view
 * to publish wins (a sheet over a page, the trade open in the builder), and the previous one comes back when it goes.
 */
export const useAsgmContext = (ctx: AsgmContext | null | undefined) => {
  const control = useContext(ControlCtx)
  const key = ctx ? `${contextKey(ctx)}|${ctx.label}` : null
  const latest = useRef(ctx)
  latest.current = ctx
  const handle = useRef<ReturnType<AsgmControl['publish']> | null>(null)
  useEffect(() => {
    if (!control || !key || !latest.current) return
    if (handle.current) handle.current.update(latest.current)
    else handle.current = control.publish(latest.current)
  }, [control, key])
  useEffect(
    () => () => {
      handle.current?.drop()
      handle.current = null
    },
    [control],
  )
  useEffect(() => {
    if (!key && handle.current) {
      handle.current.drop()
      handle.current = null
    }
  }, [key])
}

const typing = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable || t.getAttribute('aria-expanded') === 'true')
}

const DOCK_KEY = 'ff:asgm:dock'

export const AsgmProvider = ({
  league: input,
  leagueId,
  onPage,
  goPage,
  children,
}: {
  /** The page's league, analysis and models, once loaded. */
  league: { data: LeagueData; analysis: Analysis; models: Models } | null
  leagueId: string | null
  /** Assistant GM's own page is showing. */
  onPage: boolean
  goPage: () => void
  children: ReactNode
}) => {
  const league = useMemo(() => (input ? buildAsgmLeague({ data: input.data, analysis: input.analysis, models: input.models }, input.analysis.myRosterId ?? null) : null), [input?.data, input?.analysis, input?.models]) // eslint-disable-line react-hooks/exhaustive-deps
  const ready = !!league

  const [open, setOpen] = useState(false)
  const [docked, setDockedState] = useState(false)
  const [settings, setSettings] = useState(false)
  const [focusTick, setFocusTick] = useState(0)
  const [unread, setUnread] = useState(false)
  const [draft, setDraft] = useState('')
  const opener = useRef<HTMLElement | null>(null)
  const openRef = useRef(open)
  openRef.current = open || onPage

  // ---- Where questions go ----
  const [mock, setMock] = useState(false)
  const [use, setUseState] = useState<AsgmUse>('house')
  const [storedKey, setKeyState] = useState<StoredKey | null>(null)
  const [house, setHouse] = useState<AsgmHouseStatus | null | undefined>(undefined)
  useEffect(() => {
    setMock(mockForced())
    setUseState(loadUse())
    setKeyState(keys.load())
    try {
      setDockedState(window.localStorage.getItem(DOCK_KEY) === '1')
    } catch {
      // Storage blocked: floating it is.
    }
  }, [])
  const provider: Provider = mock ? 'mock' : use === 'key' && storedKey ? storedKey.provider : 'house'
  const setUse = useCallback((u: AsgmUse) => {
    setUseState(u)
    saveUse(u)
  }, [])
  const setStoredKey = useCallback((k: StoredKey | null) => {
    keys.save(k)
    setKeyState(k)
  }, [])
  const setDocked = useCallback((on: boolean) => {
    setDockedState(on)
    try {
      window.localStorage.setItem(DOCK_KEY, on ? '1' : '0')
    } catch {
      // Storage blocked: the choice lasts this visit.
    }
  }, [])
  // Today's allowance, asked once the GM is first in front of someone (and again after a reset could have happened).
  const visible = open || onPage
  useEffect(() => {
    if (!visible || provider !== 'house') return
    if (house && house.resetsAt > Date.now()) return
    let live = true
    houseStatus().then((h) => live && setHouse(h))
    return () => {
      live = false
    }
  }, [visible, provider]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- The conversation, one per league ----
  const [chat, setChat] = useState<{ league: string | null; msgs: AsgmMessage[] }>({ league: null, msgs: [] })
  const [running, setRunning] = useState<string | null>(null)
  const run = useRef<{ ctl: AbortController; id: string } | null>(null)
  useEffect(() => {
    run.current?.ctl.abort()
    run.current = null
    setRunning(null)
    setChat({ league: leagueId, msgs: leagueId ? loadChat(leagueId) : [] })
  }, [leagueId])
  useEffect(() => {
    if (!running && chat.league && chat.league === leagueId) saveChat(chat.league, chat.msgs)
  }, [chat, running, leagueId])
  useEffect(() => () => run.current?.ctl.abort(), [])

  // Text arrives a few words at a time; it is gathered and drawn once a frame, not once a word.
  const pending = useRef<{ id: string; text: string } | null>(null)
  const raf = useRef<number | null>(null)
  const patch = useCallback((id: string, fn: (m: GmMessage) => GmMessage) => setChat((c) => ({ ...c, msgs: c.msgs.map((m) => (m.id === id && m.role === 'gm' ? fn(m) : m)) })), [])
  const flush = useCallback(() => {
    if (raf.current != null) cancelAnimationFrame(raf.current)
    raf.current = null
    const p = pending.current
    if (!p || !p.text) return
    pending.current = { id: p.id, text: '' }
    patch(p.id, (m) => ({ ...m, text: m.text + p.text }))
  }, [patch])

  // ---- Context ----
  const entries = useRef(new Map<number, { ctx: AsgmContext; order: number }>())
  const seq = useRef(0)
  const [current, setCurrent] = useState<AsgmContext | undefined>(undefined)
  const recompute = useCallback(() => {
    let best: { ctx: AsgmContext; order: number } | undefined
    for (const e of entries.current.values()) if (!best || e.order > best.order) best = e
    setCurrent(best?.ctx)
  }, [])
  const [pinned, setPinned] = useState<AsgmContext | null>(null)
  const [detached, setDetached] = useState<string | null>(null)
  const context = pinned ?? (current && contextKey(current) !== detached ? current : undefined)
  const dropContext = useCallback(() => {
    setPinned(null)
    setDetached(contextKey(current))
  }, [current])

  // ---- Asking ----
  const latest = useRef({ league, provider, chat, running, context, storedKey })
  latest.current = { league, provider, chat, running, context, storedKey }
  const send = useCallback(
    (text: string, ctx?: AsgmContext) => {
      const q = text.trim()
      const { league: lg, provider: pv, chat: c, running: busy, context: here, storedKey: key } = latest.current
      if (!q || !lg || busy) return
      const about = ctx ?? here
      const user: AsgmMessage = { role: 'user', id: uid(), text: q, ...(about ? { context: about } : {}), at: Date.now() }
      const gm: GmMessage = { role: 'gm', id: uid(), text: '', steps: [], cards: [], actions: [], at: Date.now() }
      // What came before, without exchanges that ended in an error (the question there was never answered).
      const history = c.msgs.filter((m, i) => {
        const next = c.msgs[i + 1]
        return m.role === 'gm' ? !m.error && !!m.text : !(next?.role === 'gm' && (next.error || !next.text))
      })
      setChat((s) => ({ ...s, msgs: [...s.msgs, user, gm] }))
      setDraft('')
      setPinned(null)
      setRunning(gm.id)
      const ctl = new AbortController()
      run.current = { ctl, id: gm.id }
      pending.current = { id: gm.id, text: '' }
      const onEvent = (e: AsgmEvent) => {
        if (ctl.signal.aborted && e.type !== 'error') return
        if (e.type === 'text') {
          if (!pending.current || pending.current.id !== gm.id) pending.current = { id: gm.id, text: '' }
          if (e.reset) {
            // The step turned out to be a tool call, not the answer: drop what it streamed, drawn or not.
            pending.current.text = ''
            patch(gm.id, (m) => ({ ...m, text: '' }))
          }
          pending.current.text += e.delta
          if (raf.current == null) raf.current = requestAnimationFrame(flush)
          return
        }
        flush()
        if (e.type === 'step') patch(gm.id, (m) => ({ ...m, steps: m.steps.some((s) => s.id === e.id) ? m.steps.map((s) => (s.id === e.id ? { ...s, ...e, detail: e.detail ?? s.detail } : s)) : [...m.steps, e] }))
        else if (e.type === 'card') patch(gm.id, (m) => ({ ...m, cards: [...m.cards, e.card] }))
        else if (e.type === 'action') patch(gm.id, (m) => ({ ...m, actions: [...m.actions, e.action] }))
        else if (e.type === 'done') {
          patch(gm.id, (m) => ({ ...m, provider: e.model ? `${e.provider} · ${e.model}` : e.provider }))
          // The allowance is the house's: only its own answers say what is left of it.
          if (pv === 'house' && e.remaining != null) setHouse((h) => (h ? { ...h, remaining: e.remaining! } : h))
        } else if (e.type === 'error') {
          patch(gm.id, (m) => ({ ...m, error: e }))
          // Only the house running out empties it: a key's errors and a rate limit ('rate') leave it as it was.
          if (pv === 'house' && e.code === 'quota') setHouse((h) => (h ? { ...h, remaining: 0 } : h))
        }
      }
      // The key held here, not only what storage has: where storage is blocked, the one saved this visit still works.
      runTurn({ history, text: q, context: about, league: lg, provider: pv, key: pv === 'house' || pv === 'mock' ? null : key }, onEvent, ctl.signal).finally(() => {
        flush()
        // Steps still running when it ended (a stop, an error) end as stopped, so nothing spins for ever.
        patch(gm.id, (m) => ({ ...m, steps: m.steps.map((s) => (s.status === 'running' ? { ...s, status: 'error', detail: s.detail ?? 'stopped' } : s)) }))
        if (run.current?.id === gm.id) run.current = null
        setRunning((r) => (r === gm.id ? null : r))
        if (!openRef.current) setUnread(true)
      })
    },
    [flush, patch],
  )
  const stop = useCallback(() => run.current?.ctl.abort(), [])
  const retry = useCallback(
    (gmId: string) => {
      const msgs = latest.current.chat.msgs
      const i = msgs.findIndex((m) => m.id === gmId)
      const q = i > 0 ? msgs[i - 1] : null
      if (!q || q.role !== 'user' || latest.current.running) return
      setChat((c) => ({ ...c, msgs: c.msgs.filter((m) => m.id !== gmId && m.id !== q.id) }))
      // After the removal has rendered, so the history sent does not hold the old exchange.
      latest.current = { ...latest.current, chat: { ...latest.current.chat, msgs: msgs.filter((m) => m.id !== gmId && m.id !== q.id) } }
      send(q.text, q.context)
    },
    [send],
  )
  const clear = useCallback(() => {
    run.current?.ctl.abort()
    setChat((c) => ({ ...c, msgs: [] }))
    setDraft('')
    setFocusTick((t) => t + 1)
  }, [])

  // ---- Opening ----
  const control = useMemo<AsgmControl>(() => {
    const remember = () => {
      const at = document.activeElement as HTMLElement | null
      if (at && at !== document.body && !at.closest('[data-asgm]')) opener.current = at
    }
    return {
      open: (o) => {
        remember()
        setOpen(true)
        setUnread(false)
        setSettings(false)
        if (o?.context) setPinned(o.context)
        if (o?.prompt) {
          if (o.send && !latest.current.running) sendRef.current(o.prompt, o.context)
          else setDraft(o.prompt)
        }
        setFocusTick((t) => t + 1)
      },
      close: () => setOpen(false),
      focus: () => setFocusTick((t) => t + 1),
      toggle: () => {
        if (openRef.current && !onPageRef.current) return setOpen(false)
        remember()
        setOpen(true)
        setUnread(false)
        setFocusTick((t) => t + 1)
      },
      publish: (ctx) => {
        const id = ++seq.current
        entries.current.set(id, { ctx, order: id })
        recompute()
        return {
          update: (c) => {
            const e = entries.current.get(id)
            if (!e) return
            // A new view is news; the same view with a new label is not, and keeps its place.
            entries.current.set(id, { ctx: c, order: contextKey(c) === contextKey(e.ctx) ? e.order : ++seq.current })
            recompute()
          },
          drop: () => {
            entries.current.delete(id)
            recompute()
          },
        }
      },
    }
  }, [recompute])
  const sendRef = useRef(send)
  sendRef.current = send
  const onPageRef = useRef(onPage)
  onPageRef.current = onPage

  // G opens it from anywhere (not while typing, and not over a sheet, which owns the keyboard).
  useEffect(() => {
    if (!ready) return
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e) || (e.key !== 'g' && e.key !== 'G')) return
      if (document.querySelector('[role="dialog"][aria-modal="true"]:not([data-asgm])')) return
      e.preventDefault()
      // Open and in view but focus elsewhere on the page: take it to the composer rather than closing.
      if (openRef.current && !document.activeElement?.closest('[data-asgm]')) setFocusTick((t) => t + 1)
      else control.toggle()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ready, control])

  const suggestions = useMemo(() => (league ? suggest(context, league) : []), [league, context])

  const state: AsgmState = {
    ready,
    open,
    docked,
    setDocked,
    onPage,
    goPage,
    messages: chat.league === leagueId ? chat.msgs : [],
    running,
    send,
    stop,
    retry,
    clear,
    draft,
    setDraft,
    context,
    dropContext,
    suggestions,
    league,
    focusTick,
    unread,
    settings,
    setSettings,
    provider,
    mock,
    use,
    setUse,
    storedKey,
    setStoredKey,
    house,
    opener,
  }
  return (
    <ControlCtx.Provider value={control}>
      <StateCtx.Provider value={state}>{children}</StateCtx.Provider>
    </ControlCtx.Provider>
  )
}
