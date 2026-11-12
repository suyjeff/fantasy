import { graphemes, nameVariants, playerNameVariants, subVariants, type CardSide, type CardStat, type TradeCard } from '../lib/tradeShare'
import type { TrimmedPlayer } from '../lib/types'
import { DARK, LIGHT, loadImage, readPalette, rgb, type Palette } from './shareCards'
import { playerImage } from './ui'

// The trade card, drawn on a canvas as the Power Rank cards are (shareCards.ts): the same faces, colours, hairlines and
// registration marks, so a shared trade looks like the app it came from. Three sizes: a square for chats, the
// 1200×630 link preview, and a tall one for stories. Drawing is synchronous and takes a few milliseconds, so the share
// sheet redraws its preview on every change; the pictures (headshots, team avatars) are fetched once and kept, and a
// draw before they arrive leaves a plain tile in their place.
//
// Most people see the card small: a chat thumbnail about 220px wide, a link preview about 300px. So every size has a
// floor its words never go under (a ninth of an inch at that size, 44px on the square and 36px on the wide), and the
// card says less, not smaller, when it is full: a long name gives up its first name or last words, a figure's note
// its last part, the week strip its heading, a face its tile, and only then do rows pack into columns. Each block
// offers the ways it can be set out, from fullest to tightest; the card takes the fullest set of them that fits.

export type CardFormat = 'square' | 'og' | 'story'
export const FORMATS: Record<CardFormat, { w: number; h: number; label: string; hint: string }> = {
  square: { w: 1080, h: 1080, label: 'Square', hint: '1080×1080 · chats' },
  og: { w: 1200, h: 630, label: 'Wide', hint: '1200×630 · link preview' },
  story: { w: 1080, h: 1350, label: 'Tall', hint: '1080×1350 · stories' },
}
export type CardTheme = 'app' | 'dark' | 'light'
export const paletteOf = (theme: CardTheme): Palette => (theme === 'dark' ? DARK : theme === 'light' ? LIGHT : readPalette())

// The app's faces, with colour emoji and the system's own faces behind them, so a name in another script or with an
// emoji in it still draws (and measures) as itself.
const EMOJI = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"'
const SANS = `"IBM Plex Sans", system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Noto Sans CJK JP", sans-serif, ${EMOJI}`
const MONO = `"Chivo Mono", ui-monospace, Menlo, Consolas, monospace, ${EMOJI}`

// ---- Pictures and fonts, fetched once ----

const pictures = new Map<string, HTMLImageElement | null>()
const pending = new Map<string, Promise<HTMLImageElement | null>>()

export const playerSrc = (id: string, pos: string) => playerImage(id, { pos } as TrimmedPlayer)

/** Every picture a card draws. */
export const cardSources = (card: TradeCard, avatars: Record<number, string | null>) => [
  ...card.sides.flatMap((s) => s.players.map((p) => playerSrc(p.id, p.pos))),
  ...card.sides.map((s) => s.avatar ?? avatars[s.rosterId] ?? null).filter((x): x is string => !!x),
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
    const sample = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 +−–·→⇄$/.,:’“”…'
    fontsReady = Promise.all([
      ...['400', '500', '600'].map((w) => document.fonts.load(`${w} 40px "IBM Plex Sans"`, sample)),
      document.fonts.load(`italic 500 40px "IBM Plex Sans"`, sample),
      ...['400', '500', '600'].map((w) => document.fonts.load(`${w} 40px "Chivo Mono"`, sample)),
    ])
      .then(() => document.fonts.ready)
      .then(() => undefined)
      .catch(() => undefined)
  }
  return fontsReady
}

// ---- The scale ----

/**
 * One size's measures. Every length is on an 8px grid (`u`) and every word is at least `min`, which is about 9px when
 * the card is seen `thumb` wide. `name` and `value` are where a line starts and may come down to `min` and `valueMin`.
 */
type Spec = {
  W: number
  H: number
  /** The safe area's margin: nothing is drawn inside it but the ground. */
  pad: number
  u: number
  min: number
  thumb: number
  label: number
  title: number
  titleMin: number
  name: number
  value: number
  valueMin: number
  note: number
  face: number
  faceS: number
  avatar: number
  /** Lines a title may take. */
  titleLines: number
  noteLines: number
}
const SQUARE: Spec = { W: 1080, H: 1080, pad: 56, u: 8, min: 44, thumb: 220, label: 44, title: 72, titleMin: 56, name: 54, value: 96, valueMin: 60, note: 44, face: 104, faceS: 64, avatar: 48, titleLines: 2, noteLines: 3 }
const SPECS: Record<CardFormat, Spec> = {
  square: SQUARE,
  story: { ...SQUARE, H: 1350, title: 80, value: 104 },
  og: { W: 1200, H: 630, pad: 40, u: 8, min: 36, thumb: 300, label: 36, title: 54, titleMin: 44, name: 42, value: 72, valueMin: 44, note: 36, face: 72, faceS: 48, avatar: 36, titleLines: 1, noteLines: 2 },
}
/** The least a word may be on a card of this size, and the size it is judged at: for the tests and the sheet. */
export const cardFloor = (format: CardFormat) => ({ px: SPECS[format].min, thumb: SPECS[format].thumb, pad: SPECS[format].pad })

// ---- Drawing, with a record of every word ----

type Ctx = CanvasRenderingContext2D
type Rect = { x: number; y: number; w: number; h: number }
type Font = { px: number; w?: number; mono?: boolean; italic?: boolean; track?: number }

/** Where a word was drawn and the room it was given: the overflow check reads these (`cardIssues`). */
export type TextBox = { text: string; x: number; y: number; w: number; h: number; px: number; box: Rect; what: string }

const fontOf = (f: Font) => `${f.italic ? 'italic ' : ''}${f.w ?? 400} ${Math.round(f.px)}px ${f.mono ? MONO : SANS}`

type Pen = ReturnType<typeof makePen>
const makePen = (ctx: Ctx, audit?: TextBox[]) => {
  const cache = new Map<string, Map<string, number>>()
  const set = (f: Font) => {
    ctx.font = fontOf(f)
    // Not everywhere yet; the labels just sit a touch tighter without it.
    ;(ctx as Ctx & { letterSpacing?: string }).letterSpacing = `${f.track ?? 0}px`
  }
  /** The width a string takes, without the spacing after its last letter. */
  const width = (text: string, f: Font) => {
    const key = `${f.px}|${f.w ?? 400}|${f.mono ? 1 : 0}|${f.italic ? 1 : 0}|${f.track ?? 0}`
    let byText = cache.get(key)
    if (!byText) cache.set(key, (byText = new Map()))
    let w = byText.get(text)
    if (w == null) {
      set(f)
      w = Math.max(0, ctx.measureText(text).width - (text ? (f.track ?? 0) : 0))
      byText.set(text, w)
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
  const put = (text: string, x: number, y: number, f: Font, colour: string, box: Rect, align: CanvasTextAlign = 'left', what = 'text') => {
    if (!text) return 0
    set(f)
    ctx.fillStyle = colour
    ctx.textAlign = align
    ctx.fillText(text, x, y)
    const w = width(text, f)
    const x0 = align === 'left' ? x : align === 'right' ? x - w : x - w / 2
    audit?.push({ text, x: x0, y: y - f.px * 0.4, w, h: f.px * 0.8, px: f.px, box, what })
    ctx.textAlign = 'left'
    return w
  }
  /** Words wrapped to a width in at most `max` lines, the last cut with an ellipsis if the rest will not go. */
  const wrap = (text: string, f: Font, w: number, max: number) => {
    const words = text.split(' ')
    const lines: string[] = []
    let cur = ''
    for (const word of words) {
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

const ground = (ctx: Ctx, p: Palette, w: number, h: number) => {
  ctx.fillStyle = rgb(p.panel)
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = rgb(p.line2, 0.8)
  for (let y = 12; y < h; y += 24) for (let x = 12; x < w; x += 24) ctx.fillRect(x, y, 2, 2)
  ctx.fillStyle = rgb(p.accent)
  ctx.fillRect(0, 0, w, 10)
  // Registration crosshairs at the corners, like a plotted sheet.
  ctx.strokeStyle = rgb(p.line2)
  ctx.lineWidth = 2
  for (const [x, y] of [
    [24, 34],
    [w - 24, 34],
    [24, h - 24],
    [w - 24, h - 24],
  ]) {
    ctx.beginPath()
    ctx.moveTo(x - 7, y)
    ctx.lineTo(x + 7, y)
    ctx.moveTo(x, y - 7)
    ctx.lineTo(x, y + 7)
    ctx.stroke()
  }
}

/** A panel: solid, so the dot grid never runs under text, with a hairline edge. */
const box = (ctx: Ctx, p: Palette, r: Rect, fill = p.panel) => {
  ctx.fillStyle = rgb(fill)
  ctx.fillRect(r.x, r.y, r.w, r.h)
  ctx.strokeStyle = rgb(p.line2)
  ctx.lineWidth = 2
  ctx.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2)
}

/** A square picture, covering its tile from the top as the app does, or a letter in its place. */
const picture = (ctx: Ctx, p: Palette, src: string | null, letter: string, x: number, y: number, size: number) => {
  ctx.fillStyle = rgb(p.sunken)
  ctx.fillRect(x, y, size, size)
  const img = src ? pictures.get(src) : null
  if (img) {
    const s = Math.min(img.naturalWidth, img.naturalHeight)
    ctx.drawImage(img, (img.naturalWidth - s) / 2, 0, s, s, x, y, size, size)
  } else if (!src || pictures.has(src)) {
    // Failed or none: the letter. Still loading: the plain tile, so the letter never flashes before the face.
    ctx.fillStyle = rgb(p.muted)
    ctx.font = `500 ${Math.round(size * 0.44)}px ${MONO}`
    ;(ctx as Ctx & { letterSpacing?: string }).letterSpacing = '0px'
    ctx.textAlign = 'center'
    ctx.fillText(letter.toUpperCase(), x + size / 2, y + size / 2 + 1)
    ctx.textAlign = 'left'
  }
  ctx.strokeStyle = rgb(p.line2)
  ctx.lineWidth = 2
  ctx.strokeRect(x + 1, y + 1, size - 2, size - 2)
}

// ---- Blocks ----

/** A block planned for a width: the least height it needs, how much more it can use, and how to draw it in a rect. */
type Plan = { h: number; grow: number; score: number; draw: (r: Rect) => void; what?: string }

type Env = { ctx: Ctx; p: Palette; pen: Pen; S: Spec; card: TradeCard; avatars: Record<number, string | null>; memo: Map<string, unknown>; said?: DrawOptions['said'] }
/** A plan made once per draw: the layout search asks for the same block at the same width many times. */
const memo = <T,>(e: Env, key: string, make: () => T): T => {
  if (!e.memo.has(key)) e.memo.set(key, make())
  return e.memo.get(key) as T
}

const label = (S: Spec, px = S.label): Font => ({ px, w: 500, mono: true, track: Math.round(px * 0.06) })

// The sides. A side is a head ("EMILLIONAIRES GETS") and its rows. A row is a player, the FAAB it takes in, or, past
// what fits, "+3 MORE". Rows come in three kinds: `rich` (face, name, and a line of position, team and sender under
// it), `line` (a small face or none, the name with its position after it, the sender at the right) and `dense` (the
// name alone, in columns). The points a week, when shown, close every row, under a unit set once in the head.

type Kind = 'rich' | 'line' | 'dense'
type SideOpt = { arr: 'stack' | 'cols' | 'ledger'; kind: Kind; cols: number; face: boolean; cap: number; ppw?: boolean; wrap?: boolean; zoom?: number; narrow?: boolean; tight?: boolean }

/** The measures of the sides at a larger size, for a small trade on a roomy card: the floor rises with them. */
const zoomed = (S: Spec, z: number): Spec => ({ ...S, min: Math.round(S.min * z), label: Math.round(S.label * z), name: Math.round(S.name * z), face: Math.round(S.face * z), faceS: Math.round(S.faceS * z), avatar: Math.round(S.avatar * z) })
type Item = { t: 'player'; i: number } | { t: 'faab' } | { t: 'none' } | { t: 'more'; n: number }

const itemsOf = (s: CardSide) => {
  const out: Item[] = s.players.map((_, i) => ({ t: 'player', i }))
  if (s.faab) out.push({ t: 'faab' })
  if (!out.length) out.push({ t: 'none' })
  return out
}

const rowHeight = (S: Spec, kind: Kind, face: boolean) =>
  kind === 'rich' ? Math.max(S.face, S.name + S.u + S.min) + S.u * 3 : kind === 'line' ? Math.max(face ? S.faceS : 0, S.name) + S.u * 3 : S.min + S.u * 2.5
const headHeight = (S: Spec, lines: number) => lines * S.label + (lines - 1) * S.u + S.u * 3

/** The points a week as each row prints it. */
const ppwText = (v: number) => v.toFixed(1)

/**
 * One row, laid out for a width: what it says and how much it gave up to fit (`loss`: 0 says everything; a name
 * initialled, a sender dropped and a name cut cost more in turn), and how to draw it.
 */
/** A player's name in three forms, longest first: whole, initialled, surname (a form a name lacks repeats the last). */
const forms = new Map<string, string[]>()
const nameForms = (name: string) => {
  let out = forms.get(name)
  if (!out) {
    const v = playerNameVariants(name)
    out = v.length === 3 ? v : v.length === 2 ? [v[0], v[0], v[1]] : [v[0], v[0], v[0]]
    if (forms.size > 2000) forms.clear()
    forms.set(name, out)
  }
  return out
}

/** The form every name on a side takes, and its size: one for all, so a column never mixes "C. McCaffrey" and "Jefferson". */
type NameForm = { level: number; px: number }

const planRow = (e: Env, s: CardSide, item: Item, w: number, kind: Kind, face: boolean, ppwW: number, form?: NameForm) => {
  const { S, pen, p } = e
  const nameF: Font = { px: S.name, w: 600 }
  const metaF: Font = { px: S.min, w: 500, mono: true, track: 1 }
  const tagF: Font = { px: S.min, w: 600, mono: true, track: 1 }
  const faceW = kind === 'rich' ? S.face : kind === 'line' && face ? S.faceS : 0
  const gap = S.u * 2
  const x0 = faceW ? faceW + gap : 0
  const right = w - (ppwW ? ppwW + gap : 0)
  let loss = 0
  type Op = (r: Rect, cy: number) => void
  const ops: Op[] = []

  if (item.t === 'none' || item.t === 'more') {
    const f: Font = item.t === 'none' ? { px: S.name, w: 400 } : label(S, S.min)
    const ways = item.t === 'none' ? ['Nothing back', 'Nothing'] : [`+${item.n} MORE`, `+${item.n}`]
    ops.push((r, cy) => pen.put(pen.first(ways, f, r.w), r.x, cy, f, rgb(p.muted), r))
    return { loss: 0, need: null, nameRoom: 0, name: null, draw: (r: Rect) => ops.forEach((o) => o(r, r.y + r.h / 2)) }
  }
  if (item.t === 'faab') {
    const f: Font = { px: kind === 'dense' ? S.min : S.name, w: 600, mono: true }
    const text = `$${s.faab}`
    const word = 'FAAB'
    const two = kind === 'rich'
    ops.push((r, cy) => {
      if (faceW) {
        const fy = cy - faceW / 2
        e.ctx.fillStyle = rgb(p.sunken)
        e.ctx.fillRect(r.x, fy, faceW, faceW)
        e.ctx.strokeStyle = rgb(p.line2)
        e.ctx.lineWidth = 2
        e.ctx.strokeRect(r.x + 1, fy + 1, faceW - 2, faceW - 2)
        e.pen.put('$', r.x + faceW / 2, cy + 1, { px: Math.round(faceW * 0.44), w: 500, mono: true }, rgb(p.text2), { x: r.x, y: fy, w: faceW, h: faceW }, 'center', 'deco')
      }
      const box = { x: r.x + x0, y: r.y, w: r.w - x0, h: r.h }
      if (two) {
        pen.put(text, r.x + x0, cy - (S.min + S.u) / 2, f, rgb(p.text), box)
        pen.put(word, r.x + x0, cy + (S.name + S.u) / 2, metaF, rgb(p.muted), box)
        return
      }
      const tw = pen.put(text, r.x + x0, cy, f, rgb(p.text), box)
      if (x0 + tw + S.u * 1.5 + pen.width(word, metaF) <= r.w) pen.put(word, r.x + x0 + tw + S.u * 1.5, cy, metaF, rgb(p.muted), box)
    })
    return { loss: 0, need: null, nameRoom: 0, name: null, draw: (r: Rect) => ops.forEach((o) => o(r, r.y + r.h / 2)) }
  }

  const pl = s.players[item.i]
  const names = nameForms(pl.name)
  const fromWays = pl.from ? nameVariants(pl.from).map((n) => `FROM ${n.toUpperCase()}`) : []
  const tag = pl.tag ? pl.tag.toUpperCase() : null
  const tagW = tag ? pen.width(tag, tagF) + S.u * 2 : 0
  const pos = pl.pos || ''
  const nf = (px: number): Font => ({ ...nameF, px })
  /**
   * The name at the largest size and fullest form that fits `room`, and what it cost; or, given the side's form, in
   * that form (cut only if even it will not go).
   */
  let need: NameForm | null = null
  let nameRoom = 0
  const fitName = (room: number) => {
    nameRoom = room
    const top = kind === 'dense' ? S.min : S.name
    for (let v = 0; v < names.length && !need; v++)
      for (let px = top; px >= S.min; px -= 2)
        if (pen.width(names[v], nf(px)) <= room) {
          need = { level: v, px }
          break
        }
    need ??= { level: names.length - 1, px: S.min }
    const f = form ?? need
    const text = names[f.level]
    if (pen.width(text, nf(f.px)) <= room) return { text, px: f.px, loss: f.level }
    return { text: pen.cut(text, nf(S.min), room), px: S.min, loss: 10 }
  }

  if (kind === 'rich') {
    const nm = fitName(right - x0)
    loss += nm.loss
    // The line under the name: position, then team, sender and timing, each giving way in turn: the team first, then
    // the sender's name shortens, then the timing tag goes (the Timing figure says it too), then the sender.
    const room = w - x0
    const posW = pen.width(pos, metaF)
    const sep = pen.width(' · ', metaF)
    let team = pl.team ?? 'FA'
    let from = fromWays[0] ?? null
    let showTag = !!tag
    const used = () => posW + (team ? sep + pen.width(team, metaF) : 0) + (from ? sep + pen.width(from, metaF) : 0) + (showTag ? tagW + S.u * 1.5 : 0)
    if (used() > room && from) team = ''
    for (let i = 1; used() > room && from && i < fromWays.length; i++) from = fromWays[i]
    if (used() > room && showTag) {
      showTag = false
      loss += 1
    }
    if (used() > room && from) {
      from = null
      loss += 2
    }
    if (used() > room) team = ''
    if (pl.from && from !== fromWays[0]) loss += 0.5
    ops.push((r, cy) => {
      picture(e.ctx, p, playerSrc(pl.id, pl.pos), graphemes(pl.name.trim())[0] ?? '?', r.x, Math.round(cy - S.face / 2), S.face)
      const l1 = cy - (S.min + S.u) / 2
      const l2 = cy + (nm.px + S.u) / 2
      const box = { x: r.x + x0, y: r.y, w: right - x0, h: r.h }
      pen.put(nm.text, r.x + x0, l1, nf(nm.px), rgb(p.text), box)
      const mbox = { x: r.x + x0, y: r.y, w: room, h: r.h }
      let x = r.x + x0 + pen.put(pos, r.x + x0, l2, metaF, rgb(p.text2), mbox)
      const rest = [team, from].filter(Boolean).map((t) => ` · ${t}`).join('')
      x += pen.put(rest, x, l2, { ...metaF, w: 400 }, rgb(p.muted), mbox)
      if (showTag && tag) chip(e, tag, x + S.u * 1.5, l2, tagF, mbox)
    })
  } else {
    // One line: the face, the name, its position after it, and the sender at the right.
    const posF: Font = { ...metaF, w: 500 }
    const posW = pos ? pen.width(pos, posF) + S.u * 1.5 : 0
    let from: string | null = kind === 'line' ? (fromWays[0] ?? null) : null
    let showTag = kind === 'line' && !!tag
    let showPos = !!pos
    const after = () => (from ? pen.width(from, metaF) + gap : 0) + (showTag ? tagW + gap : 0)
    // The name keeps at least its surname at the floor; what follows it gives way first.
    const least = () => pen.width(names[names.length - 1], nf(S.min)) + (showPos ? posW : 0)
    for (let i = 1; from && least() + after() > right - x0 && i < fromWays.length; i++) from = fromWays[i]
    if (showTag && least() + after() > right - x0) {
      showTag = false
      loss += 1
    }
    if (from && least() + after() > right - x0) {
      from = null
      loss += 2
    }
    if (showPos && least() > right - x0) {
      showPos = false
      loss += 0.5
    }
    if (pl.from && kind === 'line' && from && from !== fromWays[0]) loss += 0.5
    if (pl.from && kind === 'dense') loss += 1.5
    const nm = fitName(right - x0 - after() - (showPos ? posW : 0))
    loss += nm.loss
    ops.push((r, cy) => {
      if (faceW) picture(e.ctx, p, playerSrc(pl.id, pl.pos), graphemes(pl.name.trim())[0] ?? '?', r.x, Math.round(cy - faceW / 2), faceW)
      const box = { x: r.x + x0, y: r.y, w: right - x0, h: r.h }
      const nw = pen.put(nm.text, r.x + x0, cy, nf(nm.px), rgb(p.text), box)
      if (showPos) pen.put(pos, r.x + x0 + nw + S.u * 1.5, cy, posF, rgb(p.muted), box)
      let rx = r.x + right
      if (from) rx -= pen.put(from, rx, cy, { ...metaF, w: 400 }, rgb(p.muted), box, 'right') + gap
      if (showTag && tag) chip(e, tag, rx - tagW, cy, tagF, box)
    })
  }
  if (ppwW && pl.ppw != null) {
    const f: Font = { px: kind === 'dense' ? S.min : S.name, w: 500, mono: true }
    ops.push((r, cy) => pen.put(ppwText(pl.ppw!), r.x + w, kind === 'rich' ? cy - (S.min + S.u) / 2 : cy, f, rgb(p.text), { x: r.x + w - ppwW, y: r.y, w: ppwW, h: r.h }, 'right'))
  }
  return { loss, need: need as NameForm | null, nameRoom, name: pl.name, draw: (r: Rect) => ops.forEach((o) => o(r, r.y + r.h / 2)) }
}

/** A small tag in the positive colour: "BUY LOW". */
const chip = (e: Env, text: string, x: number, cy: number, f: Font, room: Rect) => {
  const w = e.pen.width(text, f) + e.S.u * 2
  const h = f.px + e.S.u
  e.ctx.fillStyle = rgb(e.p.pos, 0.14)
  e.ctx.fillRect(x, cy - h / 2, w, h)
  e.pen.put(text, x + e.S.u, cy + 1, f, rgb(e.p.pos), room)
}

/**
 * A side's head: its avatar, "EMILLIONAIRES GETS", and the unit of the figures at the right of its rows. A name too long
 * for one line takes two where the layout has the height, else the shorter ways of saying it.
 */
const planHead = (e: Env, s: CardSide, w: number, unit: string | null, twoLines: boolean) => {
  const { S, pen, p } = e
  const f = label(S)
  const src = s.avatar ?? e.avatars[s.rosterId] ?? null
  const av = src ? S.avatar : 0
  const left = av ? av + S.u * 2 : 0
  const unitW = unit ? pen.width(unit, { ...f, w: 400 }) + S.u * 3 : 0
  const room = w - left - unitW
  const { lines, loss } = headLines(e, s, room, twoLines ? 2 : 1)
  const h = headHeight(S, lines.length)
  const draw = (r: Rect) => {
    if (s.focus) {
      e.ctx.fillStyle = rgb(p.accent, 0.08)
      e.ctx.fillRect(r.x, r.y, r.w, h)
      e.ctx.fillStyle = rgb(p.accent)
      e.ctx.fillRect(r.x, r.y, r.w, 6)
    }
    const pad = S.u * 3
    const cy = r.y + h / 2 + 2
    const hx = r.x + pad
    if (av) picture(e.ctx, p, src, s.head, hx, Math.round(cy - av / 2), av)
    const lh = S.label + S.u
    const box = { x: hx + left, y: r.y, w: room, h }
    lines.forEach((l, i) => pen.put(l, hx + left, cy - ((lines.length - 1) * lh) / 2 + i * lh, f, rgb(s.focus ? p.accent : p.text2), box))
    if (unit) pen.put(unit, r.x + r.w - pad, cy, { ...f, w: 400 }, rgb(p.muted), { x: r.x + r.w - pad - unitW, y: r.y, w: unitW, h }, 'right')
    e.ctx.fillStyle = rgb(p.line)
    e.ctx.fillRect(r.x, r.y + h, r.w, 2)
  }
  return { h, loss, lines: lines.length, draw }
}

/**
 * "EMILLIONAIRES GETS" in a width: whole on one line; whole on two, where it may; else a shorter way of saying the
 * team, the verb always kept ("SHOW ME YOUR… GETS" still says which way the players go).
 */
const headLines = (e: Env, s: CardSide, room: number, max: number) => memo(e, `head|${s.rosterId}|${Math.round(room)}|${max}|${e.S.label}`, () => headLines0(e, s, room, max))
const headLines0 = (e: Env, s: CardSide, room: number, max: number) => {
  const { pen } = e
  const f = label(e.S)
  const verb = / (gets|sends)$/i.exec(s.head)
  const who = verb ? s.head.slice(0, -verb[0].length) : s.head
  const tail = verb ? ` ${verb[1].toUpperCase()}` : ''
  const ways = nameVariants(who).map((n) => `${n.toUpperCase()}${tail}`)
  const two = (t: string) => {
    if (max < 2) return null
    const ls = pen.wrap(t, f, room, 2)
    return ls.length === 2 && ls.join(' ') === t && ls.every((l) => pen.width(l, f) <= room) ? ls : null
  }
  for (let i = 0; i < ways.length; i++) {
    if (pen.width(ways[i], f) <= room) return { lines: [ways[i]], loss: i <= 1 ? 0 : 1 }
    const ls = two(ways[i])
    if (ls) return { lines: ls, loss: i <= 1 ? 0 : 1 }
  }
  const name = pen.cut(nameVariants(who)[1] ?? who, f, room - pen.width(tail, f))
  // A name cut to less than a few letters says nothing: that is no way to set this head.
  const kept = graphemes(name.replace(/…$/, '')).length
  return { lines: [`${name.toUpperCase()}${tail}`.trim()], loss: kept >= 5 ? 6 : kept >= 3 ? 12 : Infinity }
}

/** A ledger's head column: as wide as its longest head needs on two lines, within a fifth and two fifths of the width. */
const ledgerHead = (e: Env, w: number) => {
  const { S, pen } = e
  const f = label(S)
  const pad = S.u * 3
  const most = Math.max(...e.card.sides.map((s) => Math.max(...headLines(e, s, w * 0.5 - pad * 2, 2).lines.map((l) => pen.width(l, f)))))
  return Math.round(Math.max(w * 0.2, Math.min(w * 0.5, most + pad * 2 + S.u)))
}

/** All the sides in one arrangement and row kind, at a width; null when that arrangement cannot work there. */
const planSides = (e: Env, w: number, o: SideOpt): Plan | null => memo(e, `sides|${w}|${JSON.stringify(o)}`, () => planSides0(e, w, o))
const planSides0 = (e0: Env, w: number, o: SideOpt): Plan | null => {
  const e = o.zoom && o.zoom !== 1 ? { ...e0, S: zoomed(e0.S, o.zoom) } : e0
  const { S, card } = e
  const n = card.sides.length
  const pad = S.u * 3
  const ledger = o.arr === 'ledger'
  // Stacked sides are separate panels, a grid step apart: the heads say which way the players go.
  const sideGap = S.u * 2
  const colW = o.arr === 'cols' ? (w - (n - 1) * 2) / n : w
  // In a ledger each side is a row: its head in a column at the left, its players to the right of it.
  const headCol = ledger ? (o.narrow ? Math.round(w * 0.36) : ledgerHead(e, w)) : 0
  const inner = colW - headCol - pad * 2
  const hasPpw = card.sides.some((s) => s.players.some((pl) => pl.ppw != null))
  const showPpw = hasPpw && o.ppw !== false
  const ppwF: Font = { px: o.kind === 'dense' ? S.min : S.name, w: 500, mono: true }
  const ppwW = showPpw ? e.pen.width('00.0', ppwF) : 0
  const cellGap = S.u * 4
  const cellW = (inner - (o.cols - 1) * cellGap) / o.cols
  // Tight: dense rows a grid step closer, for the last resort only.
  const rh = rowHeight(S, o.kind, o.face) - (o.tight && o.kind === 'dense' ? S.u : 0)
  // Too narrow a column for a name and its figure: this arrangement is not for this width.
  if (cellW < S.name * 3.5 + (o.face && o.kind !== 'dense' ? (o.kind === 'rich' ? S.face : S.faceS) : 0) + ppwW) return null
  // The unit of the points a week is said once, in the first head with the room for it beside the whole name.
  const unit = showPpw && !ledger ? 'PTS/WK' : null
  let unitAt = -1
  const heads = card.sides.map((s, i) => {
    if (ledger) {
      // Two lines where the side's rows are that tall anyway, or where one line would cut the name.
      const one = headLines(e, s, headCol - pad * 2, 1)
      const rowsHere = Math.min(o.cap, Math.ceil(itemsOf(s).length / o.cols))
      const lines = (o.wrap && one.loss >= 4) || (one.loss > 0 && rowsHere * rh >= S.label * 2 + S.u * 3) ? headLines(e, s, headCol - pad * 2, 2) : one
      return { h: 0, loss: lines.loss, lines: lines.lines.length, text: lines.lines, draw: () => {} }
    }
    if (unit && unitAt < 0) {
      const withUnit = planHead(e, s, inner, unit, false)
      if (withUnit.loss === 0) {
        unitAt = i
        return withUnit
      }
    }
    return planHead(e, s, inner, null, o.arr === 'stack' || n === 2)
  })
  let loss = heads.reduce((a, h) => a + h.loss, 0) + (unit && unitAt < 0 ? 1 : 0) + (hasPpw && !showPpw ? 2 + card.sides.reduce((a, s) => a + s.players.length, 0) * 0.5 : 0)
  // Side by side, every head is as tall as the tallest.
  const headsH = Math.max(...heads.map((h) => h.h))
  if (heads.some((h) => h.loss === Infinity)) return null
  // A side cut short still shows at least one of its players before saying how many more.
  if (o.cap * o.cols < 2 && card.sides.some((s) => itemsOf(s).length > o.cap * o.cols)) return null
  const sides = card.sides.map((s, i) => {
    let items = itemsOf(s)
    let rows = Math.ceil(items.length / o.cols)
    if (rows > o.cap) {
      const keep = o.cap * o.cols - 1
      loss += (items.length - keep) * 10
      items = [...items.slice(0, keep), { t: 'more', n: items.length - keep }]
      rows = o.cap
    }
    const plan = (form?: NameForm) =>
      items.map((it) => {
        const pw = it.t === 'player' && s.players[it.i].ppw != null ? ppwW : 0
        return memo(e, `row|${S.name}|${s.rosterId}|${JSON.stringify(it)}|${Math.round(cellW)}|${o.kind}|${o.face}|${pw}|${JSON.stringify(form)}`, () => planRow(e, s, it, cellW, o.kind, o.face, pw, form))
      })
    // Every name on the side in one form: the shortest any of them needs, at the smallest size any needs in it.
    const free = plan().filter((r) => r.need && r.name)
    const level = Math.max(0, ...free.map((r) => r.need!.level))
    const top = o.kind === 'dense' ? S.min : S.name
    const fits = (name: string, room: number) => {
      for (let x = top; x >= S.min; x -= 2) if (e.pen.width(nameForms(name)[level], { px: x, w: 600 }) <= room) return x
      return S.min
    }
    const px = Math.min(top, ...free.map((r) => fits(r.name!, r.nameRoom)))
    const planned = free.length ? plan({ level, px }) : plan()
    loss += planned.reduce((a, r) => a + r.loss, 0)
    const lh = heads[i].lines * S.label + (heads[i].lines - 1) * S.u + S.u * (o.tight ? 1 : 2)
    const h = ledger ? Math.max(lh, rows * rh) + S.u : heads[i].h + rows * rh + S.u * 2
    return { s, head: heads[i], rows, planned, h }
  })
  const h = o.arr === 'cols' ? headsH + Math.max(...sides.map((x) => x.rows)) * rh + S.u * 2 : sides.reduce((a, x) => a + x.h, 0) + (ledger ? 0 : sideGap * (n - 1))
  const rowsTotal = o.arr === 'cols' ? Math.max(...sides.map((x) => x.rows)) : sides.reduce((a, x) => a + x.rows, 0)
  const kindScore = { rich: 60, line: o.face ? 50 : 46, dense: 40 - o.cols * 4 }[o.kind]
  const grow = rowsTotal * Math.round(rh * (S.W > S.H ? 0.5 : 0.35))
  const rows = (x: (typeof sides)[number], cell: Rect, top: number, rowH: number) => {
    x.planned.forEach((row, k) => {
      const col = k % o.cols
      const line = Math.floor(k / o.cols)
      const y = top + line * rowH
      if (line > 0 && col === 0) {
        e.ctx.fillStyle = rgb(e.p.line)
        e.ctx.fillRect(cell.x + pad, Math.round(y), cell.w - pad * 2, 2)
      }
      row.draw({ x: cell.x + pad + col * (cellW + cellGap), y, w: cellW, h: rowH })
    })
    for (let c = 1; c < o.cols; c++) {
      e.ctx.fillStyle = rgb(e.p.line2)
      e.ctx.fillRect(Math.round(cell.x + pad + c * (cellW + cellGap) - cellGap / 2) - 1, top + S.u, 2, x.rows * rowH - S.u * 2)
    }
  }
  return {
    h,
    grow,
    score: kindScore - loss * 2.5 - (o.arr === 'cols' ? 0 : o.arr === 'stack' ? 1 : 3) + ((o.zoom ?? 1) - 1) * 12,
    what: `sides ${o.arr} ${o.kind}${o.face ? '+face' : ''} x${o.cols}${o.cap < Infinity ? ` cap${o.cap}` : ''}${o.ppw === false ? ' noppw' : ''} ${o.zoom ? ` zoom${o.zoom}` : ''} loss${loss}`,
    draw: (r: Rect) => {
      const extra = Math.min(grow, r.h - h)
      const rowH = rh + (rowsTotal ? extra / rowsTotal : 0)
      if (o.arr === 'cols') {
        box(e.ctx, e.p, r)
        sides.forEach((x, i) => {
          const cell = { x: r.x + i * (colW + 2), y: r.y, w: colW, h: r.h }
          x.head.draw({ ...cell, h: headsH })
          rows(x, cell, r.y + headsH + S.u, rowH)
        })
        e.ctx.fillStyle = rgb(e.p.line2)
        for (let c = 1; c < n; c++) e.ctx.fillRect(Math.round(r.x + c * (colW + 2)) - 2, r.y, 2, r.h)
        return
      }
      if (ledger) {
        box(e.ctx, e.p, r)
        const spare = r.h - h - extra
        let y = r.y + S.u / 2
        sides.forEach((x, i) => {
          const hh = Math.max(x.head.lines * S.label + (x.head.lines - 1) * S.u + S.u * (o.tight ? 1 : 2), x.rows * rowH) + S.u + spare / n
          if (i) {
            e.ctx.fillStyle = rgb(e.p.line2)
            e.ctx.fillRect(r.x, Math.round(y) - 1, r.w, 2)
          }
          if (x.s.focus) {
            e.ctx.fillStyle = rgb(e.p.accent, 0.08)
            e.ctx.fillRect(r.x, y, headCol, hh)
            e.ctx.fillStyle = rgb(e.p.accent)
            e.ctx.fillRect(r.x, y, 6, hh)
          }
          const lines = (x.head as { text?: string[] }).text ?? []
          const lh = S.label + S.u
          lines.forEach((l, k) => e.pen.put(l, r.x + pad, y + hh / 2 - ((lines.length - 1) * lh) / 2 + k * lh, label(S), rgb(x.s.focus ? e.p.accent : e.p.text2), { x: r.x + pad, y, w: headCol - pad, h: hh }))
          e.ctx.fillStyle = rgb(e.p.line)
          e.ctx.fillRect(r.x + headCol, y + S.u, 2, hh - S.u * 2)
          rows(x, { x: r.x + headCol, y, w: r.w - headCol, h: hh }, y + (hh - x.rows * rowH) / 2, rowH)
          y += hh
        })
        return
      }
      // Stacked: each side its own panel, the room left over shared between them as the rows grow.
      const spare = r.h - h - extra
      let y = r.y
      sides.forEach((x, i) => {
        const hh = x.head.h + x.rows * rowH + S.u * 2
        box(e.ctx, e.p, { x: r.x, y, w: r.w, h: hh })
        x.head.draw({ x: r.x, y, w: r.w, h: x.head.h })
        rows(x, { x: r.x, y, w: r.w, h: hh }, y + x.head.h + S.u, rowH)
        y += hh
        if (i < n - 1) {
          y += sideGap + spare / (n - 1)
        }
      })
    },
  }
}

// The figures. Big numbers in tiles two to a row (a lone one, or one too long for half a row, takes the row), each
// with its label above and its unit attached; the note under a number is the first thing to go, then the tiles become
// a list of label and number, one line each.

type StatOpt = { mode: 'tiles' | 'list'; cols: number; sub: boolean; spark: boolean; cap?: number }

/** A figure's label, longest first: "PLAYOFF ODDS", "PLAYOFFS"; a team's name, in the league's view, as names shorten. */
const statLabels = (card: TradeCard, s: CardStat) => {
  if (card.kind === 'league' && s.key === 'lineup') return nameVariants(s.label).map((t) => t.toUpperCase())
  const l = s.label
  const fill = /^Fills (.+)$/.exec(l)
  const ways = fill ? [l, `${fill[1]} filled`, fill[1]] : l === 'Playoff odds' ? [l, 'Playoffs'] : l === 'Title odds' ? [l, 'Title'] : l === 'Consensus value' ? [l, 'Consensus', 'Value'] : l === 'FAAB in' ? [l, 'FAAB'] : [l, l.split(' ')[0]]
  return [...new Set(ways)].map((t) => t.toUpperCase())
}
/** A unit, longest first: "PTS/WK", "/WK"; "PTS" after a range may go, since the numbers say it. */
const unitWays = (u: string | null) => (!u ? [''] : u === 'pts/wk' ? ['PTS/WK', '/WK'] : u === 'pts' ? ['PTS', ''] : [u.toUpperCase()])

const planStats = (e: Env, stats: CardStat[], w: number, o: StatOpt): Plan | null => memo(e, `stats|${stats.length}|${w}|${JSON.stringify(o)}`, () => planStats0(e, stats, w, o))
const planStats0 = (e: Env, stats0: CardStat[], w: number, o: StatOpt): Plan | null => {
  const { S, pen, p, card } = e
  if (!stats0.length) return { h: 0, grow: 0, score: 0, draw: () => {} }
  // Past the cap, the last figures give way to a line saying how many more there are.
  const cap = Math.min(o.cap ?? Infinity, stats0.length)
  const dropped = stats0.length - cap
  const stats = dropped ? stats0.slice(0, cap - 1) : stats0
  const more = dropped ? dropped + 1 : 0
  const lf = label(S)
  const subF: Font = { px: S.min, mono: true }
  const unitF: Font = { px: S.min, w: 500, mono: true, track: 1 }
  const pad = S.u * 3
  const tp = Math.round(S.u * 2.5)
  const gap = 2
  const unitGap = S.u
  const valueW = (s: CardStat, px: number, unit: string) => pen.width(s.value, { px, w: 600, mono: true }) + (unit ? unitGap + pen.width(unit, unitF) : 0)
  // The week strip folds into the lineup figure as a few bars beside its number, when it has no room of its own.
  const sparkOn = o.spark && !!card.strip && stats.some((s) => s.key === 'lineup')
  const toneOf = (s: CardStat) => (s.tone === 'pos' ? p.pos : s.tone === 'neg' ? p.neg : p.text)

  if (o.mode === 'list') {
    const rh = S.name + S.u * 2
    const vf: Font = { px: S.name, w: 600, mono: true }
    let loss = dropped * 20
    const rows = stats.map((s) => {
      const ways = statLabels(card, s)
      const units = unitWays(s.unit)
      // The fullest label and unit that fit together, the label giving way before the unit.
      for (const unit of units)
        for (const lab of ways) {
          const vw = valueW(s, S.name, unit)
          if (pen.width(lab, lf) + vw + S.u * 4 <= w - pad * 2) {
            loss += (lab !== ways[0] ? 0.5 : 0) + (unit !== units[0] ? 0.5 : 0)
            return { s, lab, unit, vw }
          }
        }
      return null
    })
    if (rows.some((r) => !r)) return null
    const live = rows as NonNullable<(typeof rows)[number]>[]
    const n = live.length + (more ? 1 : 0)
    return {
      h: n * rh + (n - 1) * gap,
      grow: n * S.u * 2,
      score: 6 - loss + (sparkOn ? 4 : 0),
      what: `stats list${dropped ? ` cap${cap}` : ''}${sparkOn ? ' spark' : ''}`,
      draw: (r) => {
        const each = (r.h - (n - 1) * gap) / n
        e.ctx.fillStyle = rgb(p.line2)
        e.ctx.fillRect(r.x, r.y, r.w, r.h)
        live.forEach((row, i) => {
          const y = r.y + i * (each + gap)
          const cell = { x: r.x, y, w: r.w, h: each }
          tile(e, cell, row.s.tone)
          const cy = y + each / 2
          const lw = pen.put(row.lab, r.x + pad, cy, lf, rgb(p.muted), { ...cell, x: r.x + pad, w: r.w - pad * 2 - row.vw })
          const vx = r.x + r.w - pad - row.vw
          const vw = pen.put(row.s.value, vx, cy, vf, rgb(toneOf(row.s)), { ...cell, x: vx, w: row.vw })
          if (row.unit) pen.put(row.unit, vx + vw + unitGap, cy + (S.name - S.min) * 0.18, unitF, rgb(p.muted), { ...cell, x: vx, w: row.vw })
          // The strip, folded in: bars between the label and the number.
          if (sparkOn && row.s.key === 'lineup') {
            const sx = r.x + pad + lw + S.u * 4
            const sw = vx - S.u * 4 - sx
            if (sw > S.u * 12) sparkline(e, card, { x: sx, y: y + S.u, w: Math.min(sw, S.u * 40), h: each - S.u * 2 })
          }
        })
        if (more) {
          const y = r.y + live.length * (each + gap)
          tile(e, { x: r.x, y, w: r.w, h: each }, 'neutral')
          pen.put(pen.first([`+${more} MORE FIGURES`, `+${more} FIGURES`], lf, r.w - pad * 2), r.x + pad, y + each / 2, lf, rgb(p.muted), { x: r.x + pad, y, w: r.w - pad * 2, h: each })
        }
      },
    }
  }
  if (dropped) return null

  // Tiles: rows of up to `cols`; a tile whose number will not fit its share takes a row of its own.
  const half = (w - gap * (o.cols - 1)) / o.cols
  const inner = (tw: number) => tw - pad * 2
  const fits = (s: CardStat, tw: number) => unitWays(s.unit).some((u) => valueW(s, S.valueMin, u) <= inner(tw))
  if (stats.some((s) => !fits(s, w))) return null
  const rowsOf: CardStat[][] = []
  let cur: CardStat[] = []
  for (const s of stats) {
    const lone = !fits(s, half) || (sparkOn && s.key === 'lineup')
    if (lone) {
      if (cur.length) rowsOf.push(cur)
      rowsOf.push([s])
      cur = []
      continue
    }
    cur.push(s)
    if (cur.length === o.cols) {
      rowsOf.push(cur)
      cur = []
    }
  }
  if (cur.length) rowsOf.push(cur)
  let loss = 0
  const rows = rowsOf.map((row) => {
    const tw = (w - gap * (row.length - 1)) / row.length
    const spark = sparkOn && row[0].key === 'lineup' && row.length === 1 ? Math.round(tw * 0.42) : 0
    const room = inner(tw) - (spark ? spark + S.u * 3 : 0)
    // One size for the numbers across a row, the largest every one of them fits with its fullest unit; a unit is
    // shortened only when the number would otherwise go under its floor.
    const unitFor = (s: CardStat, px: number) => unitWays(s.unit).find((u) => valueW(s, px, u) <= room) ?? null
    let px = S.value
    while (px > S.valueMin && row.some((s) => unitFor(s, px) !== unitWays(s.unit)[0])) px -= 2
    const cells = row.map((s) => {
      const unit = unitFor(s, px) ?? ''
      if (unit !== unitWays(s.unit)[0]) loss += 0.5
      const ways = statLabels(card, s)
      const lab = pen.first(ways, lf, room)
      if (lab !== ways[0]) loss += 0.5
      let sub: string | null = null
      if (o.sub && s.sub) {
        const sw = subVariants(s.sub)
        sub = sw.find((t) => pen.width(t, subF) <= room) ?? null
        if (sub !== sw[0]) loss += sub ? 0.25 : 1
      }
      return { s, lab, sub, unit }
    })
    const anySub = cells.some((c) => c.sub)
    const h = tp * 2 + S.label + S.u * 1.5 + Math.round(px * 0.86) + (anySub ? S.u * 1.5 + S.min : 0)
    return { cells, tw, px, h, spark }
  })
  const h = rows.reduce((a, r) => a + r.h, 0) + gap * (rows.length - 1)
  const subs = stats.filter((s) => s.sub).length
  return {
    h,
    grow: rows.length * S.u * 4,
    score: 20 - (o.sub ? 0 : subs * 1.5) - loss - (rows.length > 2 ? 2 : 0) + (sparkOn ? 7 : 0),
    what: `stats tiles${o.sub ? ' sub' : ''}${sparkOn ? ' spark' : ''}`,
    draw: (r) => {
      const extra = (r.h - h) / rows.length
      e.ctx.fillStyle = rgb(p.line2)
      e.ctx.fillRect(r.x, r.y, r.w, r.h)
      let y = r.y
      rows.forEach((row) => {
        const rh = row.h + extra
        row.cells.forEach((c, i) => {
          const x = r.x + i * (row.tw + gap)
          const cell = { x, y, w: i === row.cells.length - 1 ? r.x + r.w - x : row.tw, h: rh }
          tile(e, cell, c.s.tone)
          const room = { x: x + pad, y, w: inner(row.tw) - (row.spark ? row.spark + S.u * 3 : 0), h: rh }
          const block = S.label + S.u * 1.5 + row.px * 0.86 + (c.sub ? S.u * 1.5 + S.min : 0)
          let cy = y + (rh - block) / 2 + (row.cells.some((k) => k.sub) && !c.sub ? (S.u * 1.5 + S.min) / 2 : 0)
          pen.put(c.lab, x + pad, cy + S.label / 2, label(S), rgb(p.muted), room)
          cy += S.label + S.u * 1.5
          const vf: Font = { px: row.px, w: 600, mono: true }
          const vy = cy + (row.px * 0.86) / 2
          const vw = pen.put(c.s.value, x + pad, vy, vf, rgb(toneOf(c.s)), room)
          if (c.unit) pen.put(c.unit, x + pad + vw + unitGap, vy + (row.px - S.min) * 0.2, unitF, rgb(p.muted), room)
          if (c.sub) pen.put(c.sub, x + pad, cy + row.px * 0.86 + S.u * 1.5 + S.min / 2, subF, rgb(p.text2), room)
          if (row.spark) sparkline(e, card, { x: x + cell.w - pad - row.spark, y: y + tp, w: row.spark, h: rh - tp * 2 })
        })
        y += rh + gap
      })
    },
  }
}

const tile = (e: Env, r: Rect, tone: CardStat['tone']) => {
  e.ctx.fillStyle = rgb(e.p.panel)
  e.ctx.fillRect(r.x, r.y, r.w, r.h)
  if (tone !== 'neutral') {
    e.ctx.fillStyle = rgb(tone === 'pos' ? e.p.pos : e.p.neg, 0.08)
    e.ctx.fillRect(r.x, r.y, r.w, r.h)
  }
}

/** The week strip's bars alone, in a figure: no words, so it reads at any size beside the number it backs. */
const sparkline = (e: Env, card: TradeCard, r: Rect) => bars(e, card, r, null)

/**
 * The recipient's lineup change week by week: bars either side of a zero line, gains in the positive colour and the
 * odd losing week in the negative. Colour is never the only cue: a bar's side of the line says which way the week
 * went, and a dashed line at the lineup change a week (the Lineup figure) shows the run as a whole is a gain even
 * when a week or two is not. With `marks`, the best week carries its number and the first and last weeks are named.
 */
const bars = (e: Env, card: TradeCard, r: Rect, marks: { px: number } | null) => {
  const { ctx, p, pen, S } = e
  const strip = card.strip!
  const n = strip.length
  const net = card.net ?? null
  const sign = (v: number) => `${v > 0.05 ? '+' : v < -0.05 ? '−' : ''}${Math.abs(v).toFixed(1)}`
  const anyNeg = strip.some((s) => s.delta < -0.05)
  const mf: Font = { px: marks?.px ?? S.min, w: 500, mono: true }
  const top = r.y + (marks ? mf.px + S.u : 0)
  const bottom = r.y + r.h - (marks ? mf.px + S.u * 1.5 : 0)
  const max = Math.max(0.5, ...strip.map((s) => Math.max(0, s.delta)), net ?? 0)
  const negMax = anyNeg ? Math.max(...strip.map((s) => -s.delta)) : 0
  const span = Math.max(8, bottom - top)
  const zero = anyNeg ? top + span * (max / (max + negMax)) : top + span
  const scale = (anyNeg ? span : span - 2) / (anyNeg ? max + negMax : max)
  const slot = r.w / n
  const bw = Math.max(4, Math.min(S.u * 6, slot * 0.6))
  const at = (i: number) => r.x + slot * i + slot / 2
  strip.forEach((s, i) => {
    const len = Math.max(2, Math.abs(s.delta) * scale)
    ctx.fillStyle = rgb(Math.abs(s.delta) < 0.05 ? p.line2 : s.delta > 0 ? p.pos : p.neg)
    ctx.fillRect(at(i) - bw / 2, s.delta >= 0 ? zero - len : zero, bw, len)
  })
  ctx.fillStyle = rgb(p.text2)
  ctx.fillRect(r.x, zero - 1, r.w, 2)
  if (net != null) {
    const ay = Math.round(zero - net * scale)
    ctx.strokeStyle = rgb(p.text)
    ctx.lineWidth = 2
    ctx.setLineDash([S.u, S.u * 0.75])
    ctx.beginPath()
    ctx.moveTo(r.x, ay)
    ctx.lineTo(r.x + r.w, ay)
    ctx.stroke()
    ctx.setLineDash([])
  }
  if (!marks) return
  const best = strip.reduce((b, s, i) => (s.delta > strip[b].delta ? i : b), 0)
  if (strip[best].delta > 0.05) {
    const t = sign(strip[best].delta)
    const tw = pen.width(t, mf)
    const cx = Math.max(r.x + tw / 2, Math.min(r.x + r.w - tw / 2, at(best)))
    pen.put(t, cx, zero - Math.max(2, strip[best].delta * scale) - S.u - mf.px / 2, mf, rgb(p.text), r, 'center')
  }
  const wk = { ...mf, w: 400 }
  const ly = r.y + r.h - mf.px / 2
  pen.put(`WK ${strip[0].week}`, r.x, ly, wk, rgb(p.muted), r)
  if (n > 1) pen.put(`WK ${strip[n - 1].week}`, r.x + r.w, ly, wk, rgb(p.muted), r, 'right')
}

/** The strip as a block of its own: `full` with its heading ("WEEK BY WEEK · BETTER 9 OF 11"), or `bare`. */
const planStrip = (e: Env, w: number, mode: 'full' | 'bare'): Plan => {
  const { S, pen, p, card } = e
  const strip = card.strip!
  const pad = S.u * 3
  const lf = label(S)
  const better = strip.filter((s) => s.delta > 0.05).length
  const plot = S.min * 2 + S.u * 2 + S.u * 8
  const headH = mode === 'full' ? S.label + S.u * 2 : 0
  const h = pad * 2 + headH + plot
  const inner = w - pad * 2
  const key = card.net != null ? S.u * 4 : 0
  const sum = pen.first([`BETTER ${better} OF ${strip.length} WEEKS`, `BETTER ${better} OF ${strip.length}`, `${better}/${strip.length} BETTER`], lf, inner - key)
  const title = pen.first(['WEEK BY WEEK', 'WEEKS', ''], lf, inner - key - pen.width(sum, lf) - S.u * 4)
  return {
    h,
    grow: S.u * 10,
    score: mode === 'full' ? 12 : 9,
    what: `strip ${mode}`,
    draw: (r) => {
      box(e.ctx, p, r)
      const hb = { x: r.x + pad, y: r.y, w: inner, h: pad + headH }
      if (mode === 'full') {
        const ly = r.y + pad + S.label / 2
        if (title) pen.put(title, r.x + pad, ly, lf, rgb(p.muted), hb)
        const sw = pen.put(sum, r.x + r.w - pad, ly, lf, rgb(p.text), hb, 'right')
        if (card.net != null) {
          const kx = r.x + r.w - pad - sw - key
          e.ctx.strokeStyle = rgb(p.text)
          e.ctx.lineWidth = 2
          e.ctx.setLineDash([S.u, S.u * 0.75])
          e.ctx.beginPath()
          e.ctx.moveTo(kx, ly)
          e.ctx.lineTo(kx + key - S.u, ly)
          e.ctx.stroke()
          e.ctx.setLineDash([])
        }
      }
      bars(e, card, { x: r.x + pad, y: r.y + pad + headH, w: inner, h: r.h - pad * 2 - headH }, { px: S.min })
    },
  }
}

/** The sender's note, in their words: italic, behind an accent rule, wrapped to the lines its size allows. */
const planNote = (e: Env, w: number, max = e.S.noteLines): Plan => {
  const { S, pen, p, card } = e
  const f: Font = { px: S.note, w: 500, italic: true }
  const indent = S.u * 3
  const whole = `“${card.note}”`
  const lines = pen.wrap(whole, f, w - indent, max)
  const lh = Math.round(S.note * 1.3)
  const h = lines.length * lh
  return {
    h,
    grow: 0,
    score: 0,
    draw: (r) => {
      e.ctx.fillStyle = rgb(p.accent)
      e.ctx.fillRect(r.x, r.y, 6, r.h)
      if (e.said) e.said.noteCut = lines.join(' ') !== whole
      const y0 = r.y + r.h / 2 - ((lines.length - 1) * lh) / 2
      lines.forEach((l, i) => pen.put(l, r.x + indent, y0 + i * lh, f, rgb(p.text2), { x: r.x + indent, y: r.y, w: w - indent, h: r.h }))
    },
  }
}

// ---- Choosing the layout ----

/**
 * The ways the sides may be set out at this size, fullest first, ending with ways that show only so many rows of each
 * side and say how many more there are: the link and the app always carry the whole trade.
 */
const sideOpts = (e: Env, arrs: SideOpt['arr'][]): SideOpt[] => {
  // A ledger tries its heads on two lines, then on one, cut, then in a narrower column, for names packed beside them.
  if (arrs.includes('ledger')) {
    const ledger = sideOpts0(e, ['ledger'])
    return [...sideOpts0(e, arrs).map((o) => (o.arr === 'ledger' ? { ...o, wrap: true } : o)), ...ledger, ...ledger.filter((o) => o.kind === 'dense').map((o) => ({ ...o, narrow: true }))]
  }
  return sideOpts0(e, arrs)
}
const sideOpts0 = (e: Env, arrs: SideOpt['arr'][]): SideOpt[] => {
  const out: SideOpt[] = []
  const most = Math.max(...e.card.sides.map((s) => itemsOf(s).length))
  for (const arr of arrs) {
    // A small trade on a roomy card is drawn larger, not left floating in space.
    if (arr !== 'ledger' && most <= 3) for (const zoom of [1.5, 1.25]) out.push({ arr, kind: 'rich', cols: 1, face: true, cap: Infinity, zoom })
    out.push({ arr, kind: 'rich', cols: 1, face: true, cap: Infinity })
    out.push({ arr, kind: 'line', cols: 1, face: true, cap: Infinity })
    out.push({ arr, kind: 'line', cols: 1, face: false, cap: Infinity })
    for (let cap = Math.min(8, most - 1); cap >= 2; cap--) out.push({ arr, kind: 'line', cols: 1, face: false, cap })
    for (const ppw of [true, false])
      for (const cols of [1, 2, 3]) {
        if (cols > most) break
        out.push({ arr, kind: 'dense', cols, face: false, cap: Infinity, ppw })
        for (let cap = Math.min(8, Math.ceil(most / cols) - 1); cap >= 1; cap--) out.push({ arr, kind: 'dense', cols, face: false, cap, ppw })
      }
  }
  return out
}

/** Places blocks top to bottom in a rect: each grows into the room to spare, then the gaps, then it is centred. */
const stackIn = (plans: Plan[], r: Rect, gap: number, maxGap = gap * 2) => {
  const live = plans.filter((x) => x.h > 0)
  const need = live.reduce((a, x) => a + x.h, 0) + gap * Math.max(0, live.length - 1)
  let spare = Math.max(0, r.h - need)
  const growTotal = live.reduce((a, x) => a + x.grow, 0)
  const give = Math.min(spare, growTotal)
  const hs = live.map((x) => x.h + (growTotal ? (give * x.grow) / growTotal : 0))
  spare -= give
  const g = live.length > 1 ? Math.min(maxGap, gap + spare / (live.length - 1)) : gap
  spare = Math.max(0, r.h - hs.reduce((a, b) => a + b, 0) - g * Math.max(0, live.length - 1))
  let y = r.y + spare / 2
  live.forEach((x, i) => {
    x.draw({ x: r.x, y: Math.round(y), w: r.w, h: Math.round(hs[i]) })
    y += hs[i] + g
  })
}

const total = (plans: Plan[], gap: number) => {
  const live = plans.filter((x) => x.h > 0)
  return live.reduce((a, x) => a + x.h, 0) + gap * Math.max(0, live.length - 1)
}

/** The fullest layout of the blocks that fits a column of this height. */
type ColumnOpt = { note: boolean; arrs: SideOpt['arr'][]; stats: CardStat[]; strip: boolean; cols?: number }
const chooseColumn = (e: Env, w: number, h: number, gap: number, opt: ColumnOpt) =>
  memo(e, `col|${w}|${Math.floor(h)}|${gap}|${JSON.stringify({ ...opt, stats: opt.stats.length })}`, () => chooseColumn0(e, w, h, gap, opt))
const chooseColumn0 = (e: Env, w: number, h: number, gap: number, opt: ColumnOpt) => {
  const note = opt.note ? planNote(e, w) : null
  const sideP: (Plan | null)[] = opt.arrs.length
    ? sideOpts(e, opt.arrs)
        .map((o) => planSides(e, w, o))
        .filter((x): x is Plan => !!x)
    : [null]
  const cols = opt.cols ?? (w >= e.S.W * 0.6 ? 2 : 1)
  const statP: { plan: Plan | null; spark: boolean }[] = []
  if (opt.stats.length) {
    for (const sub of [true, false])
      for (const spark of opt.strip ? [false, true] : [false]) {
        const t = planStats(e, opt.stats, w, { mode: 'tiles', cols, sub, spark })
        if (t) statP.push({ plan: t, spark })
      }
    for (const spark of opt.strip ? [false, true] : [false])
      for (let cap = opt.stats.length; cap >= Math.min(3, opt.stats.length); cap--) {
        const list = planStats(e, opt.stats, w, { mode: 'list', cols: 1, sub: false, spark, cap })
        if (list) statP.push({ plan: list, spark })
      }
  } else statP.push({ plan: null, spark: false })
  const stripP: (Plan | null)[] = opt.strip ? [planStrip(e, w, 'full'), planStrip(e, w, 'bare'), null] : [null]
  let best: { score: number; plans: Plan[] } | null = null
  for (const s of sideP)
    for (const st of statP)
      for (const sp of stripP) {
        // A strip folded into the lineup figure is not drawn again on its own.
        if (sp && st.spark) continue
        const plans = [note, s, st.plan, sp].filter((x): x is Plan => !!x)
        if (!plans.length || total(plans, gap) > h) continue
        const score = plans.reduce((a, x) => a + x.score, 0)
        if (!best || score > best.score) best = { score, plans }
      }
  return best
}

/**
 * The heading: who it is for (or who trades), and the week, on one line. Returns where it ends. The title takes its
 * size on one line, then smaller, then (where it may) two lines, then a shorter way of saying the name.
 */
const drawHeader = (e: Env, title: string[]) => {
  const { S, pen, p, card } = e
  const wk = `WK ${String(card.week).padStart(2, '0')}`
  const wf: Font = { ...label(S), w: 600 }
  const ww = pen.width(wk, wf)
  const tw = S.W - S.pad * 2 - ww - S.u * 4
  let lines: string[] = []
  let px = S.title
  const tf = (x: number): Font => ({ px: x, w: 600 })
  search: for (const t of title) {
    for (px = S.title; px >= S.titleMin; px -= 4)
      if (pen.width(t, tf(px)) <= tw) {
        lines = [t]
        break search
      }
    if (S.titleLines > 1 && t === title[0]) {
      const two = pen.wrap(t, tf(S.titleMin), tw, 2)
      if (two.length === 2 && !two[1].endsWith('…')) {
        px = S.titleMin
        lines = two
        break
      }
    }
  }
  if (!lines.length) {
    px = S.titleMin
    lines = [pen.cut(title[title.length - 1], tf(px), tw)]
  }
  const lh = Math.round(px * 1.12)
  const top = S.pad
  const h = px + (lines.length - 1) * lh
  lines.forEach((l, i) => pen.put(l, S.pad, top + px / 2 + i * lh, tf(px), rgb(p.text), { x: S.pad, y: top, w: tw, h }))
  pen.put(wk, S.W - S.pad, top + px / 2, wf, rgb(p.accent), { x: S.W - S.pad - ww, y: top, w: ww, h: px }, 'right')
  return top + h
}

/** The foot: the app at the left; who it is from and the league at the right, as much of it as fits. Returns where it starts. */
const drawFooter = (e: Env) => {
  const { S, pen, p, card } = e
  const y = S.H - S.pad - S.min / 2
  const rule = S.H - S.pad - S.min - S.u * 2
  e.ctx.fillStyle = rgb(p.line2)
  e.ctx.fillRect(S.pad, rule, S.W - S.pad * 2, 2)
  const sf: Font = { px: S.min, w: 500, mono: true }
  const full = { x: S.pad, y: rule, w: S.W - S.pad * 2, h: S.H - S.pad - rule }
  const site = pen.put('ff.sujeff.com', S.pad, y, sf, rgb(p.text2), full)
  const room = S.W - S.pad * 2 - site - S.u * 6
  const lf = label(S, S.min)
  const league = card.league.toUpperCase()
  const froms = card.from ? nameVariants(card.from).map((n) => `FROM ${n.toUpperCase()}`) : []
  const ways = card.from ? [`${froms[0]} · ${league}`, ...froms] : [league]
  const by = pen.first(ways, lf, room)
  pen.put(by, S.W - S.pad, y, lf, rgb(p.muted), { ...full, x: S.W - S.pad - room, w: room }, 'right')
  return rule
}

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

export type DrawOptions = {
  /** Backing pixels per card pixel: the preview draws at the size it is shown, times the screen's density. */
  scale?: number
  /** Filled with every word drawn and the room it had (`cardIssues` reads it). */
  audit?: TextBox[]
  /** Filled with the blocks the layout chose and their scores, for tuning. */
  trace?: string[]
  /** Filled with what the card had to shorten that the sender wrote: the note, cut to fit. */
  said?: { noteCut: boolean }
}

/** Draws the card onto `canvas` (sized to the format). Synchronous: whatever pictures are here are drawn. */
export const drawTradeCard = (canvas: HTMLCanvasElement, card: TradeCard, format: CardFormat, p: Palette, avatars: Record<number, string | null> = {}, opt: DrawOptions = {}) => {
  const S = SPECS[format]
  const scale = opt.scale ?? 1
  const cw = Math.max(1, Math.round(S.W * scale))
  const ch = Math.max(1, Math.round(S.H * scale))
  if (canvas.width !== cw) canvas.width = cw
  if (canvas.height !== ch) canvas.height = ch
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no canvas')
  ctx.setTransform(cw / S.W, 0, 0, ch / S.H, 0, 0)
  ctx.textBaseline = 'middle'
  ground(ctx, p, S.W, S.H)
  if (opt.said) opt.said.noteCut = false
  const e: Env = { ctx, p, pen: makePen(ctx, opt.audit), S, card, avatars, memo: new Map(), said: opt.said }
  const top = drawHeader(e, titleWays(card)) + S.u * 3
  const bottom = drawFooter(e) - S.u * 3
  const inner = S.W - S.pad * 2
  const gap = S.u * 3
  const stats = card.stats

  if (format !== 'og') {
    // Square and tall: note, sides, figures, then the strip, top to bottom, in the fullest form that fits.
    const best = chooseColumn(e, inner, bottom - top, gap, { note: !!card.note, arrs: ['stack', 'ledger'], stats, strip: !!card.strip })
    opt.trace?.push(...(best?.plans.map((x) => `${x.what ?? ''} ${x.score.toFixed(1)}`) ?? ['last resort']))
    if (best) stackIn(best.plans, { x: S.pad, y: top, w: inner, h: bottom - top }, gap)
    else lastResort(e, { x: S.pad, y: top, w: inner, h: bottom - top }, gap, !!card.note)
    return canvas
  }

  // Wide: the note across the top, then the sides, with the figures either in a column at the right or in a row
  // under them, whichever leaves more of everything; the strip under the sides, in the figures' column, folded into
  // the lineup figure, or left off.
  // The note keeps its lines while anything fits under them; past that it keeps one, cut short, and the figures give
  // way to it (the last resort): a note is never left off.
  for (const lines of card.note ? [S.noteLines, 1] : [0]) {
    const note = lines ? planNote(e, inner, lines) : null
    const area = { x: S.pad, y: top + (note ? note.h + gap : 0), w: inner, h: bottom - top - (note ? note.h + gap : 0) }
    const chosen = chooseWide(e, area, gap)
    if (!chosen && lines > 1) continue
    note?.draw({ x: S.pad, y: top, w: inner, h: note.h })
    opt.trace?.push(...(chosen?.plans.map((x) => `${x.what ?? ''} ${x.score.toFixed(1)}`) ?? ['last resort']))
    if (chosen) chosen.draw()
    else lastResort(e, area, gap, false)
    break
  }
  return canvas
}

/** The wide card's fullest layout in the room under its note, or null when nothing fits. */
const chooseWide = (e: Env, area: Rect, gap: number) => {
  const { card } = e
  const stats = card.stats
  const inner = area.w
  type Pick = { score: number; plans: Plan[]; draw: () => void }
  let pick: Pick | null = null
  const consider = (score: number, plans: Plan[], draw: () => void) => {
    if (!pick || score > pick.score) pick = { score, plans, draw }
  }
  const arrs: SideOpt['arr'][] = ['cols', 'stack', 'ledger']
  // The figures in a column at the right, with the strip under the sides or under the figures.
  for (const rw of stats.length ? [Math.round(inner * 0.32), Math.round(inner * 0.4)] : [0])
    for (const stripRight of rw && card.strip ? [false, true] : [false]) {
      const lw = inner - (rw ? rw + gap : 0)
      const left = chooseColumn(e, lw, area.h, gap, { note: false, arrs, stats: [], strip: !!card.strip && !stripRight })
      if (!left) continue
      const right = rw ? chooseColumn(e, rw, area.h, gap, { note: false, arrs: [], stats, strip: stripRight, cols: 1 }) : null
      if (rw && !right) continue
      consider(left.score + (right?.score ?? 0) - (rw > inner * 0.35 ? 1 : 0), [...left.plans, ...(right?.plans ?? [])], () => {
        stackIn(left.plans, { ...area, w: lw }, gap)
        if (right) stackIn(right.plans, { ...area, x: area.x + lw + gap, w: rw }, gap)
      })
    }
  // The figures in a row under the sides.
  if (stats.length) {
    for (const spark of card.strip ? [true, false] : [false])
      for (const o of [{ mode: 'tiles' as const }, ...stats.slice(0, Math.max(1, stats.length - 2)).map((_, i) => ({ mode: 'list' as const, cap: stats.length - i }))]) {
        const st = planStats(e, stats, inner, { ...o, cols: Math.min(4, stats.length), sub: false, spark })
        if (!st) continue
        const left = chooseColumn(e, inner, area.h - st.h - gap, gap, { note: false, arrs, stats: [], strip: !!card.strip && !spark })
        if (!left) continue
        consider(left.score + st.score - 2, [...left.plans, st], () => stackIn([...left.plans, st], area, gap))
      }
  }
  return pick as Pick | null
}

/**
 * Nothing fits even at its tightest (dozens of players, every figure and the longest note): the note on fewer lines,
 * the sides in a ledger of names, as many rows of each as there is room for, and as many figures as fit after them.
 */
const lastResort = (e: Env, r: Rect, gap: number, withNote: boolean) => {
  const { card, S } = e
  const n = card.stats.length
  // On the wide card, first the figures in a column at the right of the ledger, giving up figures before names.
  if (S.W > S.H && n)
    for (let k = n; k >= 1; k--)
      for (const rw of [Math.round(r.w * 0.32), Math.round(r.w * 0.4)]) {
        const list = planStats(e, card.stats, rw, { mode: 'list', cols: 1, sub: false, spark: false, cap: k })
        if (!list || list.h > r.h) continue
        for (const narrow of [false, true])
          for (const [cols, tight] of [[1, true], [2, false], [2, true], [1, false]] as const)
            for (let cap = 6; cap >= 1; cap--) {
              const sides = planSides(e, r.w - rw - gap, { arr: 'ledger', kind: 'dense', cols, face: false, cap, ppw: false, narrow, tight })
              if (!sides || sides.h > r.h) continue
              stackIn([sides], { ...r, w: r.w - rw - gap }, gap)
              stackIn([list], { ...r, x: r.x + r.w - rw, w: rw }, gap)
              return
            }
      }
  let fallback: Plan[] = []
  for (let lines = withNote ? S.noteLines : 0; lines >= (withNote ? 1 : 0); lines--) {
    const note = lines ? planNote(e, r.w, lines) : null
    for (let k = n; k >= (n ? 1 : 0); k--) {
      // At the least, a line saying how many figures there are: they are never left off without a word.
      const list = k ? planStats(e, card.stats, r.w, { mode: 'list', cols: 1, sub: false, spark: false, cap: k }) : null
      for (const [wrap, narrow] of [[true, false], [false, false], [false, true]])
        for (const cols of [3, 2, 1])
          for (let cap = 6; cap >= 1; cap--) {
            const sides = planSides(e, r.w, { arr: 'ledger', kind: 'dense', cols, face: false, cap, ppw: false, wrap, narrow })
            if (!sides) continue
            const plans = [note, sides, list].filter((x): x is Plan => !!x)
            if (!fallback.length) fallback = plans
            if (total(plans, gap) <= r.h) return stackIn(plans, r, gap)
          }
    }
  }
  stackIn(fallback, r, gap)
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
export const renderTradeCard = async (card: TradeCard, format: CardFormat, p: Palette, avatars: Record<number, string | null> = {}) => {
  await Promise.all([loadCardFonts(), loadPictures(cardSources(card, avatars))])
  return drawTradeCard(document.createElement('canvas'), card, format, p, avatars)
}
