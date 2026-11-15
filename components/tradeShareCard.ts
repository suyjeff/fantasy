import { graphemes, nameVariants, playerNameVariants, subVariants, type CardSide, type CardStat, type TradeCard } from '../lib/tradeShare'
import type { TrimmedPlayer } from '../lib/types'
import { DARK, LIGHT, loadImage, readPalette, rgb, type Palette } from './shareCards'
import { playerImage } from './ui'

// The trade card, drawn on a canvas so it is the same picture on every device. Three sizes: a square for chats, the
// 1200×630 link preview, and a tall one for stories. Drawing is synchronous and takes a few milliseconds, so the share
// sheet redraws its preview on every change; the pictures (headshots, team avatars) are fetched once and kept, and a
// draw before they arrive leaves a plain tile in their place.
//
// The look is quiet on purpose: one face for words and one for figures, regular and medium weights, hierarchy from
// size and colour, hairlines rather than boxes, and the accent kept to one job (the recipient's side). Every line sits
// on one grid of margins, so the content is a single column, centred between the heading and the foot.
//
// Most people see the card small, a chat thumbnail about 320px wide. So no word goes under the size's floor (about
// 9px at that width), and a full card says less rather than smaller: names give up their first names, a figure its
// note, rows their faces, then they pack into two columns, and past that a side says how many more there are. Every
// row of a card is set alike (one form for every name, points a week on all or none). What the sender chose is kept
// in this order: every figure, then the week-by-week strip (always one of the figures: a tile, or a row under them),
// then the whole note, which is the first to give way, to one line. A label is never cut: it takes a shorter form.
// The layout is chosen by trying each way of setting each block, fullest first, and keeping the best set that fits.

export type CardFormat = 'square' | 'og' | 'story'
export const FORMATS: Record<CardFormat, { w: number; h: number; label: string; hint: string }> = {
  square: { w: 1080, h: 1080, label: 'Square', hint: '1080×1080 · chats' },
  og: { w: 1200, h: 630, label: 'Wide', hint: '1200×630 · link preview' },
  story: { w: 1080, h: 1350, label: 'Tall', hint: '1080×1350 · stories' },
}
export type CardTheme = 'app' | 'dark' | 'light'
export const paletteOf = (theme: CardTheme): Palette => (theme === 'dark' ? DARK : theme === 'light' ? LIGHT : readPalette())

const EMOJI = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"'
const SANS = `"IBM Plex Sans", system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Noto Sans CJK JP", sans-serif, ${EMOJI}`
const MONO = `"Chivo Mono", ui-monospace, Menlo, Consolas, monospace, ${EMOJI}`

// ---- Pictures and fonts, fetched once ----

const pictures = new Map<string, HTMLImageElement | null>()
const pending = new Map<string, Promise<HTMLImageElement | null>>()

const playerSrc = (id: string, pos: string) => playerImage(id, { pos } as TrimmedPlayer)

/** Every picture a card draws. */
export const cardSources = (card: TradeCard) => [
  ...card.sides.flatMap((s) => s.players.map((p) => playerSrc(p.id, p.pos))),
  ...card.sides.map((s) => s.avatar ?? null).filter((x): x is string => !!x),
]

/** Fetches what is not here yet; resolves once every one has landed or failed. */
export const loadPictures = (srcs: string[]) =>
  Promise.all(
    srcs.map((src) => {
      if (pictures.has(src)) return pictures.get(src)
      let p = pending.get(src)
      if (!p) {
        p = loadImage(src).then((img) => {
          pictures.set(src, img)
          pending.delete(src)
          return img
        })
        pending.set(src, p)
      }
      return p
    }),
  ).then(() => undefined)

/** Whether every picture is already here, so a draw now is the finished card. */
export const picturesReady = (srcs: string[]) => srcs.every((s) => pictures.has(s))

let fontsReady: Promise<void> | null = null
/** The card's faces and cuts, asked for once (they load on first use), then whatever the page has. */
export const loadCardFonts = () => {
  if (!fontsReady) {
    const sample = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 +−–·→↔$/.,:’“”…'
    fontsReady = Promise.all([...['400', '500'].map((w) => document.fonts.load(`${w} 40px "IBM Plex Sans"`, sample)), ...['400', '500'].map((w) => document.fonts.load(`${w} 40px "Chivo Mono"`, sample))])
      .then(() => document.fonts.ready)
      .then(() => undefined)
      .catch(() => undefined)
  }
  return fontsReady
}

// ---- The scale ----

/** One size's measures, on an 8px grid (`u`). No word is under `min`, which is about 9px when the card is `thumb` wide. */
type Spec = {
  W: number
  H: number
  /** The margin on every side: nothing is drawn in it but the ground. */
  pad: number
  u: number
  min: number
  thumb: number
  title: number
  titleMin: number
  titleLines: number
  name: number
  value: number
  face: number
  note: number
  noteLines: number
  wide: boolean
}
const SQUARE: Spec = { W: 1080, H: 1080, pad: 72, u: 8, min: 32, thumb: 320, title: 60, titleMin: 46, titleLines: 2, name: 42, value: 60, face: 80, note: 34, noteLines: 3, wide: false }
const SPECS: Record<CardFormat, Spec> = {
  square: SQUARE,
  story: { ...SQUARE, H: 1350, title: 64 },
  og: { W: 1200, H: 630, pad: 48, u: 8, min: 32, thumb: 360, title: 50, titleMin: 40, titleLines: 1, name: 36, value: 48, face: 64, note: 32, noteLines: 2, wide: true },
}
/** The least a word may be on a card of this size, and the width it is judged at: for the tests and the sheet. */
export const cardFloor = (format: CardFormat) => ({ px: SPECS[format].min, thumb: SPECS[format].thumb, pad: SPECS[format].pad })

// ---- Colour ----

const lum = (t: string) => {
  const [r, g, b] = t.split(',').map((v) => {
    const c = Number(v) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m)
  return (x + 0.05) / (y + 0.05)
}
const mixT = (a: string, b: string, t: number) => {
  const x = a.split(',').map(Number)
  const y = b.split(',').map(Number)
  return x.map((v, i) => Math.round(v + (y[i] - v) * t)).join(',')
}
/**
 * The palette with every ink readable on the card's ground (4.5:1, the body-text bar, since a thumbnail makes all of
 * it small): a theme whose muted grey or accent is too faint is stepped toward its text colour until it is not.
 */
const legible = (p: Palette): Palette => {
  const out = { ...p }
  for (const k of ['text2', 'muted', 'pos', 'neg', 'accent'] as const) {
    let t = 0
    while (contrast(out[k], p.panel) < 4.5 && t < 1) out[k] = mixT(p[k], p.text, (t += 0.1))
  }
  return out
}

// ---- Drawing, with a record of every word ----

type Ctx = CanvasRenderingContext2D
type Rect = { x: number; y: number; w: number; h: number }
type Font = { px: number; w?: number; mono?: boolean; track?: number }

/** Where a word was drawn and the room it was given: the overflow check reads these (`cardIssues`). */
export type TextBox = { text: string; x: number; y: number; w: number; h: number; px: number; box: Rect; what: string }

const fontOf = (f: Font) => `${f.w ?? 400} ${Math.round(f.px)}px ${f.mono ? MONO : SANS}`
/** Capital height and the depth under the baseline, as fractions of the size: for setting text by its baseline. */
const CAP = 0.7
const DESC = 0.22

type Pen = ReturnType<typeof makePen>
const makePen = (ctx: Ctx, audit?: TextBox[]) => {
  const cache = new Map<string, number>()
  const set = (f: Font) => {
    ctx.font = fontOf(f)
    ;(ctx as Ctx & { letterSpacing?: string }).letterSpacing = `${f.track ?? 0}px`
  }
  /** The width a string takes, without the spacing after its last letter. */
  const width = (text: string, f: Font) => {
    const key = `${f.px}|${f.w ?? 400}|${f.mono ? 1 : 0}|${f.track ?? 0}|${text}`
    let w = cache.get(key)
    if (w == null) {
      set(f)
      w = Math.max(0, ctx.measureText(text).width - (text ? (f.track ?? 0) : 0))
      if (cache.size > 4000) cache.clear()
      cache.set(key, w)
    }
    return w
  }
  /** Cut to a width by whole characters, with an ellipsis. */
  const cut = (text: string, f: Font, max: number) => {
    if (width(text, f) <= max) return text
    const g = graphemes(text)
    let lo = 0
    let hi = g.length
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      if (width(`${g.slice(0, mid).join('').trimEnd()}…`, f) <= max) lo = mid
      else hi = mid - 1
    }
    return lo ? `${g.slice(0, lo).join('').trimEnd().replace(/[\s,.:;·\-–—&+]+$/, '')}…` : ''
  }
  /** The first of the ways to say it that fits, or the last cut to fit. */
  const first = (ways: string[], f: Font, max: number) => ways.find((t) => width(t, f) <= max) ?? cut(ways[ways.length - 1] ?? '', f, max)
  /** Draws a line of text on a baseline; returns its width. */
  const put = (text: string, x: number, base: number, f: Font, colour: string, box: Rect, align: CanvasTextAlign = 'left', what = 'text') => {
    if (!text) return 0
    set(f)
    ctx.fillStyle = colour
    ctx.textAlign = align
    ctx.fillText(text, x, base)
    ctx.textAlign = 'left'
    const w = width(text, f)
    const x0 = align === 'left' ? x : align === 'right' ? x - w : x - w / 2
    audit?.push({ text, x: x0, y: base - f.px * CAP, w, h: f.px * (CAP + DESC), px: f.px, box, what })
    return w
  }
  /** Words wrapped to a width in at most `max` lines, the last cut with an ellipsis if the rest will not go. */
  const wrap = (text: string, f: Font, w: number, max: number) => {
    const lines: string[] = []
    let cur = ''
    for (const word of text.split(' ')) {
      const next = cur ? `${cur} ${word}` : word
      if (width(next, f) <= w || !cur) cur = next
      else {
        lines.push(cur)
        cur = word
      }
    }
    if (cur) lines.push(cur)
    if (lines.length > max) {
      const kept = lines.slice(0, max)
      kept[max - 1] = cut(`${kept[max - 1]} ${lines.slice(max).join(' ')}`, f, w)
      return kept
    }
    return lines.map((l) => cut(l, f, w))
  }
  return { width, cut, first, put, wrap }
}

type Env = { ctx: Ctx; p: Palette; pen: Pen; S: Spec; card: TradeCard; memo: Map<string, unknown>; said?: DrawOptions['said'] }
const memo = <T,>(e: Env, key: string, make: () => T): T => {
  if (!e.memo.has(key)) e.memo.set(key, make())
  return e.memo.get(key) as T
}

/** The small capitals of every label: mono, regular, spaced a little. */
const label = (px: number): Font => ({ px, mono: true, track: Math.round(px * 0.04) })
const rule = (e: Env, x: number, y: number, w: number, colour = e.p.line2) => {
  e.ctx.fillStyle = rgb(colour)
  e.ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), 2)
}

/** A square picture, covering its tile from the top as the app does, or a letter in its place. */
const picture = (e: Env, src: string | null, letter: string, x: number, y: number, size: number) => {
  const { ctx, p } = e
  ctx.fillStyle = rgb(p.sunken)
  ctx.fillRect(x, y, size, size)
  const img = src ? pictures.get(src) : null
  if (img) {
    const s = Math.min(img.naturalWidth, img.naturalHeight)
    ctx.drawImage(img, (img.naturalWidth - s) / 2, 0, s, s, x, y, size, size)
  } else if (!src || pictures.has(src)) {
    // Failed or none: the letter. Still loading: the plain tile, so the letter never flashes before the face.
    const f: Font = { px: Math.round(size * 0.4), mono: true }
    e.pen.put(letter.toUpperCase(), x + size / 2, y + size / 2 + f.px * CAP * 0.5, f, rgb(p.muted), { x, y, w: size, h: size }, 'center', 'deco')
  }
}

// ---- Blocks ----

/** A block planned for a width: the height it needs, its score, and how to draw it at a top edge. */
/** `strip`: the plan draws the week-by-week bars. `rule`: how far under its top edge its first hairline runs. */
type Plan = { h: number; score: number; what: string; draw: (x: number, y: number) => void; strip?: boolean; rule?: number }

// The sides. A side is a head ("MIND GOBLINS GETS") over its rows. A row is a player, the FAAB the side takes in, or,
// past what fits, "+3 MORE". Rows come in two kinds: `rich` (a face, the name, and under it a line of position, team
// and sender, all from one left edge) and `line` (the position in a fixed column, then the name, on one baseline).
// The points a week, when shown, close every row, under a unit set once in the first head. Many teams in little height
// take a ledger instead: a band per side, its head at the left of its rows.

type Kind = 'rich' | 'line'
/** `ledger`: each side a band, its head in a column at the left and its rows beside it, for many teams in little height. */
/** `bare`: a line row without its position column, for the most names in the least width. */
/** `wrap`: a ledger's head may put the team's name over its verb even beside a single row, making that band taller. */
type SideOpt = { kind: Kind; cols: number; cap: number; zoom: number; ppw: boolean; ledger?: boolean; tight?: boolean; bare?: boolean; wrap?: boolean }
/** `more`: the rows past what fits, said in one: as many of their surnames as go, then how many others. */
type Item = { t: 'player'; i: number } | { t: 'faab' } | { t: 'none' } | { t: 'more'; text: string }

const itemsOf = (s: CardSide) => {
  const out: Item[] = s.players.map((_, i) => ({ t: 'player', i }))
  if (s.faab) out.push({ t: 'faab' })
  if (!out.length) out.push({ t: 'none' })
  return out
}

/** A player's name in three forms, longest first: whole, initialled, surname (a form a name lacks repeats the last). */
const nameForms = (name: string) => {
  const v = playerNameVariants(name)
  return v.length === 3 ? v : v.length === 2 ? [v[0], v[0], v[1]] : [v[0], v[0], v[0]]
}

/** Who sends a player, in a deal of three or more: a phrase, so in the words' face. */
const fromText = (team: string) => `from ${nameVariants(team)[0]}`

/**
 * The rows that did not fit, in one line: "+ Hurts, Gibbs, Nacua", else "Hurts, Gibbs +3 more", else "+5 more". The
 * plus marks a line of names as more of them, so "+ Barkley, Samuel" is never read as one name.
 */
const moreText = (e: Env, rest: string[], f: Font, room: number) => {
  for (let k = rest.length; k >= 1; k--) {
    const text = k < rest.length ? `${rest.slice(0, k).join(', ')} +${rest.length - k} more` : `+ ${rest.join(', ')}`
    if (e.pen.width(text, f) <= room) return { text, named: k }
  }
  return { text: e.pen.first([`+${rest.length} more`, `+${rest.length}`], f, room), named: 0 }
}

/** The measures of one way of setting the sides. */
const sideMeasures = (S: Spec, o: SideOpt) => {
  const z = o.zoom
  const name = Math.round(S.name * z)
  const meta = Math.max(S.min, Math.round(S.min * Math.min(z, 1.15)))
  const face = Math.round(S.face * z)
  const gapLine = Math.round(S.u * 2 * z)
  const textH = name * CAP + gapLine + meta * CAP
  const rowH = o.kind === 'rich' ? Math.round(Math.max(face, textH + S.u * 2) + S.u * 3) : Math.round(name * CAP + S.u * (o.tight ? 2.5 : 4) * Math.min(z, 1.2))
  return { name, meta, face, gapLine, textH, rowH }
}

/** A head said on one line, in the shape a ledger's head takes. */
const oneLine = ({ text, loss }: { text: string; loss: number }) => ({ lines: [text], loss })

/** "MIND GOBLINS GETS" in a width, the team's name giving way and the verb always kept. */
const headText = (e: Env, s: CardSide, room: number) =>
  memo(e, `head|${s.rosterId}|${Math.round(room)}`, () => {
    const f = label(e.S.min)
    const verb = / (gets|sends)$/i.exec(s.head)
    const who = verb ? s.head.slice(0, -verb[0].length) : s.head
    const tail = verb ? ` ${verb[1].toUpperCase()}` : ''
    const names = nameVariants(who)
    const ways = names.map((n) => `${n.toUpperCase()}${tail}`)
    const i = ways.findIndex((t) => e.pen.width(t, f) <= room)
    // Dropping "The" costs nothing; a name said in its first words a little; in initials, which few will read, more.
    if (i >= 0) return { text: ways[i], loss: i === 0 || (i === 1 && !names[1].endsWith('…') && /^the\s/i.test(who)) ? 0 : names[i].endsWith('…') ? 1 : 2 }
    const name = e.pen.cut((nameVariants(who)[1] ?? who).toUpperCase(), f, room - e.pen.width(tail, f))
    const kept = graphemes(name.replace(/…$/, '')).length
    // A name cut inside a word is the last thing a head does: any whole way of setting the sides is better.
    return { text: `${name}${tail}`.trim(), loss: kept >= 5 ? 20 : kept >= 3 ? 30 : 60 }
  })

const planSides = (e: Env, w: number, o: SideOpt): Plan | null => memo(e, `sides|${w}|${JSON.stringify(o)}`, () => planSides0(e, w, o))
const planSides0 = (e: Env, w: number, o: SideOpt): Plan | null => {
  const { S, pen, p, card } = e
  const m = sideMeasures(S, o)
  const metaF: Font = { px: m.meta, mono: true, track: 1 }
  const nameF = (px: number): Font => ({ px, w: 500 })
  const ppwF: Font = { px: Math.max(S.min, Math.round(m.name * 0.85)), mono: true }
  const hasPpw = card.sides.some((s) => s.players.some((pl) => pl.ppw != null))
  const showPpw = hasPpw && o.ppw
  const ppwW = showPpw ? pen.width('00.0', ppwF) : 0
  const gap = o.kind === 'rich' ? S.u * 2 : S.u * 4
  const colGap = o.bare ? S.u * 4 : S.u * 6
  const headF = label(S.min)
  const headLH = Math.round(S.min * CAP + S.u * 2)
  // A ledger's head column: as wide as its widest head needs, within nearly half the width. A head that will not go
  // on one line puts the team's name over its verb ("BABABANIK / GETS"), the name shortening only by whole words:
  // beside a side of two rows or more always, since its band is that tall anyway, and beside one row with `wrap`.
  const rowsOf = (s: CardSide) => Math.min(o.cap, Math.ceil(itemsOf(s).length / o.cols))
  const ledgerHead = (s: CardSide, room: number) =>
    memo(e, `lhead|${s.rosterId}|${Math.round(room)}|${o.wrap || rowsOf(s) > 1}`, () => {
      const one = headText(e, s, room)
      if (!one.loss || !(o.wrap || rowsOf(s) > 1)) return oneLine(one)
      const verb = / (gets|sends)$/i.exec(s.head)
      const names = nameVariants(verb ? s.head.slice(0, -verb[0].length) : s.head)
      const i = names.findIndex((n) => pen.width(n.toUpperCase(), headF) <= room)
      if (i < 0 || !verb) return oneLine(one)
      return { lines: [names[i].toUpperCase(), verb[1].toUpperCase()], loss: (i ? (names[i].endsWith('…') ? 1 : 2) : 0) + 0.5 }
    })
  const headRoom = w * 0.45 - S.u * 4
  const headCol = o.ledger ? Math.ceil(Math.min(w * 0.45, Math.max(...card.sides.map((s) => Math.max(...ledgerHead(s, headRoom).lines.map((l) => pen.width(l, headF))))) + S.u * 4)) : 0
  const rowsW = w - headCol
  const cellW = (rowsW - (o.cols - 1) * colGap) / o.cols
  const faceW = o.kind === 'rich' ? m.face + S.u * 3 : 0
  // The position column of a line row: as wide as the widest it holds, so every name starts on one edge.
  const posCol = o.kind === 'line' && !o.bare ? pen.width(card.sides.some((s) => s.faab) ? 'FAAB' : 'DEF', metaF) + S.u * 2 : 0
  const nameRoom0 = cellW - faceW - posCol - (ppwW ? ppwW + gap : 0)
  if (nameRoom0 < S.name * (o.cols > 2 ? 3.5 : 2.5)) return null
  const headH = o.ledger ? 0 : Math.round(S.min * CAP + S.u * 3)
  const unit = showPpw && !o.ledger ? 'PTS/WK' : null
  let loss = (hasPpw && !showPpw ? 3 : 0) + (o.bare ? 2 : 0)
  if (o.cap * o.cols < 2 && card.sides.some((s) => itemsOf(s).length > o.cap * o.cols)) return null

  let unitDone = false
  let squeezed = false
  // Every row of the card is set alike: one form and one size for every name, the sender shown on all or none.
  const allPlayers = card.sides.flatMap((s) => s.players)
  const fromWAll = (pl: CardSide['players'][number]) => (o.kind === 'line' && pl.from && o.cols === 1 ? pen.width(fromText(pl.from), { px: m.meta }) + gap : 0)
  const showFrom = o.kind === 'line' && o.cols === 1 && allPlayers.every((pl) => !pl.from || nameRoom0 - fromWAll(pl) >= S.name * 4)
  if (o.kind === 'line' && allPlayers.some((pl) => pl.from) && !showFrom) loss += 2
  const roomOf = (pl: CardSide['players'][number]) => nameRoom0 - (showFrom ? fromWAll(pl) : 0)
  // The names that are drawn: a side's rows past its cap are said in its "more" line instead.
  const shown = card.sides.flatMap((s) => {
    const items = itemsOf(s)
    const keep = Math.ceil(items.length / o.cols) > o.cap ? o.cap * o.cols - 1 : items.length
    return items.slice(0, keep).flatMap((it) => (it.t === 'player' ? [s.players[it.i]] : []))
  })
  let level = 2
  let px = m.name
  let cut = false
  // An outsized name (its surname alone too wide) is cut on its own and sets no form for the rest.
  const ordinary = shown.filter((pl) => pen.width(nameForms(pl.name)[2], nameF(m.name)) <= roomOf(pl))
  const fitsAt = (lv: number, x: number) => shown.every((pl) => pen.width(nameForms(pl.name)[lv], nameF(x)) <= roomOf(pl))
  const lv0 = [0, 1, 2].find((lv) => ordinary.every((pl) => pen.width(nameForms(pl.name)[lv], nameF(m.name)) <= roomOf(pl)))
  if (lv0 != null && ordinary.length === shown.length) level = lv0
  else {
    if (lv0 != null) level = lv0
    const least = Math.max(S.min, Math.round(m.name * 0.8))
    while (px > least && !fitsAt(2, px)) px -= 2
    cut = !fitsAt(2, px)
    loss += 1
    // Names side by side are worth it only while an ordinary surname still fits whole: only an outsized one is cut.
    if (cut && o.cols > 1 && shown.some((pl) => graphemes(nameForms(pl.name)[2]).length <= 12 && pen.width(nameForms(pl.name)[2], nameF(px)) > roomOf(pl))) squeezed = true
  }
  loss += level * 1.5 * card.sides.length + (cut ? 20 : 0)
  const sides = card.sides.map((s) => {
    let items = itemsOf(s)
    if (Math.ceil(items.length / o.cols) > o.cap) {
      const keep = o.cap * o.cols - 1
      const rest = items.slice(keep).map((it) => (it.t === 'player' ? nameForms(s.players[it.i].name)[2] : it.t === 'faab' ? `$${s.faab}` : ''))
      const more = moreText(e, rest, { px: m.meta }, cellW)
      // A name said in the line costs less than one only counted.
      loss += more.named * 5 + (rest.length - more.named) * 8
      items = [...items.slice(0, keep), { t: 'more', text: more.text }]
    }
    const rows = Math.ceil(items.length / o.cols)
    // The head, with its avatar and, on the first side with the room, the unit of the figures at the right.
    const src = s.avatar ?? null
    const av = src ? Math.round(S.min * 1.2) : 0
    const left = av ? av + S.u * 1.5 : 0
    const unitW = unit && !unitDone ? pen.width(unit, headF) + S.u * 3 : 0
    let head = o.ledger ? ledgerHead(s, headCol - S.u * 4) : oneLine(headText(e, s, w - left - unitW))
    let hasUnit = !!unitW
    if (unitW && head.loss > 0) {
      head = oneLine(headText(e, s, w - left))
      hasUnit = false
    }
    if (hasUnit) unitDone = true
    loss += head.loss

    return { s, items, rows, head, hasUnit, src, av, left, level, px, showFrom }
  })
  if (squeezed) return null

  const sideGap = o.ledger ? 0 : S.wide || o.tight ? S.u * 4 : S.u * 5
  // A ledger's head sits on the baseline of its first row, its second line under it.
  const firstBase = o.kind === 'rich' ? m.rowH / 2 : Math.round(m.rowH / 2 + (m.name * CAP) / 2)
  const blockOf = (x: (typeof sides)[number]) => (o.ledger ? Math.max(x.rows * m.rowH, firstBase + (x.head.lines.length - 1) * headLH + S.min * DESC + S.u * 2) : headH + x.rows * m.rowH)
  const h = sides.reduce((a, x) => a + blockOf(x), 0) + sideGap * (sides.length - 1)
  const kindScore = (o.kind === 'rich' ? 60 : 50 - (o.cols - 1) * 6) - (o.ledger ? 8 : 0) - (o.tight ? 3 : 0)
  return {
    h,
    rule: o.ledger ? 0 : headH - S.u - 2,
    score: kindScore + (o.zoom - 1) * 20 - loss * 2.5,
    what: `sides ${o.ledger ? `ledger${o.wrap ? ' wrap' : ''}` : 'stack'} ${o.kind}${o.tight ? ' tight' : ''}${o.bare ? ' bare' : ''}${o.kind === 'rich' ? '+face' : ''} x${o.cols}${o.cap < Infinity ? ` cap${o.cap}` : ''}${showPpw || !hasPpw ? '' : ' noppw'}${o.zoom !== 1 ? ` zoom${o.zoom}` : ''} loss${loss}`,
    draw: (x0, y0) => {
      let y = y0
      sides.forEach((x) => {
        const bh = blockOf(x)
        const tone = x.s.focus ? p.accent : p.text2
        if (o.ledger) {
          rule(e, x0, y - 1, w)
          const hb = { x: x0, y, w: headCol - S.u * 4, h: bh }
          x.head.lines.forEach((l, k) => pen.put(l, x0, y + firstBase + k * headLH, headF, rgb(tone), hb))
        } else {
          const hb = { x: x0, y, w, h: headH }
          const base = y + S.min * CAP
          if (x.av) picture(e, x.src, x.s.head, x0, Math.round(base - (S.min * CAP) / 2 - x.av / 2), x.av)
          pen.put(x.head.lines[0], x0 + x.left, base, headF, rgb(tone), { ...hb, x: x0 + x.left, w: w - x.left })
          if (x.hasUnit) pen.put(unit!, x0 + w, base, headF, rgb(p.muted), hb, 'right')
          rule(e, x0, y + headH - S.u - 2, w, x.s.focus ? p.accent : p.line2)
        }
        const top = y + headH
        x.items.forEach((it, k) => {
          const col = k % o.cols
          const line = Math.floor(k / o.cols)
          const cell = { x: x0 + headCol + col * (cellW + colGap), y: top + line * m.rowH, w: cellW, h: m.rowH }
          if (line > 0) rule(e, cell.x, cell.y - 1, cellW, p.line)
          drawRow(e, x.s, it, cell, o, { ...m, metaF, nameF, ppwF, ppwW, posCol, faceW, gap, level: x.level, px: x.px, showFrom: x.showFrom })
        })
        y += bh + sideGap
      })
    },
  }
}

type RowCtx = ReturnType<typeof sideMeasures> & { metaF: Font; nameF: (px: number) => Font; ppwF: Font; ppwW: number; posCol: number; faceW: number; gap: number; level: number; px: number; showFrom: boolean }

const drawRow = (e: Env, s: CardSide, it: Item, r: Rect, o: SideOpt, m: RowCtx) => {
  const { pen, p, S } = e
  const cy = r.y + r.h / 2
  const rich = o.kind === 'rich'
  // A rich row's two lines are centred as one block; a line row's capitals are centred on the row.
  const nb = rich ? Math.round(cy - m.textH / 2 + m.px * CAP) : Math.round(cy + (m.name * CAP) / 2)
  const mb = nb + m.gapLine + m.meta * CAP
  const right = r.x + r.w - (m.ppwW ? m.ppwW + m.gap : 0)
  const x0 = r.x + m.faceW + m.posCol
  const nameBox = { x: x0, y: r.y, w: right - x0, h: r.h }
  const metaBox = { x: r.x + m.faceW, y: r.y, w: r.w - m.faceW, h: r.h }
  const tile = (glyph: string) => {
    if (!rich) return
    const fy = Math.round(cy - m.face / 2)
    e.ctx.fillStyle = rgb(p.sunken)
    e.ctx.fillRect(r.x, fy, m.face, m.face)
    const f: Font = { px: Math.round(m.face * 0.4), mono: true }
    pen.put(glyph, r.x + m.face / 2, cy + (f.px * CAP) / 2, f, rgb(p.muted), { x: r.x, y: fy, w: m.face, h: m.face }, 'center', 'deco')
  }
  if (it.t === 'more') {
    e.said?.hidden?.push(it.text)
    const f: Font = { px: m.meta }
    pen.put(it.text, r.x, Math.round(cy + (f.px * CAP) / 2), f, rgb(p.text2), r)
    return
  }
  if (it.t === 'none') {
    const f = m.nameF(m.px)
    pen.put(pen.first(['Nothing back', 'Nothing'], f, r.w), r.x + (rich ? m.faceW : 0), Math.round(cy + (f.px * CAP) / 2), f, rgb(p.muted), r)
    return
  }
  if (it.t === 'faab') {
    tile('$')
    const nf = m.nameF(m.px)
    if (rich) {
      pen.put(`$${s.faab}`, x0, nb, nf, rgb(p.text), nameBox)
      pen.put('FAAB', x0, mb, m.metaF, rgb(p.muted), metaBox)
    } else if (o.bare) {
      const w = pen.put(`$${s.faab}`, x0, nb, nf, rgb(p.text), nameBox)
      if (w + S.u * 1.5 + pen.width('FAAB', m.metaF) <= nameBox.w) pen.put('FAAB', x0 + w + S.u * 1.5, nb, m.metaF, rgb(p.muted), nameBox)
    } else {
      pen.put('FAAB', r.x, nb, m.metaF, rgb(p.muted), metaBox)
      pen.put(`$${s.faab}`, x0, nb, nf, rgb(p.text), nameBox)
    }
    return
  }
  const pl = s.players[it.i]
  const forms = nameForms(pl.name)
  const nf = m.nameF(m.px)
  const room = nameBox.w - (m.showFrom && pl.from ? pen.width(fromText(pl.from), { px: m.meta }) + m.gap : 0)
  const name = pen.width(forms[m.level], nf) <= room ? forms[m.level] : pen.cut(forms[2], nf, room)
  if (rich) {
    picture(e, playerSrc(pl.id, pl.pos), graphemes(pl.name.trim())[0] ?? '?', r.x, Math.round(cy - m.face / 2), m.face)
    pen.put(name, x0, nb, nf, rgb(p.text), nameBox)
    // Under the name, from its edge: position, team and sender, each giving way in turn, then the timing tag.
    const tag = pl.tag ? pl.tag.toUpperCase() : null
    const tagW = tag ? pen.width(tag, m.metaF) + S.u * 2 : 0
    const parts = [pl.pos, pl.team ?? 'FA'].filter(Boolean)
    const fromWays = pl.from ? nameVariants(pl.from).map((n) => `from ${n}`) : []
    const lineWays = [...fromWays.map((f) => [...parts, f].join(' · ')), parts.join(' · '), pl.pos]
    const avail = metaBox.w - (x0 - metaBox.x)
    // The line under a name is a phrase, not a label: set in the words' face, so its separators keep a normal space.
    const lineF: Font = { px: m.meta }
    let withTag = !!tag
    let line = lineWays.find((t) => pen.width(t, lineF) + (withTag ? tagW + S.u * 2 : 0) <= avail)
    if (!line) {
      withTag = false
      line = pen.first(lineWays, lineF, avail)
    }
    const lw = pen.put(line, x0, mb, lineF, rgb(p.muted), metaBox)
    if (withTag && tag) chip(e, tag, x0 + lw + S.u * 2, mb, m.metaF, metaBox)
  } else {
    if (!o.bare) pen.put(pl.pos, r.x, nb, m.metaF, rgb(p.muted), metaBox)
    pen.put(name, x0, nb, nf, rgb(p.text), nameBox)
    if (m.showFrom && pl.from) pen.put(fromText(pl.from), right, nb, { px: m.meta }, rgb(p.muted), nameBox, 'right')
  }
  if (m.ppwW && pl.ppw != null) pen.put(pl.ppw.toFixed(1), r.x + r.w, nb, m.ppwF, rgb(p.text2), { x: r.x + r.w - m.ppwW, y: r.y, w: m.ppwW, h: r.h }, 'right')
}

/** A small tag in the positive colour, on a baseline: "BUY LOW". */
const chip = (e: Env, text: string, x: number, base: number, f: Font, room: Rect) => {
  const w = e.pen.width(text, f) + e.S.u * 2
  const top = base - f.px * CAP - e.S.u
  e.ctx.fillStyle = rgb(e.p.pos, 0.12)
  e.ctx.fillRect(x, top, w, f.px * CAP + e.S.u * 2)
  e.pen.put(text, x + e.S.u, base, f, rgb(e.p.pos), room)
}

// The figures: in tiles, a row of label over a large number, divided by hairlines; or, when short of room, a list of
// label and number, one line each; past what fits, a line saying how many more there are.

/** `strip`: the week-by-week bars as a tile in a row's spare place, or as a row of their own under the figures. */
type StatOpt = { mode: 'tiles' | 'list'; cols: number; sub: boolean; cap: number; strip?: 'tile' | 'row' }

/**
 * A figure's label, longest first, each a whole word or a set abbreviation: "PLAYOFF ODDS", "PLAYOFFS", "PO ODDS". A
 * label is never cut with an ellipsis: when even the shortest will not go, the layout is not used. In the league's
 * view a label is a team's name, as names shorten, without the forms that end in an ellipsis.
 */
const statLabels = (card: TradeCard, s: CardStat) =>
  memoLabels(card.kind === 'league' && s.key === 'lineup' ? `t|${s.label}` : s.label, () => {
    if (card.kind === 'league' && s.key === 'lineup') return nameVariants(s.label).filter((t) => !t.endsWith('…'))
    const l = s.label
    const fill = /^Fills (.+)$/.exec(l)
    return fill ? [l, fill[1]] : l === 'Playoff odds' ? [l, 'Playoffs', 'PO odds'] : l === 'Title odds' ? [l, 'Title'] : l === 'Consensus value' ? [l, 'Consensus', 'Value'] : l === 'FAAB in' ? [l, 'FAAB'] : [l, l.split(' ')[0]]
  })
const labelMemo = new Map<string, string[]>()
const memoLabels = (key: string, make: () => string[]) => {
  let v = labelMemo.get(key)
  if (!v) {
    v = [...new Set(make().map((t) => t.toUpperCase()))]
    if (labelMemo.size > 200) labelMemo.clear()
    labelMemo.set(key, v)
  }
  return v
}
/** A unit, longest first: "PTS/WK", "/WK"; "PTS" after a range may go, since the numbers say it. */
const unitWays = (u: string | null) => (!u ? [''] : u === 'pts/wk' ? ['PTS/WK', '/WK'] : u === 'pts' ? ['PTS', ''] : [u.toUpperCase()])

const planStats = (e: Env, w: number, o: StatOpt): Plan | null => memo(e, `stats|${w}|${JSON.stringify(o)}`, () => planStats0(e, w, o))
const planStats0 = (e: Env, w: number, o: StatOpt): Plan | null => {
  const { S, pen, p, card } = e
  const all = card.stats
  if (!all.length && !o.strip) return null
  const cap = Math.min(o.cap, all.length)
  const dropped = all.length - cap
  const stats = dropped ? all.slice(0, cap - 1) : all
  const more = dropped ? dropped + 1 : 0
  const lf = label(S.min)
  const subF: Font = { px: S.min }
  const toneOf = (s: CardStat) => (s.tone === 'pos' ? p.pos : s.tone === 'neg' ? p.neg : p.text)
  // Tiles stand clear of the block's rule; a list's first row sits under it as every row sits under the one above.
  const top = o.mode === 'list' ? 0 : S.u * 4
  // A list row: the label at the left, the number and its unit at the right, on one baseline. The strip, set as a
  // row, takes the same height and puts its bars between the two.
  const vpx = Math.round(S.name * 0.95)
  const vf: Font = { px: vpx, w: 500, mono: true }
  const rh = Math.round(vpx * CAP + S.u * (S.wide ? 2.5 : 4))
  const row = o.strip === 'row' ? stripRow(e, w, vf, lf) : null
  // The strip's row is a little taller than a figure's, for the bars to stand readably tall.
  const sh = Math.max(rh, S.u * 8)
  if (o.strip === 'row' && !row) return null
  const stripScore = o.strip === 'tile' ? 17 : o.strip === 'row' ? 16 : 0
  /** The label and unit of a figure in a width, fullest first, the unit giving way before the label. */
  const pairOf = (s: CardStat, fits: (lab: string, unit: string) => boolean) => {
    const labs = statLabels(card, s)
    const units = unitWays(s.unit)
    const pairs = labs.flatMap((lab, i) => units.map((unit, j) => ({ lab, unit, i, j }))).sort((a, b) => a.i + a.j - (b.i + b.j) || a.i - b.i)
    const hit = pairs.find((x) => fits(x.lab, x.unit))
    return hit ? { ...hit, loss: (hit.i ? 0.5 : 0) + (hit.j ? 0.5 : 0) } : null
  }
  const drawRow = (x: number, y: number) => {
    if (!row) return
    if (e.said) e.said.weeksLeft = false
    const base = Math.round(y + sh / 2 + (vpx * CAP) / 2)
    const box = { x, y, w, h: sh }
    pen.put(row.lead, x, base, lf, rgb(p.muted), { ...box, w: row.leadW })
    const ux = x + w - row.unitW
    if (row.unit) pen.put(row.unit, ux, base, lf, rgb(p.muted), { ...box, x: ux, w: row.unitW })
    const vx = ux - row.valueW - (row.unit ? S.u * 1.5 : 0)
    pen.put(row.value, vx, base, vf, rgb(row.tone === 'pos' ? p.pos : p.text), { ...box, x: vx, w: row.valueW })
    const bx = x + row.leadW + S.u * 3
    bars(e, { x: bx, y: y + S.u, w: vx - S.u * 3 - bx, h: sh - S.u * 2 })
  }

  if (o.mode === 'list') {
    let loss = dropped * 400
    const rows = stats.map((s) => {
      const vw = (unit: string) => pen.width(s.value, vf) + (unit ? S.u * 1.5 + pen.width(unit, lf) : 0)
      const hit = pairOf(s, (lab, unit) => pen.width(lab, lf) + vw(unit) + S.u * 4 <= w)
      if (!hit) return null
      loss += hit.loss
      return { s, lab: hit.lab, unit: hit.unit, vw: vw(hit.unit) }
    })
    if (rows.some((r) => !r)) return null
    const live = rows as NonNullable<(typeof rows)[number]>[]
    const moreText = more ? pen.first([`+${more} MORE FIGURES`, `+${more} FIGURES`], lf, w) : ''
    const n = live.length + (more ? 1 : 0)
    return {
      h: top + n * rh + (row ? sh : 0),
      score: 8 - loss + stripScore,
      what: `stats list${dropped ? ` cap${cap}` : ''}${row ? ' +strip row' : ''}`,
      strip: !!row,
      draw: (x, y) => {
        rule(e, x, y, w)
        let ry = y + top
        const next = () => {
          if (ry > y + top) rule(e, x, ry, w, p.line)
        }
        live.forEach((r) => {
          next()
          const base = Math.round(ry + rh / 2 + (vpx * CAP) / 2)
          const box = { x, y: ry, w, h: rh }
          pen.put(r.lab, x, base, lf, rgb(p.muted), { ...box, w: w - r.vw - S.u * 4 })
          const vx = x + w - r.vw
          const vw = pen.put(r.s.value, vx, base, vf, rgb(toneOf(r.s)), { ...box, x: vx, w: r.vw })
          if (r.unit) pen.put(r.unit, vx + vw + S.u * 1.5, base, lf, rgb(p.muted), { ...box, x: vx, w: r.vw })
          ry += rh
        })
        if (row) {
          next()
          drawRow(x, ry)
          ry += sh
        }
        if (more) {
          next()
          pen.put(moreText, x, Math.round(ry + rh / 2 + (S.min * CAP) / 2), lf, rgb(p.muted), { x, y: ry, w, h: rh })
        }
      },
    }
  }
  if (dropped) return null

  // Tiles, `cols` to a row, the last row's tiles sharing its width; one size for every number in the block.
  const gap = S.u * 6
  // A tile is a figure, or the week-by-week strip.
  const tiles: (CardStat | 'strip')[] = o.strip === 'tile' ? [...stats, 'strip'] : stats
  const rowsOf: (CardStat | 'strip')[][] = []
  for (let i = 0; i < tiles.length; i += o.cols) rowsOf.push(tiles.slice(i, i + o.cols))
  // Balanced rows: four figures go two and two, not three and one.
  if (rowsOf.length > 1 && rowsOf[rowsOf.length - 1].length === 1 && o.cols > 2) return null
  // One grid for every row, so a short last row lines up under the first.
  const cw = (w - gap * (o.cols - 1)) / o.cols
  if (o.strip === 'tile' && cw < minBars(e)) return null
  const stripLab = o.strip === 'tile' ? ['WEEK BY WEEK', 'WEEKLY'].find((t) => pen.width(t, lf) <= cw) : null
  if (o.strip === 'tile' && !stripLab) return null
  const valueW = (s: CardStat, px: number, unit: string) => pen.width(s.value, { px, w: 500, mono: true }) + (unit ? S.u * 1.5 + pen.width(unit, lf) : 0)
  let px = S.value
  const least = Math.round(S.value * 0.7)
  const fitsAll = (x: number) => stats.every((s) => valueW(s, x, unitWays(s.unit)[0]) <= cw)
  while (px > least && !fitsAll(px)) px -= 2
  let loss = 0
  const cells = rowsOf.map((r) =>
    r.map((s) => {
      if (s === 'strip') return { s, lab: stripLab!, unit: null, sub: null }
      const hit = pairOf(s, (lab, unit) => pen.width(lab, lf) <= cw && valueW(s, px, unit) <= cw)
      if (!hit) return null
      loss += hit.loss
      let sub: string | null = null
      if (o.sub && s.sub) {
        const sw = subVariants(s.sub)
        sub = sw.find((t) => pen.width(t, subF) <= cw) ?? null
        if (sub !== sw[0]) loss += sub ? 0.25 : 1
      }
      return { s, lab: hit.lab, unit: hit.unit, sub }
    }),
  )
  if (cells.some((r) => r.some((c) => !c))) return null
  // A row of tiles is as tall as its tallest: room for a note under the number only where one of them has one, and
  // for the bars to stand readably tall where they are.
  const tileH = cells.map((r) => {
    const body = Math.max(px * CAP + (r.some((c) => c!.sub) ? S.u * 3 + S.min * CAP : 0), r.some((c) => c!.s === 'strip') ? S.u * 7 : 0)
    return Math.round(S.min * CAP + S.u * 3 + body + S.u)
  })
  const rowGap = S.u * 4
  const tilesH = tileH.reduce((a, x) => a + x, 0) + (cells.length - 1) * rowGap
  // The strip as a row closes the block, under a hairline, as the list's rows are.
  const h = top + tilesH + (row ? S.u * 2 + sh : 0)
  const subs = card.stats.filter((s) => s.sub).length
  return {
    h,
    score: 20 - (o.sub ? 0 : subs * 1.5) - loss - (px < S.value ? (S.value - px) / 8 : 0) + stripScore,
    what: `stats tiles x${o.cols}${o.sub ? ' sub' : ''}${o.strip ? ` +strip ${o.strip}` : ''}`,
    strip: !!o.strip,
    draw: (x, y) => {
      rule(e, x, y, w)
      let ty = y + top
      cells.forEach((r, ri) => {
        r.forEach((c0, i) => {
          const c = c0!
          const cx = x + i * (cw + gap)
          const box = { x: cx, y: ty, w: cw, h: tileH[ri] }
          if (i) {
            e.ctx.fillStyle = rgb(p.line)
            e.ctx.fillRect(Math.round(cx - gap / 2) - 1, ty, 2, tileH[ri])
          }
          let base = ty + S.min * CAP
          pen.put(c.lab, cx, base, lf, rgb(p.muted), box)
          if (c.s === 'strip') {
            // The bars stand where a number would, down to the foot of the row's notes.
            if (e.said) e.said.weeksLeft = false
            const by = base + S.u * 3
            bars(e, { x: cx, y: by, w: cw, h: ty + tileH[ri] - S.u - by })
            return
          }
          base += S.u * 3 + px * CAP
          const vw = pen.put(c.s.value, cx, base, { px, w: 500, mono: true }, rgb(toneOf(c.s)), box)
          if (c.unit) pen.put(c.unit, cx + vw + S.u * 1.5, base, lf, rgb(p.muted), box)
          if (c.sub) pen.put(c.sub, cx, base + S.u * 3 + S.min * CAP, subF, rgb(p.text2), box)
        })
        ty += tileH[ri] + rowGap
      })
      if (row) {
        const ry = y + top + tilesH + S.u * 2
        rule(e, x, ry, w, p.line)
        drawRow(x, ry)
      }
    },
  }
}

/**
 * The recipient's lineup change week by week: bars either side of a zero line, gains in the positive colour and the
 * odd losing week in the negative. Colour is never the only cue: a bar's side of the line says which way the week
 * went, and a dashed line at the lineup change a week (the Lineup figure) shows the run as a whole.
 *
 * It is always one of the figures: a tile of their grid where a row has a place to spare, else a row of its own under
 * them, set as a list row is ("WEEK BY WEEK", the bars, "7/8 BETTER").
 */
const bars = (e: Env, r: Rect) => {
  const { S, p, card, ctx } = e
  const strip = card.strip!
  const n = strip.length
  const net = card.net ?? null
  const anyNeg = strip.some((s) => s.delta < -0.05)
  const max = Math.max(0.5, ...strip.map((s) => Math.max(0, s.delta)), net ?? 0)
  const negMax = anyNeg ? Math.max(...strip.map((s) => -s.delta)) : 0
  const zero = r.y + r.h * (max / (max + negMax))
  const scale = r.h / (max + negMax)
  const slot = r.w / n
  const bw = Math.max(4, Math.min(S.u * 5, slot * 0.5))
  strip.forEach((s, i) => {
    const len = Math.max(2, Math.abs(s.delta) * scale)
    ctx.fillStyle = rgb(Math.abs(s.delta) < 0.05 ? p.line2 : s.delta > 0 ? p.pos : p.neg, 0.85)
    ctx.fillRect(r.x + slot * i + slot / 2 - bw / 2, s.delta >= 0 ? zero - len : zero, bw, len)
  })
  ctx.fillStyle = rgb(p.line2)
  ctx.fillRect(r.x, Math.round(zero) - 1, r.w, 2)
  if (net == null) return
  const ay = Math.round(zero - net * scale)
  ctx.strokeStyle = rgb(p.text2)
  ctx.lineWidth = 2
  ctx.setLineDash([S.u, S.u])
  ctx.beginPath()
  ctx.moveTo(r.x, ay)
  ctx.lineTo(r.x + r.w, ay)
  ctx.stroke()
  ctx.setLineDash([])
}
/** The narrowest the bars may be drawn and still read as weeks: a grid step and a half a week. */
const minBars = (e: Env) => Math.max(e.S.u * 16, e.card.strip!.length * e.S.u * 1.5)
/** The words of the strip as a row, in the shortest forms that leave the bars `minBars`; null where none do. */
const stripRow = (e: Env, w: number, vf: Font, lf: Font) =>
  memo(e, `striprow|${w}`, () => {
    const { S, pen, card } = e
    const strip = card.strip!
    const n = strip.length
    const better = strip.filter((s) => s.delta > 0.05).length
    const value = `${better}/${n}`
    const valueW = pen.width(value, vf)
    const leads = ['WEEK BY WEEK', 'WEEKLY']
    const units = ['WEEKS BETTER', 'BETTER', '']
    const pairs = leads.flatMap((lead, i) => units.map((unit, j) => ({ lead, unit, i, j }))).sort((a, b) => a.i + a.j - (b.i + b.j) || a.j - b.j)
    for (const { lead, unit } of pairs) {
      const leadW = pen.width(lead, lf)
      const unitW = unit ? pen.width(unit, lf) : 0
      if (leadW + S.u * 3 + minBars(e) + S.u * 3 + valueW + (unit ? S.u * 1.5 + unitW : 0) <= w) return { lead, unit, value, leadW, unitW, valueW, tone: better * 2 > n ? 'pos' : 'neutral' }
    }
    return null
  })

/** The sender's note, in their words, behind a hairline, wrapped to the lines it is given. */
const planNote = (e: Env, w: number, max: number): Plan => {
  const { S, pen, p, card } = e
  const f: Font = { px: S.note }
  const indent = S.u * 3
  const whole = `“${card.note}”`
  const lines = pen.wrap(whole, f, w - indent, max)
  const lh = Math.round(S.note * 1.4)
  const h = Math.round((lines.length - 1) * lh + S.note * (CAP + DESC))
  return {
    h,
    score: lines.join(' ') === whole ? 20 : max === 1 ? -20 : 10,
    what: `note ${lines.length}`,
    draw: (x, y) => {
      e.ctx.fillStyle = rgb(p.line2)
      e.ctx.fillRect(x, y, 4, h)
      if (e.said) e.said.noteCut = lines.join(' ') !== whole
      lines.forEach((l, i) => pen.put(l, x + indent, Math.round(y + S.note * CAP + i * lh), f, rgb(p.text2), { x: x + indent, y, w: w - indent, h }))
    },
  }
}

// ---- Choosing the layout ----

/** The ways the sides may be set out, fullest first, ending with ways that show only so many rows of each side. */
const sideOpts = (e: Env): SideOpt[] => {
  const most = Math.max(...e.card.sides.map((s) => itemsOf(s).length))
  const total = e.card.sides.reduce((a, s) => a + itemsOf(s).length, 0)
  const out: SideOpt[] = []
  // A small trade on a roomy card is drawn larger, not left floating in space.
  if (total <= 5) for (const zoom of [1.2, 1.1]) out.push({ kind: 'rich', cols: 1, cap: Infinity, zoom, ppw: true })
  out.push({ kind: 'rich', cols: 1, cap: Infinity, zoom: 1, ppw: true })
  if (total <= 4) out.push({ kind: 'line', cols: 1, cap: Infinity, zoom: 1.15, ppw: true })
  // Then more to a row: two columns, tighter, then (with no position column) three; then only so many rows a side.
  const grids: Pick<SideOpt, 'cols' | 'bare'>[] = [{ cols: 2 }, { cols: 2, bare: true }, { cols: 3, bare: true }].filter((g) => g.cols <= most)
  // The points a week close a row only in a single column: beside a second column they read as part of its names.
  for (const ppw of [true, false]) {
    out.push({ kind: 'line', cols: 1, cap: Infinity, zoom: 1, ppw })
    out.push({ kind: 'line', cols: 1, cap: Infinity, zoom: 1, ppw, tight: true })
    if (!ppw) for (const g of grids) for (const tight of [false, true]) out.push({ kind: 'line', ...g, cap: Infinity, zoom: 1, ppw, tight })
    for (let cap = Math.min(8, most - 1); cap >= 1; cap--) out.push({ kind: 'line', cols: 1, cap, zoom: 1, ppw, tight: true })
    if (!ppw) for (const g of grids) for (let cap = Math.min(8, Math.ceil(most / g.cols) - 1); cap >= 1; cap--) out.push({ kind: 'line', ...g, cap, zoom: 1, ppw, tight: true })
  }
  for (const g of [{ cols: 1 }, ...grids]) for (let cap = Math.ceil(most / g.cols); cap >= 1; cap--) for (const tight of [false, true]) for (const wrap of [true, false]) out.push({ kind: 'line', ...g, cap, zoom: 1, ppw: false, ledger: true, tight, wrap })
  return out
}
const statOpts = (e: Env, strip: boolean): StatOpt[] => {
  const n = e.card.stats.length
  if (!n) return strip ? [{ mode: 'list', cols: 1, sub: false, cap: 0, strip: 'row' }] : []
  const out: StatOpt[] = []
  // The strip as one more tile where the last row of figures has a place to spare, else as a row under them; and,
  // should neither fit, the figures without it.
  const ways = (cols: number): StatOpt['strip'][] => (strip ? [...(n % cols !== 0 && cols > 1 ? (['tile'] as const) : []), 'row', undefined] : [undefined])
  for (const sub of [true, false])
    for (const cols of [...new Set([Math.min(n, 3), 2, 1])]) for (const w of ways(cols)) out.push({ mode: 'tiles', cols, sub, cap: Infinity, strip: w })
  for (let cap = n; cap >= 1; cap--) for (const w of strip ? (['row', undefined] as const) : [undefined]) out.push({ mode: 'list', cols: 1, sub: false, cap, strip: w })
  return out
}

type Column = { plans: Plan[]; score: number; h: number }
/** What leaving off the strip the sender asked for costs: more than any way of setting the rest, less than a figure. */
const STRIP_LEFT = 300
const MIN_GAP = (S: Spec) => S.u * 4
const heightOf = (plans: Plan[], gap: number) => plans.reduce((a, x) => a + x.h, 0) + gap * Math.max(0, plans.length - 1)

/**
 * The best set of blocks for a column `w` by `h`: the sides, the figures with the strip among them, and the note, each
 * in the fullest form that leaves room for the rest. The note is always kept, cut to one line before anything else
 * goes; then the strip is left off, and only after it a figure (`STRIP_LEFT`, and the list's cost of a figure).
 */
const chooseColumn = (e: Env, w: number, h: number, parts: { sides: boolean; stats: boolean; strip: boolean; note: boolean }): Column | null =>
  memo(e, `col|${w}|${Math.floor(h)}|${JSON.stringify(parts)}`, () => {
    const { S, card } = e
    const gap = MIN_GAP(S)
    const notes = parts.note && card.note ? Array.from({ length: S.noteLines }, (_, i) => planNote(e, w, S.noteLines - i)) : [null]
    const sides = parts.sides ? sideOpts(e).map((o) => planSides(e, w, o)).filter((x): x is Plan => !!x) : [null]
    const wantStrip = parts.strip && !!card.strip
    const stats = parts.stats || wantStrip ? statOpts(e, wantStrip).map((o) => planStats(e, w, o)).filter((x): x is Plan => !!x) : []
    let best: Column | null = null
    for (const n of notes)
      for (const s of sides)
        for (const st of stats.length ? stats : [null]) {
          const plans = [n, s, st].filter((x): x is Plan => !!x)
          const need = heightOf(plans, gap)
          if (!plans.length || need > h) continue
          const score = plans.reduce((a, x) => a + x.score, 0) - (wantStrip && !st?.strip ? STRIP_LEFT : 0)
          if (!best || score > best.score) best = { plans, score, h: need }
        }
    return best
  })

/** Places a column's blocks in a rect, the room to spare shared out as wider gaps (to a limit), then centred. */
const place = (e: Env, plans: Plan[], r: Rect, centre = true) => {
  const { S } = e
  const need = heightOf(plans, MIN_GAP(S))
  const n = plans.length
  const g = n > 1 && centre ? Math.min(S.u * 7, MIN_GAP(S) + Math.max(0, r.h - need) / (n - 1)) : MIN_GAP(S)
  const used = plans.reduce((a, x) => a + x.h, 0) + g * (n - 1)
  let y = r.y + (centre ? Math.max(0, (r.h - used) / 2) : 0)
  for (const x of plans) {
    x.draw(r.x, Math.round(y))
    y += x.h + g
  }
}

// ---- Heading and foot ----

/** The title's ways to be said: for the recipient in a pitch, both teams of a two-team trade, else how many teams. */
const titleWays = (card: TradeCard) => {
  if (card.kind === 'pitch') return nameVariants(card.to ?? '').map((n) => `For ${n}`)
  if (card.sides.length > 2) return [`${card.sides.length}-team trade`]
  // Both names as full as they can be, the longer giving way first: never one cut to initials while the other is whole.
  const [a, b] = card.sides.map((s) => nameVariants(s.head.replace(/ (gets|sends)$/, '')))
  const pairs: [number, number][] = []
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) pairs.push([i, j])
  pairs.sort((x, y) => Math.max(...x) - Math.max(...y) || x[0] + x[1] - y[0] - y[1])
  return pairs.map(([i, j]) => `${a[i]} ↔ ${b[j]}`)
}

/**
 * The heading: a line of small capitals (what this is and the week) over the title, centred on the square and the tall
 * card, and on the wide one the title at the left with the week at the right. Returns where it ends.
 */
const drawHeader = (e: Env) => {
  const { S, pen, p, card } = e
  const lf = label(S.min)
  const inner = S.W - S.pad * 2
  const tf = (x: number): Font => ({ px: x, w: 500 })
  const eyebrow = `${card.kind === 'pitch' ? 'TRADE PROPOSAL' : 'TRADE'} · WEEK ${card.week}`
  const eyeW = S.wide ? pen.width(`WEEK ${card.week}`, lf) + S.u * 4 : 0
  const room = inner - eyeW
  const ways = titleWays(card)
  let lines: string[] = []
  let px = S.title
  search: for (const t of ways) {
    for (px = S.title; px >= S.titleMin; px -= 2)
      if (pen.width(t, tf(px)) <= room) {
        lines = [t]
        break search
      }
    if (S.titleLines > 1 && t === ways[0]) {
      const two = pen.wrap(t, tf(S.titleMin), room, 2)
      if (two.length === 2 && !two[1].endsWith('…')) {
        px = S.titleMin
        lines = two
        break
      }
    }
  }
  if (!lines.length) {
    px = S.titleMin
    lines = [pen.cut(ways[ways.length - 1], tf(px), room)]
  }
  const lh = Math.round(px * 1.2)
  if (S.wide) {
    const base = S.pad + px * CAP
    const box = { x: S.pad, y: S.pad, w: room, h: px }
    pen.put(lines[0], S.pad, base, tf(px), rgb(p.text), box)
    pen.put(`WEEK ${card.week}`, S.W - S.pad, base, lf, rgb(p.muted), { x: S.W - S.pad - eyeW, y: S.pad, w: eyeW, h: px }, 'right')
    return base + px * DESC
  }
  const cx = S.W / 2
  const eb = S.pad + S.min * CAP
  pen.put(pen.first([eyebrow, `WEEK ${card.week}`], lf, inner), cx, eb, lf, rgb(p.muted), { x: S.pad, y: S.pad, w: inner, h: S.min }, 'center')
  const t0 = eb + S.u * 3 + px * CAP
  const box = { x: S.pad, y: eb, w: inner, h: lines.length * lh + px }
  lines.forEach((l, i) => pen.put(l, cx, t0 + i * lh, tf(px), rgb(p.text), box, 'center'))
  return t0 + (lines.length - 1) * lh + px * DESC
}

/** The foot: who it is from and where it was made, centred (on the wide card, at either edge). Returns where it starts. */
const drawFooter = (e: Env) => {
  const { S, pen, p, card } = e
  const lf = label(S.min)
  const base = S.H - S.pad - S.min * DESC
  const inner = S.W - S.pad * 2
  const top = base - S.min * CAP
  const site = 'FF.SUJEFF.COM'
  const froms = card.from ? nameVariants(card.from).map((n) => `FROM ${n.toUpperCase()}`) : []
  const league = card.league.toUpperCase()
  const box = { x: S.pad, y: top, w: inner, h: S.min }
  if (S.wide) {
    const sw = pen.put(site, S.pad, base, lf, rgb(p.text2), box)
    const room = inner - sw - S.u * 6
    const by = pen.first(card.from ? [`${froms[0]} · ${league}`, ...froms] : [league], lf, room)
    pen.put(by, S.W - S.pad, base, lf, rgb(p.muted), { ...box, x: S.W - S.pad - room, w: room }, 'right')
    return top
  }
  const sep = ' · '
  const ways = card.from ? [...froms.map((f) => `${f}${sep}`), ''] : ['']
  const sw = pen.width(site, lf)
  const lead = ways.find((t) => pen.width(t, lf) + sw <= inner) ?? ''
  const lw = pen.width(lead, lf)
  const x = S.W / 2 - (lw + sw) / 2
  pen.put(lead, x, base, lf, rgb(p.muted), box)
  pen.put(site, x + lw, base, lf, rgb(p.text2), box)
  return top
}

export type DrawOptions = {
  /** Backing pixels per card pixel: the preview draws at the size it is shown, times the screen's density. */
  scale?: number
  /** Filled with every word drawn and the room it had (`cardIssues` reads it). */
  audit?: TextBox[]
  /** Filled with the blocks the layout chose, for tuning. */
  trace?: string[]
  /** Filled with what the card had to shorten that the sender wrote: the note, cut to fit. */
  said?: { noteCut: boolean; /** The week-by-week strip was asked for and the card had no room for it. */ weeksLeft?: boolean; /** The lines that stand for rows left off a side (`moreText`), as drawn. */ hidden?: string[] }
}

/** Draws the card onto `canvas` (sized to the format). Synchronous: whatever pictures are here are drawn. */
export const drawTradeCard = (canvas: HTMLCanvasElement, card: TradeCard, format: CardFormat, palette: Palette, opt: DrawOptions = {}) => {
  const S = SPECS[format]
  const scale = opt.scale ?? 1
  const cw = Math.max(1, Math.round(S.W * scale))
  const ch = Math.max(1, Math.round(S.H * scale))
  if (canvas.width !== cw) canvas.width = cw
  if (canvas.height !== ch) canvas.height = ch
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no canvas')
  ctx.setTransform(cw / S.W, 0, 0, ch / S.H, 0, 0)
  ctx.textBaseline = 'alphabetic'
  const p = legible(palette)
  ctx.fillStyle = rgb(p.panel)
  ctx.fillRect(0, 0, S.W, S.H)
  if (opt.said) {
    opt.said.noteCut = false
    opt.said.weeksLeft = !!card.strip
    opt.said.hidden = []
  }
  const e: Env = { ctx, p, pen: makePen(ctx, opt.audit), S, card, memo: new Map(), said: opt.said }
  const gap = MIN_GAP(S)
  const top = drawHeader(e) + gap
  const bottom = drawFooter(e) - gap
  const area = { x: S.pad, y: top, w: S.W - S.pad * 2, h: bottom - top }
  const all = { sides: true, stats: true, strip: true, note: true }
  const trace = (plans: Plan[]) => opt.trace?.push(...plans.map((x) => `${x.what} ${x.score.toFixed(1)}`))

  if (!S.wide) {
    const col = chooseColumn(e, area.w, area.h, all)
    if (col) {
      trace(col.plans)
      place(e, col.plans, area)
    } else lastResort(e, area, opt)
    return canvas
  }

  // Wide: the note across the top, then the sides at the left and the figures, the strip among them, in a column at
  // the right; a card with neither figures nor strip is one column.
  type Pick = { score: number; draw: () => void; plans: Plan[] }
  let pick: Pick | null = null
  const consider = (x: Pick) => {
    if (!pick || x.score > pick.score) pick = x
  }
  if (!card.stats.length && !card.strip) {
    const one = chooseColumn(e, area.w, area.h, all)
    if (one) consider({ score: one.score, plans: one.plans, draw: () => place(e, one.plans, area) })
  } else
    for (const lines of card.note ? [S.noteLines, 1] : [0]) {
      const note = lines ? planNote(e, area.w, lines) : null
      const below = { ...area, y: area.y + (note ? note.h + gap : 0), h: area.h - (note ? note.h + gap : 0) }
      for (const share of [0.28, 0.34, 0.4, 0.46]) {
        const rw = Math.round(below.w * share)
        const lw = below.w - rw - gap * 2
        const left = chooseColumn(e, lw, below.h, { sides: true, stats: false, strip: false, note: false })
        const right = chooseColumn(e, rw, below.h, { sides: false, stats: true, strip: true, note: false })
        if (!left || !right) continue
        consider({
          score: left.score + right.score + (note?.score ?? 0) + 2,
          plans: [...(note ? [note] : []), ...left.plans, ...right.plans],
          draw: () => {
            note?.draw(area.x, area.y)
            // The figures' rule level with the first rule under a side's head, where there is the height for it, so
            // the first figure and the first player share a line; the pair centred as one.
            const off = Math.max(0, Math.min(left.plans[0]?.rule ?? 0, below.h - right.h))
            const h = Math.max(left.h, right.h + off)
            const col = { ...below, y: below.y + Math.max(0, (below.h - h) / 2), h }
            place(e, left.plans, { ...col, w: lw }, false)
            e.ctx.fillStyle = rgb(p.line)
            e.ctx.fillRect(below.x + lw + gap - 1, col.y, 2, h)
            place(e, right.plans, { ...col, y: col.y + off, x: below.x + lw + gap * 2, w: rw }, false)
          },
        })
      }
    }
  const chosen = pick as Pick | null
  if (chosen) {
    trace(chosen.plans)
    chosen.draw()
  } else lastResort(e, area, opt)
  return canvas
}

/**
 * Nothing fits even at its tightest (dozens of players, every figure and the longest note): one line of note, the
 * sides in two columns of as many rows as there is room for, and as many figures as fit after them.
 */
const lastResort = (e: Env, r: Rect, opt: DrawOptions) => {
  const { S, card } = e
  const gap = MIN_GAP(S)
  const note = card.note ? planNote(e, r.w, 1) : null
  const n = card.stats.length
  let fallback: Plan[] = []
  for (let k = n; k >= (n ? 1 : 0); k--) {
    const list = k || card.strip ? (card.strip ? planStats(e, r.w, { mode: 'list', cols: 1, sub: false, cap: k, strip: 'row' }) : null) ?? (k ? planStats(e, r.w, { mode: 'list', cols: 1, sub: false, cap: k }) : null) : null
    for (let cap = 6; cap >= 1; cap--) {
      const sides = [true, false].flatMap((ledger) => [2, 1].map((cols) => planSides(e, r.w, { kind: 'line', cols, cap, zoom: 1, ppw: false, ledger }))).find((x) => x && x.h <= r.h) ?? planSides(e, r.w, { kind: 'line', cols: 1, cap, zoom: 1, ppw: false })
      if (!sides) continue
      const plans = [note, sides, list].filter((x): x is Plan => !!x)
      fallback = plans
      if (heightOf(plans, gap) <= r.h) {
        opt.trace?.push(...plans.map((x) => `${x.what} last`))
        return place(e, plans, r)
      }
    }
  }
  opt.trace?.push('last resort')
  place(e, fallback, r)
}

/**
 * What is wrong with a drawn card, from its audit: a word wider than its room or outside it, outside the safe area,
 * under the size's floor, or over another word. Empty when the card is clean.
 */
export const cardIssues = (audit: TextBox[], format: CardFormat) => {
  const S = SPECS[format]
  const out: string[] = []
  const eps = 0.75
  for (const t of audit) {
    if (t.what === 'deco') continue
    if (t.px < S.min - 0.01) out.push(`small ${t.px}px: ${t.text}`)
    if (t.x < t.box.x - eps || t.x + t.w > t.box.x + t.box.w + eps) out.push(`overflow ${Math.round(t.x + t.w - t.box.x - t.box.w)}px: ${t.text}`)
    if (t.y < t.box.y - eps - t.px * 0.15 || t.y + t.h > t.box.y + t.box.h + eps + t.px * 0.15) out.push(`out of its row: ${t.text}`)
    if (t.x < S.pad - eps || t.x + t.w > S.W - S.pad + eps || t.y < S.pad - t.px * 0.2 - eps || t.y + t.h > S.H - S.pad + t.px * 0.2 + eps) out.push(`outside the safe area: ${t.text}`)
  }
  const words = audit.filter((t) => t.what !== 'deco')
  for (let i = 0; i < words.length; i++)
    for (let j = i + 1; j < words.length; j++) {
      const a = words[i]
      const b = words[j]
      if (a.x < b.x + b.w - eps && b.x < a.x + a.w - eps && a.y < b.y + b.h - eps && b.y < a.y + a.h - eps) out.push(`overlap: ${a.text} / ${b.text}`)
    }
  return out
}

/** The finished card in a new canvas: fonts and pictures first, then the draw. */
export const renderTradeCard = async (card: TradeCard, format: CardFormat, p: Palette) => {
  await Promise.all([loadCardFonts(), loadPictures(cardSources(card))])
  return drawTradeCard(document.createElement('canvas'), card, format, p)
}
