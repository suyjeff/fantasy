// Assistant GM relay: POST /assistant/chat and GET /assistant/status.
//
// The app runs every tool in the browser on the league it already has; this only relays one model round trip at a
// time. Groq first (when the GROQ_API_KEY secret is set: free tier, never bills without a card), then Cloudflare
// Workers AI through the AI binding, which would bill past its free 10,000 neurons a day on a paid plan, so it is
// metered and hard-stopped well below that. The system prompt is ours (asgmShared.ts), not the caller's, and only the
// app's own tools may be offered, so the relay is no use as a general-purpose model.
//
// Every allowance lives in one Durable Object (meter.ts), which serialises requests: a round trip is reserved there
// before any model is called, and each Workers AI call reserves its worst case before it is sent, so concurrent
// requests cannot overrun a cap.

import { ASGM_LIMITS, ASGM_MAX_STEPS, ASGM_SYSTEM, ASGM_TOOL_NAMES } from './asgmShared'
import { limited, send } from './common'
import { ASGM, meterOf, netKey, resetsAt, type Meter, type MeterNamespace } from './meter'

export { ASGM, AsgmMeter, dayOf, resetsAt } from './meter'

export type AiBinding = { run: (model: string, input: Record<string, unknown>) => Promise<unknown> }
export type AsgmEnv = { ASGM_METER?: MeterNamespace; AI?: AiBinding; GROQ_API_KEY?: string }

const CLIENT = /^[A-Za-z0-9_-]{8,64}$/
const TURN = /^[A-Za-z0-9_-]{4,64}$/
const TOOLS = new Set<string>(ASGM_TOOL_NAMES)

/** Neurons for a Workers AI call, from its tokens. */
export const neuronsFor = (input: number, output: number) => (input * ASGM.wai.inPerM + output * ASGM.wai.outPerM) / 1e6

// ---------------------------------------------------------------------------------------------------------------
// Validation

type InMsg = { role: 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: { id: string; type?: string; function: { name: string; arguments: string } }[]; tool_call_id?: string; name?: string }
type InTool = { name: string; description: string; parameters: unknown }
export type ChatBody = { client: string; turn: string; step: number; messages: InMsg[]; tools: InTool[] }

/** The request, checked, or the reason it is refused. */
export const checkBody = (raw: unknown): { ok: true; body: ChatBody } | { ok: false; error: string } => {
  const b = raw as Partial<ChatBody> | null
  if (!b || typeof b !== 'object') return { ok: false, error: 'bad body' }
  if (typeof b.client !== 'string' || !CLIENT.test(b.client)) return { ok: false, error: 'bad client' }
  if (typeof b.turn !== 'string' || !TURN.test(b.turn)) return { ok: false, error: 'bad turn' }
  if (!Number.isInteger(b.step) || (b.step as number) < 0 || (b.step as number) >= ASGM_MAX_STEPS) return { ok: false, error: 'bad step' }
  if (!Array.isArray(b.messages) || !b.messages.length || b.messages.length > ASGM_LIMITS.messages) return { ok: false, error: 'bad messages' }
  for (const m of b.messages) {
    if (!m || !['user', 'assistant', 'tool'].includes(m.role)) return { ok: false, error: 'bad message role' }
    if (m.content != null && typeof m.content !== 'string') return { ok: false, error: 'bad message content' }
    if ((m.content ?? '').length > ASGM_LIMITS.messageChars) return { ok: false, error: 'message too long' }
    if (m.role === 'tool' && (typeof m.tool_call_id !== 'string' || !TOOLS.has(String(m.name)))) return { ok: false, error: 'bad tool result' }
    if (m.tool_calls != null) {
      if (m.role !== 'assistant' || !Array.isArray(m.tool_calls) || m.tool_calls.length > ASGM_LIMITS.toolCalls) return { ok: false, error: 'bad tool calls' }
      for (const c of m.tool_calls) if (!c || typeof c.id !== 'string' || !TOOLS.has(c.function?.name) || typeof c.function?.arguments !== 'string' || c.function.arguments.length > ASGM_LIMITS.toolArgChars) return { ok: false, error: 'bad tool call' }
    }
  }
  const last = b.messages[b.messages.length - 1]
  if (last.role === 'assistant') return { ok: false, error: 'last message must be the user or a tool result' }
  const tools = Array.isArray(b.tools) ? b.tools : []
  if (tools.length > ASGM_LIMITS.tools) return { ok: false, error: 'too many tools' }
  for (const t of tools) {
    if (!t || !TOOLS.has(t.name) || typeof t.description !== 'string') return { ok: false, error: `tool not allowed: ${String(t?.name).slice(0, 40)}` }
    if (JSON.stringify(t).length > ASGM_LIMITS.toolChars) return { ok: false, error: 'tool too large' }
  }
  return { ok: true, body: { client: b.client, turn: b.turn, step: b.step as number, messages: b.messages as InMsg[], tools } }
}

// ---------------------------------------------------------------------------------------------------------------
// Models

export type Reply = { content: string; tool_calls: { id: string; name: string; arguments: string }[] }

/** Groq, OpenAI-compatible, native tool calls. Null on any failure: the caller falls back. */
export const callGroq = async (env: AsgmEnv, body: ChatBody, fetcher: typeof fetch = fetch): Promise<Reply | null> => {
  if (!env.GROQ_API_KEY) return null
  const payload: Record<string, unknown> = {
    model: ASGM.groq.model,
    messages: [{ role: 'system', content: ASGM_SYSTEM }, ...body.messages],
    max_completion_tokens: ASGM.groq.maxOut,
    reasoning_effort: 'low',
    temperature: 0.3,
  }
  if (body.tools.length) {
    payload.tools = body.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
    payload.tool_choice = 'auto'
  }
  try {
    const res = await fetcher(ASGM.groq.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.GROQ_API_KEY}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(ASGM.groq.timeoutMs),
    })
    if (!res.ok) return null
    const j = (await res.json()) as { choices?: { message?: { content?: string | null; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] } }[] }
    const m = j.choices?.[0]?.message
    if (!m) return null
    const calls = (m.tool_calls ?? [])
      .filter((c) => c.function?.name && TOOLS.has(c.function.name))
      .map((c, i) => ({ id: c.id ?? `groq_${i}`, name: c.function!.name!, arguments: c.function!.arguments ?? '{}' }))
    if (!m.content && !calls.length) return null
    return { content: m.content ?? '', tool_calls: calls }
  } catch {
    return null
  }
}

/** Tools described in words for a model called without native tool calling. */
export const toolProtocol = (tools: InTool[]) => {
  if (!tools.length) return ''
  const lines = tools.map((t) => {
    const props = ((t.parameters as { properties?: Record<string, { type?: string; description?: string }>; required?: string[] }) ?? {}).properties ?? {}
    const req = new Set(((t.parameters as { required?: string[] }) ?? {}).required ?? [])
    const args = Object.entries(props)
      .map(([k, v]) => `${k}${req.has(k) ? '' : '?'}: ${v.type ?? 'string'}`)
      .join(', ')
    return `- ${t.name}(${args}): ${t.description}`
  })
  return `\n\nTOOLS. To call one, reply with only this line and nothing else:\nTOOL_CALL {"name": "<tool>", "arguments": {<arguments as JSON>}}\nThe result comes back as a TOOL_RESULT message. Available tools:\n${lines.join('\n')}`
}

/** The conversation as plain chat turns, tool calls and results written out, consecutive turns of one role merged. */
export const plainMessages = (messages: InMsg[]) => {
  const out: { role: 'user' | 'assistant'; content: string }[] = []
  for (const m of messages) {
    const role = m.role === 'assistant' ? 'assistant' : 'user'
    let text = m.content ?? ''
    if (m.role === 'assistant' && m.tool_calls?.length) text = [text, ...m.tool_calls.map((c) => `TOOL_CALL {"name": "${c.function.name}", "arguments": ${c.function.arguments || '{}'}}`)].filter(Boolean).join('\n')
    if (m.role === 'tool') text = `TOOL_RESULT ${m.name}:\n${text}`
    const last = out[out.length - 1]
    if (last && last.role === role) last.content += `\n\n${text}`
    else out.push({ role, content: text })
  }
  return out
}

/** A TOOL_CALL line in a reply, if there is one. */
export const parseToolCall = (text: string): { name: string; arguments: string } | null => {
  const at = text.indexOf('TOOL_CALL')
  if (at < 0) return null
  const start = text.indexOf('{', at)
  if (start < 0) return null
  let depth = 0
  let inStr = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (ch === '\\') i++
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) {
      try {
        const j = JSON.parse(text.slice(start, i + 1)) as { name?: string; arguments?: unknown }
        if (!j.name || !TOOLS.has(j.name)) return null
        return { name: j.name, arguments: JSON.stringify(j.arguments ?? {}) }
      } catch {
        return null
      }
    }
  }
  return null
}

/** Text out of whichever shape the model answered in (Responses API, chat, or the older text-generation one). */
export const replyText = (r: unknown): string => {
  if (typeof r === 'string') return r
  const o = r as Record<string, any> | null
  if (!o) return ''
  if (typeof o.output_text === 'string') return o.output_text
  if (Array.isArray(o.output)) {
    const parts = o.output
      .filter((x: any) => x?.type === 'message')
      .flatMap((x: any) => (Array.isArray(x.content) ? x.content : []))
      .map((c: any) => (typeof c?.text === 'string' ? c.text : ''))
    if (parts.join('')) return parts.join('')
  }
  if (typeof o.response === 'string') return o.response
  if (typeof o.choices?.[0]?.message?.content === 'string') return o.choices[0].message.content
  if (typeof o.result?.response === 'string') return o.result.response
  return ''
}

const usageOf = (r: unknown): { input: number; output: number } | null => {
  const u = (r as { usage?: Record<string, number> } | null)?.usage
  if (!u) return null
  const input = Number(u.input_tokens ?? u.prompt_tokens)
  const output = Number(u.output_tokens ?? u.completion_tokens)
  return Number.isFinite(input) && Number.isFinite(output) ? { input, output } : null
}

/** What a Workers AI prompt for this request comes to, in characters, as it is actually sent. */
const waiPrompt = (body: ChatBody) => {
  const instructions = ASGM_SYSTEM + toolProtocol(body.tools)
  const input = plainMessages(body.messages)
  return { instructions, input, chars: instructions.length + input.reduce((a, m) => a + m.content.length, 0) }
}

/** The worst a Workers AI call for this request could cost: its prompt at three characters a token, the whole output allowance. */
export const worstNeurons = (body: ChatBody) => neuronsFor(Math.ceil(waiPrompt(body).chars / 3), ASGM.wai.maxOut)

export type WaiResult = { reply: Reply | null; neurons: number; calls: number; denied: boolean }

type Shape = 'responses' | 'chat'
/**
 * The request shape Workers AI last took, remembered in this isolate, so a model that wants the other shape is not
 * sent (and charged for) a doomed first request every time.
 */
let waiShape: Shape = 'responses'
export const resetWaiShape = () => {
  waiShape = 'responses'
}

/**
 * Workers AI, with the tools written into the prompt (the JSON protocol above), which works whether or not the model
 * takes native tool calls. Before each call is sent its worst case is reserved on the meter (refused: `denied`);
 * afterwards the reservation becomes the usage it reports, or stays the worst case when it reports none, comes back
 * empty, or throws (it may have run). The other request shape is tried after a failure only if the meter takes a
 * second reservation. `reply` is null when nothing usable came back.
 */
export const callWorkersAi = async (env: AsgmEnv, body: ChatBody, meter: Meter, now = Date.now()): Promise<WaiResult> => {
  const out: WaiResult = { reply: null, neurons: 0, calls: 0, denied: false }
  if (!env.AI) return out
  const ai = env.AI
  const { instructions, input } = waiPrompt(body)
  const worst = worstNeurons(body)
  const payload: Record<Shape, Record<string, unknown>> = {
    // gpt-oss on Workers AI takes the Responses API shape; the chat shape is the older one.
    responses: { instructions, input, max_output_tokens: ASGM.wai.maxOut, reasoning: { effort: 'low' } },
    chat: { messages: [{ role: 'system', content: instructions }, ...input], max_tokens: ASGM.wai.maxOut },
  }
  const order: Shape[] = waiShape === 'chat' ? ['chat', 'responses'] : ['responses', 'chat']
  for (const shape of order) {
    if (!(await meter.reserveWai({ worst, now })).ok) {
      out.denied = true
      return out
    }
    out.calls++
    let r: unknown
    try {
      r = await ai.run(ASGM.wai.model, payload[shape])
    } catch {
      // It may have run before failing: the worst case stays charged.
      out.neurons += worst
      continue
    }
    waiShape = shape
    const u = usageOf(r)
    const actual = u ? neuronsFor(u.input, u.output) : worst
    out.neurons += actual
    if (actual !== worst) await meter.settleWai({ worst, actual, now })
    const text = replyText(r).trim()
    const call = parseToolCall(text)
    if (call && body.tools.length) out.reply = { content: '', tool_calls: [{ id: `wai_${Date.now().toString(36)}`, ...call }] }
    else if (text) out.reply = { content: text.replace(/TOOL_CALL[\s\S]*$/, '').trim() || text, tool_calls: [] }
    return out
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// Routes

/** Round trips per question, in this isolate: a question cannot be stretched into a free-for-all. */
const turnSteps = new Map<string, number>()

export const handleChat = async (req: Request, env: AsgmEnv, origin: string, ip: string, now = Date.now(), fetcher: typeof fetch = fetch): Promise<Response> => {
  if (limited(`aq:${ip}`, ASGM.ipPerMinute)) return send({ error: 'Too many requests. Wait a minute.', code: 'rate' }, 429, origin, { 'retry-after': '60' })
  const text = await req.text()
  if (text.length > ASGM_LIMITS.body) return send({ error: 'Request too large. Start a new conversation.', code: 'size' }, 413, origin)
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return send({ error: 'bad json' }, 400, origin)
  }
  const checked = checkBody(raw)
  if (checked.ok !== true) return send({ error: (checked as { error: string }).error }, 400, origin)
  const body = (checked as { body: ChatBody }).body

  // The same cap in this isolate's memory too, before the meter is asked.
  const tk = `${body.client}:${body.turn}`
  const seen = (turnSteps.get(tk) ?? 0) + 1
  if (seen > ASGM.stepsPerTurn) return send({ error: 'This question has used all its steps. Ask it again as a new question.', code: 'steps' }, 429, origin)
  turnSteps.set(tk, seen)
  if (turnSteps.size > 5_000) turnSteps.clear()

  // No meter, no model: the relay never runs unmetered.
  if (!env.ASGM_METER) return send({ error: 'The free model is unavailable right now. Try again later, or add your own key in settings.', code: 'unavailable' }, 503, origin)
  const meter = meterOf(env.ASGM_METER)
  const who = { client: body.client, turn: body.turn, ip: await netKey(ip), now }
  const r = await meter.reserve(who)
  const meta = { limit: r.limit, resetsAt: r.resetsAt }
  if (r.ok !== true) {
    const no = r as Extract<typeof r, { ok: false }>
    return send({ error: no.error, code: no.code, remaining: no.remaining, ...meta }, no.status, origin)
  }
  const fresh = r.fresh
  /** No answer: the question goes back (the round trip and any neurons stay spent), then the error. */
  const refuse = async (status: number, code: string, error: string) => {
    const back = await meter.settle({ ...who, fresh }).catch(() => null)
    return send({ error, code, remaining: back?.remaining ?? r.remaining, ...meta }, status, origin)
  }

  let reply = await callGroq(env, body, fetcher)
  let provider = 'groq'
  let model: string = ASGM.groq.model
  if (!reply) {
    if (!env.AI) return refuse(503, 'unavailable', 'The free model is unavailable right now. Try again later, or add your own key in settings.')
    const w = await callWorkersAi(env, body, meter, now)
    if (!w.reply) {
      if (w.denied && !w.calls) return refuse(503, 'budget', 'The free model has used its budget for today. It resets at midnight UTC; add your own key in settings to keep going now.')
      return refuse(502, 'provider', 'The model had an error. Try again in a minute.')
    }
    reply = w.reply
    provider = 'workers-ai'
    model = ASGM.wai.model
  }
  return send({ message: reply, provider, model, remaining: r.remaining, ...meta }, 200, origin)
}

export const handleStatus = async (url: URL, env: AsgmEnv, origin: string, ip: string, now = Date.now()): Promise<Response> => {
  const client = url.searchParams.get('client') ?? ''
  if (!CLIENT.test(client)) return send({ error: 'bad client' }, 400, origin)
  if (!env.ASGM_METER) return send({ remaining: 0, limit: ASGM.clientDaily, resetsAt: resetsAt(now), available: false }, 200, origin)
  const st = await meterOf(env.ASGM_METER).status({ client, ip: await netKey(ip), now })
  const g = st.day
  const open = g.q < ASGM.globalDaily && g.r < ASGM.roundsDaily && st.netLeft > 0 && (!!env.GROQ_API_KEY || (!!env.AI && g.n < ASGM.neuronCap && g.wai < ASGM.waiDaily))
  return send({ remaining: open ? Math.min(st.remaining, st.netLeft) : 0, limit: st.limit, resetsAt: st.resetsAt, available: open }, 200, origin)
}
