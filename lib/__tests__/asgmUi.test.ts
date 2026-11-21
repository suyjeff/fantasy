import { describe, expect, it, beforeEach } from 'vitest'
import { blocks, nameIndex, plain, spans } from '../../components/assistant/text'
import { bound, convoFrom, loadBook, nextUtcMidnight, saveBook, MAX_MESSAGES } from '../../components/assistant/store'
import { sectionContext } from '../../components/assistant/contexts'
import type { AsgmMessage } from '../assistant/types'
import type { Analysis } from '../analysis'

const players: Record<string, { name: string }> = {
  p1: { name: 'Jordan Mason' },
  p2: { name: "Ja'Marr Chase" },
  p3: { name: 'Deebo Samuel Sr.' },
  p4: { name: 'Jordan Love' },
  p5: { name: 'Josh Downs' },
  p6: { name: 'Kenneth Walker III' },
}
const teams = [
  { rosterId: 1, name: 'Wasian invasion' },
  { rosterId: 2, name: 'chode' },
]

describe('Assistant GM answer blocks', () => {
  it('splits the call, a list and a labelled risk line', () => {
    const b = blocks('Start Mason. Bench Downs.\n- Mason projects 14.2\n- Downs has a tough draw\nRisk: Mason is questionable.')
    expect(b).toEqual([
      { t: 'p', text: 'Start Mason. Bench Downs.' },
      { t: 'ul', items: ['Mason projects 14.2', 'Downs has a tough draw'] },
      { t: 'p', text: 'Mason is questionable.', label: 'Risk' },
    ])
  })
  it('joins wrapped lines into a paragraph or the list item above', () => {
    expect(blocks('one\ntwo\n\nthree')).toEqual([
      { t: 'p', text: 'one two' },
      { t: 'p', text: 'three' },
    ])
    expect(blocks('- first\n  carries on')).toEqual([{ t: 'ul', items: ['first carries on'] }])
  })
  it('reads numbered lists', () => {
    expect(blocks('1. a\n2) b')).toEqual([{ t: 'ul', items: ['a', 'b'] }])
  })
  it('drops bold markers when copied', () => {
    expect(plain('**Start** him')).toBe('Start him')
  })
})

describe('Assistant GM name linking', () => {
  const index = nameIndex(players, Object.keys(players), ['p1', 'p3', 'p5', 'p6'], teams)
  it('links full names, surnames of nearby players, and team names', () => {
    const s = spans('Start Mason over Josh Downs; Wasian invasion is weak at WR.', index)
    expect(s).toEqual([
      { t: 'text', s: 'Start ' },
      { t: 'player', id: 'p1', s: 'Mason' },
      { t: 'text', s: ' over ' },
      { t: 'player', id: 'p5', s: 'Josh Downs' },
      { t: 'text', s: '; ' },
      { t: 'team', id: 1, s: 'Wasian invasion' },
      { t: 'text', s: ' is weak at WR.' },
    ])
  })
  it('takes the surname before a suffix, and keeps apostrophes', () => {
    expect(spans('Samuel and Walker sit; Ja’Marr Chase starts.', index).filter((x) => x.t === 'player').map((x) => (x as { id: string }).id)).toEqual(['p3', 'p6', 'p2'])
  })
  it('never links a lowercase word or a name inside a word', () => {
    // Jordan Love is not near, so "Love" alone is not a link; "love" lowercase never is.
    expect(spans('I love Masonry and Love.', index).every((x) => x.t === 'text')).toBe(true)
  })
  it('leaves a surname shared by two nearby players alone', () => {
    const shared = nameIndex(players, Object.keys(players), ['p1', 'p4'], [])
    expect(spans('Jordan is fine', shared).every((x) => x.t === 'text')).toBe(true)
    expect(spans('Mason and Love', shared).filter((x) => x.t === 'player')).toHaveLength(2)
  })
  it('handles bold runs with names in them', () => {
    expect(spans('**Start Mason.** Then wait.', index)).toEqual([
      { t: 'bold', s: 'Start ' },
      { t: 'player', id: 'p1', s: 'Mason' },
      { t: 'bold', s: '.' },
      { t: 'text', s: ' Then wait.' },
    ])
  })
})

const user = (i: number, text = 'q'): AsgmMessage => ({ role: 'user', id: `u${i}`, text, at: i })
const gm = (i: number, text = 'a'): AsgmMessage => ({ role: 'gm', id: `g${i}`, text, steps: [{ type: 'step', id: 's', tool: 't', label: 'l', status: 'running' }], cards: [], actions: [], at: i })

describe('Assistant GM history', () => {
  beforeEach(() => window.localStorage.clear())
  it('keeps the newest messages, starting on a question', () => {
    const msgs = Array.from({ length: 30 }, (_, i) => [user(i), gm(i)]).flat()
    const b = bound(msgs, 5)
    expect(b[0].role).toBe('user')
    expect(b.length).toBeLessThanOrEqual(5)
    expect(b[b.length - 1].id).toBe('g29')
  })
  it('keeps within a character budget', () => {
    const msgs = Array.from({ length: 10 }, (_, i) => [user(i, 'x'.repeat(500)), gm(i, 'y'.repeat(500))]).flat()
    expect(JSON.stringify(bound(msgs, MAX_MESSAGES, 3000)).length).toBeLessThanOrEqual(3000)
  })
  it('round-trips per league, settling steps left running', () => {
    saveBook('L1', { current: 'c1', list: [convoFrom('c1', [user(1), gm(1)])] })
    saveBook('L2', { current: 'c2', list: [convoFrom('c2', [user(2)])] })
    const back = loadBook('L1')
    expect(back.current).toBe('c1')
    expect(back.list[0].messages.map((m) => m.id)).toEqual(['u1', 'g1'])
    const a = back.list[0].messages[1]
    expect(a.role === 'gm' && a.steps[0].status).toBe('error')
    expect(loadBook('L2').list[0].messages.map((m) => m.id)).toEqual(['u2'])
    // Deleting goes by name: a save merges with what is stored, so leaving one out of the list is not enough.
    saveBook('L1', { current: 'c1', list: [] }, { deleted: ['c1'] })
    expect(loadBook('L1').list).toEqual([])
  })
  it('ignores junk in storage', () => {
    window.localStorage.setItem('ff:asgm:chats:L3', '{"not":"a list"}')
    expect(loadBook('L3').list).toEqual([])
    window.localStorage.setItem('ff:asgm:chats:L3', '{"current":1,"list":[{"id":"x","messages":[{"role":"gm"},null,1]},null,"y"]}')
    expect(loadBook('L3')).toMatchObject({ current: null, list: [] })
    window.localStorage.setItem('ff:asgm:chats:L3', 'not json')
    expect(loadBook('L3').list).toEqual([])
  })
  it('knows when the free questions come back', () => {
    expect(new Date(nextUtcMidnight(Date.UTC(2026, 10, 18, 23, 59))).toISOString()).toBe('2026-11-19T00:00:00.000Z')
  })
})

describe('Assistant GM page context', () => {
  const analysis = { myRosterId: 2, teamById: { 1: { rosterId: 1, name: 'Wasian invasion' }, 2: { rosterId: 2, name: 'chode' } } } as unknown as Analysis
  it('names the page and its tab', () => {
    expect(sectionContext('trades', 'suggested', analysis, 11)).toEqual({ view: 'trades/suggested', label: 'Trades › Suggested trades' })
  })
  it('focuses your lineup, your waivers, or the team on screen', () => {
    expect(sectionContext('me', null, analysis, 11)?.focus).toEqual({ kind: 'lineup', rosterId: 2, week: 11, label: 'Week 11 lineup' })
    expect(sectionContext('waivers', 'moves', analysis, 11)?.focus?.kind).toBe('waivers')
    expect(sectionContext('teams', '1', analysis, 11)).toMatchObject({ label: 'Wasian invasion', focus: { kind: 'team', rosterId: 1 } })
  })
  it('has none on its own page', () => {
    expect(sectionContext('gm', null, analysis, 11)).toBeNull()
  })
})
