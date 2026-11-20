// BYOK: the user's own provider key, kept only in this browser. It is sent to the provider straight from the
// browser and never to our worker.
import type { AsgmKeyProvider, StoredKey } from './types'

const KEY = 'ff:asgm:key'
const CLIENT = 'ff:asgm:client'

export const KEY_PROVIDERS: AsgmKeyProvider[] = ['groq', 'openai', 'anthropic', 'gemini', 'openrouter']

const store = (): Storage | null => {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}

const valid = (x: unknown): x is StoredKey =>
  !!x && typeof x === 'object' && KEY_PROVIDERS.includes((x as StoredKey).provider) && typeof (x as StoredKey).key === 'string' && (x as StoredKey).key.length > 0

export const keys = {
  load(): StoredKey | null {
    try {
      const raw = store()?.getItem(KEY)
      const k = raw ? JSON.parse(raw) : null
      return valid(k) ? { provider: k.provider, key: k.key, ...(typeof k.model === 'string' && k.model ? { model: k.model } : {}) } : null
    } catch {
      return null
    }
  },
  save(k: StoredKey | null) {
    const s = store()
    if (!s) return
    try {
      if (k && valid(k)) s.setItem(KEY, JSON.stringify({ provider: k.provider, key: k.key.trim(), model: k.model }))
      else s.removeItem(KEY)
    } catch {
      // Storage blocked: the key lives for this visit only (the caller still holds it).
    }
  },
}

/** This page's id once made: stable for the page's lifetime even when storage is blocked and it cannot be kept. */
let pageClient: string | null = null

/** A random id for this browser, for the house worker's per-browser allowance. No account, nothing personal. */
export const clientId = (): string => {
  if (pageClient) return pageClient
  const s = store()
  try {
    const have = s?.getItem(CLIENT)
    if (have && /^[a-z0-9]{16,40}$/.test(have)) return (pageClient = have)
  } catch {
    // fall through
  }
  const bytes = new Uint8Array(12)
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  pageClient = Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 24).padEnd(16, '0')
  try {
    s?.setItem(CLIENT, pageClient)
  } catch {
    // Storage blocked: the id lives for this page only.
  }
  return pageClient
}

/** For tests: forget the page's id, as a new page load would. */
export const resetClientId = () => {
  pageClient = null
}
