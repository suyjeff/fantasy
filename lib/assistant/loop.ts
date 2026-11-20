// One question, end to end: read it, pre-run the obvious tools, make the fewest model calls, run whatever tools the
// model still asks for (at most ASGM_MAX_STEPS model round trips, the last one without tools), and stream the answer. Every step the user sees is a
// real unit of work; every card comes from a tool.
import { ASGM_LIMITS, ASGM_MAX_STEPS, ASGM_SYSTEM } from '../../workers/grades/src/asgmShared'
import { keys } from './keys'
import type { AsgmLeague } from './league'
import { leagueBrief, packText, planPreRuns, preLabel, readQuestion, runPre, type Reading } from './pack'
import { quickAnswer } from './quick'
import { AsgmError, complete, newId, toOpenAiMessages, type Msg, type ToolCall, type ToolSpec } from './providers'
import { runTool, toolLabel, TOOL_BY_NAME, TOOLS } from './tools'
import type { AsgmAction, AsgmCard, AsgmContext, AsgmEvent, AsgmMessage, AsgmProvider, StoredKey } from './types'

export type TurnInput = { history: AsgmMessage[]; text: string; context?: AsgmContext; league: AsgmLeague; provider: AsgmProvider; key?: StoredKey | null }

/** Conversation so far, trimmed: the last few exchanges, long answers cut, no old contexts or tool output. */
export const trimHistory = (history: AsgmMessage[], max = 6): Msg[] => {
  const kept = history.filter((m) => (m.role === 'user' ? !!m.text.trim() : !!m.text.trim() && !m.error)).slice(-max)
  // A conversation starts with the manager.
  while (kept.length && kept[0].role !== 'user') kept.shift()
  return kept.map((m) => (m.role === 'user' ? { role: 'user' as const, content: m.text.slice(0, 600) } : { role: 'assistant' as const, content: m.text.length > 900 ? `${m.text.slice(0, 900)}…` : m.text }))
}

/** Tools every question is offered: the lookups any follow-up might need. */
const CORE = ['player', 'team', 'lineup', 'matchup', 'standings', 'rankings', 'start_sit', 'playoff_odds']
/** The rest, by what the question is about. */
const BY_INTENT: Partial<Record<Reading['intents'][number], string[]>> = {
  trade: ['evaluate_trade', 'find_trades', 'trade_values'],
  values: ['trade_values', 'find_trades', 'evaluate_trade'],
  waivers: ['waivers', 'faab_bid'],
  faab: ['faab_bid', 'waivers'],
  compare: ['compare_players'],
  news: ['news'],
  needs: ['league_needs', 'find_trades', 'waivers'],
  moves: ['transactions'],
  schedule: ['schedule', 'compare_players'],
  opponent: ['schedule'],
  owner: ['transactions'],
  leaders: [],
  lineup: ['waivers'],
  matchup: ['schedule'],
  standings: ['schedule'],
  rankings: ['waivers'],
  playoffs: ['schedule'],
  roster: ['league_needs'],
  team: ['league_needs', 'schedule', 'find_trades', 'waivers'],
}

/**
 * The tools offered for a question: all of them when it is open-ended, else the core lookups plus the ones its intent
 * needs. Every tool definition is prompt on every round trip, so fewer is faster and cheaper.
 */
export const toolSpecs = (reading?: Reading): ToolSpec[] => {
  const all = TOOLS.map((t) => ({ name: t.name, description: t.description, params: t.params }))
  if (!reading || reading.intents.some((i) => !(i in BY_INTENT))) return all
  const want = new Set([...CORE, ...reading.intents.flatMap((i) => BY_INTENT[i] ?? [])])
  return all.filter((t) => want.has(t.name))
}

/** Output tokens a round trip may use (reasoning models count their thinking here too). The house worker clamps its own. */
const OUT_TOKENS: Partial<Record<AsgmProvider, number>> = { house: 900 }
const RESULT_LIMIT = 4_500
/** Characters of a step's text held back before streaming: longer than any preamble, short enough not to be felt. */
const HOLD_CHARS = 160

/** Everything the first model call is sent, without calling it: for the eval script and the payload dump. */
export const firstPayload = async (args: TurnInput, signal: AbortSignal = new AbortController().signal) => {
  const { league: lg, text } = args
  const reading = readQuestion(lg, text, args.context)
  const plan = planPreRuns(lg, text, args.context, reading)
  const pre: { label: string; tool: string; text: string; ok: boolean }[] = []
  for (const p of plan) {
    const out = await runPre(lg, p, signal)
    pre.push({ label: preLabel(lg, p), tool: p.tool, text: out.text, ok: out.ok })
  }
  const pack = packText(leagueBrief(lg, args.context), pre)
  const messages: Msg[] = [...trimHistory(args.history), { role: 'user', content: `${pack}\n\nQUESTION: ${text.trim().slice(0, 1200)}` }]
  return { reading, plan, pre, system: ASGM_SYSTEM, messages, tools: toolSpecs(reading), quick: quickAnswer(lg, text, args.context) }
}

/** The model's tool calls that can be run and relayed: known tools, arguments within the relay's limit, the first few. */
export const usableCalls = (calls: ToolCall[]) =>
  calls.filter((c) => TOOL_BY_NAME[c.name] && JSON.stringify(c.args ?? {}).length <= ASGM_LIMITS.toolArgChars).slice(0, ASGM_LIMITS.toolCalls)

const clipText = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}\n[…trimmed]` : s)

/**
 * The messages to send, inside the relay's limits (they hold for every provider): at most ASGM_LIMITS.messages, each
 * under its character cap, and the whole request under the body cap with the tool definitions counted. Old history
 * goes first, then the oldest tool results are cut down; this question's own messages are never dropped.
 */
export const fitMessages = (history: Msg[], turn: Msg[], tools: ToolSpec[]): Msg[] => {
  const room = ASGM_LIMITS.body - JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, parameters: t.params }))).length - 1_500
  let h = history.map((m) => ({ ...m, content: clipText(m.content, ASGM_LIMITS.messageChars - 20) }) as Msg)
  const t = turn.map((m) => ({ ...m, content: clipText(m.content, ASGM_LIMITS.messageChars - 20) }) as Msg)
  const size = () => JSON.stringify(toOpenAiMessages(null, [...h, ...t])).length + 200
  const over = () => h.length + t.length > ASGM_LIMITS.messages || size() > room
  while (h.length && over()) {
    h = h.slice(1)
    // History starts with the manager.
    while (h.length && h[0].role !== 'user') h = h.slice(1)
  }
  for (const cap of [1_500, 600, 200]) {
    for (const m of t) {
      if (!over()) break
      if (m.role === 'tool' && m.content.length > cap) m.content = clipText(m.content, cap)
    }
  }
  return [...h, ...t]
}

export const runModelTurn = async (args: TurnInput, onEvent: (e: AsgmEvent) => void, signal: AbortSignal) => {
  const { league: lg, provider, text } = args
  const key = provider === 'house' ? null : (args.key ?? keys.load())
  const turn = newId('t')
  const seenCards = new Set<string>()
  const seenActions = new Set<string>()
  const emit = (out: { cards?: AsgmCard[]; actions?: AsgmAction[] }) => {
    for (const card of out.cards ?? []) {
      const k = JSON.stringify(card)
      if (seenCards.has(k)) continue
      seenCards.add(k)
      onEvent({ type: 'card', id: newId('c'), card })
    }
    for (const action of out.actions ?? []) {
      const k = JSON.stringify(action)
      if (seenActions.has(k)) continue
      seenActions.add(k)
      onEvent({ type: 'action', id: newId('a'), action })
    }
  }
  const abortErr = () => onEvent({ type: 'error', code: 'aborted', message: 'Stopped.' })

  // ---- A plain lookup ("who has Puka", "Fourth & Long's record"): answered from the app's data, no model ----
  const quick = quickAnswer(lg, text, args.context)
  if (quick) {
    const id = newId('s')
    onEvent({ type: 'step', id, tool: 'lookup', label: quick.label, status: 'running' })
    onEvent({ type: 'step', id, tool: 'lookup', label: quick.label, status: 'done', detail: 'no model needed' })
    emit(quick)
    onEvent({ type: 'text', delta: quick.text })
    onEvent({ type: 'done', provider: 'app', model: 'instant lookup' })
    return
  }

  // ---- The pack: the league, the roster, and the tools this question plainly needs ----
  const reading = readQuestion(lg, text, args.context)
  const plan = planPreRuns(lg, text, args.context, reading)
  const pre: { label: string; tool: string; text: string }[] = []
  // Calls that already succeeded this turn, and where their result is, so a repeat is pointed at it. Failed calls are
  // not kept: the model may retry them.
  const ran = new Map<string, string>()
  for (const p of plan) {
    const id = newId('s')
    const label = preLabel(lg, p)
    onEvent({ type: 'step', id, tool: p.tool, label, status: 'running' })
    const out = await runPre(lg, p, signal)
    if (signal.aborted) return abortErr()
    onEvent({ type: 'step', id, tool: p.tool, label, status: out.ok ? 'done' : 'error', detail: out.ok ? out.detail : out.text.replace(/^Error:\s*/, '').slice(0, 140) })
    if (out.ok) emit(out)
    pre.push({ label, tool: p.tool, text: out.text })
    if (!p.deal && out.ok) ran.set(`${p.tool}:${JSON.stringify(p.args)}`, `the [${p.tool}] result in CONTEXT above`)
  }
  const pack = packText(leagueBrief(lg, args.context), pre)
  const history = trimHistory(args.history)
  const turnMsgs: Msg[] = [{ role: 'user', content: `${pack}\n\nQUESTION: ${text.trim().slice(0, 1200)}` }]
  const tools = toolSpecs(reading)

  let answer = ''
  /** The free relay failed on a step that offered tools: the next step answers from what is here, with none. */
  let forced = false
  let model = ''
  let served: string = provider
  let remaining: number | undefined
  for (let step = 0; step < ASGM_MAX_STEPS; step++) {
    const last = step === ASGM_MAX_STEPS - 1 || forced
    if (forced) turnMsgs.push({ role: 'user', content: 'No more tools for this question. Answer now from CONTEXT and any tool results above, and say plainly what the app could not tell you.' })
    else if (last) turnMsgs.push({ role: 'user', content: 'That is the whole tool budget for this question. Answer now from what you have, and say plainly what the app could not tell you.' })
    const messages = fitMessages(history, turnMsgs, last ? [] : tools)
    // Only a step that answers is the answer: one that goes on to call tools may open with a line of preamble. So the
    // start of each step's text is held back until there is enough of it to be an answer, and if the step then calls
    // tools after all, whatever did stream is taken back with a reset.
    let stepText = ''
    let held = ''
    let live = false
    let res
    try {
      res = await complete(provider, key, {
        system: ASGM_SYSTEM,
        messages,
        tools: last ? [] : tools,
        maxTokens: OUT_TOKENS[provider] ?? 1500,
        signal,
        turn,
        step,
        onText: (d) => {
          stepText += d
          if (live) return onEvent({ type: 'text', delta: d })
          held += d
          if (held.length >= HOLD_CHARS) {
            live = true
            onEvent({ type: 'text', delta: held })
          }
        },
      })
    } catch (e) {
      if (signal.aborted) return abortErr()
      // The free relay's model can fail on a step that offers tools (a reply it could not read). Once per question,
      // answer from the context instead of failing: the pack usually holds what is needed.
      if (provider === 'house' && !last && !forced && e instanceof AsgmError && e.code === 'provider') {
        if (live) onEvent({ type: 'text', delta: '', reset: true })
        forced = true
        continue
      }
      const err = e instanceof AsgmError ? e : new AsgmError('provider', `The model call failed: ${(e as Error)?.message ?? e}. Try again.`)
      onEvent({ type: 'error', code: err.code, message: err.message })
      return
    }
    model = res.model || model
    served = res.provider || served
    if (res.remaining != null) remaining = res.remaining
    if (!res.toolCalls.length || last) {
      answer = stepText || res.text
      if (!live && answer) onEvent({ type: 'text', delta: answer })
      break
    }
    // The model wants more: its text this step was preamble, not the answer.
    if (live) onEvent({ type: 'text', delta: '', reset: true })
    // Only calls the relay and the tools can take: known tools, arguments of a sane size, a few at a time. The rest are
    // dropped from the message altogether, so no call goes unanswered and no provider refuses the next request.
    const calls = usableCalls(res.toolCalls)
    if (!calls.length) {
      turnMsgs.push({ role: 'assistant', content: res.text || '(asked for tools that do not exist)' })
      turnMsgs.push({ role: 'user', content: `Those tool calls were not valid. Use only these tools: ${TOOLS.map((t) => t.name).join(', ')}, at most ${ASGM_LIMITS.toolCalls} at once, or answer now.` })
      continue
    }
    turnMsgs.push({ role: 'assistant', content: res.text, toolCalls: calls })
    for (const c of calls) {
      const id = newId('s')
      const label = toolLabel(c.name, c.args, lg)
      const k = `${c.name}:${JSON.stringify(c.args)}`
      onEvent({ type: 'step', id, tool: c.name, label, status: 'running' })
      const where = ran.get(k)
      const out = where ? { ok: true, text: `Same call as before: its result is ${where}; nothing has changed since.` } : await runTool(c.name, c.args, lg, signal)
      if (out.ok && !where) ran.set(k, `the earlier ${c.name} tool result in this conversation`)
      if (signal.aborted) return abortErr()
      const o = out as { ok: boolean; text: string; detail?: string; cards?: AsgmCard[]; actions?: AsgmAction[] }
      onEvent({ type: 'step', id, tool: c.name, label, status: o.ok ? 'done' : 'error', detail: o.ok ? o.detail : o.text.replace(/^Error:\s*/, '').slice(0, 140) })
      if (o.ok) emit(o)
      turnMsgs.push({ role: 'tool', toolCallId: c.id, name: c.name, content: o.text.length > RESULT_LIMIT ? `${o.text.slice(0, RESULT_LIMIT)}\n[…trimmed]` : o.text })
    }
  }
  if (!answer.trim()) {
    onEvent({ type: 'error', code: 'provider', message: 'The model returned an empty answer. Ask again, or try another model.' })
    return
  }
  onEvent({ type: 'done', provider: served, model, ...(remaining != null ? { remaining } : {}) })
}
