module.exports = {
    // Hover styles only where a pointer can hover, so taps never leave a stuck hover.
    future: { hoverOnlyWhenSupported: true },
    darkMode: 'media',
    content: [
        "./pages/**/*.{js,ts,jsx,tsx}",
        "./components/**/*.{js,ts,jsx,tsx}",
    ],
    theme: {
        // Motion: the app's tokens only (styles/fantasy.css, "Motion"), replacing Tailwind's scale so an off-system
        // duration or curve cannot be written. A bare `transition-colors` is a quick colour change on plain ease.
        transitionDuration: {
            DEFAULT: 'var(--ff-dur-quick)',
            0: '0ms',
            'ff-press': 'var(--ff-dur-press)',
            'ff-quick': 'var(--ff-dur-quick)',
            'ff-reveal': 'var(--ff-dur-reveal)',
            'ff-panel': 'var(--ff-dur-panel)',
            'ff-travel': 'var(--ff-dur-travel)',
        },
        transitionTimingFunction: {
            DEFAULT: 'ease',
            linear: 'linear',
            'ff-out': 'var(--ff-ease-out)',
            'ff-in-out': 'var(--ff-ease-in-out)',
            'ff-drawer': 'var(--ff-ease-drawer)',
        },
        transitionDelay: {},
        // Ambient loops are the app's own (styles/fantasy.css); Tailwind's spin, ping, pulse and bounce are not used.
        animation: { none: 'none' },
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
        },
    },
}
