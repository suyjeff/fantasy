// Assistant GM: the one entry point the UI imports. The model explains; the app's engines decide. Tools run here in
// the browser on the league already loaded; the house worker only relays model calls (workers/grades/src/assistant.ts).
import { sharedUrl } from '../sharedGrades'
import { clientId, keys } from './keys'
import { buildAsgmLeague, type AsgmLeague, type AsgmLeagueInput } from './league'
import { runModelTurn } from './loop'
import { runMock } from './mock'
import { listModels, testKey } from './providers'
import { suggestions } from './suggest'
import type { AsgmContext, AsgmEvent, AsgmHouseStatus, AsgmMessage, AsgmProvider, StoredKey } from './types'

export type { AsgmLeague, AsgmLeagueInput }
export type * from './types'
export { buildAsgmLeague, keys, listModels, testKey, suggestions }
export { KEY_PROVIDERS } from './keys'
export { PROVIDER_LABEL, PROVIDERS } from './providers'

/** True when the page was opened with `?asgm=mock`: every turn runs on the mock provider. */
export const mockForced = () => {
  try {
    return typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('asgm') === 'mock'
  } catch {
    return false
  }
}

export type RunTurnArgs = {
  history: AsgmMessage[]
  text: string
  context?: AsgmContext
  league: AsgmLeague
  provider: AsgmProvider
  /** The BYOK key to use; read from this browser's storage when left out. */
  key?: StoredKey | null
}

/**
 * One question, answered. Events arrive in order: steps (tool calls, running then done), cards and actions as tools
 * produce them, then the answer as text deltas, then `done`, or `error` at any point. Never throws.
 */
export const runTurn = async (args: RunTurnArgs, onEvent: (e: AsgmEvent) => void, signal: AbortSignal): Promise<void> => {
  try {
    if (args.provider === 'mock' || mockForced()) return await runMock(args.league, args.text, onEvent, signal)
    await runModelTurn(args, onEvent, signal)
  } catch (e) {
    if (signal.aborted) onEvent({ type: 'error', code: 'aborted', message: 'Stopped.' })
    else onEvent({ type: 'error', code: 'provider', message: `Something broke on our side: ${(e as Error)?.message ?? e}. Try again.` })
  }
}

/** The house worker's allowance for this browser today, or null when there is no house worker or it can't be reached. */
export const houseStatus = async (): Promise<AsgmHouseStatus | null> => {
  const base = sharedUrl()
  if (!base) return null
  try {
    const res = await fetch(`${base}/assistant/status?client=${encodeURIComponent(clientId())}`)
    if (!res.ok) return null
    const j = (await res.json()) as Partial<AsgmHouseStatus>
    if (typeof j.remaining !== 'number' || typeof j.limit !== 'number') return null
    return { remaining: j.remaining, limit: j.limit, resetsAt: Number(j.resetsAt) || 0 }
  } catch {
    return null
  }
}
