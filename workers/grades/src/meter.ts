// The Assistant GM's meter: every allowance the relay keeps (per browser, per network, the day's questions and round
// trips, Workers AI neurons and calls) in one SQLite-backed Durable Object. One instance (idFromName('meter')) sees
// every request in order and each operation reads and writes its rows synchronously, so two requests can never both
// pass a cap that only one fits under. That is what makes the neuron cap a guarantee, which KV (eventually consistent,
// last write wins) could not.
//
// The protocol is reserve-then-settle. `reserve` charges a round trip (and the question, the first time its id is
// seen) before any model is called; `reserveWai` sets aside the worst case a Workers AI call could cost before it is
// sent, and `settleWai` swaps it for what the call reported. A call that fails keeps its worst-case charge: it may
// have run. `settle` gives the question back (never the round trip or the neurons) when no answer came.

import { ASGM_MAX_STEPS } from './asgmShared'

export const ASGM = {
  /** Questions per browser per UTC day. */
  clientDaily: 15,
  /** Questions per network (a hash of the IP) per UTC day: rotating browser ids cannot drain everyone's day. */
  ipDaily: 25,
  /** Questions across everyone per UTC day. */
  globalDaily: 120,
  /** Model round trips across everyone per UTC day. */
  roundsDaily: 150,
  /** Question ids remembered per browser (more than its daily questions, so none is forgotten mid-day). */
  turnsKept: 32,
  /** Workers AI neurons we let ourselves spend per UTC day, of the 10,000 free. */
  neuronCap: 8_500,
  /** Workers AI calls per UTC day, a second fence on the same budget. */
  waiDaily: 60,
  groq: { url: 'https://api.groq.com/openai/v1/chat/completions', model: 'openai/gpt-oss-120b', maxOut: 900, timeoutMs: 25_000 },
  wai: { model: '@cf/openai/gpt-oss-120b', maxOut: 900, inPerM: 31_818, outPerM: 68_182 },
  /** Round trips one question may make, and requests per IP per minute (in memory: a speed bump, not a guarantee). */
  stepsPerTurn: ASGM_MAX_STEPS,
  ipPerMinute: 20,
} as const

export const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10)
export const resetsAt = (now: number) => {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
}

/** The slice of the Durable Object SQL API the meter uses (ctx.storage.sql). */
export type SqlLike = { exec: (query: string, ...bindings: unknown[]) => { toArray: () => Record<string, unknown>[] } }
export type MeterState = { storage: { sql: SqlLike } }

type Day = { q: number; n: number; wai: number; r: number }
type Client = { q: number; turns: Record<string, number> }
type Net = { q: number }

export type Meta = { remaining: number; limit: number; resetsAt: number }
export type Reserved = ({ ok: true; fresh: boolean } | { ok: false; code: 'steps' | 'quota' | 'budget'; error: string; status: number }) & Meta
export type MeterStatus = Meta & { day: Day; netLeft: number }

const round2 = (x: number) => Math.round(x * 100) / 100

/** The meter's logic over its table. Every method runs to completion without awaiting: one request at a time. */
export class MeterCore {
  private sql: SqlLike
  constructor(sql: SqlLike) {
    this.sql = sql
    sql.exec('CREATE TABLE IF NOT EXISTS meter (k TEXT PRIMARY KEY, v TEXT NOT NULL)')
  }

  private get<T>(k: string, fallback: T): T {
    const row = this.sql.exec('SELECT v FROM meter WHERE k = ?', k).toArray()[0]
    if (!row) return fallback
    try {
      return { ...fallback, ...(JSON.parse(String(row.v)) as T) }
    } catch {
      return fallback
    }
  }

  private put(k: string, v: unknown) {
    this.sql.exec('INSERT OR REPLACE INTO meter (k, v) VALUES (?, ?)', k, JSON.stringify(v))
  }

  /** A new UTC day clears the table: every allowance starts again. */
  private roll(now: number) {
    const day = dayOf(now)
    if (this.get<{ d: string | null }>('day', { d: null }).d === day) return
    this.sql.exec('DELETE FROM meter')
    this.put('day', { d: day })
  }

  private day = () => this.get<Day>('g', { q: 0, n: 0, wai: 0, r: 0 })
  private client = (id: string) => this.get<Client>(`c:${id}`, { q: 0, turns: {} })
  private net = (ip: string) => this.get<Net>(`i:${ip}`, { q: 0 })
  private meta = (c: Client, now: number): Meta => ({ remaining: Math.max(0, ASGM.clientDaily - c.q), limit: ASGM.clientDaily, resetsAt: resetsAt(now) })

  /** One round trip of one question: checks every cap, then charges it, all at once. */
  reserve(a: { client: string; turn: string; ip: string; now: number }): Reserved {
    this.roll(a.now)
    const g = this.day()
    const c = this.client(a.client)
    const i = this.net(a.ip)
    const steps = c.turns[a.turn] ?? 0
    const fresh = steps === 0
    const no = (code: 'steps' | 'quota' | 'budget', status: number, error: string): Reserved => ({ ok: false, code, status, error, ...this.meta(c, a.now) })
    if (steps >= ASGM.stepsPerTurn) return no('steps', 429, 'This question has used all its steps. Ask it again as a new question.')
    if (fresh && c.q >= ASGM.clientDaily)
      return no('quota', 429, `That's all ${ASGM.clientDaily} free questions for this browser today. They reset at midnight UTC; add your own key in settings to keep going.`)
    if (fresh && i.q >= ASGM.ipDaily)
      return no('quota', 429, "That's all the free questions for this network today. They reset at midnight UTC; add your own key in settings to keep going.")
    if ((fresh && g.q >= ASGM.globalDaily) || g.r >= ASGM.roundsDaily)
      return no('budget', 503, 'The free model has answered all it can today. It resets at midnight UTC; add your own key in settings to keep going now.')
    const turns = { ...c.turns, [a.turn]: steps + 1 }
    const ids = Object.keys(turns)
    const next: Client = { q: c.q + (fresh ? 1 : 0), turns: ids.length <= ASGM.turnsKept ? turns : Object.fromEntries(ids.slice(-ASGM.turnsKept).map((id) => [id, turns[id]])) }
    this.put(`c:${a.client}`, next)
    if (fresh) this.put(`i:${a.ip}`, { q: i.q + 1 })
    this.put('g', { ...g, q: g.q + (fresh ? 1 : 0), r: g.r + 1 })
    return { ok: true, fresh, ...this.meta(next, a.now) }
  }

  /**
   * No answer came: the question is given back (and its id forgotten, so asking again is charged again), never the
   * round trip or any neurons.
   */
  settle(a: { client: string; turn: string; ip: string; now: number; fresh: boolean }): Meta {
    this.roll(a.now)
    const c = this.client(a.client)
    if (!a.fresh) return this.meta(c, a.now)
    const turns = { ...c.turns }
    delete turns[a.turn]
    const next: Client = { q: Math.max(0, c.q - 1), turns }
    this.put(`c:${a.client}`, next)
    const i = this.net(a.ip)
    this.put(`i:${a.ip}`, { q: Math.max(0, i.q - 1) })
    const g = this.day()
    this.put('g', { ...g, q: Math.max(0, g.q - 1) })
    return this.meta(next, a.now)
  }

  /** Sets aside the worst case of one Workers AI call, if it fits under both caps. */
  reserveWai(a: { worst: number; now: number }): { ok: boolean } {
    this.roll(a.now)
    const g = this.day()
    if (g.wai >= ASGM.waiDaily || g.n + a.worst > ASGM.neuronCap) return { ok: false }
    this.put('g', { ...g, n: round2(g.n + a.worst), wai: g.wai + 1 })
    return { ok: true }
  }

  /** The call came back with its usage: the reservation becomes what it actually cost. */
  settleWai(a: { worst: number; actual: number; now: number }): { ok: true } {
    this.roll(a.now)
    const g = this.day()
    this.put('g', { ...g, n: round2(Math.max(0, g.n - a.worst + a.actual)) })
    return { ok: true }
  }

  status(a: { client: string; ip: string; now: number }): MeterStatus {
    this.roll(a.now)
    return { ...this.meta(this.client(a.client), a.now), day: this.day(), netLeft: Math.max(0, ASGM.ipDaily - this.net(a.ip).q) }
  }
}

type Ops = 'reserve' | 'settle' | 'reserveWai' | 'settleWai' | 'status'

/** The Durable Object (SQLite-backed: wrangler.toml `new_sqlite_classes`). */
export class AsgmMeter {
  private core: MeterCore
  constructor(state: MeterState, _env?: unknown) {
    this.core = new MeterCore(state.storage.sql)
  }
  async fetch(req: Request): Promise<Response> {
    let a: Record<string, unknown> & { op?: Ops }
    try {
      a = (await req.json()) as typeof a
    } catch {
      return new Response('bad json', { status: 400 })
    }
    const op = a.op
    if (op !== 'reserve' && op !== 'settle' && op !== 'reserveWai' && op !== 'settleWai' && op !== 'status') return new Response('bad op', { status: 400 })
    // Everything after the body is read is synchronous: no other request runs in between.
    const out = (this.core[op] as (x: unknown) => unknown)(a)
    return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json' } })
  }
}

export type MeterStub = { fetch: (input: string, init?: RequestInit) => Promise<Response> }
export type MeterNamespace = { idFromName: (name: string) => unknown; get: (id: unknown) => MeterStub }

/** The meter as the relay calls it: one request to the Durable Object per operation. */
export const meterOf = (ns: MeterNamespace) => {
  const stub = ns.get(ns.idFromName('meter'))
  const call = async <T>(op: Ops, a: Record<string, unknown>): Promise<T> => {
    const res = await stub.fetch(`https://meter/${op}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op, ...a }) })
    if (!res.ok) throw new Error(`meter ${op}: ${res.status}`)
    return (await res.json()) as T
  }
  return {
    reserve: (a: { client: string; turn: string; ip: string; now: number }) => call<Reserved>('reserve', a),
    settle: (a: { client: string; turn: string; ip: string; now: number; fresh: boolean }) => call<Meta>('settle', a),
    reserveWai: (a: { worst: number; now: number }) => call<{ ok: boolean }>('reserveWai', a),
    settleWai: (a: { worst: number; actual: number; now: number }) => call<{ ok: true }>('settleWai', a),
    status: (a: { client: string; ip: string; now: number }) => call<MeterStatus>('status', a),
  }
}
export type Meter = ReturnType<typeof meterOf>

/** A network's key in the meter: a hash of its IP, never the IP itself. */
export const netKey = async (ip: string) => {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`asgm:${ip}`)))
  return Array.from(bytes.slice(0, 10), (b) => b.toString(16).padStart(2, '0')).join('')
}
