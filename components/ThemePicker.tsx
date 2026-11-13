import React from 'react'
import { THEMES, tokensFor, type Mode, type Scheme, type Theme } from '../lib/themes'
import { MoonIcon, SunIcon, SystemIcon } from './icons'
import { Dropdown, Segmented, cx } from './ui'

export type Density = 'compact' | 'comfortable'

/** Four chips of a theme's own colours: page, panel, accent, and the first series. */
export const Swatch = ({ theme }: { theme: Theme }) => {
  const t = theme.dark ?? theme.light!
  const l = theme.light ?? theme.dark!
  const chips = [l.panel, t.bg, t.accent, t.s[1]]
  return (
    <span aria-hidden className="inline-flex shrink-0 border border-ff-line2">
      {chips.map((c, i) => (
        <span key={i} className="h-3 w-2" style={{ background: c }} />
      ))}
    </span>
  )
}

/** The one mode a theme comes in, when it does not come in both. */
export const onlyMode = (theme: Theme): Mode | null => (theme.light && theme.dark ? null : theme.light ? 'light' : 'dark')

/**
 * The app in miniature, in a theme's own colours: sidebar with the current page lit, a header rule, and a card with
 * a label, a figure, a gain and a loss, a chart line and an accent button. Drawn on a fixed grid, so it scales to any width.
 */
const ThemePreview = ({ theme, mode }: { theme: Theme; mode: Mode }) => {
  const t = tokensFor(theme, mode)
  return (
    <svg aria-hidden viewBox="0 0 120 72" shapeRendering="crispEdges" className="block h-auto w-full">
      <rect width="120" height="72" fill={t.bg} />
      {/* Sidebar */}
      <rect width="30" height="72" fill={t.panel} />
      <rect x="30" width="1" height="72" fill={t.line} />
      <rect x="5" y="5" width="15" height="3" fill={t.text} />
      <rect y="14" width="30" height="7" fill={t.raised} />
      <rect y="14" width="1.5" height="7" fill={t.accent} />
      <rect x="5" y="16.5" width="16" height="2" fill={t.text} />
      {[26, 33, 40, 47].map((y, i) => (
        <rect key={y} x="5" y={y} width={[13, 17, 11, 15][i]} height="2" fill={t.text2} opacity="0.75" />
      ))}
      {/* Page header */}
      <rect x="31" y="12" width="89" height="1" fill={t.line} />
      <rect x="36" y="5" width="24" height="3" fill={t.text} />
      <rect x="64" y="5.5" width="14" height="2" fill={t.muted} />
      {/* A card */}
      <rect x="36" y="18" width="79" height="49" fill={t.panel} stroke={t.line} strokeWidth="1" />
      <rect x="41" y="23" width="18" height="2" fill={t.muted} />
      <rect x="41" y="29" width="24" height="6" fill={t.text} />
      <rect x="41" y="39" width="12" height="3" fill={t.pos} />
      <rect x="56" y="39" width="9" height="3" fill={t.neg} />
      <rect x="94" y="22" width="17" height="7" fill={t.accent} />
      <rect x="98" y="25" width="9" height="1" fill={t.onAccent} />
      <polyline points="41,61 52,56 62,58 73,50 84,53 95,46 110,48" fill="none" stroke={t.accent} strokeWidth="1.5" shapeRendering="geometricPrecision" />
      <rect x="41" y="62" width="69" height="1" fill={t.line} />
    </svg>
  )
}

/** A theme's name with its swatch, for the dropdown's rows and its closed face. */
const ThemeName = ({ theme, tag }: { theme: Theme; tag?: boolean }) => {
  const only = onlyMode(theme)
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Swatch theme={theme} />
      <span className="min-w-0 truncate">{theme.label}</span>
      {tag && only && <span className="ml-auto pl-2 font-mono text-[10px] text-ff-muted">{only}</span>}
    </span>
  )
}

/** Every theme in one compact list, the app's neutrals first and then the editor palettes, each with its colours. */
export const ThemeSelect = ({ value, onChange, className }: { value: string; onChange: (id: string) => void; className?: string }) => (
  <Dropdown
    label="Theme"
    value={value}
    onChange={onChange}
    className={className}
    menuClassName="!left-auto right-0 max-h-[300px] min-w-[220px]"
    options={THEMES.map((t) => ({
      value: t.id,
      text: t.label,
      group: t.family === 'Tailwind' ? 'Neutral' : 'Editor',
      label: <ThemeName theme={t} tag />,
      face: <ThemeName theme={t} />,
    }))}
  />
)

/** Light, dark or the device's, as three icons. Locked (showing the one it has) for a theme with a single mode. */
export const ModeControl = ({ value, onChange, only }: { value: Scheme; onChange: (s: Scheme) => void; only: Mode | null }) => (
  <Segmented<Scheme>
    label="Mode"
    disabled={!!only}
    value={only ?? value}
    onChange={onChange}
    options={[
      { key: 'system', title: 'Match the device', label: <ModeFace icon={<SystemIcon />} name="Auto" /> },
      { key: 'light', title: 'Light', label: <ModeFace icon={<SunIcon />} name="Light" /> },
      { key: 'dark', title: 'Dark', label: <ModeFace icon={<MoonIcon />} name="Dark" /> },
    ]}
  />
)
const ModeFace = ({ icon, name }: { icon: React.ReactNode; name: string }) => (
  <span className="flex w-5 items-center justify-center max-md:w-7">
    {icon}
    <span className="sr-only">{name}</span>
  </span>
)

/**
 * The chosen theme in both its modes, side by side, the one on screen marked. A theme with one mode shows just that.
 * Clicking a miniature is not a control; the mode switch above is.
 */
export const ThemePreviews = ({ theme, mode, className }: { theme: Theme; mode: Mode; className?: string }) => {
  const modes: Mode[] = onlyMode(theme) ? [onlyMode(theme)!] : ['light', 'dark']
  return (
    <div className={cx('grid grid-cols-2 gap-2', className)}>
      {modes.map((m) => (
        <figure key={m} className="min-w-0">
          <div className={cx('border', m === mode ? 'border-ff-text2' : 'border-ff-line')}>
            <ThemePreview theme={theme} mode={m} />
          </div>
          <figcaption className="mt-1 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-ff-muted">
            <span aria-hidden className={cx('h-1 w-1', m === mode ? 'bg-ff-accent' : 'bg-ff-line2')} />
            {m}
            {m === mode && <span className="normal-case tracking-normal text-ff-text2">· on screen</span>}
          </figcaption>
        </figure>
      ))}
    </div>
  )
}
