import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { Prefs } from '../pages/index'
import { resolveMode, themeById } from '../lib/themes'
import type { HorizonMode } from '../lib/useLeagueData'
import { useLeave, useModal } from './Sheet'
import SwipeSheet, { type SwipeSheetHandle } from './SwipeSheet'
import { ModeControl, ThemePreviews, ThemeSelect, onlyMode, type Density } from './ThemePicker'
import { Button, Dropdown, Segmented, cx, useMedia, usePhone } from './ui'

// Settings, as a dialog over whatever page is open: a list of categories down the left (a strip of tabs along the
// top on phones) and the picked one's settings on the right, one row each, name and a line on what it does at the
// left, the control at the right. Everything applies and saves as it is changed.

export const SETTINGS_TABS = [
  { key: 'account', label: 'Account' },
  { key: 'appearance', label: 'Appearance' },
  { key: 'forecast', label: 'Forecast' },
  { key: 'data', label: 'Data' },
] as const
export type SettingsTab = (typeof SETTINGS_TABS)[number]['key']
export const isSettingsTab = (s: string | null | undefined): s is SettingsTab => SETTINGS_TABS.some((t) => t.key === s)

/** The league's sync and the engine's readouts, for the Data pane. */
export type SyncInfo = {
  loading: boolean
  /** What the load is doing right now, while it runs. */
  progress: string
  loadedAt: Date | null
  /** Where the league loads from: Sleeper or ESPN. */
  source: string
  onReload: () => void
  readouts: { label: string; hint: string; value: string }[]
}

export type SettingsProps = {
  tab: SettingsTab
  onTab: (t: SettingsTab) => void
  /** Called once the dialog has finished leaving. */
  onClose: () => void
  prefs: Prefs
  update: (patch: Partial<Prefs>) => void
  leagues: { id: string; name: string }[]
  leagueId: string | null
  /** Newest first; the first is the current season. */
  seasons: string[]
  /** The weeks the current horizon prices, and the fantasy playoff weeks. */
  horizonWeeks: number[]
  playoffWeeks: number[]
  onTour: () => void
  sync: SyncInfo
  /** Bumped each time something asks for Settings to open; one that arrives while it is leaving cancels the close. */
  reopen: number
}

const HORIZON_LONG: Record<HorizonMode, string> = {
  next6: 'The next six regular-season weeks',
  regular: 'Everything left before the fantasy playoffs',
  playoffs: 'Everything left, fantasy playoffs included',
}

/** The width every dropdown and slider takes on wide screens, so their edges make one column down the pane. */
const CONTROL = 'md:w-[220px]'

/** A titled run of rows. */
const Section = ({ title, children }: { title: string; children: ReactNode }) => {
  const id = useId()
  return (
    <section aria-labelledby={id} className="pt-6 first:pt-4">
      <h3 id={id} className="ff-label pb-2 text-ff-text2">
        {title}
      </h3>
      <div className="divide-y divide-ff-line border-t border-ff-line">{children}</div>
    </section>
  )
}

/**
 * One setting: its name and a line on what it does on the left, its control on the right. `stack` puts the control
 * under the name on phones, for one that wants the full width (a long dropdown, a slider).
 */
const Row = ({ label, hint, children, stack, labelId }: { label: ReactNode; hint?: ReactNode; children: ReactNode; stack?: boolean; labelId?: string }) => (
  <div className={cx('flex min-h-[52px] gap-x-6 py-2.5', stack ? 'flex-col gap-y-2 md:flex-row md:items-center' : 'items-center')}>
    <div className="min-w-0 flex-1">
      <div id={labelId} className="text-[13px] font-medium leading-tight text-ff-text">
        {label}
      </div>
      {hint && <p className="mt-1 text-pretty text-[12px] leading-snug text-ff-muted">{hint}</p>}
    </div>
    <div className={cx('flex min-w-0 shrink-0 items-center gap-2', stack ? 'justify-end max-md:w-full max-md:justify-between' : 'justify-end')}>{children}</div>
  </div>
)

/** A figure the engine reports, right-aligned in the control column. */
const Readout = ({ children }: { children: ReactNode }) => <span className="num min-w-[4ch] text-right font-mono text-[13px] text-ff-text">{children}</span>

/** A run of weeks as one unbreakable phrase, so a hint never wraps in the middle of it. */
const span = (weeks: number[]) =>
  weeks.length ? <span className="whitespace-nowrap">{weeks.length === 1 ? `week ${weeks[0]}` : `weeks ${weeks[0]}–${weeks[weeks.length - 1]}`}</span> : null

const clock = (d: Date | null) => (d ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '--:--:--')

/** Everything this page has kept in this browser goes: settings, grades, reads, the board, cached data. */
const startOver = () => {
  try {
    for (const k of Object.keys(window.localStorage)) if (k.startsWith('ff:')) window.localStorage.removeItem(k)
  } catch {
    // Storage blocked: nothing was kept to begin with.
  }
  window.location.reload()
}

/** Start over, asking once more in place before it clears; the safe choice takes focus. */
const StartOver = () => {
  const [confirm, setConfirm] = useState(false)
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (confirm) cancel.current?.focus({ preventScroll: true })
  }, [confirm])
  if (!confirm)
    return (
      <Button className="text-ff-neg hover:text-ff-neg" onClick={() => setConfirm(true)}>
        Start over…
      </Button>
    )
  return (
    <span role="group" aria-label="Start over" className="flex gap-1.5">
      <button ref={cancel} type="button" onClick={() => setConfirm(false)} className="ff-press h-8 border border-ff-line bg-ff-panel px-3 text-[12.5px] text-ff-text2 hover:bg-ff-raised max-md:h-10">
        Cancel
      </button>
      <button type="button" onClick={startOver} className="ff-press h-8 border border-ff-neg/50 bg-ff-neg/10 px-3 text-[12.5px] font-medium text-ff-neg hover:bg-ff-neg/15 max-md:h-10">
        Clear and restart
      </button>
    </span>
  )
}

const AccountPane = ({ prefs, update, leagues, leagueId, seasons, onTour }: SettingsProps) => {
  const espn = prefs.provider === 'espn'
  const phone = usePhone()
  return (
    <>
      <Section title="League">
        <Row label={espn ? 'ESPN league' : 'Sleeper user'} hint={espn ? 'The league and team this page reads.' : 'Whose leagues this page reads.'} stack>
          <span className="min-w-0 truncate font-mono text-[12.5px] text-ff-text2">{espn ? prefs.espnLeagueId : `@${prefs.username}`}</span>
          <Button size="sm" onClick={() => update({ onboarded: false })}>
            {espn ? 'Switch' : 'Switch user'}
          </Button>
        </Row>
        <Row label="League" hint={leagues.length > 1 ? `${leagues.length} leagues this season.` : leagues.length ? 'The only league this season.' : 'Listed once the league loads.'} stack={leagues.length > 1}>
          {leagues.length > 1 ? (
            <Dropdown
              label="League"
              value={leagueId ?? ''}
              onChange={(id) => update({ leagueId: id })}
              options={leagues.map((l) => ({ value: l.id, label: l.name }))}
              className={cx('w-full', CONTROL)}
              menuClassName="md:!left-auto md:right-0 max-w-[min(360px,calc(100vw-32px))] [&_.whitespace-nowrap]:truncate"
              buttonClassName="max-md:!h-10"
            />
          ) : (
            <span className="min-w-0 max-w-[220px] truncate text-[13px] text-ff-text2">{leagues[0]?.name ?? 'Not loaded'}</span>
          )}
        </Row>
        <Row label="Season" hint="An earlier season opens that year's league as it finished.">
          <Segmented<string>
            label="Season"
            value={prefs.season ?? seasons[0]}
            onChange={(v) => update({ season: v === seasons[0] ? null : v, leagueId: null })}
            options={seasons.map((s) => ({ key: s, label: <span className="num">{phone ? `’${s.slice(2)}` : s}</span>, title: s }))}
          />
        </Row>
      </Section>
      <Section title="Help">
        <Row label="Tour" hint="A quick walk through every page.">
          <Button size="sm" onClick={onTour}>
            Replay the tour
          </Button>
        </Row>
      </Section>
    </>
  )
}

const AppearancePane = ({ prefs, update }: SettingsProps) => {
  const theme = themeById(prefs.theme)
  const only = onlyMode(theme)
  const systemDark = useMedia('(prefers-color-scheme: dark)')
  return (
    <Section title="Appearance">
      <Row label="Theme" hint={only ? `${theme.label} comes in ${only} only.` : 'Each comes in light and dark.'} stack>
        <ThemeSelect value={theme.id} onChange={(id) => update({ theme: id })} className={cx('w-full', CONTROL)} />
      </Row>
      <Row label="Mode" hint={only ? `Set by ${theme.label}.` : prefs.scheme === 'system' ? `Following the device: ${systemDark ? 'dark' : 'light'} now.` : `Always ${prefs.scheme}.`}>
        <ModeControl value={prefs.scheme} onChange={(s) => update({ scheme: s })} only={only} />
      </Row>
      <Row label="Preview" hint={only ? `The app in ${theme.label}.` : 'The app in both modes; the one on screen is marked.'} stack>
        <ThemePreviews theme={theme} mode={resolveMode(theme, prefs.scheme, systemDark)} className="w-full md:w-[340px]" />
      </Row>
      <Row label="Density" hint="Comfortable sets larger type and taller rows.">
        <Segmented<Density>
          label="Density"
          value={prefs.density}
          onChange={(d) => update({ density: d })}
          options={[
            { key: 'compact', label: 'Compact' },
            { key: 'comfortable', label: 'Comfortable' },
          ]}
        />
      </Row>
    </Section>
  )
}

const ForecastPane = ({ prefs, update, horizonWeeks, playoffWeeks }: SettingsProps) => {
  const priced = span(horizonWeeks)
  const playoffs = prefs.horizon === 'playoffs'
  const weightId = useId()
  // Dragging only moves this local value; the pref (which reloads the league) is written on release.
  const [weight, setWeight] = useState(prefs.playoffWeight)
  useEffect(() => {
    setWeight(prefs.playoffWeight)
  }, [prefs.playoffWeight])
  // The native `change` event, which fires once on release (wherever the pointer ends up) and on each keyboard step;
  // React's onChange is the per-step `input` event. Read through a ref, so the listener sees the latest props.
  const range = useRef<HTMLInputElement>(null)
  const commit = useRef((w: number) => {})
  commit.current = (w) => {
    if (w !== prefs.playoffWeight) update({ playoffWeight: w })
  }
  useEffect(() => {
    const el = range.current
    if (!el) return
    const onChange = () => commit.current(Number(el.value))
    el.addEventListener('change', onChange)
    return () => el.removeEventListener('change', onChange)
  }, [playoffWeeks.length > 0])
  return (
    <Section title="Pricing">
      <Row label="Horizon" hint={priced ? <>Trades and waivers are valued over {priced}.</> : 'The weeks trades and waivers are valued over.'} stack>
        <Dropdown
          label="Pricing horizon"
          value={prefs.horizon}
          onChange={(h) => update({ horizon: h as HorizonMode })}
          className={cx('w-full', CONTROL)}
          buttonClassName="max-md:!h-10"
          menuClassName="md:!left-auto md:right-0"
          options={[
            { value: 'next6', label: '6 weeks', sub: HORIZON_LONG.next6 },
            { value: 'regular', label: 'Season', sub: HORIZON_LONG.regular },
            { value: 'playoffs', label: 'Season + playoffs', sub: HORIZON_LONG.playoffs },
          ]}
        />
      </Row>
      {playoffWeeks.length > 0 && (
        <Row
          label="Playoff weight"
          labelId={weightId}
          hint={playoffs ? <>How much each playoff week ({span(playoffWeeks)}) counts. A regular week is 1×.</> : 'Used when the horizon includes the playoffs.'}
          stack
        >
          <span className={cx('flex w-full items-center gap-3', CONTROL, !playoffs && 'opacity-50')}>
            <input
              ref={range}
              type="range"
              min={0}
              max={3}
              step={0.5}
              value={weight}
              disabled={!playoffs}
              aria-labelledby={weightId}
              aria-valuetext={`${weight} times a regular week`}
              onChange={(e) => setWeight(Number(e.target.value))}
              className="ff-range min-w-0 flex-1 disabled:cursor-default max-md:h-10"
              style={{ ['--fill' as string]: `${(weight / 3) * 100}%` }}
            />
            <span className="num w-8 shrink-0 text-right font-mono text-[12.5px] text-ff-text">{weight}×</span>
          </span>
        </Row>
      )}
    </Section>
  )
}

const DataPane = ({ sync }: SettingsProps) => (
  <>
    <Section title="Sync">
      <Row
        label="Last synced"
        hint={
          <span aria-live="polite" className="flex min-w-0 items-baseline gap-1.5">
            <span aria-hidden className={cx('h-1.5 w-1.5 shrink-0 -translate-y-px', sync.loading ? 'ff-pulse bg-ff-warn' : sync.loadedAt ? 'bg-ff-pos' : 'bg-ff-line2')} />
            <span className="min-w-0">
              {sync.loading ? (
                sync.progress || 'Loading…'
              ) : (
                <>
                  From {sync.source}.<span className="max-md:hidden"> R reloads from any page.</span>
                </>
              )}
            </span>
          </span>
        }
      >
        <span className="num font-mono text-[12.5px] text-ff-text2">{clock(sync.loadedAt)}</span>
        <Button size="sm" onClick={sync.onReload} disabled={sync.loading} aria-keyshortcuts="R" className="w-[72px]">
          {sync.loading ? 'Syncing' : 'Reload'}
        </Button>
      </Row>
    </Section>
    <Section title="Engine">
      {sync.readouts.map((r) => (
        <Row key={r.label} label={r.label} hint={r.hint}>
          <Readout>{r.value}</Readout>
        </Row>
      ))}
    </Section>
    <Section title="This browser">
      <Row label="Start over" hint="Forget your user, settings, grades and reads here.">
        <StartOver />
      </Row>
    </Section>
  </>
)

const PANES: Record<SettingsTab, (p: SettingsProps) => ReactNode> = { account: AccountPane, appearance: AppearancePane, forecast: ForecastPane, data: DataPane }

/** The categories: a column on wide screens, a strip along the top on phones. Arrows move between them and pick. */
const TabList = ({ tab, onTab, vertical, idBase }: { tab: SettingsTab; onTab: (t: SettingsTab) => void; vertical: boolean; idBase: string }) => {
  const list = useRef<HTMLDivElement>(null)
  const onKey = (e: React.KeyboardEvent) => {
    const keys = vertical ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight']
    const i = SETTINGS_TABS.findIndex((t) => t.key === tab)
    const n = SETTINGS_TABS.length
    const to = e.key === keys[0] ? (i - 1 + n) % n : e.key === keys[1] ? (i + 1) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1
    if (to < 0) return
    e.preventDefault()
    onTab(SETTINGS_TABS[to].key)
    list.current?.querySelectorAll<HTMLElement>('[role="tab"]')[to]?.focus()
  }
  return (
    <div
      ref={list}
      role="tablist"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      aria-label="Settings"
      onKeyDown={onKey}
      className={vertical ? 'flex flex-col gap-px' : 'no-scrollbar flex overflow-x-auto px-1 shadow-[inset_0_-1px_0_rgb(var(--ff-line))]'}
    >
      {SETTINGS_TABS.map((t) => {
        const on = t.key === tab
        return (
          <button
            key={t.key}
            id={`${idBase}-tab-${t.key}`}
            type="button"
            role="tab"
            aria-selected={on}
            aria-controls={`${idBase}-panel`}
            tabIndex={on ? 0 : -1}
            data-settings-tab={t.key}
            onClick={() => onTab(t.key)}
            className={cx(
              'relative shrink-0 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ff-accent/40',
              vertical ? 'flex h-8 items-center px-2.5 text-[13px]' : 'h-11 px-3 text-[13px]',
              on ? (vertical ? 'bg-ff-raised font-medium text-ff-text' : 'text-ff-text') : 'text-ff-text2 hover:bg-ff-raised/60 hover:text-ff-text',
            )}
          >
            {t.label}
            {on && <span aria-hidden className={cx('absolute bg-ff-text', vertical ? 'inset-y-0 left-0 w-[2px]' : 'inset-x-3 bottom-0 h-[2px]')} />}
          </button>
        )
      })}
    </div>
  )
}

/**
 * The settings dialog. Wide screens: a centred panel that fades and settles in, the page dimmed behind. Phones: a
 * sheet the height of the screen that swipes down to close. Focus moves in and stays in, Escape and the backdrop
 * close it, the page behind holds still, and focus goes back to what opened it.
 */
const Settings = (props: SettingsProps) => {
  const { tab, onTab, onClose, reopen } = props
  const phone = usePhone()
  const idBase = useId()
  const panel = useRef<HTMLDivElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const swipe = useRef<SwipeSheetHandle>(null)

  // Wide screens: a transition from the hidden state the first paint commits, so closing mid-entrance reverses from
  // wherever it is. Leaving is a little quicker than arriving.
  const { close, stay } = useLeave(root, onClose, 150, phone, swipe)
  // Asked to open again while it is leaving (the command palette, say): stay, and show that.
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    stay()
  }, [reopen]) // eslint-disable-line react-hooks/exhaustive-deps
  const closeRef = useRef(close)
  closeRef.current = close
  useModal(panel, () => closeRef.current())
  // R reloads from here too (Shell's key stands down while a dialog is open), so the Data pane's hint holds.
  const reloadRef = useRef(props.sync)
  reloadRef.current = props.sync
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== 'r' && e.key !== 'R') || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return
      const t = e.target as HTMLElement | null
      if (t?.closest?.('input, textarea, select, [contenteditable="true"]')) return
      // Not while something above it (the command palette) has focus.
      if (t && t !== document.body && !panel.current?.contains(t)) return
      if (reloadRef.current.loading) return
      e.preventDefault()
      reloadRef.current.onReload()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  // Then onto the picked category, so the arrows work from the first key press.
  useEffect(() => {
    panel.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true })
  }, [phone])
  // Each category opens at its top.
  useEffect(() => {
    body.current?.scrollTo({ top: 0 })
  }, [tab])

  const titleId = `${idBase}-title`
  const dialog = { role: 'dialog', 'aria-modal': true, 'aria-labelledby': titleId, tabIndex: -1 } as const
  const Pane = PANES[tab]
  const content = (
    <div ref={body} id={`${idBase}-panel`} role="tabpanel" aria-labelledby={`${idBase}-tab-${tab}`} className={cx('ff-scroll min-h-0 flex-1 overflow-y-auto px-4 pb-8 md:px-6', phone ? 'overscroll-auto' : 'overscroll-contain [scrollbar-gutter:stable]')}>
      <Pane {...props} />
    </div>
  )
  const closeButton = (
    <button type="button" onClick={() => closeRef.current()} aria-label={phone ? 'Close settings' : 'Close (Esc)'} className="-mr-2 h-8 px-2 font-mono text-[11px] text-ff-muted hover:bg-ff-raised hover:text-ff-text max-md:h-11 max-md:px-3">
      {phone ? 'DONE' : 'ESC'}
    </button>
  )

  if (phone)
    return (
      <SwipeSheet
        ref={swipe}
        side="bottom"
        className="z-50"
        onDismissed={onClose}
        backdropClassName="bg-black/45"
        panelRef={panel}
        panelProps={dialog}
        panelClassName="flex h-[calc(100dvh-env(safe-area-inset-top)-12px)] w-full flex-col border-t border-ff-line bg-ff-panel pb-[env(safe-area-inset-bottom)] shadow-[0_-8px_40px_rgba(0,0,0,0.35)] outline-none"
      >
        <div className="mx-auto mt-2 h-1 w-10 shrink-0 bg-ff-line2" aria-hidden />
        <header className="flex h-11 shrink-0 items-center justify-between gap-3 px-4">
          <h2 id={titleId} className="text-[16px] font-medium tracking-[-0.01em] text-ff-text">
            Settings
          </h2>
          {closeButton}
        </header>
        <TabList tab={tab} onTab={onTab} vertical={false} idBase={idBase} />
        {content}
      </SwipeSheet>
    )

  return (
    <div ref={root} className="ff-dialog-root fixed inset-0 z-50 flex items-center justify-center p-6" role="presentation">
      <div aria-hidden className="ff-scrim absolute inset-0 bg-black/45" onClick={() => closeRef.current()} />
      <div
        ref={panel}
        {...dialog}
        className="ff-dialog relative flex h-[min(620px,100%)] w-full max-w-[880px] flex-col border border-ff-line2 bg-ff-panel shadow-[0_24px_64px_-12px_rgba(0,0,0,0.4)] outline-none"
      >
        <header className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-ff-line pl-4 pr-3">
          <span className="flex min-w-0 items-baseline gap-2.5">
            <h2 id={titleId} className="text-[15px] font-medium tracking-[-0.01em] text-ff-text">
              Settings
            </h2>
            <span className="truncate font-mono text-[10.5px] text-ff-muted">Saved as you go</span>
          </span>
          {closeButton}
        </header>
        <div className="flex min-h-0 flex-1">
          <div className="flex w-[180px] shrink-0 flex-col justify-between border-r border-ff-line p-2">
            <TabList tab={tab} onTab={onTab} vertical idBase={idBase} />
            <p className="px-2.5 pb-1 font-mono text-[10.5px] text-ff-muted">
              <kbd className="mr-1.5 inline-flex h-[18px] min-w-[18px] items-center justify-center border border-ff-line px-1 text-[10px]">,</kbd>
              opens settings from any page
            </p>
          </div>
          {content}
        </div>
      </div>
    </div>
  )
}

export default Settings
