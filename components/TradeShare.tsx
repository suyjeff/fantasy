import React, { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { tradeValue } from '../lib/currency'
import { dealActive, type Deal } from '../lib/deal'
import { formText } from '../lib/momentum'
import { sharedUrl } from '../lib/sharedGrades'
import {
  NOTE_MAX,
  blockOn,
  buildCard,
  cardText,
  decodeDeal,
  linkMeta,
  ppwDefault,
  shareBlocks,
  slotFill,
  type Audience,
  type BlockState,
  type ShareBlockKey,
  type ShareContext,
  type ShareFacts,
  type ShareOptions,
  type TradeCard,
} from '../lib/tradeShare'
import { useFantasy } from './FantasyContext'
import { copyText, save } from './RevealShare'
import { useModal } from './Sheet'
import { toBlob } from './shareCards'
import SwipeSheet, { type SwipeSheetHandle } from './SwipeSheet'
import { CLOSE, Glyph, useDealRead } from './TradeBuilder'
import { useLeverages, useTradeSides } from './TradeCard'
import { useTradeDock } from './TradeDock'
import { cardSources, drawTradeCard, FORMATS, loadCardFonts, loadPictures, paletteOf, picturesReady, renderTradeCard, type CardFormat, type CardTheme } from './tradeShareCard'
import { Avatar, Segmented, cx, usePhone } from './ui'

// Sharing a trade: a Share button on every place a trade shows (a suggested card, the builder, a Compare column) opens
// this sheet. It shows the card as it will be sent and the few choices that shape it: who it is for, which figures go
// on it, the details, the colours and the size. Pitched to a partner, only what helps them can be switched on; the
// rest is listed, greyed, with why. Then out: a PNG, the image on the clipboard, the device's share sheet, or a link
// (workers/grades/src/trade.ts) whose preview is the wide card and which opens the deal in the app.

const SHARE = 'M7 9V1.5M4 4.25 7 1.25l3 3M2.5 7v5.5h9V7'

/** Everything known about the deal for one recipient: the read, their odds, the slot it fills, value and timing. */
const useShareFacts = (deal: Deal, audience: Audience): ShareFacts | null => {
  const { data, analysis, models } = useFantasy()
  const read = useDealRead(deal)
  const me = analysis.myRosterId
  // Playoff odds come from the trade cards' cache (and are simulated in idle time if not there yet): two teams, you in it.
  const sidesOf = useTradeSides()
  const two = deal.teams.length === 2 && me != null && deal.teams.includes(me)
  const partner = two ? deal.teams.find((t) => t !== me)! : null
  const tradeSides = useMemo(
    () =>
      partner != null
        ? sidesOf(
            partner,
            deal.moves.filter((m) => m.from === me).map((m) => m.player),
            deal.moves.filter((m) => m.to === me).map((m) => m.player),
          )
        : null,
    [sidesOf, partner, deal, me],
  )
  const lev = useLeverages([tradeSides])[0]
  const form = useMemo(() => {
    const out: ShareFacts['form'] = {}
    for (const [id, f] of Object.entries(analysis.form)) out[id] = { kind: f.kind, name: f.name, text: formText(f) }
    return out
  }, [analysis.form])
  return useMemo(() => {
    if (!read) return null
    const rid = audience.kind === 'pitch' ? audience.to : null
    const side = rid != null ? read.sides.find((s) => s.rosterId === rid) : null
    const roster = rid != null ? (analysis.teamById[rid]?.players ?? []) : []
    const fill =
      side && data.horizon.length
        ? slotFill({ slots: analysis.slots, players: data.players, horizon: data.horizon, floor: analysis.horizonReplacement, capacity: analysis.capacity, pts: analysis.horizon.perWeek, roster, sends: side.sends, receives: side.receives })
        : null
    const perceived = models.perceived
    const consensus = side && perceived ? Math.round((tradeValue(side.receives, perceived, analysis.currency, false) - tradeValue(side.sends, perceived, analysis.currency, true)) * 100) / 100 : null
    const leverage = rid != null && rid === partner ? (lev === undefined ? undefined : lev ? { playoffs: lev.partner.playoffs, title: lev.partner.title } : null) : null
    return { deal, read, leverage, fill, consensus, form }
  }, [read, audience, analysis, data, models.perceived, lev, partner, deal, form])
}

// ---- Small controls ----

/** A labelled on/off switch: a native checkbox, so keys and screen readers get it for free. */
const Switch = ({ label, detail, checked, disabled, onChange, value }: { label: string; detail?: ReactNode; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void; value?: ReactNode }) => {
  const id = useId()
  return (
    <div className={cx('flex min-h-11 items-start gap-3 py-1.5 md:min-h-9', disabled && 'opacity-60')}>
      <input
        id={id}
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        aria-describedby={detail ? `${id}-d` : undefined}
        className="peer sr-only"
      />
      <label htmlFor={id} className={cx('flex min-w-0 flex-1 cursor-pointer items-start gap-3', disabled && 'cursor-default')}>
        <span
          aria-hidden
          className={cx(
            'relative mt-0.5 flex h-[18px] w-8 shrink-0 items-center border transition-colors duration-150',
            checked && !disabled ? 'border-ff-accent bg-ff-accent/15' : 'border-ff-line2 bg-ff-sunken',
          )}
        >
          <span className={cx('absolute top-[2px] h-3 w-3 transition-[left] duration-150 motion-reduce:transition-none', checked && !disabled ? 'left-[16px] bg-ff-accent' : 'left-[2px] bg-ff-muted')} />
        </span>
        <span className="min-w-0 flex-1 leading-tight">
          <span className="flex items-baseline justify-between gap-2">
            <span className="text-[13px] text-ff-text">{label}</span>
            {value != null && <span className={cx('num shrink-0 truncate text-[12px]', checked && !disabled ? 'text-ff-pos' : 'text-ff-muted')}>{value}</span>}
          </span>
          {detail && (
            <span id={`${id}-d`} className="mt-0.5 block font-mono text-[10.5px] text-ff-muted">
              {detail}
            </span>
          )}
        </span>
      </label>
    </div>
  )
}

const Section = ({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) => (
  <section className="border-t border-ff-line px-4 py-3 first:border-t-0">
    <div className="mb-1.5 flex items-baseline justify-between gap-2">
      <h3 className="ff-label">{title}</h3>
      {aside && <span className="font-mono text-[10.5px] text-ff-muted">{aside}</span>}
    </div>
    {children}
  </section>
)

const ActionBtn = ({ children, onClick, disabled, primary, label }: { children: ReactNode; onClick: () => void; disabled?: boolean; primary?: boolean; label?: string }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    aria-label={label}
    className={cx(
      'ff-press inline-flex h-11 min-w-0 flex-1 items-center justify-center gap-1.5 whitespace-nowrap border px-2 font-mono text-[11px] uppercase tracking-[0.08em] disabled:cursor-default disabled:opacity-50 md:h-9',
      primary ? 'border-[rgb(var(--ff-accent-deep))] bg-[rgb(var(--ff-accent-deep))] text-[rgb(var(--ff-on-accent))] enabled:hover:brightness-110' : 'border-ff-line2 text-ff-text2 enabled:hover:bg-ff-raised enabled:hover:text-ff-text',
    )}
  >
    {children}
  </button>
)

// ---- What was made, kept by what it was made from ----

const fileCache = new Map<string, Promise<File>>()
const linkCache = new Map<string, Promise<string>>()
const remember = <T,>(m: Map<string, Promise<T>>, key: string, make: () => Promise<T>) => {
  let hit = m.get(key)
  if (!hit) {
    hit = make()
    m.set(key, hit)
    hit.catch(() => m.get(key) === hit && m.delete(key))
    while (m.size > 8) m.delete(m.keys().next().value as string)
  }
  return hit
}

const fileName = (card: TradeCard, format: CardFormat) => {
  const who = (card.to ?? card.league).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'trade'
  return `trade-${who}-wk${card.week}${format === 'square' ? '' : `-${format}`}.png`
}

/** The worker's link for a card: the wide picture and the card's facts, uploaded once per card. */
const uploadLink = async (card: TradeCard, theme: CardTheme): Promise<string> => {
  const base = sharedUrl()
  if (!base) throw new Error('no worker')
  const og = await toBlob(await renderTradeCard(card, 'og', paletteOf(theme)))
  if (og.size > 400 * 1024) throw new Error('card too large')
  const form = new FormData()
  form.set('meta', JSON.stringify(linkMeta(card)))
  form.set('png', og, 'trade.png')
  const ctl = new AbortController()
  const timer = window.setTimeout(() => ctl.abort(), 20000)
  try {
    const r = await fetch(`${base}/trade`, { method: 'POST', body: form, signal: ctl.signal })
    if (!r.ok) throw new Error(`share ${r.status}`)
    const { id } = (await r.json()) as { id?: string }
    if (!id || !/^[A-Za-z0-9]{10,32}$/.test(id)) throw new Error('bad id')
    return `${base}/t/${id}`
  } finally {
    window.clearTimeout(timer)
  }
}

type Status = null | { tone: 'ok' | 'bad'; text: string }

// ---- The sheet ----

const SharePanel = ({ deal, onClose, titleId, phone }: { deal: Deal; onClose: () => void; titleId: string; phone: boolean }) => {
  const { data, analysis } = useFantasy()
  const me = analysis.myRosterId ?? -1
  const name = useCallback((rid: number) => analysis.teamById[rid]?.name ?? `Team ${rid}`, [analysis.teamById])
  const partners = deal.teams.filter((t) => t !== me)
  const [audience, setAudience] = useState<Audience>(() => (partners.length ? { kind: 'pitch', to: partners[0] } : { kind: 'league' }))
  const [include, setInclude] = useState<Partial<Record<ShareBlockKey, boolean>>>({})
  const [ppw, setPpw] = useState<boolean | null>(null)
  const [faab, setFaab] = useState(true)
  const [sender, setSender] = useState(true)
  const [note, setNote] = useState('')
  const [theme, setTheme] = useState<CardTheme>('app')
  const [format, setFormat] = useState<CardFormat>('square')
  const [status, setStatus] = useState<Status>(null)
  const [link, setLink] = useState<{ key: string; url: string | null; state: 'working' | 'ready' | 'failed' } | null>(null)
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const say = useCallback((s: Status) => {
    setStatus(s)
    window.clearTimeout(timer.current)
    if (s) timer.current = window.setTimeout(() => setStatus(null), s.tone === 'bad' ? 6000 : 3000)
  }, [])

  const facts = useShareFacts(deal, audience)
  const blocks: BlockState[] = useMemo(() => (facts ? shareBlocks(audience, facts, name) : []), [facts, audience, name])
  const ppwOn = ppw ?? (facts ? ppwDefault(audience, facts.read, analysis.horizon.perWeek) : true)
  const ctx: ShareContext = useMemo(
    () => ({
      league: data.league.name || 'Fantasy league',
      leagueId: data.league.league_id,
      season: String(data.league.season),
      week: Math.max(1, Math.min(30, data.horizon[0]?.week ?? Number(data.state.week) ?? 1)),
      provider: data.provider ?? 'sleeper',
      me,
      teams: Object.fromEntries(analysis.teams.map((t) => [t.rosterId, { name: name(t.rosterId), avatar: analysis.teamById[t.rosterId]?.avatar ?? null }])),
      players: data.players,
      ppw: analysis.horizon.perWeek,
    }),
    [data, analysis, me, name],
  )
  const opts: ShareOptions = useMemo(() => ({ audience, include, ppw: ppwOn, faab: data.tradeFaab ? faab : true, sender, note }), [audience, include, ppwOn, faab, sender, note, data.tradeFaab])
  const card = useMemo(() => (facts ? buildCard(ctx, facts, blocks, opts) : null), [ctx, facts, blocks, opts])
  const key = useMemo(() => (card ? JSON.stringify([card, theme]) : ''), [card, theme])
  const pal = useMemo(() => paletteOf(theme), [theme]) // eslint-disable-line react-hooks/exhaustive-deps

  // The preview: drawn straight onto the canvas on screen at every change (a few milliseconds), then again once
  // fonts and pictures have landed, if they had not.
  const canvas = useRef<HTMLCanvasElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const [drawn, setDrawn] = useState(false)
  // The picture is fitted to its frame by measurement: CSS alone either stretches a canvas or overflows the frame.
  const [box, setBox] = useState<{ w: number; h: number } | null>(null)
  useEffect(() => {
    const el = frame.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    const el = canvas.current
    if (!el || !card) return
    let live = true
    const draw = () => {
      if (!live) return
      drawTradeCard(el, card, format, pal)
      setDrawn(true)
    }
    const raf = requestAnimationFrame(draw)
    const srcs = cardSources(card, {})
    if (!picturesReady(srcs)) Promise.all([loadCardFonts(), loadPictures(srcs)]).then(() => requestAnimationFrame(draw))
    else loadCardFonts().then(() => requestAnimationFrame(draw))
    return () => {
      live = false
      cancelAnimationFrame(raf)
    }
  }, [card, format, pal])

  // The PNG, made a beat after the last change, so Share has a file in hand when tapped (a share sheet opens only
  // straight from a tap).
  const fileKey = `${key}|${format}`
  const [file, setFile] = useState<{ key: string; file: File } | null>(null)
  useEffect(() => {
    if (!card) return
    const id = window.setTimeout(() => {
      fileFor().then((f) => setFile({ key: fileKey, file: f }), () => {})
    }, 350)
    return () => window.clearTimeout(id)
  }, [fileKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const fileFor = () =>
    remember(fileCache, fileKey, () =>
      renderTradeCard(card!, format, pal)
        .then(toBlob)
        .then((b) => new File([b], fileName(card!, format), { type: 'image/png' })),
    )
  const readyFile = file?.key === fileKey ? file.file : null

  const canShareFiles = useMemo(() => {
    try {
      const probe = new File([new Blob(['x'], { type: 'image/png' })], 'x.png', { type: 'image/png' })
      return typeof navigator.share === 'function' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [probe] })
    } catch {
      return false
    }
  }, [])
  const canCopyImage = typeof window !== 'undefined' && typeof window.ClipboardItem === 'function' && !!navigator.clipboard?.write
  const worker = sharedUrl()

  const download = () => {
    if (!card) return
    fileFor().then(
      (f) => say({ tone: 'ok', text: save(f) === 'opened' ? 'Opened the image: press and hold to save it' : 'Downloaded the image' }),
      () => say({ tone: 'bad', text: 'Could not draw the image. Try again.' }),
    )
  }
  const copyImage = () => {
    if (!card) return
    if (!canCopyImage) return download()
    // The promise goes to the clipboard straight from the tap, as Safari asks.
    const blob = fileFor().then((f) => f as Blob)
    navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).then(
      () => say({ tone: 'ok', text: 'Image copied: paste it into a message' }),
      () => {
        say({ tone: 'bad', text: 'This browser would not copy the image, so it was downloaded instead.' })
        download()
      },
    )
  }
  const shareFile = () => {
    const f = readyFile
    if (!f || !card) return
    const { title } = cardText(card)
    navigator.share({ files: [f], title }).then(
      () => say(null),
      (e) => ((e as DOMException)?.name === 'AbortError' ? say(null) : say({ tone: 'bad', text: 'Could not open the share sheet. Download the image instead.' })),
    )
  }
  const linkKey = key
  const curLink = link?.key === linkKey ? link : null
  const copyLink = () => {
    if (!card || !worker) return
    if (curLink?.state === 'working') return
    setLink({ key: linkKey, url: null, state: 'working' })
    remember(linkCache, linkKey, () => uploadLink(card, theme)).then(
      (url) => {
        setLink((l) => (l?.key === linkKey ? { key: linkKey, url, state: 'ready' } : l))
        copyText(url).then((ok) => say(ok ? { tone: 'ok', text: 'Link copied' } : { tone: 'bad', text: 'Link made: copy it from the field.' }))
      },
      () => {
        setLink((l) => (l?.key === linkKey ? { key: linkKey, url: null, state: 'failed' } : l))
        say({ tone: 'bad', text: 'Could not make the link. Try again in a moment.' })
      },
    )
  }

  const flip = (k: ShareBlockKey, on: boolean) => setInclude((x) => ({ ...x, [k]: on }))
  const pickAudience = (a: Audience) => {
    setAudience(a)
    // What was switched by hand was for the other reader.
    setInclude({})
    setPpw(null)
  }

  const hasFaab = deal.faab.some((x) => x.dollars > 0)
  const summary = audience.kind === 'pitch' ? `Shows only what helps ${name(audience.to)}` : 'The trade, and every team’s lineup change'
  const hidden = blocks.filter((b) => !b.available)
  const shown = blocks.filter((b) => b.available)
  const fmtLabel = FORMATS[format]
  const fitScale = box ? Math.min(box.w / fmtLabel.w, box.h / fmtLabel.h) : 0

  const sizePicker = (
    <div className="flex items-center justify-between gap-3">
      <Segmented<CardFormat>
        size="sm"
        label="Size"
        value={format}
        onChange={setFormat}
        options={(Object.keys(FORMATS) as CardFormat[]).map((f) => ({ key: f, label: FORMATS[f].label, title: FORMATS[f].hint }))}
      />
      <span className="min-w-0 truncate font-mono text-[10.5px] text-ff-muted">{fmtLabel.hint}</span>
    </div>
  )
  // On a phone the preview stays pinned above the choices as they scroll, so every change shows where it lands.
  const preview = (
    <div className={cx('flex flex-col gap-2', phone ? 'sticky top-0 z-[2] border-b border-ff-line bg-ff-panel px-4 pb-3 pt-1' : 'min-h-0 flex-1 p-5')}>
      <div
        className={cx('relative flex items-center justify-center border border-ff-line bg-ff-sunken', phone ? 'shrink-0 p-2' : 'min-h-0 flex-1 p-5')}
        style={phone ? { height: 'min(34dvh, calc(100vw - 50px))' } : undefined}
      >
        <div ref={frame} className="absolute inset-2 md:inset-5" aria-hidden />
        <canvas
          ref={canvas}
          role="img"
          aria-label={card ? `Preview: ${cardText(card).title}. ${cardText(card).description}` : 'Preview'}
          className={cx('relative block border border-ff-line2 bg-ff-panel shadow-[0_10px_30px_-14px_rgb(0_0_0/0.5)]', (!drawn || !box) && 'invisible')}
          style={{ width: Math.floor(fmtLabel.w * fitScale), height: Math.floor(fmtLabel.h * fitScale) }}
        />
        {!card && <span className="absolute inset-0 flex items-center justify-center font-mono text-[10.5px] uppercase tracking-[0.1em] text-ff-muted">Nothing to price yet</span>}
      </div>
      {!phone && sizePicker}
    </div>
  )

  const controls = (
    <>
      {phone && <Section title="Size">{sizePicker}</Section>}
      <Section title="For">
        <div role="radiogroup" aria-label="Who the card is for" className="-mx-1">
          {[...partners.map((t) => ({ a: { kind: 'pitch', to: t } as Audience, label: `Pitch to ${name(t)}`, sub: `Only what helps ${name(t)}`, avatar: analysis.teamById[t]?.avatar ?? null, t })), { a: { kind: 'league' } as Audience, label: 'League view', sub: 'The trade and every team’s lineup change', avatar: null, t: null }].map((o) => {
            const on = audience.kind === o.a.kind && (o.a.kind === 'league' || (audience.kind === 'pitch' && audience.to === o.t))
            return (
              <label key={o.t ?? 'league'} className={cx('flex min-h-11 cursor-pointer items-center gap-2.5 px-1 py-1.5 hover:bg-ff-raised md:min-h-10', on && 'bg-ff-raised')}>
                <input type="radio" name={`${titleId}-aud`} checked={on} onChange={() => pickAudience(o.a)} className="peer sr-only" />
                <span aria-hidden className={cx('flex h-4 w-4 shrink-0 items-center justify-center border peer-focus-visible:ring-2 peer-focus-visible:ring-ff-accent/40', on ? 'border-ff-accent' : 'border-ff-line2')}>
                  {on && <span className="h-2 w-2 bg-ff-accent" />}
                </span>
                {o.t != null ? (
                  <Avatar src={o.avatar} name={name(o.t)} size={20} />
                ) : (
                  <span aria-hidden className="flex h-5 w-5 items-center justify-center border border-ff-line2 font-mono text-[10px] text-ff-muted">
                    L
                  </span>
                )}
                <span className="min-w-0 flex-1 leading-tight">
                  <span className="block truncate text-[13px] text-ff-text">{o.label}</span>
                  <span className="block truncate font-mono text-[10.5px] text-ff-muted">{o.sub}</span>
                </span>
              </label>
            )
          })}
        </div>
      </Section>
      <Section title="On the card" aside={audience.kind === 'pitch' ? `${shown.filter((b) => blockOn(b, include)).length} of ${blocks.length}` : undefined}>
        {!facts && <p className="py-1 text-[12.5px] text-ff-muted">Pricing the trade…</p>}
        {facts && audience.kind === 'pitch' && !shown.length && (
          <p className="mb-1.5 border-l-2 border-ff-warn bg-ff-warn/[0.08] px-2.5 py-1.5 text-[12px] leading-snug text-ff-text2">
            Nothing here helps {name(audience.to)} by the numbers, so the card shows just the trade.
          </p>
        )}
        {[...shown, ...hidden].map((b) => {
          const v = b.stats[0]
          const val = b.key === 'weeks' ? `${facts?.read.weeks.length ?? 0} wks` : v ? `${v.value}${v.unit?.startsWith('/') ? v.unit : ''}` : null
          return (
            <Switch
              key={b.key}
              label={audience.kind === 'league' && b.key === 'lineup' ? 'Lineup change, each team' : b.label}
              checked={blockOn(b, include)}
              disabled={!b.available}
              onChange={(on) => flip(b.key, on)}
              value={b.available && audience.kind === 'pitch' ? val : null}
              detail={b.available ? (b.key === 'lineup' && audience.kind === 'pitch' ? v?.sub ?? undefined : b.key === 'odds' ? v?.sub ?? undefined : b.key === 'need' ? v?.label : b.key === 'momentum' ? v?.sub ?? undefined : undefined) : `Hidden: ${b.reason}`}
            />
          )
        })}
        {audience.kind === 'pitch' && <p className="mt-1.5 text-[11.5px] leading-snug text-ff-muted">Your own gain, your ask and the odds they say yes never go on the card.</p>}
      </Section>
      <Section title="Details">
        <Switch
          label="Points per week"
          checked={ppwOn}
          onChange={setPpw}
          detail={audience.kind === 'pitch' && facts && !ppwDefault(audience, facts.read, analysis.horizon.perWeek) ? 'Off by default: what they send projects higher' : 'Each player’s expected points a week'}
        />
        {data.tradeFaab && hasFaab && <Switch label="FAAB in the trade" checked={faab} onChange={setFaab} detail="The dollars moving, on each side" />}
        <Switch label="Sign with your team" checked={sender} onChange={setSender} detail={sender ? `Proposed by ${name(me)}` : 'Your team’s name is left off'} />
        <div className="pt-2">
          <div className="mb-1 flex items-baseline justify-between">
            <label htmlFor={`${titleId}-note`} className="text-[13px] text-ff-text">
              Note
            </label>
            <span className={cx('num text-[10.5px]', note.length >= NOTE_MAX ? 'text-ff-warn' : 'text-ff-muted')} aria-live="polite">
              {note.length}/{NOTE_MAX}
            </span>
          </div>
          <input
            id={`${titleId}-note`}
            type="text"
            value={note}
            maxLength={NOTE_MAX}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional: a line to them"
            className="h-10 w-full border border-ff-line bg-ff-sunken px-2.5 text-[13px] text-ff-text max-md:text-[16px] placeholder:text-ff-muted focus:border-ff-accent focus:outline-none md:h-9"
          />
        </div>
      </Section>
      <Section title="Colours">
        <Segmented<CardTheme>
          size="sm"
          block
          label="Colours"
          value={theme}
          onChange={setTheme}
          options={[
            { key: 'app', label: 'This theme', title: 'The app’s current colours' },
            { key: 'dark', label: 'Dark' },
            { key: 'light', label: 'Light' },
          ]}
        />
      </Section>
    </>
  )

  const shown_ = curLink?.state === 'ready' && curLink.url ? curLink.url.replace(/^https?:\/\//, '') : null
  const actions = (
    <div className="border-t border-ff-line bg-ff-panel px-4 py-3">
      {shown_ && (
        <div className="mb-2 flex h-9 items-center border border-ff-line bg-ff-sunken pl-2.5 font-mono text-[11.5px] text-ff-text2">
          <span className="min-w-0 flex-1 truncate" title={curLink!.url!}>
            {shown_}
          </span>
          <button type="button" onClick={() => copyText(curLink!.url!).then((ok) => say(ok ? { tone: 'ok', text: 'Link copied' } : { tone: 'bad', text: 'Could not copy. Select the link and copy it.' }))} className="h-full shrink-0 border-l border-ff-line px-2.5 uppercase tracking-[0.08em] text-ff-accent hover:bg-ff-raised">
            Copy
          </button>
        </div>
      )}
      <div className={cx('grid gap-2', phone ? 'grid-cols-2' : canShareFiles ? 'grid-cols-4' : 'grid-cols-3')}>
        <ActionBtn primary onClick={copyImage} disabled={!card}>
          {canCopyImage ? 'Copy image' : 'Save image'}
        </ActionBtn>
        <ActionBtn onClick={download} disabled={!card}>
          Download PNG
        </ActionBtn>
        {canShareFiles && (
          <ActionBtn onClick={shareFile} disabled={!readyFile}>
            {readyFile ? 'Share…' : 'Preparing…'}
          </ActionBtn>
        )}
        {worker ? (
          <ActionBtn onClick={copyLink} disabled={!card || curLink?.state === 'working'}>
            {curLink?.state === 'working' ? 'Making link…' : curLink?.state === 'failed' ? 'Retry link' : 'Copy link'}
          </ActionBtn>
        ) : null}
      </div>
      <p role="status" aria-live="polite" className={cx('mt-2 min-h-[1.2em] font-mono text-[11px] leading-snug', status?.tone === 'bad' ? 'text-ff-neg' : 'text-ff-muted')}>
        {status?.text ?? (worker ? (curLink?.state === 'ready' ? 'The link shows the wide card in a message and opens the trade in the app.' : '') : 'Links are off on this site (no share server), so share the image instead.')}
      </p>
    </div>
  )

  const head = (
    <header className="flex h-14 shrink-0 items-center gap-2.5 border-b border-ff-line pl-4 pr-1.5">
      <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center border border-ff-accent/40 bg-ff-accent/10 text-ff-accent">
        <Glyph d={SHARE} />
      </span>
      <div className="min-w-0 flex-1 leading-tight">
        <h2 id={titleId} className="truncate text-[15px] font-medium text-ff-text">
          Share trade
        </h2>
        <p className="truncate font-mono text-[10.5px] text-ff-muted">{summary}</p>
      </div>
      <button type="button" onClick={onClose} aria-label="Close (Esc)" title="Close (Esc)" className="ff-press flex h-10 w-10 shrink-0 items-center justify-center text-ff-text2 hover:bg-ff-raised hover:text-ff-text">
        <Glyph d={CLOSE} />
      </button>
    </header>
  )

  if (phone)
    return (
      <>
        {head}
        <div className="ff-scroll min-h-0 flex-1 overflow-y-auto">
          {preview}
          <div className="border-t border-ff-line">{controls}</div>
        </div>
        {actions}
      </>
    )
  return (
    <>
      {head}
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-h-0 flex-col border-r border-ff-line bg-ff-bg">{preview}</div>
        <div className="flex min-h-0 flex-col">
          <div className="ff-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain">{controls}</div>
          {actions}
        </div>
      </div>
    </>
  )
}

/** The sheet: a bottom sheet on a phone, a dialog on a wide screen, over everything (the builder included). */
export const TradeShareSheet = ({ deal, onClose }: { deal: Deal; onClose: () => void }) => {
  const phone = usePhone()
  const panel = useRef<HTMLDivElement>(null)
  const swipe = useRef<SwipeSheetHandle>(null)
  const titleId = useId()
  const close = () => (phone && swipe.current ? swipe.current.dismiss() : onClose())
  useModal(panel, close)
  const host = typeof document !== 'undefined' ? (document.querySelector('.ff') ?? document.body) : null
  if (!host) return null
  const body = <SharePanel deal={deal} onClose={close} titleId={titleId} phone={phone} />
  return createPortal(
    phone ? (
      <SwipeSheet
        ref={swipe}
        side="bottom"
        className="z-[60]"
        onDismissed={onClose}
        backdropClassName="bg-black/45"
        panelRef={panel}
        panelProps={{ role: 'dialog', 'aria-modal': true, 'aria-labelledby': titleId, tabIndex: -1 }}
        panelClassName="flex h-[calc(100dvh-28px)] w-full flex-col border-t border-ff-line2 bg-ff-panel pb-[env(safe-area-inset-bottom)] shadow-[0_-8px_40px_rgba(0,0,0,0.35)] outline-none"
      >
        <div className="flex h-3 shrink-0 items-end justify-center" aria-hidden>
          <span className="h-1 w-10 bg-ff-line2" />
        </div>
        {body}
      </SwipeSheet>
    ) : (
      <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 lg:p-6" role="presentation">
        <div className="ff-fade-in absolute inset-0 bg-black/45" onClick={onClose} />
        <div
          ref={panel}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          className="ff-fade-in relative flex h-full max-h-[820px] w-full max-w-[1120px] flex-col border border-ff-line2 bg-ff-panel shadow-[0_24px_80px_-12px_rgba(0,0,0,0.5)] outline-none"
        >
          {body}
        </div>
      </div>
    ),
    host,
  )
}

/**
 * The Share control for a trade. `icon`: a square icon button (a header); `cell`: an icon filling its share of a row of
 * them (a Compare column); `compact`: icon only on a phone, icon and word from md up (a card's footer); `full`: both.
 */
export const ShareTradeButton = ({ deal, variant = 'compact', className, label = 'Share this trade' }: { deal: Deal; variant?: 'icon' | 'compact' | 'full' | 'cell'; className?: string; label?: string }) => {
  const [open, setOpen] = useState(false)
  const ready = dealActive(deal) && deal.teams.length > 1
  const icon = variant === 'icon'
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={!ready}
        aria-haspopup="dialog"
        aria-label={variant === 'full' ? undefined : label}
        title={ready ? label : 'Add players to share the trade'}
        className={cx(
          'ff-press inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap text-ff-text2 hover:bg-ff-raised hover:text-ff-text disabled:pointer-events-none disabled:opacity-40',
          icon ? 'h-10 w-10' : variant === 'cell' ? 'h-10 min-w-0 flex-1 border border-ff-line text-[13px] md:h-8' : variant === 'compact' ? 'h-10 w-10 border border-ff-line md:h-7 md:w-auto md:px-2 md:text-[11.5px]' : 'h-10 border border-ff-line px-3 text-[12.5px] md:h-8',
          open && 'bg-ff-raised text-ff-text',
          className,
        )}
      >
        <Glyph d={SHARE} size={13} />
        {variant === 'compact' && <span className="max-md:hidden">Share</span>}
        {variant === 'full' && 'Share'}
      </button>
      {open && <TradeShareSheet deal={deal} onClose={() => setOpen(false)} />}
    </>
  )
}

/**
 * A shared trade link, once its league is on screen (useDeepLink): the deal goes into the builder, at its review, for
 * whoever opened it. Players who have moved since are left out, with a note; a visitor with no team here, or a link
 * that is not a deal, gets a plain note instead.
 */
export const SharedTradeOpener = ({ trade, finish }: { trade: string | null; finish: (note?: string) => void }) => {
  const { analysis } = useFantasy()
  const dock = useTradeDock()
  useEffect(() => {
    if (!trade) return
    const deal = decodeDeal(trade)
    if (!deal) return finish('That trade link is not one this app can read.')
    if (!dock) return finish('Shared trades open in the builder for a team in the league, and this account has none here.')
    if (deal.teams.some((t) => !analysis.teamById[t])) return finish('A team in that trade is no longer in the league.')
    const moved = deal.moves.filter((m) => !analysis.teamById[m.from]?.players.includes(m.player))
    const live: Deal = { ...deal, moves: deal.moves.filter((m) => !moved.includes(m)) }
    if (!dealActive(live)) return finish('Everyone in that trade has moved since it was shared, so there is nothing left to open.')
    dock.open(live, 'review')
    finish(moved.length ? `${moved.length === 1 ? 'One player' : `${moved.length} players`} in that trade moved since it was shared, so ${moved.length === 1 ? 'he is' : 'they are'} left out.` : undefined)
  }, [trade]) // eslint-disable-line react-hooks/exhaustive-deps
  return null
}
