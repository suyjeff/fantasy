import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_BOOK_CHARS,
  MAX_CHARS,
  MAX_CONVOS,
  MAX_DELETED,
  contextOf,
  convoFrom,
  fitBook,
  groupOf,
  joinRemoved,
  loadBook,
  matches,
  mergeConvos,
  questionsIn,
  removeConvos,
  restoreConvos,
  saveBook,
  stopped,
  titleOf,
  whenOf,
  type AsgmBook,
  type AsgmConvo,
} from '../../components/assistant/store'
import type { AsgmMessage } from '../assistant/types'
import { writeCached } from '../storage'

// Assistant GM's past conversations: many per league, kept within bounds, the old single one brought over.

const user = (id: string, text: string, at: number, context?: { view: string; label: string }): AsgmMessage => ({ role: 'user', id, text, at, ...(context ? { context } : {}) })
const gm = (id: string, text: string, at: number, running = false): AsgmMessage => ({
  role: 'gm',
  id,
  text,
  steps: [{ type: 'step', id: 's', tool: 't', label: 'l', status: running ? 'running' : 'done' }],
  cards: [],
  actions: [],
  at,
})
/** A conversation with `n` exchanges, last asked in at `at`. */
const convo = (id: string, at: number, n = 1, pad = 0): AsgmConvo =>
  convoFrom(
    id,
    Array.from({ length: n }, (_, i) => [user(`${id}u${i}`, `${id} question ${i}`, at - (n - 1 - i) * 10), gm(`${id}g${i}`, `answer ${'x'.repeat(pad)}`, at - (n - 1 - i) * 10 + 1)]).flat(),
  )

beforeEach(() => window.localStorage.clear())

describe('Assistant GM past conversations: migration', () => {
  it('brings the one stored conversation over as the open one, then drops the old key', () => {
    window.localStorage.setItem('ff:asgm:chat:L1', JSON.stringify([user('u1', '  Who do I start   at flex? ', 1000), gm('g1', 'Start Mason.', 2000, true)]))
    const b = loadBook('L1')
    expect(b.list).toHaveLength(1)
    expect(b.current).toBe(b.list[0].id)
    expect(b.list[0]).toMatchObject({ title: 'Who do I start at flex?', createdAt: 1000, updatedAt: 2000 })
    const a = b.list[0].messages[1]
    expect(a.role === 'gm' && a.steps[0].status).toBe('error')
    expect(window.localStorage.getItem('ff:asgm:chat:L1')).toBeNull()
    // And it stays: read again, the same conversation, from the new key.
    expect(loadBook('L1')).toMatchObject({ current: b.current, list: b.list })
  })
  it('keeps the old key when the new one cannot be written', () => {
    window.localStorage.setItem('ff:asgm:chat:L1', JSON.stringify([user('u1', 'q', 1)]))
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    const b = loadBook('L1')
    set.mockRestore()
    expect(b.list).toHaveLength(1)
    expect(window.localStorage.getItem('ff:asgm:chat:L1')).not.toBeNull()
  })
  it('drops an empty or unreadable old conversation', () => {
    window.localStorage.setItem('ff:asgm:chat:L1', '[]')
    expect(loadBook('L1')).toEqual({ current: null, list: [] })
    expect(window.localStorage.getItem('ff:asgm:chat:L1')).toBeNull()
    window.localStorage.setItem('ff:asgm:chat:L2', '{oops')
    expect(loadBook('L2').list).toEqual([])
  })
  it('drops the old key whenever the new list is already there', () => {
    saveBook('L1', { current: 'a', list: [convo('a', 5)] })
    window.localStorage.setItem('ff:asgm:chat:L1', JSON.stringify([user('u1', 'stale', 1)]))
    expect(loadBook('L1').list.map((c) => c.id)).toEqual(['a'])
    expect(window.localStorage.getItem('ff:asgm:chat:L1')).toBeNull()
  })
  it('leaves other leagues alone', () => {
    window.localStorage.setItem('ff:asgm:chat:L1', JSON.stringify([user('u1', 'q', 1)]))
    saveBook('L2', { current: 'b', list: [convo('b', 5)] })
    loadBook('L1')
    expect(loadBook('L2').list.map((c) => c.id)).toEqual(['b'])
  })
})

describe('Assistant GM past conversations: bounds and order', () => {
  it('lists newest first, by when each was last asked in', () => {
    const b = fitBook({ current: 'a', list: [convo('a', 100), convo('b', 300), convo('c', 200)] })
    expect(b.list.map((c) => c.id)).toEqual(['b', 'c', 'a'])
  })
  it('keeps the 30 most recent, and always the open one', () => {
    const list = Array.from({ length: 40 }, (_, i) => convo(`c${i}`, 1000 + i))
    const b = fitBook({ current: 'c0', list })
    expect(b.list).toHaveLength(MAX_CONVOS)
    expect(b.list[0].id).toBe('c39')
    expect(b.list.some((c) => c.id === 'c0')).toBe(true)
    expect(b.list.some((c) => c.id === 'c10')).toBe(false)
    expect(b.list.some((c) => c.id === 'c11')).toBe(true)
  })
  it('bounds each conversation as one was bounded before', () => {
    const big = convo('a', 5000, 30, 6000)
    const b = fitBook({ current: 'a', list: [big] })
    expect(JSON.stringify(b.list[0].messages).length).toBeLessThanOrEqual(MAX_CHARS)
    expect(b.list[0].messages[0].role).toBe('user')
    expect(b.list[0].title).toBe('a question 0')
  })
  it('keeps the whole under its character cap, dropping the oldest first', () => {
    const list = Array.from({ length: 12 }, (_, i) => convo(`c${i}`, 1000 + i, 10, 4000))
    const b = fitBook({ current: 'c0', list })
    expect(JSON.stringify(b).length).toBeLessThanOrEqual(MAX_BOOK_CHARS)
    expect(b.list.length).toBeLessThan(12)
    const ids = b.list.map((c) => c.id)
    expect(ids).toContain('c0')
    expect(ids).toContain('c11')
    // What went is the oldest of the rest, in order.
    const kept = ids.filter((x) => x !== 'c0').map((x) => Number(x.slice(1)))
    expect(Math.min(...kept)).toBe(12 - kept.length)
  })
  it('keeps conversations just put back, past the bounds, when asked', () => {
    const list = Array.from({ length: 31 }, (_, i) => convo(`c${i}`, 1000 + i))
    const b = fitBook({ current: 'c30', list }, MAX_CONVOS, MAX_BOOK_CHARS, ['c0'])
    expect(b.list.some((c) => c.id === 'c0')).toBe(true)
    expect(b.list.some((c) => c.id === 'c1')).toBe(false)
    expect(b.list).toHaveLength(MAX_CONVOS)
  })
  it('keeps the whole near the budget one conversation had before', () => {
    expect(MAX_BOOK_CHARS).toBeLessThanOrEqual(150_000)
    expect(MAX_BOOK_CHARS).toBeGreaterThanOrEqual(MAX_CHARS)
  })
  it('never keeps an empty conversation', () => {
    const empty: AsgmConvo = { id: 'e', title: 'x', createdAt: 1, updatedAt: 9, messages: [] }
    const only: AsgmConvo = { id: 'g', title: 'x', createdAt: 1, updatedAt: 9, messages: [gm('g1', 'orphan', 1)] }
    expect(fitBook({ current: 'e', list: [empty, only, convo('a', 5)] }).list.map((c) => c.id)).toEqual(['a'])
    saveBook('L1', { current: 'e', list: [empty] })
    expect(window.localStorage.getItem('ff:asgm:chats:L1')).toBeNull()
  })
  it('stays within the quota handling: a full store makes room by dropping cache', () => {
    // Through the cache's own writer, so lib/storage knows the entry is there to drop.
    writeCached('ff:v9:big', `{"t":1}${'x'.repeat(100)}`)
    const real = Storage.prototype.setItem
    let calls = 0
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      // Full until the cache entry is gone.
      if (k.startsWith('ff:asgm:') && window.localStorage.getItem('ff:v9:big') != null && calls++ < 5) throw new DOMException('full', 'QuotaExceededError')
      real.call(this, k, v)
    })
    saveBook('L1', { current: 'a', list: [convo('a', 5)] })
    set.mockRestore()
    expect(loadBook('L1').list.map((c) => c.id)).toEqual(['a'])
    expect(window.localStorage.getItem('ff:v9:big')).toBeNull()
  })
  it('returns what it kept even when storage is blocked, so the visit can drop the same', () => {
    const get = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('blocked')
    })
    const list = Array.from({ length: 35 }, (_, i) => convo(`c${i}`, i))
    expect(saveBook('L1', { current: 'c34', list }).list).toHaveLength(MAX_CONVOS)
    expect(loadBook('L1')).toEqual({ current: null, list: [] })
    get.mockRestore()
  })
})

describe('Assistant GM past conversations: two tabs', () => {
  it('merges on save: each tab keeps what the other added', () => {
    saveBook('L1', { current: 'a', list: [convo('a', 100)] })
    // A second tab, opened before the first asked anything, saves its own.
    const kept = saveBook('L1', { current: 'b', list: [convo('b', 200)] })
    expect(kept.list.map((c) => c.id)).toEqual(['b', 'a'])
    expect(loadBook('L1').list.map((c) => c.id)).toEqual(['b', 'a'])
  })
  it('keeps the copy last asked in', () => {
    const older = convo('a', 100, 1)
    const newer = convo('a', 300, 2)
    saveBook('L1', { current: 'a', list: [newer] })
    expect(saveBook('L1', { current: 'a', list: [older] }).list[0].messages).toHaveLength(4)
    expect(mergeConvos([newer], [older])[0]).toBe(newer)
    // A tie goes to this tab's copy.
    expect(mergeConvos([older], [{ ...older, title: 'theirs' }])[0]).toBe(older)
  })
  it('a conversation deleted in one tab stays deleted when another tab saves its stale copy', () => {
    saveBook('L1', { current: 'a', list: [convo('a', 100), convo('b', 200)] })
    saveBook('L1', { current: 'a', list: [convo('a', 100)] }, { deleted: ['b'] })
    expect(loadBook('L1').list.map((c) => c.id)).toEqual(['a'])
    expect(loadBook('L1').deleted).toEqual(['b'])
    const stale = saveBook('L1', { current: 'x', list: [convo('a', 100), convo('b', 200)] })
    expect(stale.list.map((c) => c.id)).toEqual(['a'])
    expect(loadBook('L1').list.map((c) => c.id)).toEqual(['a'])
  })
  it('undo in the deleting tab takes it off the deleted list', () => {
    saveBook('L1', { current: 'a', list: [convo('a', 100)] }, { deleted: ['b'] })
    saveBook('L1', { current: 'a', list: [convo('a', 100), convo('b', 200)] }, { revived: ['b'] })
    const b = loadBook('L1')
    expect(b.list.map((c) => c.id)).toEqual(['b', 'a'])
    expect(b.deleted).toEqual([])
  })
  it('remembers a bounded number of deletions', () => {
    saveBook('L1', { current: 'a', list: [convo('a', 1)] }, { deleted: Array.from({ length: MAX_DELETED + 50 }, (_, i) => `d${String(i).padStart(4, '0')}`) })
    expect(loadBook('L1').deleted).toHaveLength(MAX_DELETED)
  })
  it('writes nothing when nothing changed, so tabs settle', () => {
    const b: AsgmBook = { current: 'a', list: [convo('a', 100), convo('b', 200)] }
    saveBook('L1', b)
    const set = vi.spyOn(Storage.prototype, 'setItem')
    saveBook('L1', b)
    saveBook('L1', { current: 'a', list: [convo('b', 200), convo('a', 100)] })
    expect(set).not.toHaveBeenCalled()
    set.mockRestore()
  })
  it('keeps the open conversation per browser, apart from the shared list', () => {
    saveBook('L1', { current: 'b', list: [convo('a', 100), convo('b', 200)] })
    const raw = JSON.parse(window.localStorage.getItem('ff:asgm:chats:L1')!)
    expect(raw.current).toBeUndefined()
    expect(loadBook('L1').current).toBe('b')
    // A fresh, empty one open: nothing to reopen.
    saveBook('L1', { current: 'fresh', list: [convo('a', 100), convo('b', 200)] })
    expect(loadBook('L1').current).toBeNull()
  })
})

describe('Assistant GM past conversations: delete and undo', () => {
  const book: AsgmBook = { current: 'b', list: [convo('c', 300), convo('b', 200), convo('a', 100)] }
  it('deletes one, leaving the open one open', () => {
    const { book: after, removed } = removeConvos(book, ['a'], 'fresh')
    expect(after).toEqual({ current: 'b', list: [book.list[0], book.list[1]] })
    expect(removed).toEqual({ convos: [book.list[2]], current: null, league: null })
  })
  it('deleting the open one leaves a fresh one open, and undo opens it again', () => {
    const { book: after, removed } = removeConvos(book, ['b'], 'fresh')
    expect(after.current).toBe('fresh')
    expect(after.list.map((c) => c.id)).toEqual(['c', 'a'])
    const back = restoreConvos(after, removed)
    expect(back).toEqual(book)
  })
  it('undo puts it back in its place, but leaves open a conversation asked in since', () => {
    const { book: after, removed } = removeConvos(book, ['b'], 'fresh')
    const asked = { ...after, list: [convo('fresh', 400), ...after.list] }
    const back = restoreConvos(asked, removed)
    expect(back.current).toBe('fresh')
    expect(back.list.map((c) => c.id)).toEqual(['fresh', 'c', 'b', 'a'])
  })
  it('clears all, and undoes that too', () => {
    const { book: after, removed } = removeConvos(book, book.list.map((c) => c.id), 'fresh')
    expect(after).toEqual({ current: 'fresh', list: [] })
    expect(removed.convos).toHaveLength(3)
    expect(restoreConvos(after, removed)).toEqual(book)
  })
  it('never restores a conversation twice', () => {
    const { book: after, removed } = removeConvos(book, ['a'], 'fresh')
    const once = restoreConvos(after, removed)
    expect(restoreConvos(once, removed).list).toHaveLength(3)
  })
  it('round-trips through storage', () => {
    saveBook('L1', book)
    const { book: after } = removeConvos(loadBook('L1'), ['c'], 'fresh')
    saveBook('L1', after, { deleted: ['c'] })
    expect(loadBook('L1').list.map((c) => c.id)).toEqual(['b', 'a'])
  })
  it('joins repeated deletes into one undo, which puts them all back', () => {
    const one = removeConvos(book, ['a'], 'f1', 'L1')
    const two = removeConvos(one.book, ['b'], 'f2', 'L1')
    const both = joinRemoved(one.removed, two.removed)
    expect(both.convos.map((c) => c.id)).toEqual(['a', 'b'])
    expect(both.current).toBe('b')
    expect(restoreConvos(two.book, both, 'L1')).toEqual(book)
    // The same one twice is still one.
    expect(joinRemoved(both, one.removed).convos).toHaveLength(2)
  })
  it('never joins or restores across leagues', () => {
    const here = removeConvos(book, ['a'], 'f', 'L1').removed
    const there = removeConvos(book, ['c'], 'f', 'L2').removed
    expect(joinRemoved(here, there)).toBe(there)
    const other: AsgmBook = { current: 'x', list: [convo('x', 50)] }
    expect(restoreConvos(other, here, 'L2')).toBe(other)
    expect(restoreConvos(other, here, 'L1').list.map((c) => c.id)).toEqual(['a', 'x'])
  })
})

describe('Assistant GM past conversations: titles and rows', () => {
  it('names a conversation by its first question, trimmed and on one line', () => {
    expect(titleOf('  Should I\n\ntrade   Chase?  ')).toBe('Should I trade Chase?')
    expect(titleOf('')).toBe('Untitled')
    const long = 'Who should I start at flex this week given the injuries to my receivers and the matchup against the best defense'
    const t = titleOf(long)
    expect(t.length).toBeLessThanOrEqual(64)
    expect(t.endsWith('…')).toBe(true)
    expect(long.startsWith(t.slice(0, -1))).toBe(true)
    expect(t).not.toMatch(/\s…$/)
    // One long word is cut where it has to be.
    expect(titleOf('x'.repeat(100))).toBe(`${'x'.repeat(63)}…`)
  })
  it('keeps its title when its first question is bounded away', () => {
    const c = convo('a', 5000, 30, 6000)
    expect(fitBook({ current: 'a', list: [c] }).list[0].title).toBe('a question 0')
  })
  it('counts questions, and knows what the first one was about', () => {
    const c = convoFrom('a', [user('u', 'q', 1, { view: 'me', label: 'Week 11 lineup' }), gm('g', 'a', 2), user('u2', 'q2', 3)])
    expect(questionsIn(c)).toBe(2)
    expect(contextOf(c)).toBe('Week 11 lineup')
    expect(contextOf(convo('b', 1))).toBeNull()
  })
  it('groups by day: today, yesterday, earlier this week, older', () => {
    const now = new Date(2026, 10, 21, 15, 12).getTime()
    const at = (d: number, h = 12) => new Date(2026, 10, 21 - d, h).getTime()
    expect(groupOf(at(0, 0), now)).toBe('Today')
    expect(groupOf(at(1, 23), now)).toBe('Yesterday')
    expect(groupOf(at(1, 0), now)).toBe('Yesterday')
    expect(groupOf(at(2), now)).toBe('Earlier this week')
    expect(groupOf(at(6), now)).toBe('Earlier this week')
    expect(groupOf(at(7), now)).toBe('Older')
  })
  it('says when: a time today, yesterday, a weekday, then a date', () => {
    const now = new Date(2026, 10, 21, 18, 0).getTime()
    expect(whenOf(new Date(2026, 10, 21, 15, 12).getTime(), now)).toMatch(/^Today 3:12\sPM$/)
    expect(whenOf(new Date(2026, 10, 20, 9).getTime(), now)).toBe('Yesterday')
    expect(whenOf(new Date(2026, 10, 17, 9).getTime(), now)).toBe('Tue')
    expect(whenOf(new Date(2026, 10, 14, 9).getTime(), now)).toBe('Nov 14')
    expect(whenOf(new Date(2025, 10, 14, 9).getTime(), now)).toBe('Nov 14, 2025')
  })
  it('searches titles, questions, answers and context, every word', () => {
    const c = convoFrom('a', [user('u', 'Should I trade Chase?', 1, { view: 'trades', label: 'Trade builder' }), gm('g', 'Keep him. Sell Mason instead.', 2)])
    expect(matches(c, 'chase')).toBe(true)
    expect(matches(c, 'MASON sell')).toBe(true)
    expect(matches(c, 'builder')).toBe(true)
    expect(matches(c, 'chase waivers')).toBe(false)
    expect(matches(c, '  ')).toBe(true)
  })
  it('settles an answer cut off by a switch as stopped', () => {
    const m = stopped(gm('g', 'half', 1, true))
    expect(m.role === 'gm' && m.error?.code).toBe('aborted')
    expect(m.role === 'gm' && m.steps[0].status).toBe('error')
    const done = { ...gm('g', 'x', 1), error: { type: 'error' as const, code: 'quota' as const, message: 'out' } }
    expect(stopped(done)).toMatchObject({ error: { code: 'quota' } })
  })
})
