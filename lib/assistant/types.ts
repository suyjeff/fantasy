/**
 * Assistant GM: the contract between the brain (lib/assistant/*, workers/grades/src/assistant.ts) and the UI
 * (components/assistant/*). The brain owns this file; extend it, but keep these shapes compatible.
 */
import type { Deal } from '../deal'

/** What the user is looking at when they ask. Views publish one; entry points can pass one in. */
export type AsgmFocus =
  | { kind: 'player'; id: string; label: string }
  | { kind: 'team'; rosterId: number; label: string }
  | { kind: 'trade'; deal: Deal; label: string }
  | { kind: 'matchup'; week: number; rosterIds: [number, number]; label: string }
  | { kind: 'lineup'; rosterId: number; week: number; label: string }
  | { kind: 'waivers'; rosterId: number; label: string }

export type AsgmContext = {
  /** Section and sub-tab, e.g. "trades/builder". */
  view: string
  /** Human label for the context chip, e.g. "Trade builder". */
  label: string
  focus?: AsgmFocus
}

/** Opening the assistant from anywhere. `send: true` asks the question at once. */
export type AsgmOpen = { prompt?: string; context?: AsgmContext; send?: boolean }

/** Generative cards the UI renders with the app's own components. */
export type AsgmCard =
  | { kind: 'players'; title: string; rows: { id: string; note?: string; value?: string; tone?: 'good' | 'bad' | 'neutral' }[] }
  | { kind: 'lineup'; title: string; rosterId: number; week: number; changes: { out: string; in: string; slot: string; gain: number }[]; total: { before: number; after: number } }
  | { kind: 'trade'; title: string; deal: Deal; verdict?: string }
  | { kind: 'odds'; title: string; rows: { label: string; before?: number; after: number }[] }
  | { kind: 'waivers'; title: string; rows: { add: string; drop?: string; bid?: number; note?: string }[] }
  | { kind: 'compare'; title: string; ids: string[] }

/** Buttons that hand off to the existing UI. */
export type AsgmAction =
  | { kind: 'openTrade'; deal: Deal; label: string }
  | { kind: 'openPlayer'; id: string; label: string }
  | { kind: 'openTeam'; rosterId: number; label: string }
  | { kind: 'goto'; view: string; label: string }

export type AsgmEvent =
  /** A unit of visible work: a tool call. Label is present-tense, e.g. "Running 2,000 playoff sims". */
  | { type: 'step'; id: string; tool: string; label: string; status: 'running' | 'done' | 'error'; detail?: string }
  | { type: 'card'; id: string; card: AsgmCard }
  | { type: 'action'; id: string; action: AsgmAction }
  /**
   * Answer text, appended in order. `reset: true` means the text streamed so far was a step's preamble before it called
   * tools ("Checking your schedule."), not the answer: drop it, then append `delta` (empty) as usual. Rare: a step's
   * first 160 characters are held back until it is clear the step is answering, so a short preamble never streams.
   */
  | { type: 'text'; delta: string; reset?: true }
  | { type: 'done'; provider: string; model: string; remaining?: number }
  /**
   * quota: this browser's free questions are used up for the day. budget: the free assistant's shared daily budget is.
   * rate: too many requests in a short time (the house worker's per-minute limits, a BYOK provider's 429): wait and retry.
   * offline: unreachable. provider: the model or provider failed. key: a BYOK key is missing, rejected or out of credit.
   */
  | { type: 'error'; code: 'quota' | 'budget' | 'rate' | 'offline' | 'provider' | 'key' | 'aborted'; message: string }

export type AsgmMessage =
  | { role: 'user'; id: string; text: string; context?: AsgmContext; at: number }
  | { role: 'gm'; id: string; text: string; steps: Extract<AsgmEvent, { type: 'step' }>[]; cards: AsgmCard[]; actions: AsgmAction[]; error?: Extract<AsgmEvent, { type: 'error' }>; provider?: string; at: number }

/** Where the model runs. 'house' is our free worker; the rest are the user's own key, called from the browser. */
export type AsgmProvider = 'house' | 'groq' | 'openai' | 'anthropic' | 'gemini' | 'openrouter' | 'mock'

/** Providers that take the user's own key, called straight from the browser. */
export type AsgmKeyProvider = Exclude<AsgmProvider, 'house' | 'mock'>

/** A BYOK key, kept only in this browser's localStorage. `model` is the one picked from the provider's list. */
export type StoredKey = { provider: AsgmKeyProvider; key: string; model?: string }

/** What the house worker says about today's allowance for this browser. */
export type AsgmHouseStatus = { remaining: number; limit: number; resetsAt: number }

export type AsgmErrorCode = Extract<AsgmEvent, { type: 'error' }>['code']
