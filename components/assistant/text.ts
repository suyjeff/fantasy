// Assistant GM's words, made into the app's own: the answer split into paragraphs and lists, and every player or team
// it names turned into the linked name the rest of the app uses. Pure, so it is tested on its own
// (lib/__tests__/asgmUi.test.ts).

/** A run of an answer: plain words, a bold run, or a name to link. */
export type Span = { t: 'text'; s: string } | { t: 'bold'; s: string } | { t: 'player'; id: string; s: string } | { t: 'team'; id: number; s: string }

/** A block of an answer: a paragraph, a bulleted list, or a lead-in line ("Risk: …") whose label is set apart. */
export type Block = { t: 'p'; text: string; label?: string } | { t: 'ul'; items: string[] }

/** Words that open a line as a label in the GM's voice. Set in mono caps, like the app's labels. */
const LABEL = /^(Risk|Why|Watch|Note|Caveat|Bottom line|Next|Floor|Ceiling|Odds|Verdict)\s*:\s+/i

/** Paragraphs on blank lines, list items on "- ", "* " or "1. ", and a lone line starting "Risk:" as a labelled line. */
export const blocks = (text: string): Block[] => {
  const out: Block[] = []
  let para: string[] = []
  let list: string[] | null = null
  const flushPara = () => {
    if (para.length) {
      const joined = para.join(' ').trim()
      const m = LABEL.exec(joined)
      // The words after a label start a sentence: "Risk: this is…" reads "RISK This is…".
      const rest = m ? joined.slice(m[0].length) : ''
      out.push(m ? { t: 'p', text: rest.charAt(0).toUpperCase() + rest.slice(1), label: m[1] } : { t: 'p', text: joined })
    }
    para = []
  }
  const flushList = () => {
    if (list?.length) out.push({ t: 'ul', items: list })
    list = null
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const item = /^(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line)
    if (!line) {
      flushPara()
      flushList()
    } else if (item) {
      flushPara()
      ;(list ??= []).push(item[1])
    } else if (LABEL.test(line)) {
      // A labelled line stands alone, even right under a list or another line.
      flushPara()
      flushList()
      para.push(line)
      flushPara()
    } else if (list) {
      // A line under a list item continues it.
      list[list.length - 1] += ` ${line}`
    } else para.push(line)
  }
  flushPara()
  flushList()
  return out
}

export type NameIndex = { re: RegExp | null; lookup: Map<string, { t: 'player'; id: string } | { t: 'team'; id: number }> }

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const norm = (s: string) => s.toLowerCase().replace(/[’']/g, "'")

/**
 * The names an answer may mention. Full player and team names always link. A surname alone ("Start Pacheco") links
 * only when exactly one of the players `near` (your roster, the cards, what you are looking at) has it, so a common
 * surname never links to the wrong man.
 */
export const nameIndex = (
  players: Record<string, { name: string } | undefined>,
  ids: Iterable<string>,
  near: Iterable<string>,
  teams: { rosterId: number; name: string }[],
): NameIndex => {
  const lookup: NameIndex['lookup'] = new Map()
  for (const id of ids) {
    const n = players[id]?.name
    if (n && n.length >= 4 && !lookup.has(norm(n))) lookup.set(norm(n), { t: 'player', id })
  }
  const bySurname = new Map<string, string[]>()
  for (const id of new Set(near)) {
    const n = players[id]?.name
    if (!n) continue
    const parts = n.split(/\s+/)
    // "Jr." and "III" are not surnames: take the word before them.
    const last = parts.filter((w) => !/^(jr\.?|sr\.?|ii|iii|iv|v)$/i.test(w)).pop()
    if (!last || last.length < 3 || parts.length < 2) continue
    const k = norm(last)
    bySurname.set(k, [...(bySurname.get(k) ?? []), id])
  }
  for (const [k, list] of bySurname) if (list.length === 1 && !lookup.has(k)) lookup.set(k, { t: 'player', id: list[0] })
  for (const t of teams) if (t.name.length >= 3 && !lookup.has(norm(t.name))) lookup.set(norm(t.name), { t: 'team', id: t.rosterId })
  const keys = [...lookup.keys()].sort((a, b) => b.length - a.length)
  // Whole words only: a name inside a longer word ("Moore" in "Moored") is not a mention.
  const re = keys.length ? new RegExp(`(?<![\\p{L}\\p{N}'’])(${keys.map((k) => escape(k).replace(/'/g, "['’]")).join('|')})(?![\\p{L}\\p{N}])`, 'giu') : null
  return { re, lookup }
}

/** One line of an answer as spans: **bold** runs, and the names in `index` as links. */
export const spans = (text: string, index: NameIndex | null): Span[] => {
  const out: Span[] = []
  const push = (s: string, bold: boolean) => {
    if (!s) return
    if (!index?.re) return out.push(bold ? { t: 'bold', s } : { t: 'text', s })
    index.re.lastIndex = 0
    let at = 0
    for (let m = index.re.exec(s); m; m = index.re.exec(s)) {
      const hit = index.lookup.get(norm(m[1]))
      // A player's name is written capitalised; "love" in a sentence is not Jordan Love.
      if (!hit || (hit.t === 'player' && !/^\p{Lu}/u.test(m[1]))) continue
      if (m.index > at) out.push(bold ? { t: 'bold', s: s.slice(at, m.index) } : { t: 'text', s: s.slice(at, m.index) })
      out.push(hit.t === 'player' ? { t: 'player', id: hit.id, s: m[1] } : { t: 'team', id: hit.id, s: m[1] })
      at = m.index + m[1].length
    }
    if (at < s.length) out.push(bold ? { t: 'bold', s: s.slice(at) } : { t: 'text', s: s.slice(at) })
  }
  const parts = text.split(/\*\*(.+?)\*\*/g)
  parts.forEach((p, i) => push(p, i % 2 === 1))
  return out
}

/** The answer as plain text, for copying and for screen readers: list items keep their dashes, bold its words. */
export const plain = (text: string) => text.replace(/\*\*(.+?)\*\*/g, '$1').trim()
