// @vitest-environment node
// The Assistant GM battery against a live model. Run through scripts/asgm-eval.mjs, which sets the environment:
// ASGM_EVAL=1, ASGM_PROVIDER, ASGM_KEY, ASGM_MODEL, ASGM_OUT, ASGM_ONLY, ASGM_DELAY_MS, ASGM_HOUSE_URL.
import { writeFileSync } from 'node:fs'
import { describe, it } from 'vitest'
import { runTurn } from '../lib/assistant'
import type { AsgmEvent, AsgmProvider, StoredKey } from '../lib/assistant/types'
import { fixtureLeague } from '../lib/__tests__/assistantFixture'
import { QUESTIONS } from './asgm-questions'

const env = process.env
const provider = (env.ASGM_PROVIDER ?? 'groq') as AsgmProvider

/** Numbers in the answer that appear nowhere in what the model was sent: the hallucination check. */
const ungrounded = (answer: string, sent: string) => {
  const norm = (s: string) => s.replace(/[−–]/g, '-').replace(/,(?=\d{3})/g, '')
  const hay = norm(sent)
  const nums = norm(answer).match(/\d+(?:\.\d+)?/g) ?? []
  return [...new Set(nums)].filter((n) => {
    if (/^(19|20)\d\d$/.test(n)) return false
    const v = Number(n)
    // Small counts ("2 of", "week 3") are everywhere; check the rest.
    if (Number.isInteger(v) && v <= 4) return false
    return !new RegExp(`(^|[^\\d.])${n.replace('.', '\\.')}(?![\\d])`).test(hay) && !hay.includes(n)
  })
}

describe.skipIf(!env.ASGM_EVAL)('assistant battery, live', () => {
  it('answers every question', async () => {
    if (provider !== 'house' && !env.ASGM_KEY) throw new Error('Set ASGM_KEY (or use ASGM_PROVIDER=house with ASGM_HOUSE_URL).')
    if (provider === 'house') {
      if (!env.ASGM_HOUSE_URL) throw new Error('Set ASGM_HOUSE_URL to the worker, e.g. https://ff-grades.<you>.workers.dev')
      process.env.NEXT_PUBLIC_FF_GRADES_URL = env.ASGM_HOUSE_URL
    }
    const key: StoredKey | null = provider === 'house' ? null : { provider: provider as StoredKey['provider'], key: env.ASGM_KEY!, ...(env.ASGM_MODEL ? { model: env.ASGM_MODEL } : {}) }
    // Everything sent to the model, for the grounding check; the worker wants a browser origin.
    const sent: string[] = []
    const real = globalThis.fetch
    globalThis.fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
      if (init.body && typeof init.body === 'string') sent.push(init.body)
      const headers = provider === 'house' ? { ...(init.headers as Record<string, string>), origin: 'https://ff.sujeff.com' } : init.headers
      return real(url, { ...init, headers })
    }) as typeof fetch
    const lg = fixtureLeague()
    const only = env.ASGM_ONLY?.split(',').map((s) => s.trim())
    const qs = QUESTIONS.filter((q) => !only || only.includes(q.id))
    const out: string[] = [`# Assistant GM battery: ${provider}${env.ASGM_MODEL ? ` (${env.ASGM_MODEL})` : ''}`, '', `${new Date().toISOString()} · fixture ${lg.data.league.name}, week ${lg.data.state.week}, asking as ${lg.analysis.teamById[lg.myRosterId!].name}`, '']
    const summary: string[] = []
    for (const q of qs) {
      sent.length = 0
      const events: AsgmEvent[] = []
      const t0 = Date.now()
      await runTurn({ history: [], text: q.q, context: q.context, league: lg, provider, key }, (e) => events.push(e), AbortSignal.timeout(120_000))
      const ms = Date.now() - t0
      const answer = events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('')
      const steps = events.flatMap((e) => (e.type === 'step' && e.status !== 'running' ? [`${e.tool}${e.status === 'error' ? ' (error)' : ''}`] : []))
      const end = events[events.length - 1]
      const bad = ungrounded(answer, sent.join('\n'))
      const words = answer.split(/\s+/).filter(Boolean).length
      const flags = [end?.type === 'error' ? `ERROR ${end.code}: ${end.message}` : '', bad.length ? `ungrounded numbers: ${bad.join(', ')}` : '', words > 140 ? `long (${words} words)` : '', /^#|\n#/.test(answer) ? 'has a header' : ''].filter(Boolean)
      summary.push(`| ${q.id} | ${ms} ms | ${steps.join(', ') || '–'} | ${words} | ${flags.join('; ') || 'ok'} |`)
      out.push(`## ${q.id}: "${q.q}"`, '', `Expect: ${q.expect}`, '', `Tools: ${steps.join(', ') || 'none'} · ${ms} ms · ${words} words${end?.type === 'done' ? ` · ${end.provider} ${end.model}` : ''}`, '')
      out.push(answer ? answer.split('\n').map((l) => `> ${l}`).join('\n') : '> (no answer)', '')
      if (flags.length) out.push(`Flags: ${flags.join('; ')}`, '')
      await new Promise((r) => setTimeout(r, Number(env.ASGM_DELAY_MS ?? 3000)))
    }
    globalThis.fetch = real
    out.splice(4, 0, '| question | time | tools | words | flags |', '|---|---|---|---|---|', ...summary, '')
    const file = env.ASGM_OUT ?? 'asgm-eval.md'
    writeFileSync(file, out.join('\n'))
    console.log(`Wrote ${file}`)
  }, 3_600_000)
})
