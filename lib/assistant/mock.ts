// The 'mock' provider: realistic, timed events built from the loaded league, with no model and no network. It is
// what the UI is built and screenshot-tested against (`?asgm=mock`). Every id it names is a real one from the league.
//
// A question that starts with "!quota", "!budget", "!rate", "!offline", "!provider", "!key" or "!aborted" ends in that error
// instead, so every error state can be drawn.
import type { Deal } from '../deal'
import { nameOf, teamName, type AsgmLeague } from './league'
import type { AsgmCard, AsgmErrorCode, AsgmEvent } from './types'

const ERRORS: Record<AsgmErrorCode, string> = {
  quota: "That's today's free questions for this browser. They reset at midnight UTC, or add your own key in settings to keep going.",
  budget: 'The free model is out of budget for today across all users. It resets at midnight UTC; add your own key in settings to keep going now.',
  rate: 'Too many questions in a minute. Wait a moment and try again.',
  offline: "Can't reach the free model. Check your connection and try again.",
  provider: 'The model provider returned an error. Try again in a minute, or switch providers in settings.',
  key: 'Your key was rejected by the provider. Check it in settings.',
  aborted: 'Stopped.',
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'))
    const t = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(new DOMException('Aborted', 'AbortError'))
      },
      { once: true },
    )
  })

const r1 = (x: number) => Math.round(x * 10) / 10

/** Who the mock talks about: the asking team's best starters and bench, a partner, the best free agents. */
export const mockCast = (lg: AsgmLeague) => {
  const { data, analysis } = lg
  const myId = lg.myRosterId ?? analysis.teams[0]?.rosterId ?? 1
  const mine = analysis.teamById[myId]?.players ?? []
  const perWeek = analysis.horizon.perActive ?? {}
  const pts = (id: string) => data.projections?.[id] ?? perWeek[id] ?? analysis.market[id] ?? 0
  const sorted = [...mine].filter((id) => data.players[id]).sort((a, b) => pts(b) - pts(a))
  const starters = new Set((analysis.needs[myId]?.slots ?? []).map((s) => s.starter).filter((x): x is string => !!x))
  const bench = sorted.filter((id) => !starters.has(id))
  const start = sorted.filter((id) => starters.has(id))
  const partner = analysis.teams.find((t) => t.rosterId !== myId)?.rosterId ?? myId
  const theirs = [...(analysis.teamById[partner]?.players ?? [])].filter((id) => data.players[id]).sort((a, b) => (analysis.tradeMarket[b] ?? 0) - (analysis.tradeMarket[a] ?? 0))
  const free = Object.keys(analysis.market)
    .filter((id) => analysis.rosteredBy[id] == null && data.players[id] && ['RB', 'WR', 'TE', 'QB'].includes(data.players[id].pos))
    .sort((a, b) => (analysis.market[b] ?? 0) - (analysis.market[a] ?? 0))
  return { myId, partner, start: start.length ? start : sorted, bench: bench.length ? bench : sorted.slice(-3), theirs, free, pts }
}

export const runMock = async (lg: AsgmLeague, text: string, onEvent: (e: AsgmEvent) => void, signal: AbortSignal) => {
  const forced = /^!(quota|budget|rate|offline|provider|key|aborted)\b/i.exec(text.trim())
  let n = 0
  const id = () => `m${++n}`
  const step = async (tool: string, label: string, ms: number, detail?: string) => {
    const sid = id()
    onEvent({ type: 'step', id: sid, tool, label, status: 'running' })
    await sleep(ms, signal)
    onEvent({ type: 'step', id: sid, tool, label, status: 'done', detail })
  }
  const card = (c: AsgmCard) => onEvent({ type: 'card', id: id(), card: c })
  try {
    const { data, analysis, models } = lg
    const c = mockCast(lg)
    const week = data.projectionWeek ?? data.futureWeeks[0] ?? data.state.week
    if (forced) {
      await step('get_context', 'Reading your league', 250)
      const code = forced[1].toLowerCase() as AsgmErrorCode
      onEvent({ type: 'error', code, message: ERRORS[code] })
      return
    }

    await step('get_context', `Reading ${teamName(lg, c.myId)}'s roster`, 300, `${analysis.teamById[c.myId]?.players.length ?? 0} players`)

    // Lineup: the best bench player in for the weakest starter.
    const out = c.start[c.start.length - 1]
    const inn = c.bench[0]
    await step('optimize_lineup', `Optimizing week ${week} lineup`, 450, '1 change')
    const before = r1(c.start.reduce((s, p) => s + c.pts(p), 0))
    const gain = r1(Math.max(0.4, c.pts(inn) - c.pts(out)))
    if (out && inn) {
      card({
        kind: 'lineup',
        title: `Week ${week} lineup`,
        rosterId: c.myId,
        week,
        changes: [{ out, in: inn, slot: data.players[inn]?.pos === data.players[out]?.pos ? data.players[out]?.pos ?? 'FLEX' : 'FLEX', gain }],
        total: { before, after: r1(before + gain) },
      })
    }

    // Players and a head-to-head.
    await step('player_outlook', 'Reading projections, ranges and matchups', 400)
    const close = [c.start[c.start.length - 2], out, inn].filter((x): x is string => !!x)
    card({
      kind: 'players',
      title: 'Close calls',
      rows: close.map((p, i) => ({ id: p, value: `${r1(c.pts(p))} proj`, note: i === close.length - 1 ? 'Softer matchup, healthy' : i === 0 ? 'Safe floor' : 'Questionable, tough defense', tone: i === close.length - 1 ? 'good' : i === 0 ? 'neutral' : 'bad' })),
    })
    if (out && inn) card({ kind: 'compare', title: `${nameOf(lg, inn)} vs ${nameOf(lg, out)}`, ids: [inn, out] })

    // A trade with the first other team.
    const give = c.bench.slice(0, 2).filter(Boolean)
    const get = c.theirs.slice(2, 3)
    if (give.length && get.length && c.partner !== c.myId) {
      await step('evaluate_trade', `Pricing a deal with ${teamName(lg, c.partner)}`, 500, '64% accept')
      const deal: Deal = {
        teams: [c.myId, c.partner],
        moves: [...give.map((p) => ({ player: p, from: c.myId, to: c.partner })), ...get.map((p) => ({ player: p, from: c.partner, to: c.myId }))],
        faab: [],
      }
      card({ kind: 'trade', title: 'Trade to send', deal, verdict: 'Fair, and it fills your flex. About 64% they take it.' })
      onEvent({ type: 'action', id: id(), action: { kind: 'openTrade', deal, label: 'Open in trade builder' } })
    }

    // Playoff odds, before and after.
    await step('playoff_odds', 'Running 2,000 playoff sims', 650)
    const sim = models.forecast?.sim
    const rows = analysis.teams.slice(0, 4).map((t) => {
      const p = sim?.[t.rosterId]?.playoffs ?? 0.5
      return t.rosterId === c.myId ? { label: t.name, before: p, after: Math.min(1, p + 0.04) } : { label: t.name, after: p }
    })
    card({ kind: 'odds', title: 'Playoff odds', rows })

    // Waivers.
    await step('waiver_targets', 'Scanning the wire', 350, `${Math.min(3, c.free.length)} targets`)
    if (c.free.length) {
      const budget = models.faab ? models.faab.remaining[c.myId] ?? 0 : null
      card({
        kind: 'waivers',
        title: 'Waiver plan',
        rows: c.free.slice(0, 3).map((p, i) => ({ add: p, drop: c.bench[c.bench.length - 1 - i], bid: budget != null ? Math.max(1, Math.round(budget * (0.18 - i * 0.05))) : undefined, note: i === 0 ? 'Starts for you this week' : 'Bench stash' })),
      })
    }

    if (inn) onEvent({ type: 'action', id: id(), action: { kind: 'openPlayer', id: inn, label: `Open ${nameOf(lg, inn)}` } })
    if (c.partner !== c.myId) onEvent({ type: 'action', id: id(), action: { kind: 'openTeam', rosterId: c.partner, label: `Open ${teamName(lg, c.partner)}` } })
    onEvent({ type: 'action', id: id(), action: { kind: 'goto', view: 'waivers', label: 'Go to waivers' } })

    // The answer, streamed a few words at a time.
    const lines = [
      out && inn ? `Start ${nameOf(lg, inn)}. Bench ${nameOf(lg, out)}.` : 'Your lineup is already set.',
      out && inn ? `- ${nameOf(lg, inn)} projects ${r1(c.pts(inn))} to ${r1(c.pts(out))}, a ${gain}-point edge this week.` : '',
      `- ${nameOf(lg, c.start[0] ?? '')} stays locked in; nothing on your bench touches him.`,
      c.free[0] ? `- ${nameOf(lg, c.free[0])} is the best add on the wire if you need a body.` : '',
      'Risk: this is the mock assistant, so the numbers are illustrative.',
    ].filter(Boolean)
    const words = lines.join('\n').split(/(?<=\s)/)
    for (let i = 0; i < words.length; i += 3) {
      onEvent({ type: 'text', delta: words.slice(i, i + 3).join('') })
      await sleep(35, signal)
    }
    onEvent({ type: 'done', provider: 'mock', model: 'mock-gm', remaining: 19 })
  } catch (e) {
    if (signal.aborted || (e as Error)?.name === 'AbortError') onEvent({ type: 'error', code: 'aborted', message: ERRORS.aborted })
    else onEvent({ type: 'error', code: 'provider', message: `Mock failed: ${(e as Error)?.message ?? e}` })
  }
}

export const MOCK_ERRORS = ERRORS
