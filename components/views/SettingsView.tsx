import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { Prefs } from '../../pages/index'
import { themeById, type Scheme } from '../../lib/themes'
import type { HorizonMode } from '../../lib/useLeagueData'
import ThemePicker, { type Density } from '../ThemePicker'
import { Button, Dropdown, PageHeader, Segmented, cx, usePhone } from '../ui'

const HORIZON_LONG: Record<HorizonMode, string> = {
  next6: 'The next six regular-season weeks',
  regular: 'Everything left before the fantasy playoffs',
  playoffs: 'Everything left, fantasy playoffs included',
}

/** A titled group of settings: one hairline box, one row per setting. */
const Group = ({ title, children }: { title: string; children: ReactNode }) => {
  const id = useId()
  return (
    <section aria-labelledby={id} className="border border-ff-line bg-ff-panel">
      <h2 id={id} className="ff-label flex h-9 items-center border-b border-ff-line px-3 text-ff-text2 sm:px-4">
        {title}
      </h2>
      <div className="divide-y divide-ff-line">{children}</div>
    </section>
  )
}

/**
 * One setting: its name (and a line on what it does, when the name is not enough) beside its control on wide screens,
 * above it on phones. `wide` puts the control under the name at every width, for one that needs the room (the themes).
 */
const Row = ({ label, hint, children, wide }: { label: ReactNode; hint?: ReactNode; children: ReactNode; wide?: boolean }) => (
  <div className={cx('px-3 py-3 sm:px-4', wide ? 'space-y-3' : 'space-y-2 sm:grid sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)] sm:items-center sm:gap-6 sm:space-y-0 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]')}>
    <div className="min-w-0">
      <div className="text-[13px] font-medium text-ff-text">{label}</div>
      {hint && <p className="mt-0.5 text-[11.5px] leading-snug text-ff-muted">{hint}</p>}
    </div>
    <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>
  </div>
)

/** A run of weeks as one unbreakable phrase, so a hint never wraps in the middle of it. */
const span = (weeks: number[]) =>
  weeks.length ? <span className="whitespace-nowrap">{weeks.length === 1 ? `week ${weeks[0]}` : `weeks ${weeks[0]}–${weeks[weeks.length - 1]}`}</span> : null

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
    <span role="group" aria-label="Start over" className="flex flex-wrap gap-1.5">
      <button type="button" onClick={startOver} className="h-8 border border-ff-neg/50 bg-ff-neg/10 px-3 text-[12.5px] font-medium text-ff-neg hover:bg-ff-neg/15 max-md:h-10">
        Clear and restart
      </button>
      <button ref={cancel} type="button" onClick={() => setConfirm(false)} className="h-8 border border-ff-line bg-ff-panel px-3 text-[12.5px] text-ff-text2 hover:bg-ff-raised max-md:h-10">
        Cancel
      </button>
    </span>
  )
}

/**
 * Every preference on one page, in groups. Changes apply and save as they are made. Works before a league has
 * loaded (or when it failed to), so a wrong season or user can always be put right from here.
 */
const SettingsView = ({
  prefs,
  update,
  leagues,
  leagueId,
  seasons,
  horizonWeeks,
  playoffWeeks,
  onTour,
}: {
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
}) => {
  const phone = usePhone()
  const theme = themeById(prefs.theme)
  const only = theme.light && theme.dark ? null : theme.light ? 'light' : 'dark'
  const espn = prefs.provider === 'espn'
  const priced = span(horizonWeeks)
  const playoffs = prefs.horizon === 'playoffs'
  const weightId = useId()
  // Dragging only moves this local value; the pref (which reloads the league) is written on release.
  const [weight, setWeight] = useState(prefs.playoffWeight)
  useEffect(() => setWeight(prefs.playoffWeight), [prefs.playoffWeight])
  const commitWeight = (e: { currentTarget: HTMLInputElement }) => {
    const w = Number(e.currentTarget.value)
    if (w !== prefs.playoffWeight) update({ playoffWeight: w })
  }

  return (
    <>
      <PageHeader title="Settings" meta="Saved as you go" mobileTitle />
      <div className="ff-page-body ff-stack max-w-[860px]">
        <Group title="Account">
          <Row label={espn ? 'ESPN league' : 'Sleeper user'}>
            <span className="min-w-0 truncate font-mono text-[12.5px] text-ff-text">{espn ? prefs.espnLeagueId : `@${prefs.username}`}</span>
            <Button size="sm" onClick={() => update({ onboarded: false })}>
              {espn ? 'Switch league or team' : 'Switch user'}
            </Button>
          </Row>
          <Row label="League">
            {leagues.length > 1 ? (
              <Dropdown
                label="League"
                value={leagueId ?? ''}
                onChange={(id) => update({ leagueId: id })}
                options={leagues.map((l) => ({ value: l.id, label: l.name }))}
                className="w-full sm:w-72"
                buttonClassName="max-md:!h-10"
              />
            ) : (
              <span className="truncate text-[13px] text-ff-text2">{leagues[0]?.name ?? '—'}</span>
            )}
          </Row>
          <Row label="Season">
            <Segmented<string>
              label="Season"
              block={phone}
              value={prefs.season ?? seasons[0]}
              onChange={(v) => update({ season: v === seasons[0] ? null : v, leagueId: null })}
              options={seasons.map((s) => ({ key: s, label: <span className="num">{s}</span> }))}
            />
          </Row>
        </Group>

        <Group title="Appearance">
          <Row label="Theme" wide>
            <div className="w-full">
              <ThemePicker value={theme.id} onChange={(id) => update({ theme: id })} scheme={prefs.scheme} size={phone ? 'sm' : 'md'} />
            </div>
          </Row>
          <Row label="Mode" hint={only ? `${theme.label} only comes in ${only}.` : 'Auto follows your device.'}>
            <Segmented<Scheme>
              label="Mode"
              block={phone}
              disabled={!!only}
              value={only ?? prefs.scheme}
              onChange={(s) => update({ scheme: s })}
              options={[
                { key: 'system', label: 'Auto', title: 'Follow your device' },
                { key: 'light', label: 'Light' },
                { key: 'dark', label: 'Dark' },
              ]}
            />
          </Row>
          <Row label="Density" hint="Comfortable sets larger type and taller rows.">
            <Segmented<Density>
              label="Density"
              block={phone}
              value={prefs.density}
              onChange={(d) => update({ density: d })}
              options={[
                { key: 'compact', label: 'Compact' },
                { key: 'comfortable', label: 'Comfortable' },
              ]}
            />
          </Row>
        </Group>

        <Group title="Forecast">
          <Row label="Pricing horizon" hint={priced ? <>Trades and waivers are valued over {priced}.</> : 'The weeks trades and waivers are valued over.'}>
            <Segmented<HorizonMode>
              label="Pricing horizon"
              block={phone}
              value={prefs.horizon}
              onChange={(h) => update({ horizon: h })}
              options={[
                { key: 'next6', label: '6 weeks', title: HORIZON_LONG.next6 },
                { key: 'regular', label: 'Season', title: HORIZON_LONG.regular },
                { key: 'playoffs', label: '+ Playoffs', title: HORIZON_LONG.playoffs },
              ]}
            />
          </Row>
          {playoffWeeks.length > 0 && (
            <Row
              label={<span id={weightId}>Playoff weight</span>}
              hint={playoffs ? <>How much each playoff week ({span(playoffWeeks)}) counts. A regular week is 1×.</> : 'Used when the horizon includes the playoffs.'}
            >
              <span className={cx('flex w-full items-center gap-3 sm:w-72', !playoffs && 'opacity-50')}>
                <input
                  type="range"
                  min={0}
                  max={3}
                  step={0.5}
                  value={weight}
                  disabled={!playoffs}
                  aria-labelledby={weightId}
                  aria-valuetext={`${weight} times a regular week`}
                  onChange={(e) => setWeight(Number(e.target.value))}
                  onPointerUp={commitWeight}
                  onKeyUp={commitWeight}
                  onBlur={commitWeight}
                  className="ff-range min-w-0 flex-1 disabled:cursor-default max-md:h-10"
                  style={{ ['--fill' as string]: `${(weight / 3) * 100}%` }}
                />
                <span className="num w-9 shrink-0 text-right text-[13px] text-ff-text">{weight}×</span>
              </span>
            </Row>
          )}
        </Group>

        <Group title="Help and data">
          <Row label="Tour" hint="A quick walk through every page.">
            <Button onClick={onTour}>Replay the tour</Button>
          </Row>
          <Row label="Start over" hint="Forget your user, settings, grades and reads in this browser.">
            <StartOver />
          </Row>
        </Group>
      </div>
    </>
  )
}

export default SettingsView
