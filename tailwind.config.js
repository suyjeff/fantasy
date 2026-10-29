module.exports = {
    // Hover styles only where a pointer can hover, so taps never leave a stuck hover.
    future: { hoverOnlyWhenSupported: true },
    darkMode: 'media',
    content: [
        "./pages/**/*.{js,ts,jsx,tsx}",
        "./components/**/*.{js,ts,jsx,tsx}",
    ],
    theme: {
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
}
