const plugin = require('tailwindcss/plugin')

// The two wide breakpoints follow the page's own width, not the window's. Assistant GM can dock a 400-440px panel at
// the right (from 1440px; html[data-asgm-dock], components/assistant/AsgmHost.tsx) and the page moves over for it, so
// a page in a 1440px window then has the width a 1040px window gives it. Every layout keyed to xl or 2xl switches as
// it would at that width: xl needs 1280px of page beside the dock (a 1680px window), 2xl 1536px (1976px). sm, md and
// lg are untouched: a docked page always has the width they ask for. The dock's width: styles/fantasy.css.
const DOCK = { xl: 1680, '2xl': 1976 }
const WIDE = { xl: 1280, '2xl': 1536 }

module.exports = {
    // Hover styles only where a pointer can hover, so taps never leave a stuck hover.
    future: { hoverOnlyWhenSupported: true },
    darkMode: 'media',
    content: [
        "./pages/**/*.{js,ts,jsx,tsx}",
        "./components/**/*.{js,ts,jsx,tsx}",
    ],
    theme: {
        // xl and 2xl are the plugin's below.
        screens: { sm: '640px', md: '768px', lg: '1024px' },
        extend: {
            fontFamily: {
                sans: ['"IBM Plex Sans"', 'system-ui', 'sans-serif'],
                mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
                plex: ['"IBM Plex Sans"', 'system-ui', 'sans-serif'],
            },
            // App tokens. Values live in styles/fantasy.css as RGB
            // triplets so alpha modifiers (bg-ff-accent/10) work.
            colors: {
                ff: Object.fromEntries(
                    ['bg', 'panel', 'raised', 'sunken', 'line', 'line2', 'text', 'text2', 'muted', 'accent', 'accent2', 'pos', 'neg', 'warn', 's1', 's2', 's3', 's4', 's5'].map(
                        (k) => [k, `rgb(var(--ff-${k}) / <alpha-value>)`],
                    ),
                ),
            },
            // Motion curves (also var(--ff-ease-*) in styles/fantasy.css).
            transitionTimingFunction: {
                'ff-out': 'cubic-bezier(0.23, 1, 0.32, 1)',
                'ff-drawer': 'cubic-bezier(0.32, 0.72, 0, 1)',
            },
        },
    },
    plugins: [
        // Tailwind writes these before the core breakpoints (checked in the built CSS: every xl: and max-xl: rule comes
        // before the lg: ones), so they cannot rely on order: with no extra specificity, `lg:grid-cols-2 xl:grid-cols-3`
        // would stay at two columns on a wide screen, because the lg rule comes later. So each format carries html in its
        // selector, one element (and for the min-width forms an attribute) more than a plain utility, and an xl or max-xl
        // class wins over an sm, md or lg one, as it would by order.
        // The hazard that buys: xl: and 2xl: rules ((0,2,1)) also beat state variants on the same property, hover:,
        // focus:, aria-* and the like ((0,2,0)). Don't pair an xl:/2xl: utility with a state variant that sets the same
        // property on the same element; put the state on a wrapper, or give the state its own xl: form
        // (xl:hover:bg-...), which carries the same extra specificity.
        plugin(({ addVariant }) => {
            for (const k of ['xl', '2xl']) {
                addVariant(k, [`@media (min-width: ${WIDE[k]}px) { html:not([data-asgm-dock]) & }`, `@media (min-width: ${DOCK[k]}px) { html[data-asgm-dock] & }`])
                addVariant(`max-${k}`, [`@media (max-width: ${WIDE[k] - 0.02}px) { html & }`, `@media (max-width: ${DOCK[k] - 0.02}px) { html[data-asgm-dock] & }`])
            }
        }),
    ],
}
