# Fantasy

A fantasy football terminal for Sleeper and ESPN leagues: power rankings, playoff odds, trades, waivers and the live
slate, served at https://ff.sujeff.com. Moved out of [jeffsite](https://github.com/suyjeff/jeffsite) with its history.

- `pages/`, `components/`, `lib/`, `styles/fantasy.css`: the app (Next.js, static export, Tailwind).
- `workers/grades/`: the Cloudflare Worker behind shared grades and Power Rank link previews (see its README).
- `tests/accuracy/`: a weekly check of scoring against Sleeper's live API.

```bash
npm install
npm run dev    # http://localhost:3000
npm test
```

Pushes to `main` deploy to GitHub Pages (`.github/workflows/deploy.yml`); the worker deploys on its own when
`workers/grades/` changes.
