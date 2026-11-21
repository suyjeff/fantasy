import React from 'react'
import { cx } from './ui'

// The app's few icons, drawn on a 14px grid in the house's technical style: 1px hairlines, square ends, crisp
// edges, no fills but for the one mark that carries state. They take the colour of the text around them.

const Svg = ({ children, className, size = 14 }: { children: React.ReactNode; className?: string; size?: number }) => (
  <svg
    aria-hidden
    width={size}
    height={size}
    viewBox="0 0 14 14"
    fill="none"
    stroke="currentColor"
    strokeWidth="1"
    strokeLinecap="square"
    shapeRendering="crispEdges"
    className={cx('shrink-0', className)}
  >
    {children}
  </svg>
)

/** A trade: two lanes, one each way, with square heads. */
export const TradeIcon = ({ className, size }: { className?: string; size?: number }) => (
  <Svg className={className} size={size}>
    <path d="M1.5 4.5h10M9.5 2.5l2 2-2 2" />
    <path d="M12.5 9.5h-10M4.5 7.5l-2 2 2 2" />
  </Svg>
)

/** Something being put together: a frame with a cross at its centre, as on a drafting sheet. */
export const BuildIcon = ({ className, size }: { className?: string; size?: number }) => (
  <Svg className={className} size={size}>
    <path d="M1.5 4V1.5H4M10 1.5h2.5V4M12.5 10v2.5H10M4 12.5H1.5V10" />
    <path d="M7 4.5v5M4.5 7h5" />
  </Svg>
)

/** Add one more: a plus in a square. */
export const AddIcon = ({ className, size }: { className?: string; size?: number }) => (
  <Svg className={className} size={size}>
    <rect x="1.5" y="1.5" width="11" height="11" />
    <path d="M7 4.5v5M4.5 7h5" />
  </Svg>
)

/** Opens a detail: an arrow out of a corner. */
export const OpenIcon = ({ className, size }: { className?: string; size?: number }) => (
  <Svg className={className} size={size}>
    <path d="M5.5 2.5h-3v9h9v-3" />
    <path d="M8 2.5h3.5V6M11.5 2.5 6.5 7.5" />
  </Svg>
)

/**
 * A pane with its sidebar ruled off: the show and hide sidebar control. Drawn like the usual panel glyph (a square
 * window, one rule just left of centre) with a hairline stroke; `open` shades the sidebar side, so the same icon
 * says which state it is in and eases between them.
 */
export const PanelIcon = ({ className, size = 16, open }: { className?: string; size?: number; open?: boolean }) => (
  <svg aria-hidden width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="miter" className={cx('shrink-0', className)}>
    <path
      d="M1.5 2.5H6v11H1.5Z"
      fill="currentColor"
      stroke="none"
      className="motion-safe:transition-opacity motion-safe:duration-ff-reveal motion-safe:ease-ff-out"
      style={{ opacity: open ? 0.22 : 0 }}
    />
    <rect x="1.5" y="2.5" width="13" height="11" />
    <path d="M6 2.5v11" />
  </svg>
)

/** An insight: a bulb cut in facets, on a neck and a base rule, with the filament rising into it. */
export const BulbIcon = ({ className, size }: { className?: string; size?: number }) => (
  <Svg className={className} size={size}>
    <path d="M4.5 10.5v-2l-2-2v-3l2-2h5l2 2v3l-2 2v2Z" />
    <path d="M7 10.5V7M5.5 12.5h3" />
  </Svg>
)

/** An instruction: an i in a square, as AddIcon draws its plus. */
export const InfoIcon = ({ className, size }: { className?: string; size?: number }) => (
  <Svg className={className} size={size}>
    <rect x="1.5" y="1.5" width="11" height="11" />
    <path d="M7 6.5V10" />
    <rect x="6.5" y="3.5" width="1" height="1" fill="currentColor" stroke="none" />
  </Svg>
)

/**
 * Assistant GM's mark: a football on the diagonal, its laces stitched across the seam. Drawn on the same 14px grid
 * and 1px hairline as the rest; the curves keep geometric precision so the ball stays round at 12px.
 */
export const FootballIcon = ({ className, size = 14 }: { className?: string; size?: number }) => (
  <svg aria-hidden width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" shapeRendering="geometricPrecision" className={cx('shrink-0', className)}>
    <path d="M1.5 12.5C0.6 7 7 0.6 12.5 1.5C13.4 7 7 13.4 1.5 12.5Z" />
    <path d="M3.4 8.1 5.9 10.6M8.1 3.4 10.6 5.9" />
    <path d="M5.6 8.4 8.4 5.6M5.8 6.8 7.2 8.2M6.8 5.8 8.2 7.2" />
  </svg>
)

/**
 * The AI mark that rides after Assistant GM's name: a four-point star with a small one off its shoulder, in the
 * accent. Solid, so it reads at 9px. `live` lets it turn slowly while the GM is working (motion only, never the only
 * sign of it).
 */
export const Sparkle = ({ className, size = 10, live, title }: { className?: string; size?: number; live?: boolean; title?: string }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 12 12"
    role={title ? 'img' : undefined}
    aria-label={title}
    aria-hidden={title ? undefined : true}
    className={cx('asgm-sparkle shrink-0 text-ff-accent', live && 'is-live', className)}
  >
    <path className="asgm-sparkle-a" d="M5 1.2C5.4 3.9 6.1 4.6 8.8 5C6.1 5.4 5.4 6.1 5 8.8C4.6 6.1 3.9 5.4 1.2 5C3.9 4.6 4.6 3.9 5 1.2Z" fill="currentColor" />
    <path className="asgm-sparkle-b" d="M9.6 7.4C9.75 8.45 10.05 8.75 11.1 8.9C10.05 9.05 9.75 9.35 9.6 10.4C9.45 9.35 9.15 9.05 8.1 8.9C9.15 8.75 9.45 8.45 9.6 7.4Z" fill="currentColor" />
  </svg>
)

// The round ones below (gear, sun, moon) are drawn at geometric precision: crisp edges would stair-step their curves.

/** Settings: an eight-tooth gear with flat tips around an open hub. */
export const GearIcon = ({ className, size = 14 }: { className?: string; size?: number }) => (
  <svg aria-hidden width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1" strokeLinejoin="miter" className={cx('shrink-0', className)}>
    <path d="M5.64 2.61L5.81 1.12L8.19 1.12L8.36 2.61L9.15 2.93L10.32 2L12 3.68L11.07 4.85L11.39 5.64L12.88 5.81L12.88 8.19L11.39 8.36L11.07 9.15L12 10.32L10.32 12L9.15 11.07L8.36 11.39L8.19 12.88L5.81 12.88L5.64 11.39L4.85 11.07L3.68 12L2 10.32L2.93 9.15L2.61 8.36L1.12 8.19L1.12 5.81L2.61 5.64L2.93 4.85L2 3.68L3.68 2L4.85 2.93Z" />
    <circle cx="7" cy="7" r="1.75" />
  </svg>
)

/** Past conversations: a clock face whose rim turns back, with a square-cornered arrow where it starts and square hands. */
export const HistoryIcon = ({ className, size = 14 }: { className?: string; size?: number }) => (
  <svg aria-hidden width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="square" strokeLinejoin="miter" className={cx('shrink-0', className)}>
    <path d="M1.75 7A5.25 5.25 0 1 0 3.29 3.29" />
    <path d="M1.5 1.75v2.5h2.5" />
    <path d="M7 4.5V7h2.5" />
  </svg>
)

/** Follow the device: a monitor on its stand. */
export const SystemIcon = ({ className, size }: { className?: string; size?: number }) => (
  <Svg className={className} size={size}>
    <rect x="1.5" y="2.5" width="11" height="7.5" />
    <path d="M5 12.5h4M7 10v2.5" />
  </Svg>
)

/** Light mode: a sun, a ring with eight rays. */
export const SunIcon = ({ className, size = 14 }: { className?: string; size?: number }) => (
  <svg aria-hidden width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="square" className={cx('shrink-0', className)}>
    <circle cx="7" cy="7" r="2.5" />
    <path d="M7 1v1.5M7 11.5V13M1 7h1.5M11.5 7H13M2.75 2.75l1.06 1.06M10.19 10.19l1.06 1.06M2.75 11.25l1.06-1.06M10.19 3.81l1.06-1.06" />
  </svg>
)

/** Dark mode: a crescent. */
export const MoonIcon = ({ className, size = 14 }: { className?: string; size?: number }) => (
  <svg aria-hidden width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1" className={cx('shrink-0', className)}>
    <path d="M11.5 8.6A5 5 0 1 1 5.4 2.5a4 4 0 0 0 6.1 6.1Z" />
  </svg>
)

/** Dismiss: two hairlines crossed. */
export const CloseIcon = ({ className, size = 14 }: { className?: string; size?: number }) => (
  <svg aria-hidden width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="square" className={cx('shrink-0', className)}>
    <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" />
  </svg>
)

const CHEVRON_TURN ={ down: undefined, up: 'rotate(180 7 7)', left: 'rotate(90 7 7)', right: 'rotate(-90 7 7)' } as const

/** How far an expander's chevron turns as it opens: a down one flips up, a right one turns to point down. */
const OPEN_TURN = { down: '180deg', up: '180deg', left: '-90deg', right: '90deg' } as const

/** The app's one chevron: an open line V for every expander, dropdown, pager and "go" hint. Takes the text colour;
 *  point it with `dir`. Give an expander's or a dropdown's chevron `open`, and it turns as the thing it controls
 *  opens and closes, on the shared reveal timing (`ff-turn`), the same everywhere. A native <details> turns it with
 *  `className="ff-turn group-open:[rotate:180deg]"`. */
export const ChevronIcon = ({ dir = 'down', open, className, size = 12 }: { dir?: keyof typeof CHEVRON_TURN; open?: boolean; className?: string; size?: number }) => (
  <svg
    aria-hidden
    width={size}
    height={size}
    viewBox="0 0 14 14"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="square"
    className={cx('inline-block shrink-0', open != null && 'ff-turn', className)}
    style={open ? { rotate: OPEN_TURN[dir] } : undefined}
  >
    <path d="M3 5.25l4 4 4-4" transform={CHEVRON_TURN[dir]} />
  </svg>
)
