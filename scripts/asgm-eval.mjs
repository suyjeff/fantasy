#!/usr/bin/env node
// Runs the Assistant GM question battery (scripts/asgm-questions.ts) against a live model and writes a Markdown report:
// each question, the tools it used, the answer, timing, and flags (errors, numbers that appear nowhere in what the
// model was sent, answers that run long). The tools run on the fixture league, exactly as they do in the browser.
//
//   ASGM_PROVIDER=groq ASGM_KEY=gsk_... node scripts/asgm-eval.mjs
//   ASGM_PROVIDER=openai ASGM_KEY=sk-... ASGM_MODEL=gpt-4.1-mini node scripts/asgm-eval.mjs
//   ASGM_PROVIDER=anthropic ASGM_KEY=sk-ant-... ASGM_MODEL=<model id> node scripts/asgm-eval.mjs
//   ASGM_PROVIDER=house ASGM_HOUSE_URL=https://ff-grades.<you>.workers.dev node scripts/asgm-eval.mjs
//
// Optional: ASGM_MODEL (default: the provider's default in lib/assistant/providers.ts; Anthropic: the newest on the
// account), ASGM_ONLY=start,faab-34 (question ids), ASGM_OUT=report.md (default asgm-eval.md), ASGM_DELAY_MS between
// questions (default 3000; use 20000 on Groq's free tier, which allows 8,000 tokens a minute). The house provider
// counts against the worker's daily allowance like any browser.
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const env = { ...process.env, ASGM_EVAL: '1', ASGM_OUT: resolve(process.env.ASGM_OUT ?? 'asgm-eval.md') }
if (!env.ASGM_PROVIDER) env.ASGM_PROVIDER = 'groq'
if (env.ASGM_PROVIDER !== 'house' && !env.ASGM_KEY) {
  console.error('Set ASGM_KEY to a key for ASGM_PROVIDER (groq, openai, anthropic, gemini, openrouter), or use ASGM_PROVIDER=house with ASGM_HOUSE_URL.')
  process.exit(1)
}
const r = spawnSync('npx', ['vitest', 'run', 'scripts/asgm-eval.test.ts', '--reporter=dot'], { cwd: root, env, stdio: 'inherit' })
process.exit(r.status ?? 1)
