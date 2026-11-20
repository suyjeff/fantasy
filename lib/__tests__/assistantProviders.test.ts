import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runTurn, houseStatus, keys, testKey, listModels } from '../assistant'
import { AsgmError, complete, resetHouseVersion, toAnthropicMessages, toGeminiContents, toOpenAiMessages, type CompleteReq, type Msg } from '../assistant/providers'
import type { AsgmEvent, StoredKey } from '../assistant/types'
import { fixtureLeague } from './assistantFixture'
import { checkBody } from '../../workers/grades/src/assistant'
import { ASGM_LIMITS, ASGM_TOOL_NAMES_V1 } from '../../workers/grades/src/asgmShared'
import type { AsgmMessage } from '../assistant/types'

// Every provider behind one call shape, against a mocked fetch: streaming text, tool calls, errors that say what to do.
const enc = new TextEncoder()
const sseBody = (events: unknown[], raw = false) =>
  new ReadableStream({
    start(c) {
      // Split mid-event, as the network does.
      const text = events.map((e) => `data: ${raw ? e : JSON.stringify(e)}\n\n`).join('')
      for (let i = 0; i < text.length; i += 37) c.enqueue(enc.encode(text.slice(i, i + 37)))
      c.close()
    },
  })
const sse = (events: unknown[], raw = false) => new Response(sseBody(events, raw), { status: 200, headers: { 'content-type': 'text/event-stream' } })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

type Call = { url: string; init: RequestInit }
let calls: Call[] = []
const mockFetch = (...responses: (Response | Error | ((c: Call) => Response))[]) => {
  calls = []
  let i = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const c = { url: String(url), init }
      calls.push(c)
      const r = responses[Math.min(i++, responses.length - 1)]
      if (r instanceof Error) throw r
      return typeof r === 'function' ? r(c) : r
    }),
  )
}
const body = (i = 0) => JSON.parse(String(calls[i].init.body))
const headers = (i = 0) => calls[i].init.headers as Record<string, string>

const req = (over: Partial<CompleteReq> = {}): CompleteReq => ({
  system: 'SYS',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [{ name: 'lineup', description: 'd', params: { type: 'object', properties: { week: { type: 'integer' } }, required: [] } }],
  maxTokens: 300,
  signal: new AbortController().signal,
  ...over,
})
const key = (provider: StoredKey['provider'], model?: string): StoredKey => ({ provider, key: 'sk-test', ...(model ? { model } : {}) })

afterEach(() => vi.unstubAllGlobals())

describe('OpenAI-compatible providers (OpenAI, Groq, OpenRouter)', () => {
  it('streams text and assembles tool calls split across chunks', async () => {
    mockFetch(
      sse(
        [
          { model: 'gpt-x', choices: [{ delta: { content: 'Start ' } }] },
          { choices: [{ delta: { content: 'Hubbard.' } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'line', arguments: '{"we' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'up', arguments: 'ek":12}' } }] } }] },
          '[DONE]',
        ].map((e) => (e === '[DONE]' ? e : JSON.stringify(e))),
        true,
      ),
    )
    const deltas: string[] = []
    const r = await complete('openai', key('openai', 'gpt-x'), req({ onText: (d) => deltas.push(d) }))
    expect(deltas).toEqual(['Start ', 'Hubbard.'])
    expect(r).toMatchObject({ text: 'Start Hubbard.', provider: 'openai', model: 'gpt-x', toolCalls: [{ id: 'call_1', name: 'lineup', args: { week: 12 } }] })
    expect(calls[0].url).toBe('https://api.openai.com/v1/chat/completions')
    expect(headers().authorization).toBe('Bearer sk-test')
    expect(body()).toMatchObject({ model: 'gpt-x', stream: true, max_completion_tokens: 300, tool_choice: 'auto', messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }] })
    expect(body().tools[0]).toEqual({ type: 'function', function: { name: 'lineup', description: 'd', parameters: { type: 'object', properties: { week: { type: 'integer' } }, required: [] } } })
  })

  it('uses each provider’s own address, token field and defaults', async () => {
    mockFetch(sse(['[DONE]'], true))
    await complete('groq', key('groq'), req()).catch(() => {})
    expect(calls[0].url).toBe('https://api.groq.com/openai/v1/chat/completions')
    expect(body()).toMatchObject({ model: 'openai/gpt-oss-120b', reasoning_effort: 'low', max_completion_tokens: 300 })
    mockFetch(sse(['[DONE]'], true))
    await complete('openrouter', key('openrouter', 'some/model'), req())
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(body()).toMatchObject({ model: 'some/model', max_tokens: 300 })
  })

  it('sends tool calls and results back in OpenAI’s shape', () => {
    const msgs: Msg[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'lineup', args: { week: 12 } }] },
      { role: 'tool', toolCallId: 'c1', name: 'lineup', content: 'result' },
    ]
    expect(toOpenAiMessages(null, msgs)).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lineup', arguments: '{"week":12}' } }] },
      { role: 'tool', tool_call_id: 'c1', name: 'lineup', content: 'result' },
    ])
  })
})

describe('Anthropic, straight from the browser', () => {
  it('sends the direct-browser header, streams text and reads tool input deltas', async () => {
    mockFetch(
      sse([
        { type: 'message_start', message: { model: 'some-model' } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Checking.' } },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'player', input: {} } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"player":' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"Hubbard"}' } },
        { type: 'message_stop' },
      ]),
    )
    const r = await complete('anthropic', key('anthropic', 'some-model'), req())
    expect(r).toMatchObject({ text: 'Checking.', model: 'some-model', toolCalls: [{ id: 'toolu_1', name: 'player', args: { player: 'Hubbard' } }] })
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages')
    expect(headers()['anthropic-dangerous-direct-browser-access']).toBe('true')
    expect(headers()['x-api-key']).toBe('sk-test')
    expect(body()).toMatchObject({ model: 'some-model', system: 'SYS', max_tokens: 300, stream: true, tools: [{ name: 'lineup', input_schema: { type: 'object' } }] })
  })

  it('takes its model from the account’s list when none is picked (no model name in the app)', async () => {
    mockFetch(json({ data: [{ id: 'newest-model' }, { id: 'older-model' }] }), sse([{ type: 'message_start', message: { model: 'newest-model' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }]))
    const r = await complete('anthropic', { provider: 'anthropic', key: 'sk-other' }, req())
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/models?limit=100')
    expect(body(1).model).toBe('newest-model')
    expect(r.text).toBe('ok')
  })

  it('groups tool results into one user turn', () => {
    const out = toAnthropicMessages([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'x', toolCalls: [{ id: 'a', name: 'lineup', args: {} }, { id: 'b', name: 'player', args: { player: 'X' } }] },
      { role: 'tool', toolCallId: 'a', name: 'lineup', content: '1' },
      { role: 'tool', toolCallId: 'b', name: 'player', content: '2' },
    ])
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(out[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 'a', content: '1' },
      { type: 'tool_result', tool_use_id: 'b', content: '2' },
    ])
  })
})

describe('Gemini', () => {
  it('sends the key in a header, reads function calls and keeps their signature', async () => {
    mockFetch(
      sse([
        { candidates: [{ content: { parts: [{ text: 'Let me see. ' }] } }] },
        { candidates: [{ content: { parts: [{ functionCall: { name: 'standings', args: {} }, thoughtSignature: 'sig' }] } }] },
      ]),
    )
    const r = await complete('gemini', key('gemini'), req({ tools: [{ name: 'standings', description: 'd', params: { type: 'object', properties: {} } }] }))
    expect(calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse')
    expect(headers()['x-goog-api-key']).toBe('sk-test')
    expect(calls[0].url).not.toContain('sk-test')
    expect(body().tools[0].functionDeclarations[0]).toEqual({ name: 'standings', description: 'd' })
    expect(r.toolCalls[0]).toMatchObject({ name: 'standings', args: {}, meta: { thoughtSignature: 'sig' } })
    const back = toGeminiContents([{ role: 'assistant', content: '', toolCalls: r.toolCalls }, { role: 'tool', toolCallId: r.toolCalls[0].id, name: 'standings', content: 'table' }])
    expect(back).toEqual([
      { role: 'model', parts: [{ functionCall: { name: 'standings', args: {} }, thoughtSignature: 'sig' }] },
      { role: 'user', parts: [{ functionResponse: { name: 'standings', response: { result: 'table' } } }] },
    ])
  })
})

describe('errors say what to do next', () => {
  const code = async (r: Response | Error, provider: 'openai' | 'house' = 'openai', signal?: AbortSignal) => {
    mockFetch(r)
    try {
      await complete(provider, provider === 'house' ? null : key('openai'), req(signal ? { signal } : {}))
      return null
    } catch (e) {
      return e as AsgmError
    }
  }
  beforeEach(() => {
    process.env.NEXT_PUBLIC_FF_GRADES_URL = 'https://worker.test'
  })
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_FF_GRADES_URL
  })

  it('maps provider failures to the contract’s codes', async () => {
    expect((await code(json({ error: { message: 'Invalid API key' } }, 401)))!.code).toBe('key')
    expect((await code(json({ error: { message: 'Invalid API key' } }, 401)))!.message).toMatch(/OpenAI rejected the key \(401: Invalid API key\)\. Check or replace it/)
    // A 429 is a rate limit, never "out of free questions"; an account out of credit is the key's problem.
    expect(await code(json({ error: { message: 'Rate limit reached' } }, 429))).toMatchObject({ code: 'rate', message: 'Too many questions in a minute for your OpenAI key. Wait a moment and try again.' })
    expect((await code(json({ error: { message: 'You exceeded your current quota', code: 'insufficient_quota' } }, 429)))!.code).toBe('key')
    expect((await code(json({}, 500)))!.code).toBe('provider')
    expect((await code(new TypeError('Failed to fetch')))!.code).toBe('offline')
    const ac = new AbortController()
    ac.abort()
    const abortErr = Object.assign(new Error('Aborted'), { name: 'AbortError' })
    expect((await code(abortErr, 'openai', ac.signal))!.code).toBe('aborted')
    expect(await complete('openai', null, req()).catch((e: AsgmError) => e.code)).toBe('key')
  })

  it('maps the house worker’s quota and budget answers', async () => {
    expect(await code(json({ code: 'quota', error: 'That is all 15.' }, 429), 'house')).toMatchObject({ code: 'quota', message: 'That is all 15.' })
    expect((await code(json({ code: 'budget' }, 503), 'house'))!.code).toBe('budget')
    // Only the worker's own quota code means the day's questions are gone.
    expect(await code(json({ code: 'rate', error: 'Too many requests. Wait a minute.' }, 429), 'house')).toMatchObject({ code: 'rate', message: 'Too many questions in a minute. Wait a moment and try again.' })
    expect((await code(json({ code: 'steps' }, 429), 'house'))!.code).toBe('rate')
    expect((await code(json({}, 429), 'house'))!.code).toBe('rate')
    expect((await code(new TypeError('Failed to fetch'), 'house'))!.code).toBe('offline')
    delete process.env.NEXT_PUBLIC_FF_GRADES_URL
    expect((await code(json({}), 'house'))!.message).toMatch(/isn't set up on this site/)
  })
})

describe('a whole turn', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_FF_GRADES_URL = 'https://worker.test'
  })
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_FF_GRADES_URL
    resetHouseVersion()
  })

  it('answers a plain lookup from the league itself: no model, no request, any team', async () => {
    const lg = fixtureLeague()
    mockFetch(new Error('no network'))
    const events: AsgmEvent[] = []
    await runTurn({ history: [], text: 'what team has Puka', league: lg, provider: 'house' }, (e) => events.push(e), new AbortController().signal)
    expect(calls).toHaveLength(0)
    expect(events.map((e) => e.type)).toEqual(['step', 'step', 'card', 'action', 'text', 'done'])
    expect(events[1]).toMatchObject({ type: 'step', tool: 'lookup', status: 'done', label: 'Looking up who has Puka Nacua' })
    expect((events[4] as { delta: string }).delta).toMatch(/^Fourth & Long has Puka Nacua \(WR, LAR\), their WR\d\./)
    expect(events[3]).toMatchObject({ action: { kind: 'openTeam', rosterId: 4 } })
    expect(events[5]).toEqual({ type: 'done', provider: 'app', model: 'instant lookup' })
    // A judgment about the same player is the model's.
    mockFetch(json({ message: { content: 'Pass.', tool_calls: [] }, provider: 'workers-ai', model: 'm' }))
    await runTurn({ history: [], text: 'should I trade for Puka?', league: lg, provider: 'house' }, () => {}, new AbortController().signal)
    expect(calls).toHaveLength(1)
  }, 30_000)

  it('answers from the pack when the free model fails on a step that offers tools', async () => {
    // The live relay on Workers AI returned 502 whenever the model reached for a tool: answer without tools instead.
    const lg = fixtureLeague()
    mockFetch(json({ error: 'The model had an error. Try again in a minute.', code: 'provider', remaining: 15 }, 502), json({ message: { content: 'Two-Point Tries: +4.4 pts/wk from a league-average WR.', tool_calls: [] }, provider: 'workers-ai', model: 'm', remaining: 14 }))
    const events: AsgmEvent[] = []
    await runTurn({ history: [], text: 'which team needs a WR most', league: lg, provider: 'house' }, (e) => events.push(e), new AbortController().signal)
    expect(calls).toHaveLength(2)
    expect(body(0).tools.length).toBeGreaterThan(0)
    expect(body(1).tools).toEqual([])
    expect(body(1).step).toBe(1)
    expect(body(1).messages[body(1).messages.length - 1].content).toMatch(/^No more tools for this question/)
    expect(events[events.length - 1]).toMatchObject({ type: 'done', remaining: 14 })
    // Only once: a second failure is the manager's error to see.
    mockFetch(json({ error: 'x', code: 'provider' }, 502))
    const again: AsgmEvent[] = []
    await runTurn({ history: [], text: 'which team needs a WR most', league: lg, provider: 'house' }, (e) => again.push(e), new AbortController().signal)
    expect(calls).toHaveLength(2)
    expect(again[again.length - 1]).toMatchObject({ type: 'error', code: 'provider' })
  }, 30_000)

  it('offers a relay that predates the newer tools only the ones it knows, from then on', async () => {
    const lg = fixtureLeague()
    mockFetch(json({ error: 'tool not allowed: league_needs' }, 400), () => json({ message: { content: 'Two-Point Tries.', tool_calls: [] }, provider: 'workers-ai', model: 'm' }))
    await runTurn({ history: [], text: 'which team needs a WR most', league: lg, provider: 'house' }, () => {}, new AbortController().signal)
    expect(calls).toHaveLength(2)
    expect(body(0).tools.map((t: { name: string }) => t.name)).toContain('league_needs')
    expect(body(1).tools.every((t: { name: string }) => ASGM_TOOL_NAMES_V1.includes(t.name))).toBe(true)
    // The next question goes straight to the old set: no refused request first.
    mockFetch(() => json({ message: { content: 'Two-Point Tries.', tool_calls: [] }, provider: 'workers-ai', model: 'm' }))
    await runTurn({ history: [], text: 'which team needs a WR most', league: lg, provider: 'house' }, () => {}, new AbortController().signal)
    expect(calls).toHaveLength(1)
    expect(body(0).tools.some((t: { name: string }) => t.name === 'league_needs')).toBe(false)
  }, 30_000)

  it('pre-runs, relays to the house worker, runs the tool it asks for, then answers', async () => {
    const lg = fixtureLeague()
    mockFetch(
      json({ message: { content: '', tool_calls: [{ id: 'c1', name: 'playoff_odds', arguments: '{}' }] }, provider: 'groq', model: 'm', remaining: 14 }),
      json({ message: { content: 'Start Chuba Hubbard.\n- 14.4 projected.', tool_calls: [] }, provider: 'groq', model: 'm', remaining: 14 }),
    )
    const events: AsgmEvent[] = []
    await runTurn({ history: [], text: 'Should I bench my RB2 against the Ravens?', league: lg, provider: 'house' }, (e) => events.push(e), new AbortController().signal)
    const steps = events.filter((e): e is Extract<AsgmEvent, { type: 'step' }> => e.type === 'step')
    expect(steps.map((s) => `${s.tool}:${s.status}`)).toEqual(['lineup:running', 'lineup:done', 'playoff_odds:running', 'playoff_odds:done'])
    expect(steps[2].label).toBe('Running 4,000 playoff sims')
    expect(events.filter((e) => e.type === 'card').map((e) => (e as { card: { kind: string } }).card.kind)).toEqual(['lineup', 'odds'])
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe('Start Chuba Hubbard.\n- 14.4 projected.')
    expect(events[events.length - 1]).toEqual({ type: 'done', provider: 'house:groq', model: 'm', remaining: 14 })
    // Same question, same turn id, step by step; the system prompt is the worker's, so none is sent.
    expect(calls.map((c) => c.url)).toEqual(['https://worker.test/assistant/chat', 'https://worker.test/assistant/chat'])
    expect(body(0).turn).toBe(body(1).turn)
    expect([body(0).step, body(1).step]).toEqual([0, 1])
    expect(body(0).messages.some((m: { role: string }) => m.role === 'system')).toBe(false)
    expect(body(0).messages[0].content).toMatch(/^CONTEXT/)
    expect(body(1).messages.slice(-2).map((m: { role: string }) => m.role)).toEqual(['assistant', 'tool'])
    expect(body(1).messages[body(1).messages.length - 1].content).toMatch(/simulated seasons/)
  }, 30_000)

  it('makes at most four model calls, the last without tools', async () => {
    const lg = fixtureLeague()
    mockFetch(() => json({ message: { content: '', tool_calls: [{ id: `x${calls.length}`, name: 'standings', arguments: '{}' }] }, provider: 'groq', model: 'm' }))
    const events: AsgmEvent[] = []
    await runTurn({ history: [], text: 'hello', league: lg, provider: 'house' }, (e) => events.push(e), new AbortController().signal)
    expect(calls).toHaveLength(4)
    expect(body(3).tools).toEqual([])
    expect(body(2).tools.length).toBeGreaterThan(0)
    expect(events[events.length - 1]).toMatchObject({ type: 'error', code: 'provider' })
  }, 30_000)

  it('keeps every request inside the relay’s limits: tool calls, messages and size', async () => {
    const lg = fixtureLeague()
    const many = Array.from({ length: 7 }, (_, i) => ({ id: `m${i}`, name: i === 0 ? 'run_shell' : i === 1 ? 'player' : 'standings', arguments: i === 1 ? JSON.stringify({ player: 'x'.repeat(3000) }) : `{"n":${i}}` }))
    const big = (i: number) => ({ id: `b${i}`, name: 'matchup', arguments: `{"week":${11 + i}}` })
    mockFetch(
      json({ message: { content: '', tool_calls: many }, provider: 'groq', model: 'm' }),
      json({ message: { content: '', tool_calls: [0, 1, 2, 3].map(big) }, provider: 'groq', model: 'm' }),
      json({ message: { content: '', tool_calls: [4, 5, 6, 7].map((i) => ({ ...big(i), arguments: `{"week":${11 + (i % 4)},"team":"Fourth & Long"}` })) }, provider: 'groq', model: 'm' }),
      json({ message: { content: 'Start Chuba Hubbard.', tool_calls: [] }, provider: 'groq', model: 'm' }),
    )
    // A long conversation before the question.
    const history: AsgmMessage[] = Array.from({ length: 24 }, (_, i) =>
      i % 2 ? { role: 'gm', id: `g${i}`, text: 'y'.repeat(900), steps: [], cards: [], actions: [], at: 0 } : { role: 'user', id: `u${i}`, text: 'x'.repeat(600), at: 0 },
    )
    const events: AsgmEvent[] = []
    await runTurn({ history, text: 'Who should I start this week?', league: lg, provider: 'house' }, (e) => events.push(e), new AbortController().signal)
    expect(events[events.length - 1]).toMatchObject({ type: 'done' })
    expect(calls).toHaveLength(4)
    for (let i = 0; i < calls.length; i++) {
      const raw = String(calls[i].init.body)
      expect(raw.length).toBeLessThanOrEqual(ASGM_LIMITS.body)
      expect(checkBody(JSON.parse(raw))).toMatchObject({ ok: true })
    }
    // Of the seven calls only the five real ones with sane arguments survive, and of those the first four.
    const first = body(1).messages.find((m: { tool_calls?: unknown[] }) => m.tool_calls)
    expect(first.tool_calls.map((c: { function: { name: string } }) => c.function.name)).toEqual(['standings', 'standings', 'standings', 'standings'])
  }, 60_000)

  it('lets the model retry a failed call, and points a repeat of a good one at its result', async () => {
    const lg = fixtureLeague()
    const ask = (id: string, player: string) => json({ message: { content: '', tool_calls: [{ id, name: 'player', arguments: JSON.stringify({ player }) }] }, provider: 'groq', model: 'm' })
    mockFetch(ask('a', 'Zzyzx Nobody'), ask('b', 'Zzyzx Nobody'), ask('c', 'Zay Flowers'), json({ message: { content: 'Done.', tool_calls: [] }, provider: 'groq', model: 'm' }))
    const events: AsgmEvent[] = []
    await runTurn({ history: [], text: 'hello', league: lg, provider: 'house' }, (e) => events.push(e), new AbortController().signal)
    const toolMsgs = body(3).messages.filter((m: { role: string }) => m.role === 'tool').map((m: { content: string }) => m.content)
    // Both failures really ran (each says why), and the good call ran too.
    expect(toolMsgs[0]).toMatch(/^Error: no player matches/)
    expect(toolMsgs[1]).toMatch(/^Error: no player matches/)
    expect(toolMsgs[2]).toMatch(/^Zay Flowers: WR/)
    expect(events.filter((e) => e.type === 'step' && e.status === 'error')).toHaveLength(2)
    // A repeat of a pre-run that succeeded points at CONTEXT.
    mockFetch(json({ message: { content: '', tool_calls: [{ id: 'z', name: 'lineup', arguments: '{}' }] }, provider: 'groq', model: 'm' }), json({ message: { content: 'Done.', tool_calls: [] }, provider: 'groq', model: 'm' }))
    await runTurn({ history: [], text: 'Who should I start this week?', league: lg, provider: 'house' }, () => {}, new AbortController().signal)
    expect(body(1).messages[body(1).messages.length - 1].content).toBe('Same call as before: its result is the [lineup] result in CONTEXT above; nothing has changed since.')
  }, 60_000)

  it('shows only the answering step’s text: a preamble before tool calls never reaches the answer', async () => {
    const lg = fixtureLeague()
    const step = (text: string, tool: boolean) =>
      sse(
        [
          ...(text.match(/[\s\S]{1,40}/g) ?? []).map((t) => JSON.stringify({ choices: [{ delta: { content: t } }] })),
          ...(tool ? [JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `c${text.length}`, function: { name: 'standings', arguments: '{}' } }] } }] })] : []),
          '[DONE]',
        ],
        true,
      )
    const final = 'Start Chuba Hubbard. He projects 14.4 against a tough Baltimore defense, and nobody on your bench is within six points of him this week, so he stays in the lineup.'
    const shown = (events: AsgmEvent[]) =>
      events.reduce((acc, e) => (e.type === 'text' ? (e.reset ? '' : acc) + e.delta : acc), '')
    // A short preamble is held back and dropped: no reset needed.
    mockFetch(step('Checking the standings.', true), step(final, false))
    const a: AsgmEvent[] = []
    await runTurn({ history: [], text: 'hello', league: lg, provider: 'openai', key: key('openai', 'gpt-x') }, (e) => a.push(e), new AbortController().signal)
    expect(a.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe(final)
    expect(a.some((e) => e.type === 'text' && e.reset)).toBe(false)
    // The final answer still streams, in pieces.
    expect(a.filter((e) => e.type === 'text').length).toBeGreaterThan(1)
    // A long preamble that already streamed is taken back with a reset.
    const long = 'Let me look at this carefully. '.repeat(8)
    mockFetch(step(long, true), step(final, false))
    const b: AsgmEvent[] = []
    await runTurn({ history: [], text: 'hello', league: lg, provider: 'openai', key: key('openai', 'gpt-x') }, (e) => b.push(e), new AbortController().signal)
    expect(b.some((e) => e.type === 'text' && e.reset)).toBe(true)
    expect(shown(b)).toBe(final)
    expect(b[b.length - 1]).toMatchObject({ type: 'done' })
  }, 30_000)

  it('reports a stop as aborted', async () => {
    const lg = fixtureLeague()
    const ac = new AbortController()
    mockFetch(() => {
      ac.abort()
      throw new DOMException('Aborted', 'AbortError')
    })
    const events: AsgmEvent[] = []
    await runTurn({ history: [], text: 'Who should I start?', league: lg, provider: 'house' }, (e) => events.push(e), ac.signal)
    expect(events[events.length - 1]).toMatchObject({ type: 'error', code: 'aborted' })
  }, 30_000)

  it('reads the house allowance', async () => {
    mockFetch(json({ remaining: 12, limit: 15, resetsAt: 1_800_000_000_000, available: true }))
    expect(await houseStatus()).toEqual({ remaining: 12, limit: 15, resetsAt: 1_800_000_000_000 })
    expect(calls[0].url).toMatch(/^https:\/\/worker\.test\/assistant\/status\?client=[a-z0-9]{16,}$/)
  })
})

describe('BYOK keys', () => {
  it('stay in this browser and are checked against the provider’s model list', async () => {
    keys.save({ provider: 'groq', key: '  gsk-abc  ', model: 'openai/gpt-oss-120b' })
    expect(keys.load()).toEqual({ provider: 'groq', key: 'gsk-abc', model: 'openai/gpt-oss-120b' })
    keys.save(null)
    expect(keys.load()).toBeNull()
    mockFetch(json({ data: [{ id: 'openai/gpt-oss-120b' }, { id: 'whisper-large-v3' }, { id: 'llama-3.3-70b-versatile' }] }))
    expect(await testKey({ provider: 'groq', key: 'gsk-abc' })).toMatchObject({ ok: true })
    expect(await listModels({ provider: 'groq', key: 'gsk-abc' })).toEqual(['openai/gpt-oss-120b', 'llama-3.3-70b-versatile'])
    mockFetch(json({ error: { message: 'bad' } }, 401))
    expect(await testKey({ provider: 'openai', key: 'nope' })).toMatchObject({ ok: false, message: expect.stringMatching(/rejected the key/) })
  })
})

describe('the browser id for the free allowance', () => {
  it('stays the same for the page’s lifetime, even when storage is blocked', async () => {
    const { clientId, resetClientId } = await import('../assistant/keys')
    resetClientId()
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    const a = clientId()
    expect(a).toMatch(/^[a-z0-9]{16,24}$/)
    expect(clientId()).toBe(a)
    expect(clientId()).toBe(a)
    get.mockRestore()
    set.mockRestore()
    // With storage working, the stored id is the page's from the first read on.
    resetClientId()
    localStorage.setItem('ff:asgm:client', 'abcdefghij0123456789')
    expect(clientId()).toBe('abcdefghij0123456789')
    localStorage.removeItem('ff:asgm:client')
    expect(clientId()).toBe('abcdefghij0123456789')
    resetClientId()
  })
})
