// Shared trades. The app posts the 1200×630 card of a trade and the facts printed on it (lib/tradeShare `TradeCard`:
// the teams, the players, the blocks the sender chose to show, a note), and gets back a short link. Unlike a shared
// Power Rank, the link is a page of its own for everyone: link-preview bots read its Open Graph tags, and a person
// sees the trade, with a button that opens it in the app's trade builder for a member of the league.
//
//   t:<id>      the facts, as JSON
//   t:<id>:png  the card
//
// Both expire after 120 days. Only what the card shows is accepted: every field is read, checked and capped, and
// anything else in the request is dropped.

import { limited, send } from './common'
import { LEAGUE_ID, SITE, tradeAppUrl } from './links'
import { BOTS, CARD, checkPng, clean, esc, int, newId, readBody, text, TTL_SECONDS, ID, type ShareEnv } from './share'

/** The facts are a few kilobytes at most: four sides of long names, eight blocks and a note. */
export const MAX_TRADE_META = 9_000
const TRADE = /^\d{1,4}\.\d{1,4}\.\$?[A-Za-z0-9_-]{1,24}(,\d{1,4}\.\d{1,4}\.\$?[A-Za-z0-9_-]{1,24}){0,29}$/
const TAGS = ['buy low', 'sell high'] as const
const TONES = ['pos', 'neg', 'neutral'] as const

export type TradeMeta = {
  kind: 'pitch' | 'league'
  league: string
  leagueId: string
  season: string
  week: number
  provider: 'sleeper' | 'espn'
  title: string
  description: string
  to: string | null
  from: string | null
  note: string | null
  sides: { head: string; focus: boolean; faab: number; players: { name: string; pos: string; team: string | null; ppw: number | null; tag: (typeof TAGS)[number] | null; from: string | null }[] }[]
  stats: { label: string; value: string; unit: string | null; sub: string | null; tone: (typeof TONES)[number] }[]
  strip: { week: number; delta: number }[] | null
  /** The deal as the app's link carries it (lib/tradeShare `encodeDeal`). */
  trade: string
}

const num = (v: unknown, lo: number, hi: number): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v * 100) / 100 : null)
/** A string that may be missing: null when it is, the cleaned string when it is good, undefined when it is bad. */
const opt = (v: unknown, max: number): string | null | undefined => (v == null ? null : (clean(v, max) ?? undefined))

/** The facts, or why they were refused. Every field is checked; nothing is passed through unread. */
export const parseTradeMeta = (raw: unknown): TradeMeta | string => {
  if (!raw || typeof raw !== 'object') return 'bad meta'
  const m = raw as Record<string, unknown>
  const kind = m.kind === 'pitch' || m.kind === 'league' ? m.kind : null
  const league = clean(m.league, 80)
  const leagueId = typeof m.leagueId === 'string' && LEAGUE_ID.test(m.leagueId) ? m.leagueId : null
  const season = typeof m.season === 'string' && /^\d{4}$/.test(m.season) ? m.season : null
  const week = int(m.week, 1, 30)
  const provider = m.provider === 'espn' ? 'espn' : m.provider === 'sleeper' ? 'sleeper' : null
  const title = clean(m.title, 120)
  const description = clean(m.description, 300)
  const to = opt(m.to, 60)
  const from = opt(m.from, 60)
  const note = opt(m.note, 100)
  const trade = typeof m.trade === 'string' && m.trade.length <= 800 && TRADE.test(m.trade) ? m.trade : null
  if (!kind) return 'bad kind'
  if (!league) return 'bad league'
  if (!leagueId) return 'bad leagueId'
  if (!season) return 'bad season'
  if (week == null) return 'bad week'
  if (!provider) return 'bad provider'
  if (!title) return 'bad title'
  if (!description) return 'bad description'
  if (to === undefined || (kind === 'pitch' && !to)) return 'bad to'
  if (from === undefined) return 'bad from'
  if (note === undefined) return 'bad note'
  if (!trade) return 'bad trade'

  if (!Array.isArray(m.sides) || m.sides.length < 2 || m.sides.length > 4) return 'bad sides'
  const sides: TradeMeta['sides'] = []
  for (const s of m.sides) {
    const r = (s ?? {}) as Record<string, unknown>
    const head = clean(r.head, 80)
    const faab = int(r.faab ?? 0, 0, 10_000)
    if (!head || faab == null || !Array.isArray(r.players) || r.players.length > 10) return 'bad sides'
    const players: TradeMeta['sides'][number]['players'] = []
    for (const p of r.players) {
      const q = (p ?? {}) as Record<string, unknown>
      const name = clean(q.name, 60)
      const pos = typeof q.pos === 'string' && /^[A-Z0-9/]{0,6}$/.test(q.pos) ? q.pos : null
      const team = q.team == null ? null : typeof q.team === 'string' && /^[A-Za-z]{2,4}$/.test(q.team) ? q.team : undefined
      const ppw = q.ppw == null ? null : num(q.ppw, -10, 100)
      const tag = q.tag == null ? null : TAGS.find((t) => t === q.tag)
      const pfrom = opt(q.from, 60)
      if (!name || pos == null || team === undefined || (q.ppw != null && ppw == null) || tag === undefined || pfrom === undefined) return 'bad player'
      players.push({ name, pos, team, ppw, tag, from: pfrom })
    }
    sides.push({ head, focus: r.focus === true, faab, players })
  }

  if (!Array.isArray(m.stats) || m.stats.length > 8) return 'bad stats'
  const stats: TradeMeta['stats'] = []
  for (const s of m.stats) {
    const r = (s ?? {}) as Record<string, unknown>
    const label = clean(r.label, 60)
    const value = clean(r.value, 24)
    const unit = opt(r.unit, 10)
    const sub = opt(r.sub, 90)
    const tone = TONES.find((t) => t === r.tone)
    if (!label || !value || unit === undefined || sub === undefined || !tone) return 'bad stats'
    stats.push({ label, value, unit, sub, tone })
  }

  let strip: TradeMeta['strip'] = null
  if (m.strip != null) {
    if (!Array.isArray(m.strip) || m.strip.length < 1 || m.strip.length > 20) return 'bad strip'
    strip = []
    for (const w of m.strip) {
      const r = (w ?? {}) as Record<string, unknown>
      const wk = int(r.week, 1, 30)
      const delta = num(r.delta, -200, 200)
      if (wk == null || delta == null) return 'bad strip'
      strip.push({ week: wk, delta })
    }
  }
  return { kind, league, leagueId, season, week, provider, title, description, to, from, note, sides, stats, strip, trade }
}

/** POST /trade: validate, store, answer with the link's id. */
export async function handleTradePost(req: Request, env: ShareEnv, origin: string, ip: string): Promise<Response> {
  if (limited(`t1:${ip}`, 6) || limited(`th:${ip}`, 40, 3_600_000)) return send({ error: 'slow down' }, 429, origin, { 'retry-after': '60' })
  const body = await readBody(req, MAX_TRADE_META)
  if ('error' in body) return send({ error: body.error }, body.status, origin)
  const meta = parseTradeMeta(body.meta)
  if (typeof meta === 'string') return send({ error: meta }, 400, origin)
  const dims = checkPng(body.png)
  if (typeof dims === 'string') return send({ error: dims }, dims === 'png too large' ? 413 : 400, origin)
  const id = newId()
  const buf = body.png.buffer.slice(body.png.byteOffset, body.png.byteOffset + body.png.byteLength) as ArrayBuffer
  await Promise.all([
    env.GRADES.put(`t:${id}:png`, buf, { expirationTtl: TTL_SECONDS }),
    env.GRADES.put(`t:${id}`, JSON.stringify({ v: 1, at: Date.now(), ...meta }), { expirationTtl: TTL_SECONDS }),
  ])
  return send({ id, url: `${new URL(req.url).origin}/t/${id}` }, 200, origin)
}

const signed = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}`

/** The lineup change week by week, as small bars either side of a zero line. */
const stripSvg = (strip: NonNullable<TradeMeta['strip']>) => {
  const w = 28
  const h = 64
  const mid = h / 2
  const max = Math.max(0.5, ...strip.map((s) => Math.abs(s.delta)))
  const bars = strip
    .map((s, i) => {
      const len = Math.max(1, (Math.abs(s.delta) / max) * (mid - 4))
      const y = s.delta >= 0 ? mid - len : mid
      return `<rect x="${i * w + 6}" y="${y.toFixed(1)}" width="${w - 12}" height="${len.toFixed(1)}" fill="${Math.abs(s.delta) < 0.05 ? '#3f3f46' : s.delta > 0 ? '#2ec470' : '#f46666'}"><title>Week ${s.week}: ${signed(s.delta)}</title></rect><text x="${i * w + w / 2}" y="${h + 14}" text-anchor="middle">${s.week}</text>`
    })
    .join('')
  return `<svg class="strip" viewBox="0 0 ${strip.length * w} ${h + 18}" role="img" aria-label="Lineup change by week: ${esc(strip.map((s) => `week ${s.week} ${signed(s.delta)}`).join(', '))}"><line x1="0" x2="${strip.length * w}" y1="${mid}" y2="${mid}" stroke="#52525b" stroke-width="1.5"/>${bars}</svg>`
}

/** The page, for bots and people alike: Open Graph tags, the card, the trade in words, and the way into the app. */
export const tradePage = (meta: TradeMeta, id: string, origin: string) => {
  const page = `${origin}/t/${id}`
  const image = `${origin}/t/${id}.png`
  const to = tradeAppUrl({ leagueId: meta.leagueId, season: meta.season, trade: meta.trade })
  const alt = `${meta.title}: ${meta.description}`.slice(0, 300)
  const tags = [
    ['og:type', 'website'],
    ['og:site_name', 'sujeff.com / Fantasy'],
    ['og:title', meta.title],
    ['og:description', meta.description],
    ['og:url', page],
    ['og:image', image],
    ['og:image:type', 'image/png'],
    ['og:image:width', String(CARD.w)],
    ['og:image:height', String(CARD.h)],
    ['og:image:alt', alt],
    ['twitter:card', 'summary_large_image'],
    ['twitter:title', meta.title],
    ['twitter:description', meta.description],
    ['twitter:image', image],
    ['twitter:image:alt', alt],
    ['theme-color', '#111114'],
  ]
  const side = (s: TradeMeta['sides'][number]) => `<section class="side${s.focus ? ' focus' : ''}">
<h2>${esc(s.head)}</h2>
<ul>${s.players
    .map(
      (p) =>
        `<li><span class="ps">${esc(p.pos)}</span><span class="nm">${esc(p.name)}${p.tag ? ` <em>${esc(p.tag)}</em>` : ''}<small>${esc([p.team ?? 'FA', p.from ? `from ${p.from}` : ''].filter(Boolean).join(' · '))}</small></span>${p.ppw != null ? `<span class="ppw">${p.ppw.toFixed(1)}<small>/wk</small></span>` : ''}</li>`,
    )
    .join('')}${s.faab ? `<li><span class="ps">$</span><span class="nm">$${s.faab} FAAB</span></li>` : ''}${!s.players.length && !s.faab ? '<li class="none">Nothing back</li>' : ''}</ul>
</section>`
  const stats = meta.stats.length
    ? `<div class="stats">${meta.stats
        .map(
          (s) =>
            `<div class="stat ${s.tone}"><div class="lab">${esc(s.label)}</div><div class="val">${esc(s.value)}${s.unit ? `<small>${esc(s.unit)}</small>` : ''}</div>${s.sub ? `<div class="sub">${esc(s.sub)}</div>` : ''}</div>`,
        )
        .join('')}</div>`
    : ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(meta.title)}</title>
<meta name="description" content="${esc(meta.description)}">
<meta name="robots" content="noindex">
${tags.map(([k, v]) => `<meta ${k.startsWith('og:') ? 'property' : 'name'}="${k}" content="${esc(v)}">`).join('\n')}
<style>
*{box-sizing:border-box}
body{margin:0;background:#09090b;color:#fafafa;font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
main{width:min(760px,100%);margin:0 auto;padding:20px 16px 40px}
.eyebrow,h2,.lab,.ps,small,.cta,.foot,.strip text{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
.eyebrow{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#a1a1aa}
h1{margin:6px 0 2px;font-size:24px;font-weight:600;letter-spacing:-.01em;line-height:1.2}
.by{margin:0;color:#a1a1aa;font-size:13px}
.card{display:block;width:100%;height:auto;margin:16px 0;border:1px solid #27272a;background:#111114}
.note{margin:0 0 16px;padding:10px 12px;border-left:2px solid #5298f0;background:#111114;color:#d4d4d8}
.sides{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:1px;background:#27272a;border:1px solid #27272a}
.side{background:#111114;padding:12px}
.side.focus{box-shadow:inset 0 2px 0 #5298f0}
h2{margin:0 0 6px;font-size:11px;font-weight:500;letter-spacing:.12em;text-transform:uppercase;color:#a1a1aa}
.focus h2{color:#5298f0}
ul{list-style:none;margin:0;padding:0}
li{display:flex;align-items:center;gap:10px;padding:7px 0;border-top:1px solid #202023}
li:first-child{border-top:0}
.ps{flex:none;width:34px;padding:3px 0;border:1px solid #3f3f46;text-align:center;font-size:11px;color:#d4d4d8}
.nm{flex:1;min-width:0}
.nm small{display:block;font-size:11px;color:#a1a1aa}
.nm em{font-style:normal;font-family:ui-monospace,Menlo,monospace;font-size:10px;text-transform:uppercase;color:#2ec470}
.ppw{font-variant-numeric:tabular-nums;font-family:ui-monospace,Menlo,monospace}
.ppw small{color:#a1a1aa;margin-left:2px}
.none{color:#a1a1aa}
.stats{display:flex;flex-wrap:wrap;gap:1px;margin-top:16px;background:#27272a;border:1px solid #27272a}
.stat{flex:1 1 150px;background:#111114;padding:10px 12px}
.lab{font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:#a1a1aa}
.val{margin-top:2px;font:600 22px/1.2 ui-monospace,Menlo,monospace;font-variant-numeric:tabular-nums}
.stat.pos .val{color:#2ec470}
.stat.neg .val{color:#f46666}
.val small{margin-left:4px;font-size:11px;font-weight:400;color:#a1a1aa}
.sub{font-size:12px;color:#a1a1aa}
.weeks{margin-top:16px;padding:12px;border:1px solid #27272a;background:#111114}
.strip{display:block;width:100%;max-width:${meta.strip ? meta.strip.length * 44 : 0}px;margin-top:8px}
.strip text{font-size:9px;fill:#a1a1aa}
.go{display:flex;flex-wrap:wrap;align-items:center;gap:10px 16px;margin:0 0 16px;padding:14px 16px;border:1px solid #27272a;background:#111114}
.cta{display:inline-flex;align-items:center;gap:8px;height:44px;padding:0 18px;background:#2a64c4;color:#fff;text-decoration:none;font-size:12px;letter-spacing:.1em;text-transform:uppercase}
.cta:hover{filter:brightness(1.1)}
.go p{flex:1 1 260px;margin:0;font-size:13px;color:#a1a1aa}
.foot{margin-top:28px;font-size:12px;color:#71717a}
.foot a{color:#a1a1aa}
</style>
</head>
<body>
<main>
<div class="eyebrow">${esc(meta.league)} · Week ${meta.week}</div>
<h1>${esc(meta.title)}</h1>
${meta.from && meta.kind === 'pitch' ? '' : meta.from ? `<p class="by">Shared by ${esc(meta.from)}</p>` : ''}
<img class="card" src="${esc(image)}" width="${CARD.w}" height="${CARD.h}" alt="${esc(alt)}">
<div class="go">
<a class="cta" href="${esc(to)}">Open in Fantasy →</a>
<p>Opens this trade in the trade builder, priced for your own team, if you are in ${esc(meta.league)}. You will be asked for your fantasy username first.</p>
</div>
${meta.note ? `<p class="note">“${esc(meta.note)}”</p>` : ''}
<div class="sides">${meta.sides.map(side).join('')}</div>
${stats}
${meta.strip ? `<div class="weeks"><h2>${esc(meta.to ? `${meta.to} lineup, week by week` : 'Lineup, week by week')}</h2>${stripSvg(meta.strip)}</div>` : ''}
<div class="foot"><a href="${SITE}">ff.sujeff.com</a> · fantasy football, modelled</div>
</main>
</body>
</html>`
}

/** GET /t/:id (the page) and GET /t/:id.png (the card). Open to anyone; it holds only what the card shows. */
export async function serveTrade(req: Request, env: ShareEnv): Promise<Response> {
  const url = new URL(req.url)
  const m = /^\/t\/([A-Za-z0-9]+)(\.png)?$/.exec(url.pathname)
  if (!m || !ID.test(m[1])) return text('Not found', 404)
  const [, id, png] = m
  if (png) {
    const buf = await env.GRADES.get(`t:${id}:png`, 'arrayBuffer')
    if (!buf) return text('Not found', 404)
    return new Response(req.method === 'HEAD' ? null : buf, {
      headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=31536000, immutable', 'access-control-allow-origin': '*' },
    })
  }
  const stored = (await env.GRADES.get(`t:${id}`, 'json')) as (TradeMeta & { v?: number }) | null
  const meta = stored ? parseTradeMeta(stored) : null
  if (!meta || typeof meta === 'string') {
    // A link that has lapsed says so, and still offers the app.
    const bot = BOTS.test(req.headers.get('user-agent') ?? '')
    return text(
      bot
        ? 'Not found'
        : `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Trade link expired</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#09090b;color:#fafafa;font:15px/1.5 system-ui,sans-serif"><main style="text-align:center;padding:24px"><p>This trade link has expired or never existed.</p><a href="${SITE}/#trades" style="color:#5298f0">Open Fantasy</a></main></body>`,
      404,
    )
  }
  return text(tradePage(meta, id, url.origin), 200, { 'cache-control': 'public, max-age=300' })
}
