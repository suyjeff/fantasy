import { describe, expect, it } from 'vitest'
import { cardFloor, drawTradeCard, type CardFormat, type TextBox } from '../../components/tradeShareCard'
import { cardIssues } from '../../components/tradeShareCard'
import { DARK } from '../../components/shareCards'
import { graphemes, nameVariants, playerNameVariants, subVariants, type CardStat, type TradeCard } from '../tradeShare'

// The shorter ways of saying a name, and the card laid out over a matrix of trades on a stand-in canvas whose text is
// measured by a fixed table: the real fonts are checked in a browser, but every rule about room (nothing wider than
// its box, nothing under the floor, nothing on top of anything, nothing left off) holds for any widths, so it is held
// here for these.

describe('shorter names', () => {
  it('drops "The", then words, then goes to initials and the first word', () => {
    expect(nameVariants('The Mahomes Alone Crew')).toEqual(['The Mahomes Alone Crew', 'Mahomes Alone Crew', 'Mahomes Alone…', 'MAC', 'Mahomes…'])
    expect(nameVariants('Emillionaires')).toEqual(['Emillionaires'])
  })
  it('never ends a shortened name on a little word or a dangling mark', () => {
    for (const v of nameVariants('The Extraordinarily Long Team Name Of Destiny')) expect(v).not.toMatch(/\b(of|the|and)…$|[\s,.:·-]…$/i)
    expect(nameVariants('Show Me Your TDs Please!!')).toContain('Show Me Your…')
  })
  it('keeps emoji and other scripts whole', () => {
    const goat = nameVariants('🐐🐐 GOAT Squad 🐐🐐')
    expect(goat[0]).toBe('🐐🐐 GOAT Squad 🐐🐐')
    for (const v of goat) expect(v).not.toMatch(/\uD83D(?![\uDC00-\uDFFF])/)
    expect(nameVariants('Медведи из Москвы')).toContain('МИМ')
    expect(graphemes('👨‍👩‍👧 Fam')).toHaveLength(5)
  })
  it('initials a player’s first name, then keeps the surname alone', () => {
    expect(playerNameVariants('Amon-Ra St. Brown')).toEqual(['Amon-Ra St. Brown', 'A. St. Brown', 'St. Brown'])
    expect(playerNameVariants('Deebo Samuel Sr.')).toEqual(['Deebo Samuel Sr.', 'D. Samuel Sr.', 'Samuel'])
    expect(playerNameVariants('A.J. Brown')).toEqual(['A.J. Brown', 'Brown'])
    expect(playerNameVariants('Nacua')).toEqual(['Nacua'])
  })
  it('shortens a figure’s note by its last part, keeping parts that carry a figure', () => {
    expect(subVariants('48% → 60% · title +3.0 pt')[1]).toBe('48% → 60%')
    const league = subVariants('lineup · better 8 of 11 wks')
    expect(league.indexOf('better 8 of 11 wks')).toBeLessThan(league.indexOf('lineup'))
    expect(subVariants('better 10 of 11 weeks')).toContain('better 10 of 11 wks')
    expect(subVariants('St. Brown: down week: 4.2 vs 14.0 expected')).toContain('St. Brown: down week')
  })
})

// ---- A canvas that measures by table ----

const EMOJI = /\p{Extended_Pictographic}/u
const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u
const fakeCanvas = () => {
  let px = 10
  let mono = false
  let spacing = 0
  const ctx: Record<string, unknown> = {
    measureText: (t: string) => ({
      width: graphemes(t).reduce((a, g) => a + spacing + px * (EMOJI.test(g) || WIDE.test(g) ? 1 : mono ? 0.6 : g === ' ' ? 0.28 : /[A-Z0-9]/.test(g) ? 0.62 : 0.52), 0),
    }),
  }
  const proxy = new Proxy(ctx, {
    get: (o, k) => (k in o ? o[k as string] : () => {}),
    set: (o, k, v) => {
      if (k === 'font') {
        px = Number(/(\d+)px/.exec(v)?.[1] ?? 10)
        mono = /Chivo Mono/.test(v.split('px')[1] ?? '')
      }
      if (k === 'letterSpacing') spacing = parseFloat(v) || 0
      o[k as string] = v
      return true
    },
  })
  return { width: 0, height: 0, getContext: () => proxy } as unknown as HTMLCanvasElement
}

// ---- The matrix ----

const NAMES = {
  short: ['Emillionaires', 'chode', 'bababanik', 'visheshshah00'],
  long: ['The Extraordinarily Long Team Name Of Destiny', 'Show Me Your TDs Please!!', 'Mahomes Alone In The Dark', 'Ja’Marr Of The Worlds 2025'],
  intl: ['東京ドラゴンズ・ファンタジー', '🐐🐐 GOAT Squad 🐐🐐', 'Медведи из Москвы', 'Équipe Señor Ñandú'],
}
const PLAYERS = ['Christian McCaffrey', 'Justin Jefferson', 'Amon-Ra St. Brown', 'Saquon Barkley', 'Christopher Brownington-Smythe', 'Deebo Samuel Sr.', 'A.J. Brown', 'Jaxon Smith-Njigba']
const SHAPES: Record<string, { counts: number[]; faab?: number[]; league?: boolean }> = {
  one: { counts: [1, 1] },
  two: { counts: [2, 2] },
  threeOne: { counts: [3, 1] },
  fiveFour: { counts: [5, 4] },
  faabOnly: { counts: [1, 0], faab: [0, 25] },
  three: { counts: [2, 1, 1] },
  four: { counts: [1, 2, 1, 1], faab: [0, 0, 0, 5] },
  max: { counts: [15, 15] },
  league: { counts: [2, 1], faab: [0, 10], league: true },
}
const ALL: CardStat[] = [
  { key: 'lineup', label: 'Lineup', value: '+3.4', unit: 'pts/wk', sub: 'better 10 of 11 weeks', tone: 'pos' },
  { key: 'odds', label: 'Playoff odds', value: '+11.6', unit: 'pt', sub: '48% → 60% · title +3.0 pt', tone: 'pos' },
  { key: 'need', label: 'Fills FLEX', value: '8.5 → 16.1', unit: 'pts', sub: 'this week’s starter', tone: 'pos' },
  { key: 'value', label: 'Consensus value', value: '+1.8', unit: '/wk', sub: 'by expert rankings', tone: 'pos' },
  { key: 'momentum', label: 'Timing', value: 'Buy low', unit: null, sub: 'St. Brown: down week: 4.2 vs 14.0 expected', tone: 'pos' },
]
const NOTE = 'Open to swapping Walker for your WR3 if you want a bit more upside here. Let me know soon!!'

const makeCard = (shape: string, names: keyof typeof NAMES, blocks: 'all' | 'one' | 'none', note: boolean): TradeCard => {
  const s = SHAPES[shape]
  const N = NAMES[names]
  const n = s.counts.length
  let k = 0
  const sides = s.counts.map((c, i) => ({
    rosterId: i + 1,
    head: `${N[i]} gets`,
    avatar: null,
    focus: !s.league && i === 0,
    faab: s.faab?.[i] ?? 0,
    players: Array.from({ length: c }, () => {
      const name = PLAYERS[k % PLAYERS.length]
      return { id: `p${k++}`, name, pos: 'WR', team: 'DET', ppw: 12.3, tag: blocks !== 'none' && k === 1 ? ('buy low' as const) : null, from: n > 2 ? N[(i + 1) % n] : null }
    }),
  }))
  const stats = s.league
    ? blocks === 'none'
      ? []
      : sides.map((_, i): CardStat => ({ key: 'lineup', label: N[i], value: i ? '−0.6' : '+1.9', unit: '/wk', sub: 'lineup · better 8 of 11 wks', tone: i ? 'neg' : 'pos' }))
    : blocks === 'all'
      ? ALL.filter((x) => n === 2 || x.key !== 'odds')
      : blocks === 'one'
        ? ALL.slice(0, 1)
        : []
  return {
    v: 1,
    kind: s.league ? 'league' : 'pitch',
    league: 'NYC Fantasy Football',
    leagueId: '1',
    season: '2026',
    week: 10,
    provider: 'sleeper',
    to: s.league ? null : N[0],
    from: N[1],
    sides,
    stats,
    strip: blocks === 'all' && !s.league ? [1.2, 2.8, -0.4, 2.2, 4.0].map((delta, i) => ({ week: 10 + i, delta })) : null,
    net: blocks === 'all' && !s.league ? 2.3 : null,
    note: note ? NOTE : null,
    deal: { moves: [], faab: [] },
  }
}

const draw = (card: TradeCard, format: CardFormat) => {
  const audit: TextBox[] = []
  const trace: string[] = []
  drawTradeCard(fakeCanvas(), card, format, DARK, { audit, trace })
  return { audit, trace, texts: audit.map((t) => t.text) }
}

/** What the card should say and does not: a side's head, a player (unless counted in a "+N"), a figure, the note. */
const missing = (card: TradeCard, texts: string[]) => {
  const out: string[] = []
  const heads = texts.filter((t) => / (GETS|SENDS)$/.test(t) || t === 'GETS').length
  if (heads < card.sides.length) out.push(`heads ${heads}`)
  const more = texts.map((t) => /^\+(\d+)( MORE)?$/.exec(t)).reduce((a, m) => a + (m ? Number(m[1]) : 0), 0)
  const items = card.sides.reduce((a, s) => a + s.players.length + (s.faab ? 1 : 0), 0)
  // Several players share a name here, so they are counted by how many rows name one.
  const rows = texts.filter((t) => PLAYERS.some((p) => playerNameVariants(p).includes(t) || (t.endsWith('…') && p.includes(t.slice(0, 3))))).length
  const faab = card.sides.filter((s) => s.faab && texts.includes(`$${s.faab}`)).length
  if (rows + faab + more < items) out.push(`players ${rows}+${faab}+${more} of ${items}`)
  const figMore = texts.map((t) => /^\+(\d+) (MORE )?FIGURES$/.exec(t)).reduce((a, m) => a + (m ? Number(m[1]) : 0), 0)
  if (card.stats.filter((s) => texts.includes(s.value)).length + figMore < card.stats.length) out.push('figures')
  if (card.note && !texts.some((t) => t.startsWith('“'))) out.push('note')
  return out
}

describe('the card, over the matrix', () => {
  const formats: CardFormat[] = ['square', 'og', 'story']
  for (const shape of Object.keys(SHAPES))
    for (const names of Object.keys(NAMES) as (keyof typeof NAMES)[])
      it(`${shape}, ${names} names: fits, reads and says everything`, () => {
        for (const blocks of ['all', 'one', 'none'] as const)
          for (const note of [false, true])
            for (const f of formats) {
              const card = makeCard(shape, names, blocks, note)
              const { audit, texts } = draw(card, f)
              const label = `${shape}/${names}/${blocks}${note ? '/note' : ''}/${f}`
              expect(cardIssues(audit, f), label).toEqual([])
              expect(missing(card, texts), label).toEqual([])
            }
      })
})

describe('the layout it chooses', () => {
  it('gives every name on a side the same form, cutting one only when its surname alone will not fit', () => {
    for (const f of ['square', 'og', 'story'] as const) {
      const card = makeCard('max', 'short', 'all', true)
      const { audit } = draw(card, f)
      // Rows of one side share a box height and sit in its column; group names by the side whose head precedes them.
      const names = audit.filter((t) => PLAYERS.some((p) => playerNameVariants(p).includes(t.text) || (t.text.endsWith('…') && p.includes(t.text.slice(0, 3)))))
      const forms = new Set(
        names
          .filter((t) => !t.text.endsWith('…'))
          .map((t) => {
            const p = PLAYERS.find((q) => playerNameVariants(q).includes(t.text))!
            const v = playerNameVariants(p)
            return t.text === v[0] && v.length > 1 && t.text !== v[v.length - 1] ? 'whole' : t.text === v[v.length - 1] ? 'surname' : 'initialled'
          }),
      )
      expect(forms.size, f).toBeLessThanOrEqual(1)
    }
  })

  it('sets two sides one above the other on the square, and as panels or columns, never a ledger, on the wide card', () => {
    const card = makeCard('one', 'short', 'one', false)
    expect(draw(card, 'og').trace.find((t) => t.startsWith('sides'))).toMatch(/^sides (cols|stack)/)
    expect(draw(card, 'square').trace.find((t) => t.startsWith('sides'))).toMatch(/^sides stack/)
  })
  it('never sets three or four teams in narrow columns: rows per team instead', () => {
    for (const shape of ['three', 'four'])
      for (const f of ['square', 'og', 'story'] as const) expect(draw(makeCard(shape, 'long', 'all', false), f).trace.find((t) => t.startsWith('sides'))).toMatch(/^sides (stack|ledger)/)
  })
  it('draws a small trade larger when the card has room, the floor rising with it', () => {
    const { audit, trace } = draw(makeCard('one', 'short', 'none', false), 'square')
    expect(trace.find((t) => t.startsWith('sides'))).toMatch(/zoom1\.\d/)
    const name = audit.find((t) => t.text.includes('McCaffrey'))!
    expect(name.px).toBeGreaterThan(cardFloor('square').px * 1.2)
  })
  it('keeps every word at the floor or above on every size, the floor being 9px at thumbnail size', () => {
    for (const f of ['square', 'og', 'story'] as const) {
      const { px, thumb } = cardFloor(f)
      expect((px * thumb) / (f === 'og' ? 1200 : 1080)).toBeGreaterThanOrEqual(8.9)
    }
  })
  it('says how many more there are rather than shrinking a big trade past reading', () => {
    const { texts } = draw(makeCard('max', 'short', 'all', true), 'square')
    expect(texts.some((t) => /^\+\d+( MORE)?$/.test(t))).toBe(true)
  })
  it('draws the week strip where it has room, and gives it up before any figure', () => {
    expect(draw(makeCard('one', 'short', 'all', false), 'story').trace.some((t) => t.startsWith('strip'))).toBe(true)
    const { trace } = draw(makeCard('max', 'short', 'all', true), 'square')
    expect(trace.some((t) => t.startsWith('stats'))).toBe(true)
  })
})
