"""The backtest's Python half: scores, decomposition, fits and the holdout scorecard, on the harness rows.

    python3 -I research/scripts/analyze.py          writes research/results/*.json and prints the tables

Split: train = 2021-2024 league-seasons, holdout = 2025 (never used to choose anything), live = 2026 (reported only).
Every comparison is paired (same games) and its interval is a bootstrap over league-seasons, since games inside a
league share managers, rosters and scoring and are not independent.
"""

import json
import math
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd
from scipy.special import ndtr  # standard normal CDF

ROOT = Path(__file__).resolve().parent.parent
H = ROOT / "data" / "harness"
OUT = ROOT / "results"
OUT.mkdir(exist_ok=True)
RNG = np.random.default_rng(20261106)
TRAIN = [2021, 2022, 2023, 2024]
HOLD = [2025]
EPS = 1e-6


def read(prefix):
    return pd.concat([pd.read_csv(p, dtype={"league_id": str}) for p in sorted(H.glob(f"{prefix}_*.csv"))], ignore_index=True)


def logloss(p, y):
    p = np.clip(p, EPS, 1 - EPS)
    return -(y * np.log(p) + (1 - y) * np.log(1 - p))


def brier(p, y):
    return (p - y) ** 2


def boot(df, col_a, col_b=None, metric=logloss, n=2000, y="y"):
    """Mean metric (or paired difference a - b) with a 95% interval, resampling whole league-seasons."""
    d = df.copy()
    d["_a"] = metric(d[col_a].values, d[y].values)
    d["_b"] = metric(d[col_b].values, d[y].values) if col_b else 0.0
    g = d.groupby("league_id").agg(a=("_a", "sum"), b=("_b", "sum"), n=("_a", "size"))
    a, b, m = g.a.values, g.b.values, g.n.values
    est = (a.sum() - b.sum()) / m.sum()
    idx = RNG.integers(0, len(g), size=(n, len(g)))
    draws = (a[idx].sum(1) - b[idx].sum(1)) / m[idx].sum(1)
    lo, hi = np.percentile(draws, [2.5, 97.5])
    return dict(est=round(float(est), 5), lo=round(float(lo), 5), hi=round(float(hi), 5), n=int(m.sum()), leagues=int(len(g)))


def reliability(p, y, edges=(0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0001)):
    out = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (p >= lo) & (p < hi)
        if m.sum():
            out.append(dict(lo=lo, hi=round(min(hi, 1), 2), n=int(m.sum()), p=round(float(p[m].mean()), 4), observed=round(float(y[m].mean()), 4)))
    return out


# ---------------------------------------------------------------- next-week games


def walk_forward(tw: pd.DataFrame, k_eff=24.0, form_w=0.0, form_k=8.0, sigma_floor_n=8, sigma_fallback=None):
    """
    Per team-week, what the shipped model knew going in (lib/forecast teamRatings, the per-game backtest's form):
    efficiency = (n·own + k·league) / (n + k) on managed points per projected optimal point in earlier weeks, and the
    league's weekly σ of (managed − projected × efficiency). Returns mu (optimal-lineup model), sigma, and the same σ
    measured for the starters' projection (Sleeper's matchup number).
    """
    rows = []
    for (lid, season), g in tw.groupby(["league_id", "season"], sort=False):
        g = g.sort_values("week")
        weeks = sorted(g.week.unique())
        for i, w in enumerate(weeks):
            prior = g[g.week < w]
            cur = g[g.week == w]
            if prior.empty:
                continue
            lg = prior.managed.sum() / prior.proj_opt.sum()
            agg = prior.groupby("rid").agg(a=("managed", "sum"), p=("proj_opt", "sum"), n=("managed", "size"))
            eff = ((agg.n * (agg.a / agg.p) + k_eff * lg) / (agg.n + k_eff)) if math.isfinite(k_eff) else pd.Series(lg, index=agg.index)
            pe = prior.rid.map(eff).fillna(lg)
            resid = prior.managed - prior.proj_opt * pe
            bias = resid.mean()
            fsum = (resid - bias).groupby(prior.rid).sum()
            form = fsum / (agg.n + form_k)
            sig = resid.std(ddof=1) if len(resid) >= sigma_floor_n else sigma_fallback
            r_st = prior.points - prior.proj_st
            sig_st = r_st.std(ddof=1) if len(r_st) >= sigma_floor_n else sigma_fallback
            ppg = prior.groupby("rid").points.mean()
            c = cur[["league_id", "season", "week", "rid", "opp", "points", "opp_points", "proj_opt", "proj_st"]].copy()
            c["eff"] = c.rid.map(eff).fillna(lg)
            c["form"] = c.rid.map(form).fillna(0.0)
            c["mu"] = c.proj_opt * c.eff + form_w * c.form
            c["sigma"] = sig
            c["sigma_st"] = sig_st
            c["ppg"] = c.rid.map(ppg)
            c["n_prior"] = i
            rows.append(c)
    return pd.concat(rows, ignore_index=True)


def games(team_rows: pd.DataFrame) -> pd.DataFrame:
    """Pair each team-week with its opponent's (one row per game, lower roster id as side a)."""
    a = team_rows[team_rows.rid < team_rows.opp]
    b = team_rows.rename(columns={c: c + "_b" for c in team_rows.columns if c not in ("league_id", "season", "week")})
    g = a.merge(b, left_on=["league_id", "season", "week", "opp"], right_on=["league_id", "season", "week", "rid_b"])
    g = g[(g.points != g.opp_points) & (g.points > 0) & (g.opp_points > 0)]
    g["y"] = (g.points > g.opp_points).astype(float)
    return g


def elo_probs(g: pd.DataFrame, sigma: float, k=18.0, lineup_share=0.5) -> np.ndarray:
    """lib/forecast runElo, game for game: 538's MOV multiplier, the lineup credit (ELWAY-style) on both sides."""
    per_point = (0.3989 / (np.sqrt(2) * sigma)) / (np.log(10) / 1600)
    scale = 14 / (sigma * np.sqrt(2))
    out = np.full(len(g), np.nan)
    pos = {ix: i for i, ix in enumerate(g.index)}
    for _, s in g.groupby(["league_id", "season"], sort=False):
        r = {}
        for _, wk in s.sort_values("week").groupby("week"):
            snap = dict(r)
            for ix, row in wk.iterrows():
                ra, rb = snap.get(row.rid, 1500.0), snap.get(row.rid_b, 1500.0)
                edge = lineup_share * per_point * (row.proj_opt - row.proj_opt_b)
                exp = 1 / (1 + 10 ** (-(ra - rb + edge) / 400))
                out[pos[ix]] = exp
                act = row.y
                wd = (ra - rb + edge) if act == 1 else (rb - ra - edge)
                mov = np.log(abs(row.points - row.opp_points) * scale + 1) * 2.2 / (wd * 0.001 + 2.2)
                shift = k * mov * (act - exp)
                r[row.rid] = r.get(row.rid, ra) + shift
                r[row.rid_b] = r.get(row.rid_b, rb) - shift
    return out


def winp(da, db, s):
    return ndtr((da - db) / (np.sqrt(2) * np.maximum(1.0, s)))


def main():
    tw = read("team_week")
    tw = tw[(tw.points > 0) & (tw.proj_opt > 0)]
    ls = tw.groupby(["league_id", "season"]).size().reset_index()
    print(f"team-weeks {len(tw):,} in {len(ls):,} league-seasons:", ls.groupby("season").size().to_dict())
    pooled_sigma = float((tw[tw.season.isin(TRAIN)].managed - tw[tw.season.isin(TRAIN)].proj_opt).std())
    results = {"counts": {"team_weeks": int(len(tw)), "league_seasons": ls.groupby("season").size().to_dict()}}

    # --- 1. Shipped model and benchmarks, every week from week 2 on.
    base = walk_forward(tw, sigma_fallback=25.0)
    g = games(base)
    g["p_coin"] = 0.5
    g["p_monke"] = np.clip(winp(g.mu, g.mu_b, g.sigma), 0.001, 0.999)
    g["p_proj"] = winp(g.proj_opt, g.proj_opt_b, g.sigma)
    g["p_sleeper"] = winp(g.proj_st, g.proj_st_b, g.sigma_st)
    g["p_elo"] = elo_probs(g, pooled_sigma)
    g["p_elo_results"] = elo_probs(g, pooled_sigma, lineup_share=0.0)
    split = {"train": g[g.season.isin(TRAIN)], "holdout": g[g.season.isin(HOLD)], "live": g[g.season == 2026]}
    card = {}
    for name, d in split.items():
        if d.empty:
            continue
        card[name] = {m: {"logloss": boot(d, f"p_{m}"), "brier": boot(d, f"p_{m}", metric=brier), "accuracy": round(float(((d[f"p_{m}"] > 0.5) == (d.y == 1)).mean()), 4)} for m in ["coin", "elo_results", "elo", "proj", "monke", "sleeper"]}
        card[name]["monke_minus_sleeper"] = boot(d, "p_monke", "p_sleeper")
        card[name]["monke_minus_proj"] = boot(d, "p_monke", "p_proj")
        card[name]["reliability_monke"] = reliability(d.p_monke.values, d.y.values)
        card[name]["reliability_sleeper"] = reliability(d.p_sleeper.values, d.y.values)
    results["next_week"] = card

    # --- 2. Opinion: where MONKE and Sleeper's matchup number pick different winners, who was right.
    op = {}
    for name, d in split.items():
        dis = d[(d.p_monke > 0.5) != (d.p_sleeper > 0.5)]
        if len(dis):
            op[name] = dict(games=int(len(d)), disagree=int(len(dis)), monke_right=round(float(((dis.p_monke > 0.5) == (dis.y == 1)).mean()), 4))
    results["opinion"] = op

    # --- 3. Efficiency prior and form weight, fitted on train by log loss (σ re-measured inside each fit).
    fits = []
    for k in [0, 4, 8, 16, 24, 48, 96, float("inf")]:
        b = games(walk_forward(tw[tw.season.isin(TRAIN)], k_eff=k, sigma_fallback=25.0))
        fits.append(dict(k=k, logloss=float(logloss(winp(b.mu, b.mu_b, b.sigma), b.y).mean()), n=int(len(b))))
    results["efficiency_prior_fit"] = fits
    best_k = min(fits, key=lambda r: r["logloss"])["k"]
    ffits = []
    for fw in [0, 0.25, 0.5, 1.0]:
        b = games(walk_forward(tw[tw.season.isin(TRAIN)], k_eff=24, form_w=fw, sigma_fallback=25.0))
        ffits.append(dict(form_weight=fw, logloss=float(logloss(winp(b.mu, b.mu_b, b.sigma), b.y).mean())))
    results["form_weight_fit"] = ffits

    # σ scale: is the measured σ itself calibrated? Fit one multiplier on train.
    tr = split["train"]
    sc = [(c, float(logloss(winp(tr.mu, tr.mu_b, tr.sigma * c), tr.y).mean())) for c in np.arange(0.8, 1.31, 0.05)]
    results["sigma_scale_fit"] = [dict(scale=round(c, 2), logloss=round(v, 5)) for c, v in sc]

    # --- 4. Error decomposition per team-week (train): actual − model = (actual − starters' projection)
    #        + (starters' projection − optimal × efficiency). Variance shares and what is predictable out of sample.
    d = base[base.season.isin(TRAIN)].copy()
    d["e_total"] = d.points - d.mu
    d["e_player"] = d.points - d.proj_st
    d["e_lineup"] = d.proj_st - d.mu
    v = d[["e_total", "e_player", "e_lineup"]].var()
    cov = d[["e_player", "e_lineup"]].cov().iloc[0, 1]
    results["decomposition"] = dict(
        var_total=round(float(v.e_total), 1),
        var_player=round(float(v.e_player), 1),
        var_lineup=round(float(v.e_lineup), 1),
        cov2=round(float(2 * cov), 1),
        sd_total=round(float(np.sqrt(v.e_total)), 2),
        sd_player=round(float(np.sqrt(v.e_player)), 2),
        sd_lineup=round(float(np.sqrt(v.e_lineup)), 2),
        mean_player=round(float(d.e_player.mean()), 2),
        mean_lineup=round(float(d.e_lineup.mean()), 2),
    )

    # --- 5. Player level: bias, spread by position and projection, Vegas, same-team correlation.
    pl = read("player")
    pl = pl[pl.proj > 0]
    con = duckdb.connect(str(ROOT / "data" / "monke.duckdb"), read_only=True)
    pw = con.execute("select season, week, player_id, team, implied, spread, total, report_status from player_week").df()
    pl = pl.merge(pw, on=["season", "week", "player_id"], how="left")
    pl["resid"] = pl.actual - pl.proj
    pos = ["QB", "RB", "WR", "TE", "K", "DEF"]
    pl = pl[pl.pos.isin(pos)]
    tr_p = pl[pl.season.isin(TRAIN) & (pl.started == 1)].drop_duplicates(["season", "week", "player_id"])
    ho_p = pl[pl.season.isin(HOLD) & (pl.started == 1)].drop_duplicates(["season", "week", "player_id"])
    spread = []
    for p_ in pos:
        x = tr_p[tr_p.pos == p_]
        if len(x) < 200:
            continue
        b1, b0 = np.polyfit(x.proj, np.abs(x.resid), 1)
        spread.append(dict(pos=p_, n=int(len(x)), bias=round(float(x.resid.mean()), 2), sd=round(float(x.resid.std()), 2), mad_intercept=round(float(b0), 2), mad_slope=round(float(b1), 3), skew=round(float(x.resid.skew()), 2)))
    results["player_spread"] = spread
    # Vegas: does the team's implied total explain what Sleeper's projection missed?
    veg = []
    for p_ in ["QB", "RB", "WR", "TE"]:
        x = tr_p[(tr_p.pos == p_) & tr_p.implied.notna()].copy()
        h = ho_p[(ho_p.pos == p_) & ho_p.implied.notna()].copy()
        if len(x) < 200 or len(h) < 50:
            continue
        mi = x.implied.mean()
        X = np.c_[np.ones(len(x)), x.proj * (x.implied - mi) / mi]
        beta = np.linalg.lstsq(X, x.resid.values, rcond=None)[0]
        Xh = np.c_[np.ones(len(h)), h.proj * (h.implied - mi) / mi]
        mse0 = float(((h.resid - x.resid.mean()) ** 2).mean())
        mse1 = float(((h.resid - Xh @ beta) ** 2).mean())
        veg.append(dict(pos=p_, n_train=int(len(x)), n_hold=int(len(h)), beta=round(float(beta[1]), 3), holdout_mse_gain_pct=round(100 * (mse0 - mse1) / mse0, 3)))
    results["vegas"] = veg
    # Same-NFL-team residual correlation among one fantasy team's starters (stacks), QB with his receivers.
    st = pl[pl.season.isin(TRAIN) & (pl.started == 1) & pl.team.notna()]
    qb = st[st.pos == "QB"][["league_id", "season", "week", "rid", "team", "resid"]]
    rec = st[st.pos.isin(["WR", "TE"])][["league_id", "season", "week", "rid", "team", "resid"]]
    pair = qb.merge(rec, on=["league_id", "season", "week", "rid", "team"], suffixes=("_qb", "_rec"))
    results["stack_corr"] = dict(pairs=int(len(pair)), corr=round(float(pair.resid_qb.corr(pair.resid_rec)), 3) if len(pair) > 30 else None)

    # Recoverable player error: a per-position linear correction (bias + slope on projection), fitted on train,
    # scored on holdout starters.
    rec_gain = []
    for p_ in pos:
        x = tr_p[tr_p.pos == p_]
        h = ho_p[ho_p.pos == p_]
        if len(x) < 200 or len(h) < 50:
            continue
        b1, b0 = np.polyfit(x.proj, x.resid, 1)
        mse0 = float((h.resid**2).mean())
        mse1 = float(((h.resid - (b0 + b1 * h.proj)) ** 2).mean())
        rec_gain.append(dict(pos=p_, slope=round(float(b1), 3), intercept=round(float(b0), 2), holdout_mse_gain_pct=round(100 * (mse0 - mse1) / mse0, 2)))
    results["player_recalibration"] = rec_gain

    # Lineup layer: is a manager's lineup gap (starters' projection vs optimal) predictable from their own past?
    lu = tw.sort_values(["league_id", "season", "rid", "week"]).copy()
    lu["gap"] = lu.proj_st - lu.proj_opt
    lu["past_gap"] = lu.groupby(["league_id", "season", "rid"]).gap.transform(lambda s: s.shift().expanding().mean())
    x = lu[lu.season.isin(TRAIN) & lu.past_gap.notna()]
    results["lineup_gap"] = dict(mean=round(float(x.gap.mean()), 2), sd=round(float(x.gap.std()), 2), corr_with_own_past=round(float(x.gap.corr(x.past_gap)), 3))

    # Team-level talent prior for the power rank (RESULTS_PRIOR_GAMES, TALENT_SHARE): within-team weekly variance
    # against the variance of true team means, by method of moments per league-season.
    ks = []
    for (lid, s), gg in tw[tw.season.isin(TRAIN)].groupby(["league_id", "season"]):
        per = gg.groupby("rid").points
        within = per.var(ddof=1).mean()
        nbar = per.size().mean()
        between = per.mean().var(ddof=1) - within / nbar
        ks.append((within, between))
    w_, b_ = np.array(ks).T
    results["talent_prior"] = dict(within_sd=round(float(np.sqrt(w_.mean())), 2), between_sd=round(float(np.sqrt(max(b_.mean(), 0))), 2), prior_games=round(float(w_.mean() / max(b_.mean(), 1e-9)), 2), talent_share=round(float(np.sqrt(max(b_.mean(), 0) / w_.mean())), 3))

    # --- 6. Season odds: calibration by week, and the tauShare × persistence grid.
    se = read("season")
    se = se[se.season.isin(TRAIN + HOLD + [2026])]
    grid = sorted({c[3:] for c in se.columns if c.startswith("po_")})
    season_res = {}
    for name, seasons in [("train", TRAIN), ("holdout", HOLD)]:
        d = se[se.season.isin(seasons)].copy()
        if d.empty:
            continue
        d["y"] = d.made.astype(float)
        cells = []
        for c in grid:
            cells.append(dict(cell=c, logloss=round(float(logloss(d[f"po_{c}"].values, d.y.values).mean()), 5), brier=round(float(brier(d[f"po_{c}"].values, d.y.values).mean()), 5)))
        by_week = {}
        for w, dw in d.groupby("asof"):
            by_week[int(w)] = dict(n=int(len(dw)), shipped=boot(dw, "p_playoffs"), reliability=reliability(dw.p_playoffs.values, dw.y.values, edges=(0, 0.01, 0.05, 0.2, 0.4, 0.6, 0.8, 0.95, 0.99, 1.0001)))
        extremes = dict(
            p99_n=int((d.p_playoffs >= 0.99).sum()), p99_missed=int(((d.p_playoffs >= 0.99) & (d.y == 0)).sum()),
            p01_n=int((d.p_playoffs <= 0.01).sum()), p01_made=int(((d.p_playoffs <= 0.01) & (d.y == 1)).sum()),
            clinched_in=int((d.clinch == "in").sum()), clinched_in_missed=int(((d.clinch == "in") & (d.y == 0)).sum()),
            clinched_out=int((d.clinch == "out").sum()), clinched_out_made=int(((d.clinch == "out") & (d.y == 1)).sum()),
        )
        season_res[name] = dict(n=int(len(d)), cells=sorted(cells, key=lambda r: r["logloss"]), by_week=by_week, extremes=extremes, title=boot(d.assign(y=d.champ.astype(float)), "p_title"))
    results["season"] = season_res
    if "train" in season_res:
        best = season_res["train"]["cells"][0]["cell"]
        h = se[se.season.isin(HOLD)].assign(y=lambda x: x.made.astype(float))
        if len(h):
            results["season"]["holdout_best_vs_shipped"] = dict(best_cell=best, delta=boot(h, f"po_{best}", "po_0.4_0.85"))

    (OUT / "scorecard.json").write_text(json.dumps(results, indent=1, default=float))
    print(json.dumps(results, indent=1, default=float)[:20000])


if __name__ == "__main__":
    main()
