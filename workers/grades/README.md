# ff-grades

A tiny Cloudflare Worker with two jobs for the fantasy app: it lets everyone's "Would they?" trade
grades inform the trade odds for every user, and it holds the link previews for shared Power Ranks
and shared trades (`POST /trade`, then `/t/<id>`: a page with the trade card and an "Open in Fantasy"
button, and `/t/<id>.png`; only what the card shows is stored). It also relays the Assistant GM's
model calls on free tiers (see "Assistant GM" below). The
site stays static; without this worker (or without `FF_GRADES_URL`) the app behaves exactly as before,
with grades kept in the browser and shared rankings falling back to a plain link.

What it stores: roster ids, the grade, the reason, the model's log-odds, the ask, a price-scale
number, a timestamp and a random per-browser id. No names, usernames or accounts. It runs on
Cloudflare's free tier.

How it keeps count: each browser writes only its own KV key (`c:<league>:<client>`), so there is no
shared counter to corrupt when two people grade at once. A read adds the keys up, and the sums are
cached in KV (`snap:l:<league>` for 10 minutes, `snap:g` for 30), so most reads cost two KV gets.

## Setup

1. Make a free account at https://dash.cloudflare.com/sign-up (no card needed).
2. Install and sign in, from this folder:
   ```
   cd workers/grades
   npm ci
   npx wrangler login
   ```
3. Create the KV namespace:
   ```
   npx wrangler kv namespace create GRADES
   ```
   It prints an `id`. Paste it into `wrangler.toml` in place of `REPLACE_WITH_KV_ID`.
4. Deploy:
   ```
   npx wrangler deploy
   ```
   It prints a URL like `https://ff-grades.<your-subdomain>.workers.dev`. Copy it (no trailing slash).
5. In the GitHub repo, go to Settings > Secrets and variables > Actions > Variables, and add a
   repository variable named `FF_GRADES_URL` with that URL.
6. Re-run the deploy workflow (Actions > Deploy to GitHub Pages > Run workflow, or push to main) so
   the build picks the variable up.

### Deploying from GitHub

`.github/workflows/deploy-worker.yml` runs `npx wrangler deploy` whenever a push to main touches
`workers/grades/**` (or by hand: Actions > Deploy shared-link worker > Run workflow). It needs a token:

1. In the Cloudflare dashboard open My Profile > API Tokens > Create Token, and use the "Edit
   Cloudflare Workers" template. Scope it to your account (and, if you like, only this worker).
2. In the GitHub repo go to Settings > Secrets and variables > Actions > Secrets, and add
   `CLOUDFLARE_API_TOKEN` with that token.
3. If the token can see more than one Cloudflare account, also add `CLOUDFLARE_ACCOUNT_ID` (the
   account id is on the right of the dashboard's Workers & Pages page).

The workflow installs from `package-lock.json` (`npm ci`), and wrangler is pinned to an exact version in
`package.json`; to move it, change that version and run `npm install` here to refresh the lockfile.
Without `CLOUDFLARE_API_TOKEN` the workflow skips with a notice instead of failing. The KV namespace
id stays in `wrangler.toml`; the deploy does not create it.

To try it locally: `npx wrangler dev` serves the worker on http://localhost:8787 (with a local KV);
run the app with `NEXT_PUBLIC_FF_GRADES_URL=http://localhost:8787 npm run dev`.

## Endpoints

- `POST /grades` with `{ league, client, grades: [...], remove: [...] }`. Validated, at most 40 KB,
  60 grades a post, 400 per browser per league. One grade per deal per browser: a regrade replaces.
- `GET /prior?league=<id>&client=<id>&v=<price scale>` returns everyone else's lessons: a global
  residual total across leagues, and per team in that league the residual total, count, how many
  browsers marked the manager dormant, players said to be untouchable, and the smallest premium
  balked at. The caller's own grades are left out, so the app never counts them twice.

### Shared Power Rank links

The app uploads a 1200x630 preview card and a few facts about a ranking, and gets back a short link,
`https://<worker>/s/<id>`. Pasted into a message, the link unfurls to the card; opened by a person, it
sends them to `https://ff.sujeff.com/?league=<id>&season=<year>&reveal=<week>#power`, where the app asks for their
fantasy name (as any visit does) and then opens that week.

- `POST /share` with `multipart/form-data` (`meta` as JSON, `png` as the file) or JSON
  `{ meta, png }` with `png` in base64. `meta` is `{ league, leagueId, week, season, title,
  description, provider, top: [{ rank, name, score, move }] }`. Every field is checked and
  length-capped, the picture must be a PNG of exactly 1200x630 (read from its header) and at most
  400 KB, the request must declare its length (411 without, 413 over the cap) and is read in bounded
  chunks, and a post is limited per IP (6 a minute, 40 an hour). Answers `{ id, url }`. CORS as below.
- `GET /s/<id>`: link-preview bots (iMessage, Slack, Discord, WhatsApp, Telegram, LinkedIn, X...)
  get a page of Open Graph and Twitter tags with no redirect (matched by name: facebookexternalhit,
  Facebot, Twitterbot, Slackbot, Discordbot, WhatsApp, TelegramBot, LinkedInBot, Applebot, and a few
  more); anyone else gets a private, uncached 302 to the app. The
  page also carries a script redirect and an "Open Power Rank" link, and no meta refresh.
- `GET /s/<id>.png`: the card, cached for a year.

Each is stored in KV (`s:<id>` and `s:<id>:png`) for 120 days. The ids are 14 random letters and digits.
These two GET routes are open to any site; everything else keeps the CORS rule below. Each shared
ranking costs two KV writes, so the free tier's 1,000 writes a day is roughly 500 shares (the app
remembers the link it made for an unchanged ranking, so a repeat share costs nothing).

CORS allows only https://ff.sujeff.com and http://localhost (any port). The per-IP rate limit lives in
the isolate's memory, so it is a speed bump and not a hard cap. To get a hard cap, add a Cloudflare
rate limiting rule on the worker's route in the dashboard.

## Free-tier limits

KV's free tier allows 1,000 writes, 1,000 list operations, and 100,000 reads a day.

- A grade post costs one write (plus one read of the browser's own key), so about 1,000 posts a day
  (the app batches changes, so that is more grades than it sounds).
- A cold read rebuilds a snapshot: one list operation per 1,000 browsers for the league and for
  everyone, one get per browser in the league, and one write per snapshot. With the caching that is
  at most about 144 league rebuilds and 48 global rebuilds a day per active league, so list
  operations are the limit to watch: roughly 5 busy leagues a day fits. Idle leagues cost nothing.
- Per request the worker reads at most 30 browsers per league and the first 5,000 browsers overall,
  to stay inside the free plan's 50 subrequests.

## Assistant GM

The app's "Assistant GM" chat runs its tools in the browser, on the league it has already loaded, and
uses this worker only to relay model calls when the user has not added a key of their own (with a key,
the browser calls the provider directly and nothing passes through here). Code: `src/assistant.ts`;
the system prompt and the list of allowed tools are in `src/asgmShared.ts`, which the app imports too.

- `POST /assistant/chat` with `{ client, turn, step, messages, tools }`: one model round trip.
  `messages` are OpenAI-style chat messages without a system message (the worker adds its own prompt);
  `tools` must be the app's own tools by name. Answers `{ message: { content, tool_calls }, provider,
  model, remaining, limit, resetsAt }`, or an error with a `code`: `quota` (429, this browser's or network's
  questions are used up), `budget` (503, the day's shared budget is spent), `rate`, `size`, `steps`,
  `provider`, `unavailable`. The app shows `rate` and `steps` as "wait a moment", not as an empty allowance.
- `GET /assistant/status?client=<id>` answers `{ remaining, limit, resetsAt, available }`.

### Setup

Nothing is required: the `[ai]` binding in `wrangler.toml` gives the worker Cloudflare Workers AI
(`@cf/openai/gpt-oss-120b`), which every account has on the free plan. For a faster, larger free
allowance, add a Groq key, which the worker tries first:

1. Make a free account at https://console.groq.com (no card) and create an API key.
2. In the GitHub repo, Settings > Secrets and variables > Actions > Secrets, add `GROQ_API_KEY`.
   The deploy workflow sets it on the worker (`wrangler secret put GROQ_API_KEY`) on the next deploy;
   without the GitHub secret that step is skipped. Or set it by hand: `npx wrangler secret put GROQ_API_KEY`.
3. Do not add a card to the Groq account: without one, Groq's free tier cannot bill.

The site finds the worker through the same `FF_GRADES_URL` variable as the grades.

### Why it never leaves the free tier

Every allowance is kept by one SQLite-backed Durable Object (`src/meter.ts`, binding `ASGM_METER`, one instance
named `meter`). It handles one request at a time and each check-and-charge is a single synchronous step, so
concurrent requests cannot both pass a cap that only one of them fits under. Each round trip is *reserved*
there before any model is called, and each Workers AI call reserves its worst case before it is sent. Every
count is per UTC day and resets at 00:00 UTC, the same moment Workers AI's free allowance resets.

- **Questions.** 15 per browser (a random id kept in the browser), 25 per network (a hash of the IP; the IP
  itself is never stored), and 120 across everyone. A question is charged the first time its `turn` id is
  seen; the meter counts round trips for each recent id, so a reused id is not charged again and cannot go
  past 4 round trips, and two tabs each pay for their own questions. A question that gets no answer is given
  back (its round trip and any neurons are not). Round trips are capped at 150 a day across everyone. Per IP,
  20 requests a minute, and the step cap again, in the isolate's memory (a speed bump).
- **Groq** (`openai/gpt-oss-120b`, free tier about 30 requests a minute, 1,000 a day, 8,000 tokens a
  minute, 200,000 a day). At most 150 round trips a day, under the daily request cap. A round trip is about
  3,500 to 5,000 tokens, so the token caps run out first (about 40 to 55 calls a day, and back-to-back calls
  inside a minute): Groq then answers 429 and the worker falls back to Workers AI. A Groq account with no
  card cannot be billed, so its limits only ever mean a fallback.
- **Workers AI** (free: 10,000 neurons a day; on the Workers Paid plan anything past that is billed, so
  this is the limit that matters). gpt-oss-120b costs 31,818 neurons per million input tokens and 68,182
  per million output tokens. The meter stops at **8,500 neurons a day**: before each call it reserves the
  *worst case* (the prompt at 3 characters a token plus the full 900-token output allowance) and refuses the
  call if that would cross the cap; afterwards the reservation becomes the usage the model reports. A call that
  reports no usage, comes back empty or malformed, or throws keeps its worst-case charge (it may have run). A
  typical call (4,000 tokens in, 500 out) is about 160 neurons; the worst case for a full request is about
  200 to 250. So Workers AI answers at least 34 and typically about 50 calls a day, and never more than 60 (a
  second cap). If Workers AI rejects one request shape, the worker tries the other only if a second worst case
  still fits, and remembers the shape that worked so later calls are not charged twice.
- **A second, independent backstop.** On the Workers **Free** account plan, Workers AI past 10,000 neurons
  a day errors instead of billing. Keep the account on the Free plan and nothing here can be billed, whatever
  the meter does.
- **Durable Object requests** (free plan: 100,000 a day, plus SQLite row limits far above this). A round
  trip makes one meter request on Groq; on Workers AI, one more per call reservation and one per settle
  (at most 1 + 2 × 2 + 1 = 6 with a failed first shape and a give-back). At 150 round trips that is at most
  about 900 a day; status checks add one each (limited to 60 a minute per IP). The assistant no longer uses KV.
- **Abuse.** The worker uses its own system prompt and accepts only the app's tools, so it is no use as a
  general model. Bodies are capped at 48 KB, 24 messages, 16,000 characters a message, 20 tools and 4 tool
  calls a message; the output is clamped to 900 tokens; the model is fixed; CORS admits only the site and
  localhost. Without the meter binding the relay refuses every request rather than run unmetered.

To change a limit, edit `ASGM` at the top of `src/meter.ts` and redo the arithmetic above.

The meter's table holds `day`, `g` (`{ q, n, wai, r }`: questions, neurons, Workers AI calls, round trips),
`c:<client>` (`{ q, turns }`: questions, and round trips by question id, the 32 latest) and `i:<hash>` (`{ q }`).
It clears itself at the first request of each UTC day.

### Deploying the meter

`wrangler.toml` declares the Durable Object (`[[durable_objects.bindings]]`) and its migration
(`[[migrations]] tag = "asgm-v1"`, `new_sqlite_classes = ["AsgmMeter"]`); the first deploy after this change
creates it. SQLite-backed Durable Objects are available on the Workers Free plan. The API token needs
permission to edit Durable Objects as well as Workers (the "Edit Cloudflare Workers" template includes it);
if it does not, the deploy fails and the workflow's log says so in wrangler's error.

## Resetting

Delete the KV namespace in the dashboard (Storage & Databases > KV) and make a new one, or delete
single keys: `c:<league>:<client>`, `snap:l:<league>`, `snap:g`. The assistant's meter resets itself daily.
