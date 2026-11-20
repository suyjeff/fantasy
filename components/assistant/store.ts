// Assistant GM's memory in this browser: one conversation per league, and which model to ask. Bounded, so a long
// season of questions never crowds the league cache out of localStorage (lib/storage keeps that within its quota).
import type { AsgmMessage } from '../../lib/assistant'
import { writeStored } from '../../lib/storage'

/** Messages kept per league, and the characters they may take in all. Older ones go first. */
export const MAX_MESSAGES = 40
export const MAX_CHARS = 120_000

const chatKey = (league: string) => `ff:asgm:chat:${league}`
const USE_KEY = 'ff:asgm:use'

/** A message fit to keep: finished (no step still running), and with nothing that only made sense mid-answer. */
const settled = (m: AsgmMessage): AsgmMessage =>
  m.role === 'gm' ? { ...m, steps: m.steps.map((s) => (s.status === 'running' ? { ...s, status: 'error' as const, detail: s.detail ?? 'stopped' } : s)) } : m

/** The newest messages that fit both bounds, always starting on a question (never an answer cut from its own). */
export const bound = (msgs: AsgmMessage[], max = MAX_MESSAGES, chars = MAX_CHARS): AsgmMessage[] => {
  let out = msgs.slice(-max)
  let size = JSON.stringify(out).length
  while (out.length && size > chars) {
    size -= JSON.stringify(out[0]).length + 1
    out = out.slice(1)
  }
  while (out.length && out[0].role !== 'user') out = out.slice(1)
  return out
}

const isMessage = (x: unknown): x is AsgmMessage => {
  const m = x as AsgmMessage
  return !!m && typeof m === 'object' && typeof m.id === 'string' && (m.role === 'user' ? typeof m.text === 'string' : m.role === 'gm' && Array.isArray(m.steps) && Array.isArray(m.cards) && Array.isArray(m.actions))
}

export const loadChat = (league: string): AsgmMessage[] => {
  try {
    const raw = window.localStorage.getItem(chatKey(league))
    const xs = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(xs) ? xs.filter(isMessage).map(settled) : []
  } catch {
    return []
  }
}

export const saveChat = (league: string, msgs: AsgmMessage[]) => {
  try {
    if (!msgs.length) return window.localStorage.removeItem(chatKey(league))
    writeStored(chatKey(league), JSON.stringify(bound(msgs.map(settled))))
  } catch {
    // Storage blocked: the conversation lasts this visit.
  }
}

/** House (free) or the key saved in this browser. */
export type AsgmUse = 'house' | 'key'
export const loadUse = (): AsgmUse => {
  try {
    return window.localStorage.getItem(USE_KEY) === 'key' ? 'key' : 'house'
  } catch {
    return 'house'
  }
}
export const saveUse = (u: AsgmUse) => {
  try {
    window.localStorage.setItem(USE_KEY, u)
  } catch {
    // Storage blocked: the choice lasts this visit.
  }
}

/** "5 PM", "12:30 AM": when the free questions come back, in this browser's time. */
export const resetTime = (at: number) => {
  const d = new Date(at)
  return d.toLocaleTimeString([], { hour: 'numeric', minute: d.getMinutes() ? '2-digit' : undefined }).replace(/\s?([AP])\.?M\.?/i, (_, x) => ` ${x.toUpperCase()}M`)
}

/** The next 00:00 UTC, when the house's free questions come back. */
export const nextUtcMidnight = (now = Date.now()) => {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
}

/** An id for a message: unique in this browser. */
export const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
