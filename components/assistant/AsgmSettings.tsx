import React, { useEffect, useId, useRef, useState } from 'react'
import { KEY_PROVIDERS, PROVIDER_LABEL, PROVIDERS, listModels, testKey, type StoredKey } from '../../lib/assistant'
import { Dropdown, cx } from '../ui'
import type { AsgmState } from './AsgmProvider'
import { useAsgm } from './AsgmProvider'
import { nextUtcMidnight, resetTime } from './store'

// Who answers: the free house model (a few questions a day, shared), or the reader's own key with a provider of their
// choice. The key is kept in this browser only and goes from here straight to the provider, never to our server.

type KeyProvider = StoredKey['provider']
/** What a key looks like, as the field's placeholder. */
const HINT: Record<KeyProvider, string> = { groq: 'gsk_…', openai: 'sk-…', anthropic: 'sk-ant-…', gemini: 'AIza…', openrouter: 'sk-or-…' }
export const KEY_CHOICES = KEY_PROVIDERS.map((id) => ({ id, label: PROVIDER_LABEL[id], hint: HINT[id], where: PROVIDERS[id].keyUrl }))
const providerLabel = (p: string) => (PROVIDER_LABEL as Record<string, string>)[p] ?? p

/** One line on who is answering and what is left, for the GM's header. */
export const providerLine = (s: Pick<AsgmState, 'provider' | 'house' | 'storedKey' | 'mock'>) => {
  if (s.mock) return 'mock answers · offline'
  if (s.provider !== 'house') return `${providerLabel(s.provider).toLowerCase()} · your key${s.storedKey?.model ? ` · ${s.storedKey.model}` : ''}`
  if (!s.house) return 'free model'
  return `free model · ${s.house.remaining} of ${s.house.limit} left today`
}

const Radio = ({ checked, onSelect, title, sub, children, id }: { checked: boolean; onSelect: () => void; title: string; sub: React.ReactNode; children?: React.ReactNode; id: string }) => (
  <div className={cx('border', checked ? 'border-ff-accent/50 bg-ff-accent/[0.04]' : 'border-ff-line bg-ff-panel')}>
    <label htmlFor={id} className="flex min-h-11 cursor-pointer items-start gap-2.5 px-3 py-2.5">
      <input id={id} type="radio" name="asgm-use" checked={checked} onChange={onSelect} className="peer sr-only" />
      <span aria-hidden className={cx('mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center border peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ff-accent', checked ? 'border-ff-accent' : 'border-ff-line2')}>
        {checked && <span className="h-1.5 w-1.5 bg-ff-accent" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium text-ff-text">{title}</span>
        <span className="mt-0.5 block text-[12px] leading-snug text-ff-text2">{sub}</span>
      </span>
    </label>
    {checked && children && <div className="border-t border-ff-line/70 px-3 pb-3 pt-2.5">{children}</div>}
  </div>
)

const KeyForm = () => {
  const s = useAsgm()
  const saved = s.storedKey
  const [provider, setProvider] = useState<KeyProvider>(saved?.provider ?? 'groq')
  const [key, setKey] = useState(saved?.key ?? '')
  const [show, setShow] = useState(false)
  const [status, setStatus] = useState<{ kind: 'idle' | 'busy' | 'ok' | 'bad'; text: string }>({ kind: 'idle', text: '' })
  const [models, setModels] = useState<string[] | null>(null)
  // The key just removed, for Undo: it may be the only copy the reader has.
  const [removed, setRemoved] = useState<StoredKey | null>(null)
  const [missing, setMissing] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const keyId = useId()
  const statusId = useId()
  const meta = KEY_CHOICES.find((p) => p.id === provider)!
  const dirty = !saved || saved.provider !== provider || saved.key !== key.trim()

  // The saved key's models, once, to pick from.
  useEffect(() => {
    if (!saved) return setModels(null)
    let live = true
    listModels(saved).then(
      (xs) => live && setModels(xs),
      () => live && setModels([]),
    )
    return () => {
      live = false
    }
  }, [saved?.provider, saved?.key]) // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    const k: StoredKey = { provider, key: key.trim(), ...(saved?.provider === provider && saved.model ? { model: saved.model } : {}) }
    // Checked on press, not by a dead button: say what is missing and put the cursor there.
    if (!k.key) {
      setMissing(true)
      setStatus({ kind: 'bad', text: `Paste your ${meta.label} key first.` })
      return input.current?.focus()
    }
    setMissing(false)
    setRemoved(null)
    s.setStoredKey(k)
    setStatus({ kind: 'busy', text: `Checking with ${meta.label}…` })
    const r = await testKey(k).catch(() => ({ ok: false, message: `Couldn't reach ${meta.label}.` }))
    setStatus({ kind: r.ok ? 'ok' : 'bad', text: r.message || (r.ok ? 'Key works.' : 'That key did not work.') })
  }
  const test = async () => {
    if (!saved) return
    setStatus({ kind: 'busy', text: `Checking with ${providerLabel(saved.provider)}…` })
    const r = await testKey(saved).catch(() => ({ ok: false, message: `Couldn't reach ${providerLabel(saved.provider)}.` }))
    setStatus({ kind: r.ok ? 'ok' : 'bad', text: r.message || (r.ok ? 'Key works.' : 'That key did not work.') })
  }
  const remove = () => {
    setRemoved(saved)
    s.setStoredKey(null)
    setKey('')
    setModels(null)
    setStatus({ kind: 'idle', text: 'Key removed from this browser.' })
  }
  const undo = () => {
    if (!removed) return
    s.setStoredKey(removed)
    setProvider(removed.provider)
    setKey(removed.key)
    setRemoved(null)
    setStatus({ kind: 'idle', text: 'Key put back.' })
  }
  const field = 'h-9 w-full border border-ff-line2 bg-ff-panel px-2.5 text-[13px] text-ff-text placeholder:text-ff-muted focus:border-ff-accent/70 focus:outline-none focus:shadow-[0_0_0_3px_rgb(var(--ff-accent)/0.12)] max-md:h-11'
  return (
    <div className="space-y-2.5">
      <div>
        <span className="ff-label mb-1 block">Provider</span>
        <Dropdown
          label="Provider"
          value={provider}
          onChange={(v) => {
            setProvider(v as KeyProvider)
            setStatus({ kind: 'idle', text: '' })
          }}
          options={KEY_CHOICES.map((p) => ({ value: p.id, label: p.label }))}
          className="block"
          buttonClassName="!h-9 w-full max-md:!h-11"
        />
      </div>
      <div>
        <span className="mb-1 flex items-baseline justify-between gap-2">
          <label htmlFor={keyId} className="ff-label">
            API key
          </label>
          <a href={meta.where} target="_blank" rel="noreferrer" className="ff-hit font-mono text-[10.5px] text-ff-accent hover:underline">
            get a {meta.label} key<span className="sr-only"> (opens in a new tab)</span>
            <span aria-hidden> ↗</span>
          </a>
        </span>
        <div className="flex">
          <input
            id={keyId}
            type={show ? 'text' : 'password'}
            value={key}
            ref={input}
            onChange={(e) => {
              setKey(e.target.value)
              if (missing && e.target.value.trim()) setMissing(false)
            }}
            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), save())}
            placeholder={meta.hint}
            autoComplete="off"
            spellCheck={false}
            aria-describedby={statusId}
            aria-invalid={missing || undefined}
            className={cx(field, 'min-w-0 flex-1 font-mono')}
          />
          <button
            type="button"
            onClick={() => setShow(!show)}
            aria-pressed={show}
            aria-label={show ? 'Hide the key' : 'Show the key'}
            className="ff-press h-9 shrink-0 border border-l-0 border-ff-line2 px-2.5 font-mono text-[10.5px] uppercase tracking-[0.06em] text-ff-text2 hover:bg-ff-raised hover:text-ff-text max-md:h-11"
          >
            {show ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {dirty ? (
          <button type="button" onClick={save} className="ff-press h-8 bg-ff-text px-3 text-[12.5px] font-medium text-ff-panel hover:bg-ff-text/85 max-md:h-10">
            Save and test
          </button>
        ) : (
          <button type="button" onClick={test} className="ff-press h-8 border border-ff-line2 bg-ff-panel px-3 text-[12.5px] text-ff-text hover:bg-ff-raised max-md:h-10">
            Test key
          </button>
        )}
        {saved && (
          <button type="button" onClick={remove} className="ff-press h-8 px-2.5 text-[12.5px] text-ff-text2 hover:bg-ff-raised hover:text-ff-neg max-md:h-10">
            Remove key
          </button>
        )}
        {/* Removing acts at once; Undo puts the key back, since nothing else in the app keeps a copy. */}
        {!saved && removed && (
          <button type="button" onClick={undo} className="ff-press h-8 border border-ff-line2 bg-ff-panel px-3 text-[12.5px] font-medium text-ff-text hover:bg-ff-raised max-md:h-10">
            Undo
          </button>
        )}
      </div>
      <p id={statusId} role="status" className={cx('min-h-[16px] font-mono text-[11px]', status.kind === 'ok' ? 'text-ff-pos' : status.kind === 'bad' ? 'text-ff-neg' : 'text-ff-muted')}>
        {status.kind === 'busy' && <span aria-hidden className="ff-pulse mr-1.5 inline-block h-1.5 w-1.5 bg-ff-accent align-middle" />}
        {status.kind === 'ok' && '✓ '}
        {status.text}
      </p>
      {saved && (
        <div>
          <span className="ff-label mb-1 block">Model</span>
          {models == null ? (
            <p className="font-mono text-[11px] text-ff-muted">Loading {providerLabel(saved.provider)}&apos;s models…</p>
          ) : models.length ? (
            <Dropdown
              label="Model"
              value={saved.model ?? ''}
              onChange={(v) => s.setStoredKey({ ...saved, model: v || undefined })}
              options={[{ value: '', label: 'Recommended', sub: 'the GM picks a capable one' }, ...models.map((m) => ({ value: m, label: m }))]}
              className="block"
              buttonClassName="!h-9 w-full font-mono text-[12px] max-md:!h-11"
              menuClassName="max-h-[260px]"
            />
          ) : (
            <p className="text-[12px] leading-snug text-ff-text2">{providerLabel(saved.provider)} didn&apos;t list its models, so the GM uses its recommended one.</p>
          )}
        </div>
      )}
    </div>
  )
}

/** The settings pane, in place of the conversation (or in the page's side column). */
const AsgmSettings = ({ onDone, inline }: { onDone?: () => void; inline?: boolean }) => {
  const s = useAsgm()
  const houseId = useId()
  const keyId = useId()
  const reset = s.house ? resetTime(s.house.resetsAt || nextUtcMidnight()) : null
  const left = s.house ? `${s.house.remaining} of ${s.house.limit} questions left today${reset ? ` · resets ${reset}` : ''}` : 'A few questions a day from this browser, free.'
  return (
    <div className={cx('space-y-3', !inline && 'px-3 py-3')}>
      {!inline && (
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="ff-label">Who answers</h3>
          {onDone && (
            <button type="button" onClick={onDone} className="ff-hit font-mono text-[11px] text-ff-text2 hover:text-ff-text">
              <span aria-hidden>← </span>back<span className="sr-only"> to the conversation</span>
            </button>
          )}
        </div>
      )}
      {s.mock && <p className="border border-ff-warn/35 bg-ff-warn/[0.07] px-3 py-2 text-[12px] text-ff-text2">This page has ?asgm=mock: every answer is canned, whatever is set here.</p>}
      <fieldset className="space-y-2">
        <legend className="sr-only">Who answers</legend>
        <Radio
          id={houseId}
          checked={s.use === 'house'}
          onSelect={() => s.setUse('house')}
          title="Free model"
          sub={
            <>
              {left}
              {s.house?.remaining === 0 && <span className="mt-1 block font-medium text-ff-warn">Out for today. Add your own key to keep going.</span>}
            </>
          }
        />
        <Radio id={keyId} checked={s.use === 'key'} onSelect={() => s.setUse('key')} title="Your own key" sub="Groq, OpenAI, Anthropic, Gemini or OpenRouter. No daily limit but theirs; you pay them for what you use.">
          <KeyForm />
        </Radio>
      </fieldset>
      {s.use === 'key' && !s.storedKey && <p className="text-[12px] text-ff-muted">Until a key is saved, questions go to the free model.</p>}
      <p className="border-t border-ff-line pt-2.5 text-[11.5px] leading-snug text-ff-muted">
        <span>
          Your key stays in this browser and goes straight to the provider. It never touches our server. The GM reads your league from this page; the model only sees the numbers it asks for.
        </span>
      </p>
    </div>
  )
}

export default AsgmSettings
