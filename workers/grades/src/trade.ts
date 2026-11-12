// Shared trades. The app posts the 1200×630 card of a trade and the facts printed on it (lib/tradeShare `TradeCard`:
// the teams, the players, the blocks the sender chose to show, a note), and gets back a short link. Unlike a shared
// Power Rank, the link is a page of its own for everyone: link-preview bots read its Open Graph tags, and a person
// sees the trade, with a button that opens it in the app's trade builder for a member of the league.
//
//   t:<id>      the facts, as JSON
//   t:<id>:png  the card
//
// Both expire after 120 days. Only what the card shows is accepted: every field is read, checked and capped, and
// anything else in the request is dropped. The title and description are written here from those fields, never taken
// from the request, and the deal the link opens must be the one pictured, so a link cannot say one trade and open
// another.

import { limited, send } from './common'
import { LEAGUE_ID, SITE, tradeAppUrl } from './links'
import { BOTS, CARD, checkPng, clean, esc, int, newId, readBody, text, TTL_SECONDS, ID, type ShareEnv } from './share'
import { MAX_DEAL_PARTS, MAX_DEAL_TEAMS, MAX_TRADE_META, parseTrade, tradeText, type LinkDeal } from './tradeLink'

export { MAX_TRADE_META }
const PLAYER_ID = /^[A-Za-z0-9_-]{1,24}$/
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
  sides: { rosterId: number; head: string; focus: boolean; faab: number; players: { id: string; name: string; pos: string; team: string | null; ppw: number | null; tag: (typeof TAGS)[number] | null; from: string | null }[] }[]
  stats: { label: string; value: string; unit: string | null; sub: string | null; tone: (typeof TONES)[number] }[]
  strip: { week: number; delta: number }[] | null
  /** With the strip, the lineup change a week its dashed line marks (lib/tradeShare `TradeCard.net`). */
  net: number | null
  /** The deal as the app's link carries it (lib/tradeShare `encodeDeal`): always the one the sides picture. */
  trade: string
}

/**
 * Whether the deal is the one pictured: the same teams, every player on the side of the team he goes to and none left
 * out, and FAAB, where it is shown, as the deal pays it (each side what it takes in; the recipient's figure, net).
 */
const pictured = (deal: LinkDeal, sides: TradeMeta['sides'], stats: TradeMeta['stats']) => {
  const ids = sides.map((s) => s.rosterId)
  if (new Set(ids).size !== ids.length || ids.length !== deal.teams.length || !deal.teams.every((t) => ids.includes(t))) return false
  const listed = sides.flatMap((s) => s.players.map((p) => ({ id: p.id, to: s.rosterId })))
  if (listed.length !== deal.moves.length || !listed.every((p) => deal.moves.some((m) => m.player === p.id && m.to === p.to))) return false
  const paid = (rid: number, dir: 'from' | 'to') => deal.faab.filter((x) => x[dir] === rid).reduce((a, x) => a + x.dollars, 0)
  // FAAB is on the card for every side or for none.
  const shown = sides.some((s) => s.faab > 0)
  if (!sides.every((s) => s.faab === (shown ? paid(s.rosterId, 'to') : 0))) return false
  const focus = sides.find((s) => s.focus)
  const faabStat = stats.find((s) => s.label === 'FAAB in')
  if (faabStat && (!shown || !focus || faabStat.value !== `$${paid(focus.rosterId, 'to') - paid(focus.rosterId, 'from')}`)) return false
  return true
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
  const to = opt(m.to, 60)
  const from = opt(m.from, 60)
  const note = opt(m.note, 100)
  const trade = typeof m.trade === 'string' ? m.trade : null
  const deal = parseTrade(trade)
  if (!kind) return 'bad kind'
  if (!league) return 'bad league'
  if (!leagueId) return 'bad leagueId'
  if (!season) return 'bad season'
  if (week == null) return 'bad week'
  if (!provider) return 'bad provider'
  if (to === undefined || (kind === 'pitch' && !to)) return 'bad to'
  if (from === undefined) return 'bad from'
  if (note === undefined) return 'bad note'
  if (!trade || !deal) return 'bad trade'

  if (!Array.isArray(m.sides) || m.sides.length < 2 || m.sides.length > MAX_DEAL_TEAMS) return 'bad sides'
  const sides: TradeMeta['sides'] = []
  for (const s of m.sides) {
    const r = (s ?? {}) as Record<string, unknown>
    const rosterId = int(r.rosterId, 0, 9999)
    const head = clean(r.head, 80)
    const faab = int(r.faab ?? 0, 0, 10_000)
    if (rosterId == null || !head || faab == null || !Array.isArray(r.players) || r.players.length > MAX_DEAL_PARTS) return 'bad sides'
    const players: TradeMeta['sides'][number]['players'] = []
    for (const p of r.players) {
      const q = (p ?? {}) as Record<string, unknown>
      const pid = typeof q.id === 'string' && PLAYER_ID.test(q.id) ? q.id : null
      const name = clean(q.name, 60)
      const pos = typeof q.pos === 'string' && /^[A-Z0-9/]{0,6}$/.test(q.pos) ? q.pos : null
      const team = q.team == null ? null : typeof q.team === 'string' && /^[A-Za-z]{2,4}$/.test(q.team) ? q.team : undefined
      const ppw = q.ppw == null ? null : num(q.ppw, -10, 100)
      const tag = q.tag == null ? null : TAGS.find((t) => t === q.tag)
      const pfrom = opt(q.from, 60)
      if (!pid || !name || pos == null || team === undefined || (q.ppw != null && ppw == null) || tag === undefined || pfrom === undefined) return 'bad player'
      players.push({ id: pid, name, pos, team, ppw, tag, from: pfrom })
    }
    sides.push({ rosterId, head, focus: r.focus === true, faab, players })
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
  // Older links have no net; their strip is drawn without the line.
  const net = strip && m.net != null ? num(m.net, -200, 200) : null
  if (strip && m.net != null && net == null) return 'bad net'
  if (!pictured(deal, sides, stats)) return 'trade does not match the card'
  const { title, description } = tradeText({ kind, league, to, from, sides, stats })
  return { kind, league, leagueId, season, week, provider, title, description, to, from, note, sides, stats, strip, net, trade }
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

/**
 * The lineup change week by week, as small bars either side of a zero line, with the card's dashed line at the
 * lineup change a week. Each bar's side of the line, its tooltip and the summary above say which way it went, so the
 * colour is never the only cue.
 */
const stripSvg = (strip: NonNullable<TradeMeta['strip']>, net: number | null) => {
  const w = 28
  const h = 64
  // As on the card: with no losing week the zero line sits at the foot and the bars use the height; otherwise it sits
  // where gains and losses split it, so the week numbers always sit just under the bars.
  const up = Math.max(0.5, ...strip.map((s) => s.delta), net ?? 0)
  const down = Math.max(0, ...strip.map((s) => -s.delta), -(net ?? 0))
  const span = h - 4
  const mid = 2 + span * (up / (up + down))
  const k = span / (up + down)
  const y = (v: number) => mid - v * k
  const bars = strip
    .map((s, i) => {
      const len = Math.max(1, Math.abs(s.delta) * k)
      const top = s.delta >= 0 ? mid - len : mid
      return `<rect x="${i * w + 6}" y="${top.toFixed(1)}" width="${w - 12}" height="${len.toFixed(1)}" fill="${Math.abs(s.delta) < 0.05 ? '#3f3f46' : s.delta > 0 ? '#2ec470' : '#f46666'}"><title>Week ${s.week}: ${signed(s.delta)}</title></rect><text x="${i * w + w / 2}" y="${h + 14}" text-anchor="middle">${s.week}</text>`
    })
    .join('')
  const line = net != null ? `<line x1="0" x2="${strip.length * w}" y1="${y(net).toFixed(1)}" y2="${y(net).toFixed(1)}" stroke="#fafafa" stroke-width="1.5" stroke-dasharray="4 3"/>` : ''
  const label = `Lineup change by week${net != null ? `, ${signed(net)} a week overall` : ''}: ${strip.map((s) => `week ${s.week} ${signed(s.delta)}`).join(', ')}`
  return `<svg class="strip" viewBox="0 0 ${strip.length * w} ${h + 18}" role="img" aria-label="${esc(label)}"><line x1="0" x2="${strip.length * w}" y1="${mid.toFixed(1)}" y2="${mid.toFixed(1)}" stroke="#71717a" stroke-width="1.5"/>${bars}${line}</svg>`
}

/** The strip's heading line: the lineup change a week, and how many of the weeks are better. */
const stripSummary = (strip: NonNullable<TradeMeta['strip']>, net: number | null) => {
  const better = strip.filter((s) => s.delta > 0.05).length
  return `${net != null ? `<span class="key" aria-hidden="true"></span>${signed(net)} a week overall · ` : ''}better in ${better} of ${strip.length} weeks`
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
.val{margin-top:2px;font:600 22px/1.2 ui-monospace,Menlo,monospace;font-variant-numeric:tabular-nums;white-space:nowrap}
.stat.pos .val{color:#2ec470}
.stat.neg .val{color:#f46666}
.val small{margin-left:4px;font-size:11px;font-weight:400;color:#a1a1aa}
.sub{font-size:12px;color:#a1a1aa}
.weeks{margin-top:16px;padding:12px;border:1px solid #27272a;background:#111114}
.strip{display:block;width:100%;max-width:${meta.strip ? meta.strip.length * 44 : 0}px;margin-top:8px}
.strip text{font-size:9px;fill:#a1a1aa}
.weeks-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:4px 12px}
.weeks-head h2{margin:0}
.weeks-sum{font:12px/1.4 ui-monospace,Menlo,monospace;color:#fafafa}
.key{display:inline-block;width:16px;margin-right:6px;vertical-align:middle;border-top:1.5px dashed #fafafa}
.go{display:flex;flex-wrap:wrap;align-items:center;gap:10px 16px;margin:0 0 16px;padding:14px 16px;border:1px solid #27272a;background:#111114}
.cta{display:inline-flex;align-items:center;gap:8px;height:44px;padding:0 18px;background:#2a64c4;color:#fff;text-decoration:none;font-size:12px;letter-spacing:.1em;text-transform:uppercase}
.cta:hover{filter:brightness(1.1)}
.go p{flex:1 1 260px;margin:0;font-size:13px;color:#a1a1aa}
.foot{margin-top:28px;font-size:12px;color:#a1a1aa}
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
<p>Opens this trade in the trade builder, priced for your own team, if you are in ${esc(meta.league)}. The first time, you’ll be asked for your fantasy username.</p>
</div>
${meta.note ? `<p class="note">“${esc(meta.note)}”</p>` : ''}
<div class="sides">${meta.sides.map(side).join('')}</div>
${stats}
${meta.strip ? `<div class="weeks"><div class="weeks-head"><h2>${esc(meta.to ? `${meta.to} lineup, week by week` : 'Lineup, week by week')}</h2><span class="weeks-sum">${stripSummary(meta.strip, meta.net)}</span></div>${stripSvg(meta.strip, meta.net)}</div>` : ''}
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
        : `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Trade link expired</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#09090b;color:#fafafa;font:15px/1.5 system-ui,sans-serif"><main style="text-align:center;padding:24px"><p>This trade link has expired or never existed. Ask whoever sent it for a new one.</p><a href="${SITE}/#trades" style="color:#5298f0">Open Fantasy</a></main></body>`,
      404,
    )
  }
  return text(tradePage(meta, id, url.origin), 200, { 'cache-control': 'public, max-age=300' })
}
