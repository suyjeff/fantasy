// What the model is sent for the battery's questions on the fixture league: the system prompt, the tools, and for each
// question the context pack with the tools the app pre-ran. Written as Markdown for a person to read, so they can judge
// whether a good model could answer each one from it. Skipped unless ASGM_DUMP names the output file:
//   ASGM_DUMP=/tmp/payloads.md npx vitest run scripts/asgm-payloads.test.ts
// ASGM_ALL=1 dumps every question, not only the ones marked for it.
import { writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { firstPayload } from '../lib/assistant/loop'
import { fixtureLeague } from '../lib/__tests__/assistantFixture'
import { runTool } from '../lib/assistant/tools'
import { QUESTIONS } from './asgm-questions'

/** Follow-up calls a model would plausibly make where the pack leaves a gap, run here so the dump shows their output too. */
const FOLLOW_UPS: Record<string, { tool: string; args: Record<string, unknown> }[]> = {
  flex: [{ tool: 'lineup', args: {} }],
  'bench-rb2': [{ tool: 'start_sit', args: { players: ['Chuba Hubbard', 'Kyle Monangai'] } }],
  'get-chase': [{ tool: 'evaluate_trade', args: { give: ['Cam Skattebo', 'Jameson Williams'], get: ["Ja'Marr Chase"] } }],
}

describe.skipIf(!process.env.ASGM_DUMP)('payload dump', () => {
  it('writes what the model would receive', async () => {
    const lg = fixtureLeague()
    const parts: string[] = []
    const qs = QUESTIONS.filter((q) => process.env.ASGM_ALL || q.dump)
    const first = await firstPayload({ history: [], text: qs[0].q, context: qs[0].context, league: lg, provider: 'house' })
    parts.push('# Assistant GM: what the model receives', '')
    parts.push(`Fixture: ${lg.data.league.name} (anonymised), ${lg.analysis.teams.length} teams, NFL week ${lg.data.state.week} of ${lg.data.league.season}, asking as ${lg.analysis.teamById[lg.myRosterId!].name}.`)
    parts.push(`Every question is one model call with this system prompt, the ${first.tools.length} tools below, and one user message (the context pack plus the question). If that is not enough the model can call tools: at most 4 model round trips a question, the last without tools.`, '')
    parts.push('## System prompt', '', '```text', first.system, '```', '')
    parts.push('## Tools (name: description; parameters)', '')
    for (const t of first.tools) parts.push(`- **${t.name}**: ${t.description} \`${JSON.stringify(Object.keys(t.params.properties ?? {}))}\``)
    const toolChars = JSON.stringify(first.tools).length
    parts.push('', `Tool definitions: ${toolChars.toLocaleString('en-US')} characters of JSON (about ${Math.round(toolChars / 4)} tokens).`, '')
    for (const q of qs) {
      const p = await firstPayload({ history: [], text: q.q, context: q.context, league: lg, provider: 'house' })
      const user = p.messages[p.messages.length - 1].content as string
      parts.push(`## ${q.id}: "${q.q}"`, '')
      if (q.context) parts.push(`On screen: ${q.context.label}${q.context.focus ? ` (focus: ${q.context.focus.label})` : ''}`)
      parts.push(`Read as: ${p.reading.intents.join(', ')}; players: ${p.reading.players.map((id) => lg.data.players[id]?.name).join(', ') || 'none'}. Pre-ran: ${p.plan.map((x) => `${x.tool}(${x.deal ? 'deal on screen' : JSON.stringify(x.args)})`).join(', ') || 'nothing'}.`)
      parts.push(`A good answer: ${q.expect}`)
      const missing = (q.needs ?? []).filter((re) => !re.test(p.messages[p.messages.length - 1].content as string))
      parts.push(q.needs?.length ? `Answerable from this one message: ${missing.length ? `NO, missing ${missing.join(', ')}` : `yes (holds ${q.needs.length} key facts: ${q.needs.map((r) => r.source.slice(0, 40)).join(' · ')})`}` : '', '')
      parts.push(`User message (${user.length.toLocaleString('en-US')} chars, about ${Math.round((user.length + JSON.stringify(p.tools).length + p.system.length) / 4)} tokens with system and tools):`, '', '```text', user, '```', '')
      for (const f of FOLLOW_UPS[q.id] ?? []) {
        const out = await runTool(f.tool, f.args, lg)
        parts.push(`Likely follow-up tool call \`${f.tool}(${JSON.stringify(f.args)})\` returns:`, '', '```text', out.text, '```', '')
      }
      expect(p.messages.length).toBe(1)
    }
    writeFileSync(process.env.ASGM_DUMP!, parts.join('\n'))
  }, 120_000)
})
