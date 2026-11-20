// Model providers behind one call shape. The house provider relays through our worker (workers/grades
// /assistant/chat), which picks the model; the rest are the user's own key, called straight from the browser, so the
// key never touches our worker. Tool calling is normalised: each adapter takes the same messages and tool specs and
// returns the same { text, toolCalls }; text streams through onText where the provider streams.
import { ASGM_TOOL_NAMES_V1 } from '../../workers/grades/src/asgmShared'
import { sharedUrl } from '../sharedGrades'
import { clientId } from './keys'
import type { Schema } from './tools'
import type { AsgmErrorCode, AsgmKeyProvider, AsgmProvider, StoredKey } from './types'

export type ToolCall = { id: string; name: string; args: Record<string, unknown>; /** Provider extras sent back verbatim (Gemini's thought signature). */ meta?: Record<string, unknown> }
export type Msg =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; content: string; toolCallId: string; name: string }
export type ToolSpec = { name: string; description: string; params: Schema }
export type CompleteReq = {
  system: string
  messages: Msg[]
  tools: ToolSpec[]
  maxTokens: number
  signal: AbortSignal
  onText?: (delta: string) => void
  /** House only: which question and which round trip of it, for the worker's allowance. */
  turn?: string
  step?: number
}
export type CompleteRes = { text: string; toolCalls: ToolCall[]; provider: string; model: string; remaining?: number }

export class AsgmError extends Error {
  code: AsgmErrorCode
  constructor(code: AsgmErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

export const PROVIDER_LABEL: Record<AsgmProvider, string> = {
  house: 'Free model',
  groq: 'Groq',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Google Gemini',
  openrouter: 'OpenRouter',
  mock: 'Mock',
}

/**
 * Where each BYOK provider lives and the model used when the user has not picked one. Anthropic has no default here:
 * its model comes from its own models list (newest first), so no model name is written into the app.
 */
export const PROVIDERS: Record<AsgmKeyProvider, { base: string; model: string | null; keyUrl: string }> = {
  groq: { base: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', keyUrl: 'https://console.groq.com/keys' },
  openai: { base: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', keyUrl: 'https://platform.openai.com/api-keys' },
  openrouter: { base: 'https://openrouter.ai/api/v1', model: 'openai/gpt-oss-120b', keyUrl: 'https://openrouter.ai/keys' },
  anthropic: { base: 'https://api.anthropic.com/v1', model: null, keyUrl: 'https://console.anthropic.com/settings/keys' },
  gemini: { base: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash', keyUrl: 'https://aistudio.google.com/apikey' },
}

const ANTHROPIC_HEADERS = (key: string) => ({
  'x-api-key': key,
  'anthropic-version': '2023-06-01',
  // Required for a call straight from a browser; the key is the user's own and stays in their browser.
  'anthropic-dangerous-direct-browser-access': 'true',
})

// ---------------------------------------------------------------------------------------------------------------
// Errors

const what = (p: AsgmProvider) => PROVIDER_LABEL[p]

/** A failed HTTP response as an error the UI can say something useful about. */
const httpError = async (p: AsgmProvider, res: Response): Promise<AsgmError> => {
  let detail = ''
  try {
    const t = await res.text()
    try {
      const j = JSON.parse(t)
      detail = String(j?.error?.message ?? (typeof j?.error === 'string' ? j.error : '') ?? j?.message ?? '').slice(0, 200)
    } catch {
      detail = t.slice(0, 200)
    }
  } catch {
    // no body
  }
  const s = res.status
  if (s === 401 || s === 403) return new AsgmError('key', `${what(p)} rejected the key (${s}${detail ? `: ${detail}` : ''}). Check or replace it in settings.`)
  // A 429 is a rate limit, except where the account itself has run dry (OpenAI's insufficient_quota): that is the key's.
  if (s === 429 && /insufficient_quota|credit|billing|exceeded your current quota/i.test(detail))
    return new AsgmError('key', `Your ${what(p)} account is out of credit (${detail}). Check its plan and billing, or switch providers in settings.`)
  if (s === 429) return new AsgmError('rate', `Too many questions in a minute for your ${what(p)} key. Wait a moment and try again.`)
  if (s === 404) return new AsgmError('provider', `${what(p)} doesn't know that model${detail ? ` (${detail})` : ''}. Pick another one in settings.`)
  if (s === 400 || s === 422) return new AsgmError('provider', `${what(p)} refused the request${detail ? `: ${detail}` : ''}. Try another model, or ask again.`)
  return new AsgmError('provider', `${what(p)} had an error (${s}). Try again in a minute, or switch providers in settings.`)
}

/** fetch, with network failures and aborts turned into the right error. */
const call = async (p: AsgmProvider, url: string, init: RequestInit, signal: AbortSignal): Promise<Response> => {
  let res: Response
  try {
    res = await fetch(url, { ...init, signal })
  } catch (e) {
    if (signal.aborted || (e as Error)?.name === 'AbortError') throw new AsgmError('aborted', 'Stopped.')
    throw new AsgmError('offline', `Can't reach ${what(p)}. Check your connection (or an ad blocker) and try again.`)
  }
  if (!res.ok) throw await httpError(p, res)
  return res
}

// ---------------------------------------------------------------------------------------------------------------
// Streams

const dataOf = (block: string) =>
  block
    .split(/\r?\n/)
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).replace(/^ /, ''))
    .join('\n')

/** Server-sent events from a fetch body, one data payload at a time. */
export async function* sse(res: Response, signal: AbortSignal): AsyncGenerator<string> {
  if (!res.body) {
    for (const block of (await res.text()).split(/\r?\n\r?\n/)) {
      const d = dataOf(block)
      if (d) yield d
    }
    return
  }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      if (signal.aborted) throw new AsgmError('aborted', 'Stopped.')
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let m: RegExpExecArray | null
      while ((m = /\r?\n\r?\n/.exec(buf))) {
        const d = dataOf(buf.slice(0, m.index))
        buf = buf.slice(m.index + m[0].length)
        if (d) yield d
      }
    }
    const d = dataOf(buf)
    if (d) yield d
  } catch (e) {
    if (e instanceof AsgmError) throw e
    if (signal.aborted) throw new AsgmError('aborted', 'Stopped.')
    throw new AsgmError('offline', 'The connection dropped mid-answer. Ask again.')
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // already released
    }
  }
}

const parseArgs = (s: unknown): Record<string, unknown> => {
  if (s && typeof s === 'object') return s as Record<string, unknown>
  try {
    const v = JSON.parse(String(s ?? '') || '{}')
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

let seq = 0
export const newId = (p: string) => `${p}_${Date.now().toString(36)}${(++seq).toString(36)}`

// ---------------------------------------------------------------------------------------------------------------
// OpenAI-compatible: OpenAI, Groq, OpenRouter (and the house worker's message format)

export const toOpenAiMessages = (system: string | null, messages: Msg[]) => [
  ...(system ? [{ role: 'system', content: system }] : []),
  ...messages.map((m) =>
    m.role === 'tool'
      ? { role: 'tool', tool_call_id: m.toolCallId, name: m.name, content: m.content }
      : m.role === 'assistant' && m.toolCalls?.length
        ? { role: 'assistant', content: m.content || null, tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) }
        : { role: m.role, content: m.content },
  ),
]

export const toOpenAiTools = (tools: ToolSpec[]) => tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.params } }))

const openAiCompat = async (p: 'groq' | 'openai' | 'openrouter', key: StoredKey, req: CompleteReq): Promise<CompleteRes> => {
  const cfg = PROVIDERS[p]
  const model = key.model || cfg.model!
  const body: Record<string, unknown> = { model, messages: toOpenAiMessages(req.system, req.messages), stream: true }
  if (req.tools.length) {
    body.tools = toOpenAiTools(req.tools)
    body.tool_choice = 'auto'
  }
  // OpenAI's newer models take max_completion_tokens only; Groq takes both; OpenRouter normalises max_tokens.
  if (p === 'openrouter') body.max_tokens = req.maxTokens
  else body.max_completion_tokens = req.maxTokens
  if (p === 'groq' && /gpt-oss/.test(model)) body.reasoning_effort = 'low'
  const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${key.key}` }
  if (p === 'openrouter') headers['x-title'] = 'Fantasy Assistant GM'
  const res = await call(p, `${cfg.base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) }, req.signal)
  let text = ''
  const calls: Record<number, { id: string; name: string; args: string }> = {}
  let served = model
  for await (const data of sse(res, req.signal)) {
    if (data === '[DONE]') break
    let j: any
    try {
      j = JSON.parse(data)
    } catch {
      continue
    }
    if (j.error) throw new AsgmError('provider', `${what(p)}: ${String(j.error.message ?? j.error).slice(0, 200)}`)
    if (j.model) served = j.model
    const d = j.choices?.[0]?.delta
    if (!d) continue
    if (typeof d.content === 'string' && d.content) {
      text += d.content
      req.onText?.(d.content)
    }
    for (const tc of d.tool_calls ?? []) {
      const i = tc.index ?? 0
      const c = (calls[i] ??= { id: '', name: '', args: '' })
      if (tc.id) c.id = tc.id
      if (tc.function?.name) c.name += tc.function.name
      if (tc.function?.arguments) c.args += tc.function.arguments
    }
  }
  const toolCalls = Object.values(calls)
    .filter((c) => c.name)
    .map((c) => ({ id: c.id || newId('call'), name: c.name, args: parseArgs(c.args) }))
  return { text, toolCalls, provider: p, model: served }
}

// ---------------------------------------------------------------------------------------------------------------
// Anthropic Messages API, straight from the browser

export const toAnthropicMessages = (messages: Msg[]) => {
  const out: { role: 'user' | 'assistant'; content: unknown[] }[] = []
  const push = (role: 'user' | 'assistant', block: unknown) => {
    const last = out[out.length - 1]
    if (last && last.role === role) last.content.push(block)
    else out.push({ role, content: [block] })
  }
  for (const m of messages) {
    if (m.role === 'tool') push('user', { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content })
    else if (m.role === 'assistant') {
      if (m.content) push('assistant', { type: 'text', text: m.content })
      for (const c of m.toolCalls ?? []) push('assistant', { type: 'tool_use', id: c.id, name: c.name, input: c.args })
    } else push('user', { type: 'text', text: m.content })
  }
  return out
}

const anthropic = async (key: StoredKey, req: CompleteReq): Promise<CompleteRes> => {
  const model = key.model || (await firstModel(key))
  if (!model) throw new AsgmError('key', "Couldn't list your Anthropic models. Check the key, then pick a model in settings.")
  const body: Record<string, unknown> = { model, system: req.system, messages: toAnthropicMessages(req.messages), max_tokens: req.maxTokens, stream: true }
  if (req.tools.length) body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.params }))
  const res = await call('anthropic', `${PROVIDERS.anthropic.base}/messages`, { method: 'POST', headers: { 'content-type': 'application/json', ...ANTHROPIC_HEADERS(key.key) }, body: JSON.stringify(body) }, req.signal)
  let text = ''
  const blocks: Record<number, { id: string; name: string; json: string }> = {}
  let served = model
  for await (const data of sse(res, req.signal)) {
    let j: any
    try {
      j = JSON.parse(data)
    } catch {
      continue
    }
    if (j.type === 'error') throw new AsgmError('provider', `Anthropic: ${String(j.error?.message ?? 'error').slice(0, 200)}. Try again in a minute.`)
    if (j.type === 'message_start' && j.message?.model) served = j.message.model
    if (j.type === 'content_block_start' && j.content_block?.type === 'tool_use') blocks[j.index] = { id: j.content_block.id, name: j.content_block.name, json: '' }
    if (j.type === 'content_block_delta') {
      if (j.delta?.type === 'text_delta' && j.delta.text) {
        text += j.delta.text
        req.onText?.(j.delta.text)
      }
      if (j.delta?.type === 'input_json_delta' && blocks[j.index]) blocks[j.index].json += j.delta.partial_json ?? ''
    }
  }
  const toolCalls = Object.values(blocks).map((b) => ({ id: b.id || newId('toolu'), name: b.name, args: parseArgs(b.json) }))
  return { text, toolCalls, provider: 'anthropic', model: served }
}

// ---------------------------------------------------------------------------------------------------------------
// Google Gemini

/** Gemini takes an OpenAPI subset: an object with no properties is left out altogether. */
export const geminiSchema = (s: Schema): Record<string, unknown> | undefined => {
  if (s.type === 'object' && (!s.properties || !Object.keys(s.properties).length)) return undefined
  const out: Record<string, unknown> = { type: s.type.toUpperCase() }
  if (s.description) out.description = s.description
  if (s.enum) out.enum = s.enum
  if (s.items) out.items = geminiSchema(s.items) ?? { type: 'STRING' }
  if (s.properties) {
    out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, geminiSchema(v) ?? { type: 'STRING' }]))
    if (s.required?.length) out.required = s.required
  }
  return out
}

export const toGeminiContents = (messages: Msg[]) => {
  const out: { role: 'user' | 'model'; parts: unknown[] }[] = []
  const push = (role: 'user' | 'model', part: unknown) => {
    const last = out[out.length - 1]
    if (last && last.role === role) last.parts.push(part)
    else out.push({ role, parts: [part] })
  }
  for (const m of messages) {
    if (m.role === 'tool') push('user', { functionResponse: { name: m.name, response: { result: m.content } } })
    else if (m.role === 'assistant') {
      if (m.content) push('model', { text: m.content })
      for (const c of m.toolCalls ?? []) push('model', { functionCall: { name: c.name, args: c.args }, ...(c.meta ?? {}) })
    } else push('user', { text: m.content })
  }
  return out
}

const gemini = async (key: StoredKey, req: CompleteReq): Promise<CompleteRes> => {
  const model = (key.model || PROVIDERS.gemini.model!).replace(/^models\//, '')
  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: req.system }] },
    contents: toGeminiContents(req.messages),
    generationConfig: { maxOutputTokens: req.maxTokens },
  }
  if (req.tools.length) {
    body.tools = [
      {
        functionDeclarations: req.tools.map((t) => {
          const parameters = geminiSchema(t.params)
          return { name: t.name, description: t.description, ...(parameters ? { parameters } : {}) }
        }),
      },
    ]
  }
  const url = `${PROVIDERS.gemini.base}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`
  const res = await call('gemini', url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key.key }, body: JSON.stringify(body) }, req.signal)
  let text = ''
  const toolCalls: ToolCall[] = []
  for await (const data of sse(res, req.signal)) {
    let j: any
    try {
      j = JSON.parse(data)
    } catch {
      continue
    }
    if (j.error) throw new AsgmError('provider', `Gemini: ${String(j.error.message ?? 'error').slice(0, 200)}`)
    for (const part of j.candidates?.[0]?.content?.parts ?? []) {
      if (part.thought) continue
      if (typeof part.text === 'string' && part.text) {
        text += part.text
        req.onText?.(part.text)
      }
      if (part.functionCall) {
        const meta: Record<string, unknown> = {}
        if (part.thoughtSignature) meta.thoughtSignature = part.thoughtSignature
        toolCalls.push({ id: newId('gem'), name: part.functionCall.name, args: parseArgs(part.functionCall.args), meta })
      }
    }
  }
  return { text, toolCalls, provider: 'gemini', model }
}

// ---------------------------------------------------------------------------------------------------------------
// House: our worker relays to a free-tier model. Not streamed (the worker answers in one piece), so the text is
// handed on in small pieces at once.

export const houseUrl = () => sharedUrl()

/**
 * Set once the relay has refused a tool it does not know: it is the first deployed version, so it is offered only the
 * tools that version allows, for the rest of this page's life. A refusal is free (the relay checks before it meters).
 */
let houseV1 = false
export const resetHouseVersion = () => {
  houseV1 = false
}

const house = async (req: CompleteReq): Promise<CompleteRes> => {
  const base = houseUrl()
  if (!base) throw new AsgmError('offline', "The free model isn't set up on this site. Add your own key in settings.")
  const send = async (v1: boolean) => {
    const tools = v1 ? req.tools.filter((t) => ASGM_TOOL_NAMES_V1.includes(t.name)) : req.tools
    const body = {
      client: clientId(),
      turn: req.turn ?? newId('t'),
      step: req.step ?? 0,
      messages: toOpenAiMessages(null, req.messages),
      tools: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.params })),
    }
    try {
      return await fetch(`${base}/assistant/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: req.signal })
    } catch (e) {
      if (req.signal.aborted || (e as Error)?.name === 'AbortError') throw new AsgmError('aborted', 'Stopped.')
      throw new AsgmError('offline', "Can't reach the free model. Check your connection and try again.")
    }
  }
  let res = await send(houseV1)
  let j: any = null
  try {
    j = await res.json()
  } catch {
    // not JSON
  }
  if (res.status === 400 && !houseV1 && /^tool not allowed/.test(String(j?.error ?? ''))) {
    houseV1 = true
    res = await send(true)
    j = null
    try {
      j = await res.json()
    } catch {
      // not JSON
    }
  }
  if (!res.ok) {
    // The relay says why a model call came back empty (what Workers AI returned): for whoever reads the console.
    if (j?.why && typeof console !== 'undefined') console.warn(`[asgm] free model: ${String(j.why).slice(0, 200)}`)
    const code = j?.code
    const msg = typeof j?.error === 'string' ? j.error : null
    if (code === 'quota') throw new AsgmError('quota', msg ?? "That's today's free questions for this browser. They reset at midnight UTC; add your own key in settings to keep going.")
    if (code === 'budget') throw new AsgmError('budget', msg ?? 'The free model has used its budget for today. It resets at midnight UTC; add your own key in settings to keep going now.')
    if (code === 'steps') throw new AsgmError('rate', 'That question took too many steps. Ask it again.')
    if (code === 'rate' || res.status === 429) throw new AsgmError('rate', 'Too many questions in a minute. Wait a moment and try again.')
    if (res.status === 413) throw new AsgmError('provider', 'That conversation got too long for the free model. Start a new conversation.')
    throw new AsgmError('provider', msg ?? `The free model had an error (${res.status}). Try again in a minute.`)
  }
  const m = j?.message ?? {}
  const text = typeof m.content === 'string' ? m.content : ''
  const toolCalls: ToolCall[] = (Array.isArray(m.tool_calls) ? m.tool_calls : [])
    .map((c: any) => ({ id: String(c.id ?? newId('call')), name: String(c.name ?? c.function?.name ?? ''), args: parseArgs(c.arguments ?? c.function?.arguments) }))
    .filter((c: ToolCall) => c.name)
  if (text && req.onText) for (const piece of text.match(/\S+\s*|\s+/g) ?? [text]) req.onText(piece)
  return { text, toolCalls, provider: `house:${j?.provider ?? 'house'}`, model: String(j?.model ?? ''), remaining: typeof j?.remaining === 'number' ? j.remaining : undefined }
}

// ---------------------------------------------------------------------------------------------------------------
// Entry points

/** One model round trip on the chosen provider. */
export const complete = (provider: AsgmProvider, key: StoredKey | null, req: CompleteReq): Promise<CompleteRes> => {
  if (provider === 'house') return house(req)
  if (provider === 'mock') return Promise.reject(new AsgmError('provider', 'The mock provider has no model.'))
  if (!key || key.provider !== provider || !key.key) return Promise.reject(new AsgmError('key', `Add your ${what(provider)} key in settings first.`))
  if (provider === 'anthropic') return anthropic(key, req)
  if (provider === 'gemini') return gemini(key, req)
  return openAiCompat(provider, key, req)
}

const modelsCache = new Map<string, string[]>()
const firstModel = async (key: StoredKey) => (await listModels(key))[0] ?? null

/** The provider's models that can take tools, newest or best first where the provider says. Throws AsgmError. */
export const fetchModels = async (k: StoredKey, signal: AbortSignal = new AbortController().signal): Promise<string[]> => {
  const p = k.provider
  if (p === 'anthropic') {
    const res = await call(p, `${PROVIDERS.anthropic.base}/models?limit=100`, { headers: ANTHROPIC_HEADERS(k.key) }, signal)
    const j: any = await res.json()
    return (j?.data ?? []).map((m: any) => String(m.id)).filter(Boolean)
  }
  if (p === 'gemini') {
    const res = await call(p, `${PROVIDERS.gemini.base}/models?pageSize=200`, { headers: { 'x-goog-api-key': k.key } }, signal)
    const j: any = await res.json()
    return (j?.models ?? [])
      .filter((m: any) => (m.supportedGenerationMethods ?? []).includes('generateContent') && /gemini/i.test(m.name ?? ''))
      .map((m: any) => String(m.name).replace(/^models\//, ''))
  }
  const res = await call(p, `${PROVIDERS[p].base}/models`, { headers: { authorization: `Bearer ${k.key}` } }, signal)
  const j: any = await res.json()
  const rows: any[] = j?.data ?? []
  if (p === 'openrouter') return rows.filter((m) => !m.supported_parameters || m.supported_parameters.includes('tools')).map((m) => String(m.id))
  if (p === 'openai') return rows.map((m) => String(m.id)).filter((id) => /^(gpt-|o\d|chatgpt)/.test(id) && !/(audio|realtime|image|tts|transcribe|search|embedding|instruct)/.test(id)).sort()
  return rows.filter((m) => m.active !== false).map((m) => String(m.id)).filter((id) => !/(whisper|tts|guard|playai|orpheus)/i.test(id))
}

/** Models for the picker; an empty list when the key cannot list them (the default model is used then). */
export const listModels = async (k: StoredKey): Promise<string[]> => {
  const ck = `${k.provider}:${k.key.slice(-6)}`
  if (modelsCache.has(ck)) return modelsCache.get(ck)!
  try {
    const xs = await fetchModels(k)
    modelsCache.set(ck, xs)
    return xs
  } catch {
    return []
  }
}

/** Whether the key works, in a sentence for the settings sheet. */
export const testKey = async (k: StoredKey): Promise<{ ok: boolean; message: string }> => {
  if (!k.key?.trim()) return { ok: false, message: 'Paste a key first.' }
  try {
    const key = { ...k, key: k.key.trim() }
    const xs = await fetchModels(key)
    modelsCache.set(`${k.provider}:${key.key.slice(-6)}`, xs)
    if (k.model && xs.length && !xs.includes(k.model)) return { ok: false, message: `The key works, but ${k.model} isn't in your ${what(k.provider)} model list. Pick another.` }
    const model = k.model || PROVIDERS[k.provider].model || xs[0]
    return { ok: true, message: `Key works: ${xs.length} model${xs.length === 1 ? '' : 's'} available${model ? `, using ${model}` : ''}. It stays in this browser.` }
  } catch (e) {
    return { ok: false, message: e instanceof AsgmError ? e.message : `Couldn't check the key: ${(e as Error)?.message ?? e}` }
  }
}
