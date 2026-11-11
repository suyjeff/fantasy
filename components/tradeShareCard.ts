import type { CardSide, CardStat, TradeCard } from '../lib/tradeShare'
import type { TrimmedPlayer } from '../lib/types'
import { DARK, LIGHT, MONO, SANS, fit, loadImage, readPalette, rgb, type Palette } from './shareCards'
import { playerImage } from './ui'

// The trade card, drawn on a canvas as the Power Rank cards are (shareCards.ts): the same faces, colours, hairlines and
// registration marks, so a shared trade looks like the app it came from. Three sizes: a square for chats, the
// 1200×630 link preview, and a tall one for stories. Drawing is synchronous and takes a few milliseconds, so the share
// sheet redraws its preview on every change; the pictures (headshots, team avatars) are fetched once and kept, and a
// draw before they arrive leaves a plain tile in their place.

export type CardFormat = 'square' | 'og' | 'story'
export const FORMATS: Record<CardFormat, { w: number; h: number; label: string; hint: string }> = {
  square: { w: 1080, h: 1080, label: 'Square', hint: '1080×1080 · chats' },
  og: { w: 1200, h: 630, label: 'Wide', hint: '1200×630 · link preview' },
  story: { w: 1080, h: 1350, label: 'Tall', hint: '1080×1350 · stories' },
}
export type CardTheme = 'app' | 'dark' | 'light'
export const paletteOf = (theme: CardTheme): Palette => (theme === 'dark' ? DARK : theme === 'light' ? LIGHT : readPalette())

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
    const sample = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 +−–·→⇄$/.,:’“”'
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

// ---- Drawing ----

type Ctx = CanvasRenderingContext2D
type Rect = { x: number; y: number; w: number; h: number }

const spaced = (ctx: Ctx, px: number) => {
  // Not everywhere yet; the labels just sit a touch tighter without it.
  ;(ctx as Ctx & { letterSpacing?: string }).letterSpacing = `${px}px`
}

/** Text wrapped to a width, at most `max` lines, the last cut with an ellipsis. */
const wrap = (ctx: Ctx, text: string, width: number, max: number) => {
  const words = text.split(' ')
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w
    if (ctx.measureText(next).width <= width || !cur) cur = next
    else {
      lines.push(cur)
      cur = w
    }
  }
  if (cur) lines.push(cur)
  if (lines.length > max) {
    const kept = lines.slice(0, max)
    kept[max - 1] = fit(ctx, `${kept[max - 1]} ${lines.slice(max).join(' ')}`, width)
    return kept
  }
  return lines.map((l) => fit(ctx, l, width))
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
    [28, 38],
    [w - 28, 38],
    [28, h - 28],
    [w - 28, h - 28],
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
    ctx.font = `500 ${Math.round(size * 0.4)}px ${MONO}`
    ctx.textAlign = 'center'
    ctx.fillText(letter.toUpperCase(), x + size / 2, y + size / 2 + 1)
    ctx.textAlign = 'left'
  }
  ctx.strokeStyle = rgb(p.line2)
  ctx.lineWidth = 2
  ctx.strokeRect(x + 1, y + 1, size - 2, size - 2)
}

/** The two-way arrows of a swap, in a square, centred on cx,cy. */
const swapMark = (ctx: Ctx, p: Palette, cx: number, cy: number, s: number) => {
  ctx.fillStyle = rgb(p.panel)
  ctx.fillRect(cx - s / 2, cy - s / 2, s, s)
  ctx.strokeStyle = rgb(p.line2)
  ctx.lineWidth = 2
  ctx.strokeRect(cx - s / 2 + 1, cy - s / 2 + 1, s - 2, s - 2)
  const a = s * 0.26
  const gap = s * 0.13
  ctx.strokeStyle = rgb(p.accent)
  ctx.lineWidth = Math.max(2, s / 18)
  ctx.lineCap = 'square'
  ctx.beginPath()
  // Top arrow to the right, bottom arrow to the left.
  ctx.moveTo(cx - a, cy - gap)
  ctx.lineTo(cx + a, cy - gap)
  ctx.moveTo(cx + a - a * 0.45, cy - gap - a * 0.45)
  ctx.lineTo(cx + a, cy - gap)
  ctx.lineTo(cx + a - a * 0.45, cy - gap + a * 0.45)
  ctx.moveTo(cx + a, cy + gap)
  ctx.lineTo(cx - a, cy + gap)
  ctx.moveTo(cx - a + a * 0.45, cy + gap - a * 0.45)
  ctx.lineTo(cx - a, cy + gap)
  ctx.lineTo(cx - a + a * 0.45, cy + gap + a * 0.45)
  ctx.stroke()
}

/** The largest a face gets in a column this wide: a narrow column (three or four sides) keeps its room for the name. */
const faceCap = (colW: number) => Math.round(Math.min(104, colW * 0.2))
/** How a card's sides are set out: in a row, or two by two for four sides on a card that is not wide. */
const sideGrid = (n: number, r: { w: number; h: number }) => (n === 4 && r.w / r.h < 2.2 ? { cols: 2, rows: 2 } : { cols: n, rows: 1 })

/** One side's column: who it is, then what it takes in, one row per player (and FAAB). */
const drawSide = (ctx: Ctx, p: Palette, s: CardSide, r: Rect, o: { headH: number; rowH: number; avatar: string | null; k: number; clear?: { left: number; right: number } }) => {
  const { headH, rowH, k } = o
  const pad = Math.round(22 * Math.min(1, k + 0.15))
  // Head: the recipient's marked with the accent along the top.
  if (s.focus) {
    ctx.fillStyle = rgb(p.accent, 0.08)
    ctx.fillRect(r.x, r.y, r.w, headH)
    ctx.fillStyle = rgb(p.accent)
    ctx.fillRect(r.x, r.y, r.w, 5)
  }
  const av = Math.round(headH * 0.52)
  // The head keeps clear of the swap mark that sits on the rule between two sides.
  let tx = r.x + pad + (o.clear?.left ?? 0)
  if (o.avatar) {
    picture(ctx, p, o.avatar, s.head, tx, r.y + (headH - av) / 2 + 2, av)
    tx += av + 14
  }
  ctx.fillStyle = rgb(s.focus ? p.accent : p.muted)
  ctx.font = `500 ${Math.round(21 * Math.min(1.1, k + 0.2))}px ${MONO}`
  spaced(ctx, 2)
  ctx.textAlign = 'left'
  ctx.fillText(fit(ctx, s.head.toUpperCase(), r.x + r.w - pad - (o.clear?.right ?? 0) - tx), tx, r.y + headH / 2 + 3)
  spaced(ctx, 0)
  ctx.fillStyle = rgb(p.line)
  ctx.fillRect(r.x, r.y + headH, r.w, 2)

  const rows: { kind: 'player' | 'faab' | 'none'; i?: number }[] = [...s.players.map((_, i) => ({ kind: 'player' as const, i })), ...(s.faab ? [{ kind: 'faab' as const }] : [])]
  if (!rows.length) rows.push({ kind: 'none' })
  const face = Math.round(Math.min(rowH - 22 * k, faceCap(r.w)))
  rows.forEach((row, n) => {
    const y = r.y + headH + n * rowH
    const mid = y + rowH / 2
    if (n > 0) {
      ctx.fillStyle = rgb(p.line)
      ctx.fillRect(r.x + pad, y, r.w - pad * 2, 1.5)
    }
    const fx = r.x + pad
    const fy = Math.round(mid - face / 2)
    const nx = fx + face + Math.round(18 * k)
    const right = r.x + r.w - pad
    if (row.kind === 'none') {
      ctx.fillStyle = rgb(p.muted)
      ctx.font = `400 ${Math.round(26 * k)}px ${SANS}`
      ctx.fillText('Nothing back', fx, mid)
      return
    }
    if (row.kind === 'faab') {
      ctx.fillStyle = rgb(p.sunken)
      ctx.fillRect(fx, fy, face, face)
      ctx.strokeStyle = rgb(p.line2)
      ctx.lineWidth = 2
      ctx.strokeRect(fx + 1, fy + 1, face - 2, face - 2)
      ctx.fillStyle = rgb(p.text2)
      ctx.font = `500 ${Math.round(face * 0.42)}px ${MONO}`
      ctx.textAlign = 'center'
      ctx.fillText('$', fx + face / 2, fy + face / 2 + 1)
      ctx.textAlign = 'left'
      ctx.fillStyle = rgb(p.text)
      ctx.font = `600 ${Math.round(34 * k)}px ${MONO}`
      ctx.fillText(`$${s.faab}`, nx, mid - 11 * k)
      ctx.fillStyle = rgb(p.muted)
      ctx.font = `400 ${Math.round(20 * k)}px ${MONO}`
      spaced(ctx, 1.5)
      ctx.fillText('FAAB', nx, mid + 22 * k)
      spaced(ctx, 0)
      return
    }
    const pl = s.players[row.i!]
    picture(ctx, p, playerSrc(pl.id, pl.pos), pl.name.trim()[0] ?? '?', fx, fy, face)
    // Points a week at the right edge, read first after the name.
    let nameRight = right
    if (pl.ppw != null) {
      ctx.textAlign = 'right'
      ctx.fillStyle = rgb(p.text)
      ctx.font = `500 ${Math.round(34 * k)}px ${MONO}`
      const v = pl.ppw.toFixed(1)
      ctx.fillText(v, right, mid - 11 * k)
      const vw = ctx.measureText(v).width
      ctx.fillStyle = rgb(p.muted)
      ctx.font = `400 ${Math.round(17 * k)}px ${MONO}`
      spaced(ctx, 1.5)
      ctx.fillText('PTS/WK', right, mid + 22 * k)
      spaced(ctx, 0)
      nameRight = right - Math.max(vw, ctx.measureText('PTS/WK').width + 10) - 18 * k
      ctx.textAlign = 'left'
    }
    ctx.fillStyle = rgb(p.text)
    ctx.font = `600 ${Math.round(32 * k)}px ${SANS}`
    // A long name gives up its first name to an initial before it is cut: "J. Daniels", not "Jayden Dani…".
    const parts = pl.name.trim().split(/\s+/)
    const short = parts.length > 1 ? `${parts[0][0]}. ${parts.slice(1).join(' ')}` : pl.name
    // Then it may shrink a little, and only then is it cut.
    let npx = Math.round(32 * k)
    const nameRoom = nameRight - nx
    const shown = ctx.measureText(pl.name).width <= nameRoom ? pl.name : short
    while (ctx.measureText(shown).width > nameRoom && npx > Math.round(32 * k * 0.82)) ctx.font = `600 ${--npx}px ${SANS}`
    ctx.fillText(fit(ctx, shown, nameRoom), nx, mid - 11 * k)
    // Under the name: position, team, who sends him in a bigger deal, and timing in their favour.
    ctx.font = `500 ${Math.round(20 * k)}px ${MONO}`
    let sx = nx
    ctx.fillStyle = rgb(p.text2)
    ctx.fillText(pl.pos, sx, mid + 22 * k)
    sx += ctx.measureText(pl.pos).width
    ctx.fillStyle = rgb(p.muted)
    ctx.font = `400 ${Math.round(20 * k)}px ${MONO}`
    // In a deal of three or more, who sends him matters more than his NFL team, so the team gives way first.
    const room = () => nameRight - sx - (pl.tag ? tagW : 0)
    let rest = ` · ${pl.team ?? 'FA'}${pl.from ? ` · from ${pl.from}` : ''}`
    if (pl.from && ctx.measureText(rest).width > nameRight - sx) rest = ` · from ${pl.from}`
    let tagW = 0
    if (pl.tag) {
      ctx.save()
      ctx.font = `600 ${Math.round(16 * k)}px ${MONO}`
      spaced(ctx, 1.5)
      tagW = ctx.measureText(pl.tag.toUpperCase()).width + 16 * k + 12 * k
      spaced(ctx, 0)
      ctx.restore()
    }
    // No room for the team and the tag both: the tag stays (it is the point), the team goes.
    const restText = ctx.measureText(rest).width <= room() ? rest : tagW ? '' : fit(ctx, rest, Math.max(0, nameRight - sx))
    ctx.fillText(restText, sx, mid + 22 * k)
    sx += ctx.measureText(restText).width
    if (pl.tag && sx + tagW <= nameRight + 1) {
      const tx0 = sx + 12 * k
      const th = Math.round(26 * k)
      ctx.fillStyle = rgb(p.pos, 0.12)
      ctx.fillRect(tx0, mid + 22 * k - th / 2, tagW - 12 * k, th)
      ctx.fillStyle = rgb(p.pos)
      ctx.font = `600 ${Math.round(16 * k)}px ${MONO}`
      spaced(ctx, 1.5)
      ctx.fillText(pl.tag.toUpperCase(), tx0 + 8 * k, mid + 23 * k)
      spaced(ctx, 0)
    }
  })
}

/** The sides, side by side (two by two for four on a square), with the swap mark between two. */
const drawSides = (ctx: Ctx, p: Palette, card: TradeCard, r: Rect, avatars: Record<number, string | null>, maxRow: number, layout?: { cols: number; rows: number }) => {
  const n = card.sides.length
  const grid = layout ?? sideGrid(n, r)
  box(ctx, p, r)
  const cw = r.w / grid.cols
  const headH = 64
  const count = (s: CardSide) => Math.max(1, s.players.length + (s.faab ? 1 : 0))
  const most = Math.max(...card.sides.map(count))
  // Stacked one above another, each side is as tall as its own rows; side by side, they share the tallest one's height.
  const stacked = grid.cols === 1 && n > 1
  const total = card.sides.reduce((a, s) => a + count(s), 0)
  const rowH = stacked
    ? Math.min(maxRow, faceCap(cw) + 36, Math.floor((r.h - n * (headH + 8)) / total))
    : Math.min(maxRow, faceCap(cw) + 36, Math.floor((r.h / grid.rows - headH - 8) / most))
  const ch = r.h / grid.rows
  // Rows and type grow and shrink together, and a narrow column holds the type down further.
  const k = Math.max(0.55, Math.min(rowH / 100, cw / 420, 1.22))
  let sy = r.y
  card.sides.forEach((s, i) => {
    const col = i % grid.cols
    const row = Math.floor(i / grid.cols)
    const h = stacked ? (i === n - 1 ? r.y + r.h - sy : headH + count(s) * rowH + 8) : ch
    const cell = { x: r.x + col * cw, y: stacked ? sy : r.y + row * ch, w: cw, h }
    if (stacked && i > 0) {
      ctx.fillStyle = rgb(p.line2)
      ctx.fillRect(r.x, Math.round(sy) - 1, r.w, 2)
    }
    sy += h
    const mark = n === 2 ? Math.round(headH * 0.72) / 2 + 6 : 0
    drawSide(ctx, p, s, cell, { headH, rowH, avatar: s.avatar ?? avatars[s.rosterId] ?? null, k, clear: { left: i === 1 ? mark : 0, right: i === 0 ? mark : 0 } })
  })
  ctx.fillStyle = rgb(p.line2)
  for (let c = 1; c < grid.cols; c++) ctx.fillRect(Math.round(r.x + c * cw) - 1, r.y, 2, r.h)
  if (!stacked) for (let rr = 1; rr < grid.rows; rr++) ctx.fillRect(r.x, Math.round(r.y + rr * ch) - 1, r.w, 2)
  if (n === 2) swapMark(ctx, p, r.x + cw, r.y + headH / 2, Math.round(headH * 0.72))
}

/** The benefit figures: a few large numbers with their labels, in a hairline grid. */
const drawStats = (ctx: Ctx, p: Palette, stats: CardStat[], r: Rect, cols: number, valuePx: number) => {
  const rows = Math.ceil(stats.length / cols)
  const gap = 2
  const tw = (r.w - gap * (cols - 1)) / cols
  const th = (r.h - gap * (rows - 1)) / rows
  ctx.fillStyle = rgb(p.line2)
  ctx.fillRect(r.x, r.y, r.w, r.h)
  stats.forEach((s, i) => {
    const x = r.x + (i % cols) * (tw + gap)
    const y = r.y + Math.floor(i / cols) * (th + gap)
    const last = i === stats.length - 1
    // The last tile of a short row runs to the edge, so the grid never ends in a block of line colour.
    const w = last ? r.x + r.w - x : tw
    ctx.fillStyle = rgb(p.panel)
    ctx.fillRect(x, y, w, th)
    if (s.tone !== 'neutral') {
      ctx.fillStyle = rgb(s.tone === 'pos' ? p.pos : p.neg, 0.08)
      ctx.fillRect(x, y, w, th)
    }
    const pad = Math.round(Math.min(24, w * 0.08))
    const v = Math.min(valuePx, th * 0.42)
    const lab = Math.round(Math.max(15, Math.min(20, v * 0.36)))
    const sub = s.sub ? Math.round(lab * 0.95) : 0
    const block = lab + 14 + v + (sub ? 12 + sub : 0)
    let cy = y + (th - block) / 2
    ctx.textAlign = 'left'
    ctx.fillStyle = rgb(p.muted)
    ctx.font = `500 ${lab}px ${MONO}`
    spaced(ctx, 2)
    ctx.fillText(fit(ctx, s.label.toUpperCase(), w - pad * 2), x + pad, cy + lab / 2)
    spaced(ctx, 0)
    cy += lab + 14
    ctx.fillStyle = rgb(s.tone === 'pos' ? p.pos : s.tone === 'neg' ? p.neg : p.text)
    let vpx = Math.round(v)
    ctx.font = `600 ${vpx}px ${MONO}`
    const unit = s.unit ? ` ${s.unit.toUpperCase()}` : ''
    const unitPx = Math.round(Math.max(15, vpx * 0.34))
    const unitW = () => {
      ctx.font = `400 ${unitPx}px ${MONO}`
      const uw = unit ? ctx.measureText(unit).width : 0
      ctx.font = `600 ${vpx}px ${MONO}`
      return uw
    }
    // Shrink a long value ("7.0 → 8.5", "Buy low, sell high") to its tile rather than cut it.
    while (vpx > 18 && ctx.measureText(s.value).width + unitW() > w - pad * 2) {
      vpx -= 2
      ctx.font = `600 ${vpx}px ${MONO}`
    }
    ctx.fillText(s.value, x + pad, cy + v / 2)
    const vw = ctx.measureText(s.value).width
    if (unit) {
      ctx.fillStyle = rgb(p.muted)
      ctx.font = `400 ${unitPx}px ${MONO}`
      ctx.fillText(unit, x + pad + vw, cy + v / 2 + vpx * 0.12)
    }
    if (sub) {
      cy += v + 12
      ctx.fillStyle = rgb(p.text2)
      let spx = sub
      ctx.font = `400 ${spx}px ${MONO}`
      while (spx > 13 && ctx.measureText(s.sub!).width > w - pad * 2) ctx.font = `400 ${--spx}px ${MONO}`
      ctx.fillText(fit(ctx, s.sub!, w - pad * 2), x + pad, cy + sub / 2)
    }
  })
}

/**
 * The recipient's lineup change week by week: bars either side of a zero line, gains in the positive colour and the
 * odd losing week in the negative, the best week labelled.
 */
const drawStrip = (ctx: Ctx, p: Palette, card: TradeCard, r: Rect) => {
  const strip = card.strip!
  box(ctx, p, r)
  const pad = 24
  const lab = 19
  ctx.fillStyle = rgb(p.muted)
  ctx.font = `500 ${lab}px ${MONO}`
  spaced(ctx, 2)
  ctx.textAlign = 'left'
  ctx.fillText(fit(ctx, `${card.to ?? ''} lineup, week by week`.trim().toUpperCase(), r.w - pad * 2 - 160), r.x + pad, r.y + pad + lab / 2)
  spaced(ctx, 0)
  ctx.textAlign = 'right'
  ctx.font = `400 ${lab - 2}px ${MONO}`
  ctx.fillText('PTS VS NOW', r.x + r.w - pad, r.y + pad + lab / 2)
  const top = r.y + pad + lab + 26
  const weekH = 26
  const bottom = r.y + r.h - pad - weekH
  const max = Math.max(0.5, ...strip.map((s) => Math.abs(s.delta)))
  const anyNeg = strip.some((s) => s.delta < -0.05)
  // With no losing week the zero line sits low and the bars use the height; otherwise it sits where the split falls.
  const negMax = anyNeg ? Math.max(...strip.map((s) => -s.delta)) : 0
  const span = bottom - top
  const zero = anyNeg ? top + span * (max / (max + negMax)) : bottom
  const scale = (anyNeg ? span : span - 4) / (anyNeg ? max + negMax : max)
  const slot = (r.w - pad * 2) / strip.length
  const bw = Math.min(40, slot * 0.58)
  const best = strip.reduce((b, s, i) => (s.delta > strip[b].delta ? i : b), 0)
  strip.forEach((s, i) => {
    const cx = r.x + pad + slot * i + slot / 2
    const len = Math.max(2, Math.abs(s.delta) * scale)
    ctx.fillStyle = rgb(Math.abs(s.delta) < 0.05 ? p.line2 : s.delta > 0 ? p.pos : p.neg)
    ctx.fillRect(cx - bw / 2, s.delta >= 0 ? zero - len : zero, bw, len)
    ctx.fillStyle = rgb(p.muted)
    ctx.font = `400 17px ${MONO}`
    ctx.textAlign = 'center'
    ctx.fillText(String(s.week), cx, r.y + r.h - pad - weekH / 2 + 4)
    if (i === best && s.delta > 0.05) {
      ctx.fillStyle = rgb(p.text)
      ctx.font = `500 18px ${MONO}`
      const ly = zero - len - 14
      ctx.fillText(`+${s.delta.toFixed(1)}`, cx, Math.max(top - 6, ly))
    }
  })
  ctx.fillStyle = rgb(p.text2)
  ctx.fillRect(r.x + pad, zero - 1, r.w - pad * 2, 2)
  ctx.textAlign = 'left'
}

const drawNote = (ctx: Ctx, p: Palette, note: string, r: Rect, px: number, lines: number) => {
  ctx.fillStyle = rgb(p.accent)
  ctx.fillRect(r.x, r.y, 5, r.h)
  ctx.fillStyle = rgb(p.text2)
  ctx.font = `italic 500 ${px}px ${SANS}`
  ctx.textAlign = 'left'
  const ls = wrap(ctx, `“${note}”`, r.w - 28, lines)
  const lh = px * 1.3
  const y0 = r.y + r.h / 2 - ((ls.length - 1) * lh) / 2
  ls.forEach((l, i) => ctx.fillText(l, r.x + 24, y0 + i * lh + 1))
}

/** The note's height at a size and width, wrapped to at most `lines`. */
const noteLines = (ctx: Ctx, note: string, w: number, px: number, lines: number) => {
  ctx.font = `italic 500 ${px}px ${SANS}`
  return wrap(ctx, `“${note}”`, w - 28, lines).length
}

const titleOf = (card: TradeCard) => (card.kind === 'pitch' ? { eyebrow: 'Trade pitch', title: `For ${card.to}` } : { eyebrow: 'Trade', title: card.sides.length > 2 ? `${card.sides.length}-team trade` : card.sides.map((s) => s.head.replace(/ gets$/, '')).join(' ⇄ ') })

/** Draws the card onto `canvas` (sized to the format). Synchronous: whatever pictures are here are drawn. */
export const drawTradeCard = (canvas: HTMLCanvasElement, card: TradeCard, format: CardFormat, p: Palette, avatars: Record<number, string | null> = {}) => {
  const { w: W, h: H } = FORMATS[format]
  if (canvas.width !== W) canvas.width = W
  if (canvas.height !== H) canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no canvas')
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.textBaseline = 'middle'
  ground(ctx, p, W, H)
  const og = format === 'og'
  const PAD = og ? 52 : 64
  const { eyebrow, title } = titleOf(card)

  // Heading: what it is and the league, who it is for, and the week.
  const wk = `WK ${String(card.week).padStart(2, '0')}`
  ctx.font = `600 ${og ? 44 : 52}px ${MONO}`
  const wkW = ctx.measureText(wk).width
  ctx.textAlign = 'right'
  ctx.fillStyle = rgb(p.accent)
  ctx.fillText(wk, W - PAD, og ? 66 : 94)
  ctx.textAlign = 'left'
  ctx.fillStyle = rgb(p.muted)
  ctx.font = `500 ${og ? 20 : 24}px ${MONO}`
  spaced(ctx, og ? 2.5 : 3)
  ctx.fillText(fit(ctx, `${eyebrow} · ${card.league}`.toUpperCase(), W - PAD * 2 - wkW - 40), PAD, og ? 58 : 84)
  spaced(ctx, 0)
  ctx.fillStyle = rgb(p.text)
  let tpx = og ? 46 : 60
  ctx.font = `600 ${tpx}px ${SANS}`
  while (tpx > 34 && ctx.measureText(title).width > W - PAD * 2 - (og ? wkW + 30 : 0)) {
    tpx -= 2
    ctx.font = `600 ${tpx}px ${SANS}`
  }
  ctx.fillText(fit(ctx, title, W - PAD * 2 - (og ? wkW + 30 : 0)), PAD, og ? 106 : 150)

  // Footer: the app, and who it is from.
  const footH = og ? 62 : 86
  const fy = H - footH / 2 + (og ? 2 : 4)
  ctx.fillStyle = rgb(p.line2)
  ctx.fillRect(PAD, H - footH, W - PAD * 2, 2)
  ctx.fillStyle = rgb(p.text2)
  ctx.font = `500 ${og ? 22 : 26}px ${MONO}`
  ctx.fillText('ff.sujeff.com', PAD, fy)
  const siteW = ctx.measureText('ff.sujeff.com').width
  ctx.textAlign = 'right'
  ctx.fillStyle = rgb(p.muted)
  ctx.font = `400 ${og ? 18 : 21}px ${MONO}`
  spaced(ctx, 1.5)
  const by = card.from ? `PROPOSED BY ${card.from.toUpperCase()}` : 'REST-OF-SEASON PROJECTIONS'
  ctx.fillText(fit(ctx, by, W - PAD * 2 - siteW - 40), W - PAD, fy)
  spaced(ctx, 0)
  ctx.textAlign = 'left'

  const top = og ? 134 : 196
  const bottom = H - footH - (og ? 18 : 28)
  const gap = og ? 14 : 20
  const stats = card.stats

  if (og) {
    // Wide: the sides on the left, the figures stacked on the right; the note above the sides when there is one, and
    // the week strip under them when they leave the room for it (a small trade usually does).
    const statW = stats.length ? (stats.length > 3 ? 400 : 330) : 0
    const left = { x: PAD, y: top, w: W - PAD * 2 - (statW ? statW + gap : 0), h: bottom - top }
    if (card.note) {
      const nh = 40
      drawNote(ctx, p, card.note, { x: left.x, y: left.y, w: left.w, h: nh }, 24, 1)
      left.y += nh + 12
      left.h -= nh + 12
    }
    const grid = sideGrid(card.sides.length, left)
    const most = Math.max(1, ...card.sides.map((s) => s.players.length + (s.faab ? 1 : 0)))
    const natural = grid.rows * (64 + most * Math.min(112, faceCap(left.w / grid.cols) + 36) + 10)
    const stripLeft = !!card.strip && left.h - natural - gap >= 150
    const stripRight = !!card.strip && !stripLeft && stats.length <= 2 && !!statW
    drawSides(ctx, p, card, stripLeft ? { ...left, h: natural } : left, avatars, 120)
    if (stripLeft) drawStrip(ctx, p, card, { x: left.x, y: left.y + natural + gap, w: left.w, h: left.h - natural - gap })
    if (statW) {
      const right = { x: W - PAD - statW, y: top, w: statW, h: bottom - top }
      const sh = stripRight ? Math.round(right.h * (stats.length === 1 ? 0.45 : 0.62)) : right.h
      drawStats(ctx, p, stats, { ...right, h: sh }, stats.length > 3 ? 2 : 1, stats.length > 3 ? 40 : 52)
      if (stripRight) drawStrip(ctx, p, card, { x: right.x, y: right.y + sh + gap, w: right.w, h: right.h - sh - gap })
    }
    return canvas
  }

  // Square and tall: note, sides, figures, then the strip, top to bottom. The sides' rows grow into the room there is,
  // to a point, and whatever is left over is shared above and below, so a small trade sits centred, not hung at the top.
  const story = format === 'story'
  const inner = W - PAD * 2
  // A tall card stacks a few figures one above another; a square sets them in a row (two rows for five or six).
  const cols = story ? (stats.length <= 3 ? 1 : 2) : stats.length <= 4 ? stats.length : 3
  const statRows = stats.length ? Math.ceil(stats.length / cols) : 0
  let statH = statRows ? statRows * (story ? 150 : statRows > 1 ? 132 : 150) + (statRows - 1) * 2 : 0
  const notePx = story ? 32 : 28
  const noteN = card.note ? noteLines(ctx, card.note, inner, notePx, story ? 3 : 2) : 0
  const noteH = noteN ? Math.round(noteN * notePx * 1.3 + 18) : 0
  const most = Math.max(1, ...card.sides.map((s) => s.players.length + (s.faab ? 1 : 0)))
  const headH = 64
  const minRow = 64
  const fixed = (x: number) => (x ? x + gap : 0)
  let stripH = card.strip ? (story ? 210 : 172) : 0
  let room = bottom - top - fixed(noteH) - fixed(statH) - fixed(stripH)
  // Three or four sides sit side by side (two by two for four), or, when there is the height for it, one above
  // another at full width, where names and "from" lines have the room they need.
  const n = card.sides.length
  const grid = n >= 3 && room >= n * (headH + most * 80 + 10) ? { cols: 1, rows: n } : sideGrid(n, { w: inner, h: 600 })
  const sideRows = grid.rows
  const colW = inner / grid.cols
  const maxRow = Math.min(story ? 150 : 124, faceCap(colW) + 36)
  // Sides never get squeezed below a readable height: past that, the strip goes first (it is the least of them).
  if (stripH && room < sideRows * (headH + most * minRow + 10)) {
    room += fixed(stripH)
    stripH = 0
  }
  const stacked = grid.cols === 1 && n > 1
  const rowsAll = card.sides.reduce((a, s) => a + Math.max(1, s.players.length + (s.faab ? 1 : 0)), 0)
  const rowH = stacked
    ? Math.max(40, Math.min(maxRow, Math.floor((room - n * (headH + 8) - 2) / rowsAll)))
    : Math.max(40, Math.min(maxRow, Math.floor((room / sideRows - headH - 10) / most)))
  const sidesH = Math.min(room, stacked ? n * (headH + 8) + rowsAll * rowH + 2 : sideRows * (headH + most * rowH + 10))
  // Room to spare goes first to the strip and the figures, which read better a little taller, then to the margins.
  let spare = Math.max(0, room - sidesH)
  if (stripH) {
    const more = Math.min(spare * 0.5, story ? 120 : 70)
    stripH += more
    spare -= more
  }
  if (statH) {
    const more = Math.min(spare * 0.5, statRows * (story ? 40 : 24))
    statH += more
    spare -= more
  }
  let y = top + Math.round(spare / 2)
  if (noteH) {
    drawNote(ctx, p, card.note!, { x: PAD, y, w: inner, h: noteH }, notePx, story ? 3 : 2)
    y += noteH + gap
  }
  drawSides(ctx, p, card, { x: PAD, y, w: inner, h: sidesH }, avatars, rowH, grid)
  y += sidesH + gap
  if (statH) {
    drawStats(ctx, p, stats, { x: PAD, y, w: inner, h: statH }, cols, story ? 76 : stats.length >= 4 ? 52 : 64)
    y += statH + gap
  }
  if (stripH) drawStrip(ctx, p, card, { x: PAD, y, w: inner, h: stripH })
  return canvas
}

/** The finished card in a new canvas: fonts and pictures first, then the draw. */
export const renderTradeCard = async (card: TradeCard, format: CardFormat, p: Palette, avatars: Record<number, string | null> = {}) => {
  await Promise.all([loadCardFonts(), loadPictures(cardSources(card, avatars))])
  return drawTradeCard(document.createElement('canvas'), card, format, p, avatars)
}
