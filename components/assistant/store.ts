// Assistant GM's memory in this browser: the conversations had in each league, and which model to ask. Bounded, so a
// season of questions never crowds the league cache out of localStorage (lib/storage keeps that within its quota):
// up to 30 conversations per league in about 150K characters, roughly what the one conversation per league had before.
// Several tabs can share a league: a save merges with what is stored (the newer copy of a conversation wins, and a
// conversation deleted anywhere stays deleted), and each tab keeps the conversation it has open to itself.
import type { AsgmMessage } from '../../lib/assistant'
import { writeStored } from '../../lib/storage'

/** Messages kept per conversation, and the characters they may take in all. Older ones go first. */
export const MAX_MESSAGES = 40
export const MAX_CHARS = 120_000
/** Conversations kept per league, and the characters they may take together: the oldest go first, never the open one
 *  (nor one just put back with Undo). */
export const MAX_CONVOS = 30
export const MAX_BOOK_CHARS = 150_000
/** Deleted conversations remembered per league, so another tab's stale copy cannot bring one back. */
export const MAX_DELETED = 200

/** One conversation: what it was about (its first question), when it began and was last asked in, and what was said. */
export type AsgmConvo = { id: string; title: string; createdAt: number; updatedAt: number; messages: AsgmMessage[] }
/** A league's conversations, newest first, and the one that is open. Only conversations with something said are kept.
 *  `deleted`, as read back: the ids deleted in any tab. */
export type AsgmBook = { current: string | null; list: AsgmConvo[]; deleted?: string[] }

export const bookKey = (league: string) => `ff:asgm:chats:${league}`
/** The conversation this browser had open last, per league; apart from the list, so two tabs never fight over it. */
const openKey = (league: string) => `ff:asgm:open:${league}`
/** Where one conversation per league was kept before there were many: read once, moved into the list, then removed. */
const legacyKey = (league: string) => `ff:asgm:chat:${league}`
const USE_KEY = 'ff:asgm:use'

/** A message fit to keep: finished (no step still running), and with nothing that only made sense mid-answer. */
const settled = (m: AsgmMessage): AsgmMessage =>
  m.role === 'gm' ? { ...m, steps: m.steps.map((s) => (s.status === 'running' ? { ...s, status: 'error' as const, detail: s.detail ?? 'stopped' } : s)) } : m

/** An answer cut off mid-way (the reader stopped it, or moved to another conversation): settled, and said to be stopped. */
export const stopped = (m: AsgmMessage): AsgmMessage => {
  const s = settled(m)
  return s.role === 'gm' && !s.error ? { ...s, error: { type: 'error', code: 'aborted', message: 'Stopped.' } } : s
}

/** The newest messages that fit both bounds, always starting on a question (never an answer cut from its own). */
export const bound = (msgs: AsgmMessage[], max = MAX_MESSAGES, chars = MAX_CHARS): AsgmMessage[] => {
  let out = msgs.slice(-max)
  let size = JSON.stringify(out).length
  while (out.length && size > chars) {
    size -= JSON.stringify(out[0]).length + 1
    out = out.slice(1)
  }
  while (out.length && out[0].role !== 'user') out = out.slice(1)
  return out
}

const isMessage = (x: unknown): x is AsgmMessage => {
  const m = x as AsgmMessage
  return !!m && typeof m === 'object' && typeof m.id === 'string' && (m.role === 'user' ? typeof m.text === 'string' : m.role === 'gm' && Array.isArray(m.steps) && Array.isArray(m.cards) && Array.isArray(m.actions))
}

/** A conversation's name: its first question on one line, cut at a word near 64 characters. */
export const titleOf = (text: string, max = 64) => {
  const t = text.replace(/\s+/g, ' ').trim()
  if (!t) return 'Untitled'
  if (t.length <= max) return t
  const cut = t.slice(0, max - 1)
  const at = cut.lastIndexOf(' ')
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:.\-–—]+$/, '')}…`
}

const firstQuestion = (msgs: AsgmMessage[]) => msgs.find((m): m is Extract<AsgmMessage, { role: 'user' }> => m.role === 'user')
const stamp = (m: AsgmMessage | undefined) => (m && typeof m.at === 'number' && Number.isFinite(m.at) ? m.at : 0)

/** A conversation made from its messages (the one kept before there were many, a fresh one as it is first asked in). */
export const convoFrom = (id: string, msgs: AsgmMessage[], now = Date.now()): AsgmConvo => ({
  id,
  title: titleOf(firstQuestion(msgs)?.text ?? ''),
  createdAt: stamp(msgs[0]) || now,
  updatedAt: stamp(msgs[msgs.length - 1]) || now,
  messages: msgs,
})

/** A stored conversation read back, or null when it is not one (or has nothing in it). */
const readConvo = (x: unknown): AsgmConvo | null => {
  const c = x as Partial<AsgmConvo>
  if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !Array.isArray(c.messages)) return null
  const messages = c.messages.filter(isMessage).map(settled)
  if (!messages.some((m) => m.role === 'user')) return null
  const made = convoFrom(c.id, messages)
  return {
    id: c.id,
    title: typeof c.title === 'string' && c.title.trim() ? c.title : made.title,
    createdAt: typeof c.createdAt === 'number' ? c.createdAt : made.createdAt,
    updatedAt: typeof c.updatedAt === 'number' ? c.updatedAt : made.updatedAt,
    messages,
  }
}

/** Newest first; ties by id, so every tab orders (and so writes) the same list the same way. */
const newestFirst = (list: AsgmConvo[]) => [...list].sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

/**
 * The book as it may be kept: every conversation settled and within bound(), empty ones gone, newest first, at most
 * `max` of them and `chars` characters in all, the oldest dropped first. The open conversation is never dropped (bound()
 * keeps it within MAX_CHARS, under the whole), nor any in `keep` (ones just put back with Undo).
 */
export const fitBook = (book: AsgmBook, max = MAX_CONVOS, chars = MAX_BOOK_CHARS, keep: Iterable<string> = []): AsgmBook => {
  const held = new Set(keep)
  if (book.current) held.add(book.current)
  const kept = newestFirst(book.list)
    .map((c) => ({ ...c, messages: bound(c.messages.map(settled)) }))
    .filter((c) => c.messages.length > 0)
  const fixed = kept.filter((c) => held.has(c.id))
  let rest = kept.filter((c) => !held.has(c.id)).slice(0, Math.max(0, max - fixed.length))
  const size = (c: AsgmConvo) => JSON.stringify(c).length + 1
  let total = fixed.reduce((n, c) => n + size(c), 0) + rest.reduce((n, c) => n + size(c), 0) + 40
  while (rest.length && total > chars) {
    total -= size(rest[rest.length - 1])
    rest = rest.slice(0, -1)
  }
  return { current: book.current, list: newestFirst([...fixed, ...rest]) }
}

/**
 * Two copies of a league's conversations as one: each conversation once, the copy last asked in winning (this tab's on
 * a tie), none that was deleted.
 */
export const mergeConvos = (mine: AsgmConvo[], theirs: AsgmConvo[], deleted: Iterable<string> = []): AsgmConvo[] => {
  const gone = new Set(deleted)
  const by = new Map<string, AsgmConvo>()
  for (const c of theirs) if (!gone.has(c.id)) by.set(c.id, c)
  for (const c of mine) {
    if (gone.has(c.id)) continue
    const other = by.get(c.id)
    if (!other || c.updatedAt >= other.updatedAt) by.set(c.id, c)
  }
  return newestFirst([...by.values()])
}

const parseBook = (raw: string): AsgmBook | null => {
  try {
    const x = JSON.parse(raw) as { current?: unknown; list?: unknown; deleted?: unknown }
    if (!x || typeof x !== 'object' || !Array.isArray(x.list)) return null
    const list = x.list.map(readConvo).filter((c): c is AsgmConvo => !!c)
    // Two with one id (a hand-edited store): the newer stands.
    const seen = new Set<string>()
    const unique = newestFirst(list).filter((c) => !seen.has(c.id) && !!seen.add(c.id))
    const deleted = Array.isArray(x.deleted) ? x.deleted.filter((d): d is string => typeof d === 'string') : []
    return { current: typeof x.current === 'string' ? x.current : null, list: unique.filter((c) => !deleted.includes(c.id)), deleted }
  } catch {
    return null
  }
}

const readOpen = (s: Storage, league: string, fallback: string | null) => {
  try {
    return s.getItem(openKey(league)) ?? fallback
  } catch {
    return fallback
  }
}

/**
 * A league's conversations, and the one this browser had open. The first time, the one conversation kept before there
 * were many becomes the open one in the list; its old key goes once the list is safely written (or whenever the list
 * is already there). Storage blocked or unreadable: none.
 */
export const loadBook = (league: string): AsgmBook => {
  try {
    const s = window.localStorage
    const raw = s.getItem(bookKey(league))
    if (raw != null) {
      s.removeItem(legacyKey(league))
      const b = parseBook(raw)
      return b ? { ...b, current: readOpen(s, league, b.current) } : { current: null, list: [] }
    }
    const old = s.getItem(legacyKey(league))
    if (old == null) return { current: null, list: [] }
    let msgs: AsgmMessage[] = []
    try {
      const xs = JSON.parse(old) as unknown
      msgs = Array.isArray(xs) ? xs.filter(isMessage).map(settled) : []
    } catch {
      // Unreadable: nothing to bring over.
    }
    const id = uid()
    const book: AsgmBook = msgs.some((m) => m.role === 'user') ? { current: id, list: [convoFrom(id, msgs)] } : { current: null, list: [] }
    if (!book.list.length) s.removeItem(legacyKey(league))
    else if (writeStored(bookKey(league), JSON.stringify({ list: fitBook(book).list, deleted: [] }))) {
      s.removeItem(legacyKey(league))
      writeStored(openKey(league), id)
    }
    return book
  } catch {
    return { current: null, list: [] }
  }
}

/** What a save needs to know beyond the list: what this tab deleted, what it put back since, and what not to trim. */
export type AsgmSaveOpts = { deleted?: Iterable<string>; revived?: Iterable<string>; keep?: Iterable<string> }

/**
 * Keeps a league's conversations: merged with what is stored (another tab's newer copies win, a conversation deleted in
 * any tab stays deleted, unless this one put it back), fitted to the bounds. Nothing is written when nothing changed, so
 * two tabs settle rather than answering each other's writes. Returns what was kept (also when storage is blocked, so
 * the visit holds the same).
 */
export const saveBook = (league: string, book: AsgmBook, opts: AsgmSaveOpts = {}): AsgmBook => {
  let s: Storage | null = null
  let raw: string | null = null
  try {
    s = window.localStorage
    raw = s.getItem(bookKey(league))
  } catch {
    s = null
  }
  const stored = (raw != null && parseBook(raw)) || { current: null, list: [], deleted: [] }
  const gone = new Set([...(stored.deleted ?? []), ...(opts.deleted ?? [])])
  for (const id of opts.revived ?? []) gone.delete(id)
  const fit = fitBook({ current: book.current, list: mergeConvos(book.list, stored.list, gone) }, MAX_CONVOS, MAX_BOOK_CHARS, opts.keep)
  const deleted = [...gone].sort().slice(-MAX_DELETED)
  if (s) {
    try {
      if (!fit.list.length && !deleted.length) s.removeItem(bookKey(league))
      else {
        const value = JSON.stringify({ list: fit.list, deleted })
        if (value !== raw) writeStored(bookKey(league), value)
      }
      if (book.current && fit.list.some((c) => c.id === book.current)) {
        if (s.getItem(openKey(league)) !== book.current) writeStored(openKey(league), book.current)
      } else s.removeItem(openKey(league))
    } catch {
      // Storage blocked: the conversations last this visit.
    }
  }
  return { ...fit, deleted }
}

/** What a delete took away, to put back with Undo: the conversations, whether one of them was open, and the league
 *  they belong to (Undo puts them back there or nowhere). */
export type AsgmRemoved = { convos: AsgmConvo[]; current: string | null; league: string | null }

/** Takes conversations out of the book. The open one going leaves a fresh one open, with the id `fresh`. */
export const removeConvos = (book: AsgmBook, ids: string[], fresh: string, league: string | null = null): { book: AsgmBook; removed: AsgmRemoved } => {
  const out = new Set(ids)
  const convos = book.list.filter((c) => out.has(c.id))
  const wasOpen = book.current != null && out.has(book.current)
  return {
    book: { current: wasOpen ? fresh : book.current, list: book.list.filter((c) => !out.has(c.id)) },
    removed: { convos, current: wasOpen ? book.current : null, league },
  }
}

/** Two deletes as one Undo: everything either took, and the open one if either took it. */
export const joinRemoved = (a: AsgmRemoved | null, b: AsgmRemoved): AsgmRemoved =>
  a && a.league === b.league ? { convos: [...a.convos, ...b.convos.filter((c) => !a.convos.some((x) => x.id === c.id))], current: a.current ?? b.current, league: b.league } : b

/** Undo: the conversations back in their places (by when they were last asked in), and the open one open again if
 *  nothing has been asked since in the fresh one that took its place. Given a league, only into that league. */
export const restoreConvos = (book: AsgmBook, removed: AsgmRemoved, league?: string | null): AsgmBook => {
  if (league !== undefined && removed.league !== league) return book
  const have = new Set(book.list.map((c) => c.id))
  const list = newestFirst([...book.list, ...removed.convos.filter((c) => !have.has(c.id))])
  const openIsEmpty = !book.list.some((c) => c.id === book.current)
  return { current: removed.current && openIsEmpty ? removed.current : book.current, list }
}

// ---- Reading the list ----

export type AsgmGroup = 'Today' | 'Yesterday' | 'Earlier this week' | 'Older'
const dayStart = (t: number) => {
  const d = new Date(t)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}
/** Calendar days between two times, in this browser's time zone (a daylight-saving day still counts as one). */
const daysAgo = (at: number, now: number) => Math.round((dayStart(now) - dayStart(at)) / 86_400_000)

/** Which part of the list a conversation sits in: today, yesterday, the five days before, or older. */
export const groupOf = (at: number, now = Date.now()): AsgmGroup => {
  const d = daysAgo(at, now)
  return d <= 0 ? 'Today' : d === 1 ? 'Yesterday' : d < 7 ? 'Earlier this week' : 'Older'
}

const time = (t: number) => {
  const d = new Date(t)
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?([AP])\.?M\.?/i, (_, x) => ` ${x.toUpperCase()}M`)
}

/** When a conversation was last asked in, as the list says it: "Today 3:12 PM", "Yesterday", "Tue", "Nov 14", "Nov 14, 2025". */
export const whenOf = (at: number, now = Date.now()) => {
  const d = daysAgo(at, now)
  if (d <= 0) return `Today ${time(at)}`
  if (d === 1) return 'Yesterday'
  if (d < 7) return new Date(at).toLocaleDateString([], { weekday: 'short' })
  const same = new Date(at).getFullYear() === new Date(now).getFullYear()
  return new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric', ...(same ? {} : { year: 'numeric' }) })
}

/** The questions asked in a conversation. */
export const questionsIn = (c: AsgmConvo) => c.messages.reduce((n, m) => n + (m.role === 'user' ? 1 : 0), 0)
/** What the first question was about (the page it was asked from), if anything. */
export const contextOf = (c: AsgmConvo) => firstQuestion(c.messages)?.context?.label ?? null

/** Does a conversation hold every word of the search, in its title, its questions, its answers or what they were about? */
export const matches = (c: AsgmConvo, q: string) => {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const hay = [c.title, ...c.messages.map((m) => (m.role === 'user' ? `${m.text} ${m.context?.label ?? ''}` : m.text))].join('\n').toLowerCase()
  return words.every((w) => hay.includes(w))
}

/** House (free) or the key saved in this browser. */
export type AsgmUse = 'house' | 'key'
export const loadUse = (): AsgmUse => {
  try {
    return window.localStorage.getItem(USE_KEY) === 'key' ? 'key' : 'house'
  } catch {
    return 'house'
  }
}
export const saveUse = (u: AsgmUse) => {
  try {
    window.localStorage.setItem(USE_KEY, u)
  } catch {
    // Storage blocked: the choice lasts this visit.
  }
}

/** "5 PM", "12:30 AM": when the free questions come back, in this browser's time. */
export const resetTime = (at: number) => {
  const d = new Date(at)
  return d.toLocaleTimeString([], { hour: 'numeric', minute: d.getMinutes() ? '2-digit' : undefined }).replace(/\s?([AP])\.?M\.?/i, (_, x) => ` ${x.toUpperCase()}M`)
}

/** The next 00:00 UTC, when the house's free questions come back. */
export const nextUtcMidnight = (now = Date.now()) => {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
}

/** An id for a message: unique in this browser. */
export const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
