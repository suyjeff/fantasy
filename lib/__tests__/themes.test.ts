import { describe, expect, it } from 'vitest'
import { DEFAULT_THEME, THEMES, contrast, mix, themeById, themeVars } from '../themes'

const modes = THEMES.flatMap((t) => (['light', 'dark'] as const).filter((m) => t[m]).map((m) => ({ id: `${t.id}/${m}`, t: t[m]! })))

describe('themes', () => {
  it.each(modes)('$id: body text, secondary text and labels meet WCAG AA on panels and the page', ({ t }) => {
    for (const surface of [t.panel, t.bg, t.raised, t.sunken]) {
      expect(contrast(t.text, surface)).toBeGreaterThanOrEqual(7)
      expect(contrast(t.text2, surface)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(t.muted, surface)).toBeGreaterThanOrEqual(4.5)
    }
  })
  it.each(modes)('$id: accent, gain, loss and caution read as text on the panel and on their own tinted chips', ({ t }) => {
    for (const ink of [t.accent, t.pos, t.neg, t.warn]) {
      expect(contrast(ink, t.panel)).toBeGreaterThanOrEqual(4.5)
      // Chips and badges tint the panel with their own ink (bg-ff-warn/15 and the like).
      expect(contrast(ink, mix(t.panel, ink, 0.15))).toBeGreaterThanOrEqual(4.5)
      expect(contrast(ink, mix(t.raised, ink, 0.1))).toBeGreaterThanOrEqual(4.5)
    }
  })
  it.each(modes)('$id: the two head-to-head series colours read as large figures', ({ t }) => {
    // The matchup sets each side's score in s1 and s2 at 26px (large text, 3:1).
    for (const ink of [t.s[0], t.s[1]]) expect(contrast(ink, t.panel)).toBeGreaterThanOrEqual(3)
  })
  // The comparison chart's four lines (OKLab ΔE ×100, Machado 2009 colour-blind simulation): the dataviz validator's
  // gates for lines, where each line's neighbours in the set must stay apart.
  const lab = (h: string, m?: number[][]) => {
    let [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    if (m) [r, g, b] = m.map((row) => Math.min(1, Math.max(0, row[0] * r + row[1] * g + row[2] * b)))
    const [l, mm, s] = [
      [0.4122214708, 0.5363325363, 0.0514459929],
      [0.2119034982, 0.6806995451, 0.1073969566],
      [0.0883024619, 0.2817188376, 0.6299787005],
    ].map((k) => Math.cbrt(k[0] * r + k[1] * g + k[2] * b))
    return [0.2104542553 * l + 0.793617785 * mm - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * mm + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * mm - 0.808675766 * s]
  }
  const PROTAN = [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]]
  const DEUTAN = [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]]
  const dE = (a: string, b: string, m?: number[][]) => {
    const [x, y] = [lab(a, m), lab(b, m)]
    return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2])
  }
  it.each(modes)('$id: the comparison chart\'s four series tell apart, colour-blind vision included, and show on the panel', ({ id, t }) => {
    const [lo, hi] = id.endsWith('/dark') ? [0.48, 0.67] : [0.43, 0.77]
    for (const k of t.k) {
      expect(contrast(k, t.panel)).toBeGreaterThanOrEqual(3)
      const [L, a, b] = lab(k)
      expect(L).toBeGreaterThanOrEqual(lo)
      expect(L).toBeLessThanOrEqual(hi)
      expect(Math.hypot(a, b)).toBeGreaterThanOrEqual(0.1)
    }
    for (let i = 0; i < 3; i++) {
      expect(dE(t.k[i], t.k[i + 1])).toBeGreaterThanOrEqual(15)
      expect(Math.min(dE(t.k[i], t.k[i + 1], PROTAN), dE(t.k[i], t.k[i + 1], DEUTAN))).toBeGreaterThanOrEqual(8)
    }
  })
  it.each(modes)('$id: button text reads on the button body', ({ t }) => {
    // The Aqua capsule's label sits on accentDeep; the lighter accent only tints the top edge.
    expect(contrast(t.onAccent, t.accentDeep)).toBeGreaterThanOrEqual(4.5)
  })
  const added = modes.filter(({ id }) => /^(catppuccin|gruvbox|monokai)\//.test(id))
  it.each(added)('$id: the new themes keep every ink readable on its own 15% chip over any surface (panel, raised, sunken, page)', ({ t }) => {
    for (const ink of [t.accent, t.pos, t.neg, t.warn]) for (const surface of [t.panel, t.raised, t.sunken, t.bg]) expect(contrast(ink, mix(surface, ink, 0.15))).toBeGreaterThanOrEqual(4.5)
  })
  it.each(modes)('$id: the crown\'s gold ink reads on the panel and on the No. 1 row\'s gold wash', ({ id, t }) => {
    const dark = id.endsWith('/dark')
    const ink = dark ? '#f6cd6e' : '#845c00'
    const gold = dark ? '#f2c14e' : '#b68004'
    for (const surface of [t.panel, t.raised]) for (const a of [0, 0.09]) expect(contrast(ink, mix(surface, gold, a))).toBeGreaterThanOrEqual(4.5)
  })
  it('emits every token the stylesheet uses', () => {
    const v = themeVars(THEMES[0], 'light')
    for (const k of ['--ff-bg', '--ff-panel', '--ff-text', '--ff-accent', '--ff-accent-deep', '--ff-on-accent', '--ff-s5', '--ff-c4', '--ff-k4', '--ff-gold', '--ff-gold-ink']) expect(v[k]).toMatch(/^\d+ \d+ \d+$/)
  })
  it('has unique ids, and the retired Tailwind greys are gone', () => {
    const ids = THEMES.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const gone of ['gray', 'neutral', 'stone']) expect(ids).not.toContain(gone)
    for (const added of ['catppuccin', 'gruvbox', 'monokai']) expect(ids).toContain(added)
  })
  it('falls back to the default theme for a retired or unknown saved id', () => {
    for (const id of ['gray', 'neutral', 'stone', 'nope', '', null, undefined]) expect(themeById(id).id).toBe(DEFAULT_THEME)
    expect(themeById('monokai').id).toBe('monokai')
  })
})
