# MONKE model audit, November 2026

The forecast was refitted and re-tested on 1,365 Sleeper league-seasons (2022–2025) played forward week by week
through the app's own `lib/` code. Every tuned constant was chosen on 2022–24, and a change was adopted only if it beat
the shipped model on 2025 (which no fit saw) by more than its 95% interval. Intervals come from a bootstrap that
resamples whole league-seasons, because games inside a league share managers and scoring. Raw numbers are in
`research/results/`. Re-run everything with the commands at the bottom.

## Data

| Source | What | Rows |
| --- | --- | --- |
| Sleeper `/projections/nfl/regular/{season}/{week}` | Weekly projections, still served for every week back to 2018 (2017 rows exist but carry no points) | 101,033 projected player-weeks 2019–25 |
| Sleeper `/stats/nfl/regular/{season}/{week}` | Weekly stat lines | 141,094 player-weeks with a projection or a stat line, 2018–26 |
| Sleeper leagues | The two leagues in `tests/accuracy/leagues.json`, their `previous_league_id` chains, then two hops out through their managers (1,207 managers, 16,072 eligible finished leagues), sampled in a fixed hashed order | 1,375 league-seasons, 268,810 team-weeks; 1,365 used after filters |
| nflverse | Weekly player stats (team by week), injury reports, schedules with closing spread and total | 89,708 projected player-weeks matched to a Vegas line; 41,398 injury-report rows |

Filters: 8–14 teams, not best ball, season complete, at least 8 regular-season weeks with points. The leagues behind
the shipped settings were the 2 seed leagues (n = 15 and 18 games) and 148 leagues from 2025. Splits: train
2022–24 (688 league-seasons, 48,556 games), holdout 2025 (353, 25,225 games), live 2026 (the seed leagues).

One caveat on what the backtest knows: a stored past-week projection is Sleeper's last pre-kickoff number, so next-week
predictions use what was known at kickoff. Season simulations from week *w* carry week *w+1*'s projection forward
(with the app's availability decay and byes) instead of reading each future week's stored projection, which would
already know that week's injuries.

## Scorecard: next week's games (log loss, lower is better; 2025 holdout, 25,225 games)

| Model | Log loss | 95% interval | Picks right |
| --- | --- | --- | --- |
| Coin | 0.693 | | 49% |
| Elo, results only | 0.659 | | 60% |
| Elo with lineup credit (shipped Elo) | 0.633 | | 64% |
| Projected best lineup, no adjustment | 0.614 | | 65% |
| **MONKE as shipped** (best lineup × efficiency) | 0.612 | 0.605–0.619 | 65% |
| **MONKE refitted** (best lineup + lineup habit) | 0.592 | 0.584–0.599 | 67% |
| Sleeper's matchup number at kickoff (the starters actually set) | 0.559 | 0.551–0.567 | 70% |

Refitted minus shipped: **−0.020 (−0.025 to −0.016)**.

Sleeper's at-kickoff number is the best forecaster here because it knows the lineup. MONKE's number is made before
lineups are final. Where the refitted MONKE and Sleeper's kickoff number pick different winners (2,764 holdout games),
MONKE is right 37.5% of the time. **MONKE has no license to disagree with a lineup that is already set.** Its edge is
the days before: it already prices the habits that will shape the lineup.

## Scorecard: playoff and title odds (2025 holdout, 19,412 team snapshots after weeks 3, 5, 7, 9, 11)

| | Shipped | Refitted | Refitted − shipped |
| --- | --- | --- | --- |
| Playoff odds, log loss | 0.382 | 0.366 | −0.017 (−0.022 to −0.011) |
| Title odds, log loss | | | −0.003 (−0.006 to −0.001) |
| After week 3 | 0.503 | 0.479 | −0.024 (−0.032 to −0.016) |
| After week 11 | 0.223 | 0.217 | −0.006 (−0.010 to −0.002) |

Calibration of the refitted playoff odds on the holdout:

| Predicted | Teams | Mean predicted | Made it |
| --- | --- | --- | --- |
| under 1% | 1,729 | 0.2% | 0.3% |
| 1–5% | 1,016 | 2.8% | 2.7% |
| 5–20% | 2,203 | 11.8% | 12.4% |
| 20–40% | 2,345 | 29.7% | 30.0% |
| 40–60% | 2,436 | 50.0% | 50.2% |
| 60–80% | 2,878 | 70.3% | 69.8% |
| 80–95% | 2,914 | 88.2% | 88.2% |
| 95–99% | 1,482 | 97.2% | 96.9% |
| 99% and up | 2,409 | 99.8% | 99.6% |

The tails run slightly hot: at 99% and up, 10 of 2,409 teams missed (0.42% against 0.19% predicted). The display
never shows these as 100% (it shows ">99%"). That is the right call on this evidence.

Clinch and elimination calls on real seasons: 468 clinched and 304 eliminated on the holdout, none wrong. On train,
969 clinched with none wrong, and 2 of 665 eliminated teams made the bracket. Both are leagues whose bracket does not
follow the standings (one is seeded by points scored, in a league whose settings say otherwise; one put a 2–10 team
in). Across 872 leagues, the bracket matches the record standings in 95% of leagues for every setting combination,
so these are commissioner or data irregularities, not the arithmetic. Brute force on 2,000 random small leagues (every
remaining outcome × every tiebreak order): 5,841 calls, 0 wrong, 4.9% of settled spots left open.

## Where the error is

Per team-week, the miss splits into *player error* (actual points minus the starters' projection) and *lineup
deviation* (the starters' projection minus what MONKE expected). In the median league-season (686 with 60+ team-weeks;
typical score 135):

| | σ (points) | Share of variance |
| --- | --- | --- |
| Total miss | 27.7 | |
| Player projection error | 24.9 | 84% |
| Lineup deviation | 11.7 | 17% |

The player layer is most of the error, but almost none of it is recoverable from what we have. Sleeper's projections
are unbiased by position (QB −0.4, RB +0.1, WR −0.1, TE +0.1 points), and out of sample:

- **Linear recalibration by position:** improves holdout squared error by +1.6% (QB), 0.0% (RB), −0.4% (WR) and
  −0.4% (TE).
- **Vegas team implied totals:** +1.2% for RBs, ~0% for WRs, −1.4% for QBs and −0.5% for TEs. Sleeper's projections
  already price the line.

The lineup layer is smaller but persistent. A team's gap correlates 0.76 with its own past average, because the same
managers leave the same slots empty or the same byes in. That is where the recoverable error is: 0.020 log loss
mid-week, and 0.053 once the lineup is known.

Also measured:

- **Player spread:** grows with the projection, about 0.3–0.5 points of absolute miss per projected point.
- **Stacks:** a QB and his own receiver on one fantasy team have residual correlation 0.36 (38,227 pairs).
- **Player-level σ:** a σ built from these fits is calibrated as-is (best scale 0.95) but does not beat the league's
  single weekly σ (−0.0013, interval −0.0028 to +0.0001). Not adopted.

## Tuning decisions

| Constant | Was | Now | Evidence (train → holdout) | What moves downstream |
| --- | --- | --- | --- | --- |
| Rating form (`lib/forecast teamRatings`) | best lineup × efficiency | best lineup + lineup habit | −0.020 (−0.025 to −0.016) next week; −0.017 playoff odds | Next-week win probabilities (Slate, matchup sheets), every playoff/title/bye number, week stakes, trade leverage (a trade is no longer scaled by the manager's efficiency, so a careless manager's gains are not discounted), recap "expected" scores and upsets, Scout's "Lineup calls" fact |
| `LINEUP_PRIOR_GAMES` | – | 1 | best of 0, 1, 2, 4, 8, 16, none (0.5881) | How fast a manager's habit counts: about half after one game |
| `EFFICIENCY_PRIOR_GAMES` | 24 | 24 | best of 0–96 (0.6037) | Display only now (Eff columns) |
| `FORM_WEIGHT` | 0 | 0 | 0 / ¼ / ½ / 1 → 0.6037 / 0.6041 / 0.6052 / 0.6092 | Nothing (form is shown, not rated) |
| `SIM.tauShare` | 0.4 | 0.3 | 6 × 6 grid, train best (0.3, 0.7); holdout −0.0015 (−0.0025 to −0.0004) | Spread of every simulated season: slightly more confident early, less later |
| `SIM.persistence` | 0.85 | 0.7 | as above | More pull toward the middle over the season: a team far ahead in week 4 reads a little less certain |
| `SIM.sims` | 4,000 | 4,000 | worst-case simulation error √(0.25/4000) = 0.79 points | Pinned by test under 1 point |
| `RESULTS_PRIOR_GAMES` | 10 | 3.6 | best of 2–20; holdout −0.009 (−0.011 to −0.007); method of moments 2.8 | Power rank and score move with results sooner (results count 53% after 4 games, was 29%); strength of schedule; the weekly Power Rank reveal |
| `TALENT_SHARE` | 0.3 | 0.3 | preseason only, nothing to grade it on | Preseason power margins |
| `ELO` (k 18, ⅓ regress, lineup ½) | | unchanged | display and benchmark only; holdout 0.633 | Elo column |
| `clampOdds` | 0.001–0.999 | unchanged | | Stored next-week odds never 0 or 1 |
| `DEFAULT_POWER_WEIGHTS` | | unchanged | not refitted: roster strength needs the value model at each past date | |
| `MARKET_WEIGHT` (props blend) | 0.5 | unchanged | props are not archived, so the live test is the only check | Next week's horizon |

## Bugs found

- **Median-game leagues** (`league_average_match`, 128 of 1,365 league-seasons, about 1 in 11). The app counted only
  head-to-head results, so records, standings, playoff odds and clinch calls ran on half the real wins. A team two
  games clear could read as clinched when it was not. Fixed in records (`buildTeamWeeks`/`buildTeamSeasons`), the
  simulation (every simulated week plays the median game), the single-season trace and the clinch arithmetic, with a
  brute-force test over every order of each week's scores.

## Not done, and what would settle it

- **Next-week odds once a lineup is set.** Sleeper's starters' number beats MONKE by 0.033 at kickoff. Switching
  the live odds to it once lineups lock is the obvious next step, but historical data only has final lineups, not
  Thursday's. The live test logs both numbers every Thursday from week 9 (`research/live/`). Score it after four or
  five weeks.
- **Power weights** and **Elo** settings were not refitted.

## Re-running

```bash
node research/scripts/crawl.mjs players
node research/scripts/crawl.mjs nfl 2018 2026
node research/scripts/crawl.mjs leagues
GAP=70 POOL=24 node research/scripts/crawl.mjs expand 1100
python3 -I research/scripts/build_dataset.py
python3 -I research/scripts/export_teams.py
for i in 0 1 2 3; do OUT=harness_base SHARD=$i SHARDS=4 npx vitest run --config research/vitest.config.ts research/harness/run.test.ts & done; wait
python3 -I research/scripts/analyze.py
```

The nflverse files are plain downloads into `research/data/nflverse/` (`stats_player/stats_player_week_{season}.csv`,
`injuries/injuries_{season}.csv` from the nflverse-data releases, `games.csv` from nfldata, `db_playerids.csv` from
dynastyprocess). `harness_base` is the shipped model and `harness_cand` the candidate, each run from its own checkout.
