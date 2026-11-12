import React, { useId } from 'react'
import { THEMES, resolveMode, tokensFor, type Mode, type Scheme, type Theme } from '../lib/themes'
import { cx, useMedia } from './ui'

export type Density = 'compact' | 'comfortable'

/** Four chips of a theme's own colours: page, panel, accent, and the first series. */
export const Swatch = ({ theme, compact }: { theme: Theme; compact?: boolean }) => {
  const t = theme.dark ?? theme.light!
  const l = theme.light ?? theme.dark!
  const chips = compact ? [t.bg, t.accent] : [l.panel, t.bg, t.accent, t.s[1]]
  return (
    <span aria-hidden className="inline-flex shrink-0 border border-ff-line2">
      {chips.map((c, i) => (
        <span key={i} className="h-3 w-2" style={{ background: c }} />
      ))}
    </span>
  )
}

/**
 * The app in miniature, in a theme's own colours: sidebar with the current page lit, a header rule, and a card with
 * a label, a figure, a gain and a loss, a chart line and an accent button. Drawn on a fixed grid, so it scales to any width.
 */
export const ThemePreview = ({ theme, mode, className }: { theme: Theme; mode: Mode; className?: string }) => {
  const t = tokensFor(theme, mode)
  return (
    <svg aria-hidden viewBox="0 0 120 72" shapeRendering="crispEdges" className={cx('block h-auto w-full', className)}>
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


/** One theme as a picker tile: its miniature over its name. `sm` for tight spaces (phones, popovers). */
export const ThemeTile = ({ theme, mode, checked, name, onPick, size = 'md' }: { theme: Theme; mode: Mode; checked: boolean; name: string; onPick: () => void; size?: 'sm' | 'md' }) => {
  // The few themes that come in one mode only say so, on the miniature itself in its own colours.
  const only = theme.light && theme.dark ? null : theme.light ? 'light' : 'dark'
  const t = tokensFor(theme, mode)
  return (
    <label
      title={only ? `${theme.label} (${only} only)` : theme.label}
      className={cx(
        'relative flex min-w-0 cursor-pointer flex-col border bg-ff-panel transition-colors',
        checked ? 'border-ff-accent shadow-[0_0_0_1px_rgb(var(--ff-accent))]' : 'border-ff-line hover:border-ff-line2',
        'has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ff-accent',
      )}
    >
      <input type="radio" name={name} value={theme.id} checked={checked} onChange={onPick} className="sr-only" />
      <span className="relative block border-b border-ff-line">
        <ThemePreview theme={theme} mode={mode} />
        {only && (
          <span className="absolute bottom-1 right-1 border px-1 font-mono text-[9px] leading-[13px]" style={{ background: t.panel, color: t.text2, borderColor: t.line2 }}>
            {only}
          </span>
        )}
      </span>
      <span className={cx('flex min-w-0 items-center gap-1.5', size === 'sm' ? 'h-7 px-1.5 text-[11px]' : 'h-9 px-2 text-[12.5px]')}>
        <span className={cx('min-w-0 flex-1 truncate', checked ? 'font-medium text-ff-text' : 'text-ff-text2')}>{theme.label}</span>
        {checked && (
          <span aria-hidden className="shrink-0 font-mono text-[11px] text-ff-accent">
            ✓
          </span>
        )}
      </span>
    </label>
  )
}

/**
 * Every theme as a grid of tiles, a native radio group (arrows move and pick). A theme with both modes is drawn in the
 * mode the scheme picks, so switching Light or Dark redraws the grid; the rest show the only mode they have.
 */
const ThemePicker = ({ value, onChange, scheme, size = 'md', label = 'Theme' }: { value: string; onChange: (id: string) => void; scheme: Scheme; size?: 'sm' | 'md'; label?: string }) => {
  const name = useId()
  const systemDark = useMedia('(prefers-color-scheme: dark)')
  return (
    <fieldset className="min-w-0">
      <legend className="sr-only">{label}</legend>
      <div className={cx('grid', size === 'sm' ? 'grid-cols-[repeat(auto-fill,minmax(80px,1fr))] gap-1.5' : 'grid-cols-[repeat(auto-fill,minmax(136px,1fr))] gap-2')}>
        {THEMES.map((t) => (
          <ThemeTile key={t.id} theme={t} mode={resolveMode(t, scheme, systemDark)} name={name} size={size} checked={t.id === value} onPick={() => onChange(t.id)} />
        ))}
      </div>
    </fieldset>
  )
}

export default ThemePicker
