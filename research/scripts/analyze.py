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
H = ROOT / "data" / "harness_base"
HC = ROOT / "data" / "harness_cand"
OUT = ROOT / "results"
OUT.mkdir(exist_ok=True)
RNG = np.random.default_rng(20261106)
TRAIN = [2021, 2022, 2023, 2024]
HOLD = [2025]
EPS = 1e-6


def read(prefix, root=None):
    return pd.concat([pd.read_csv(p, dtype={"league_id": str}) for p in sorted((root or H).glob(f"{prefix}_*.csv"))], ignore_index=True)


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
    league's weekly σ of (managed − projected × efficiency) over those weeks, at the efficiencies of the moment.
    Vectorised: each team's running sums of m, p, m², mp, p² (m managed, p projected) up to the week before.
    """
    t = tw.sort_values(["league_id", "season", "rid", "week"]).copy()
    t["m"], t["p"] = t.managed, t.proj_opt
    t["mm"], t["mp"], t["pp"], t["one"] = t.m * t.m, t.m * t.p, t.p * t.p, 1.0
    t["st_r"] = t.points - t.proj_st
    t["st_rr"] = t.st_r * t.st_r
    cols = ["m", "p", "mm", "mp", "pp", "one", "points", "st_r", "st_rr"]
    key = ["league_id", "season", "rid"]
    cum = t.groupby(key)[cols].cumsum() - t[cols]  # sums over this team's earlier weeks
    for c in cols:
        t["c_" + c] = cum[c]
    # League totals over earlier weeks: sum the per-week league totals, cumulated, shifted by one week.
    wk = t.groupby(["league_id", "season", "week"])[cols].sum().groupby(level=[0, 1]).cumsum()
    wk = wk.groupby(level=[0, 1]).shift(1).fillna(0.0)
    wk.columns = ["L_" + c for c in cols]
    t = t.merge(wk, left_on=["league_id", "season", "week"], right_index=True)
    t = t[t.L_one > 0]
    lg = t.L_m / t.L_p
    own = (t.c_m / t.c_p.replace(0, np.nan)).fillna(lg)
    n = t.c_one
    eff = ((n * own + k_eff * lg) / (n + k_eff)) if math.isfinite(k_eff) else lg
    t["eff"] = eff
    # σ at this week's efficiencies needs every team's sums: Σ over teams of Σ(m − e·p)² and Σ(m − e·p).
    t["e_sq"] = t.c_mm - 2 * eff * t.c_mp + eff**2 * t.c_pp
    t["e_s"] = t.c_m - eff * t.c_p
    # A team absent this week still counts in σ; its row is missing, so its sums are carried in by the league totals
    # only approximately (rare: byes do not exist in fantasy, only missing rows).
    agg = t.groupby(["league_id", "season", "week"]).agg(S2=("e_sq", "sum"), S1=("e_s", "sum"), N=("c_one", "sum"))
    agg["sigma"] = np.sqrt(((agg.S2 - agg.S1**2 / agg.N) / (agg.N - 1)).clip(lower=0))
    agg["bias"] = agg.S1 / agg.N
    agg.loc[agg.N < sigma_floor_n, "sigma"] = sigma_fallback
    t = t.merge(agg[["sigma", "bias"]], left_on=["league_id", "season", "week"], right_index=True)
    t["form"] = ((t.e_s - t.bias * n) / (n + form_k)).where(n > 0, 0.0)
    t["mu"] = t.proj_opt * t.eff + form_w * t.form
    st_var = (t.groupby(["league_id", "season", "week"]).agg(a=("c_st_rr", "sum"), b=("c_st_r", "sum"), N=("c_one", "sum")))
    st_var["sigma_st"] = np.sqrt(((st_var.a - st_var.b**2 / st_var.N) / (st_var.N - 1)).clip(lower=0))
    st_var.loc[st_var.N < sigma_floor_n, "sigma_st"] = sigma_fallback
    t = t.merge(st_var[["sigma_st"]], left_on=["league_id", "season", "week"], right_index=True)
    t["ppg"] = t.c_points / n.replace(0, np.nan)
    t["n_prior"] = n
    keep = ["league_id", "season", "week", "rid", "opp", "points", "opp_points", "proj_opt", "proj_st", "eff", "form", "mu", "sigma", "sigma_st", "ppg", "n_prior"]
    return t[keep].reset_index(drop=True)


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
    def split(x):
        vv = x[["e_total", "e_player", "e_lineup"]].var()
        cc = x[["e_player", "e_lineup"]].cov().iloc[0, 1]
        return dict(n=int(len(x)), sd_total=round(float(np.sqrt(vv.e_total)), 2), sd_player=round(float(np.sqrt(vv.e_player)), 2), sd_lineup=round(float(np.sqrt(vv.e_lineup)), 2),
                    var_player=round(float(vv.e_player), 1), var_lineup=round(float(vv.e_lineup), 1), cov2=round(float(2 * cc), 1), mean_lineup=round(float(x.e_lineup.mean()), 2))
    # Abandoned or half-set lineups (starters projected under 70% of the best lineup) are their own population.
    active = d.proj_st >= 0.7 * d.proj_opt
    results["decomposition_split"] = dict(all=split(d), active=split(d[active]), abandoned_share=round(float((~active).mean()), 4))
    # Per league-season (scoring scales differ by a factor of three across leagues), then the median league.
    per = []
    for _, x in d.groupby(["league_id", "season"]):
        if len(x) < 60:
            continue
        vv = x[["e_total", "e_player", "e_lineup"]].var()
        cc = 2 * x[["e_player", "e_lineup"]].cov().iloc[0, 1]
        per.append(dict(sd_total=np.sqrt(vv.e_total), sd_player=np.sqrt(vv.e_player), sd_lineup=np.sqrt(vv.e_lineup), share_player=vv.e_player / vv.e_total, share_lineup=vv.e_lineup / vv.e_total, share_cov=cc / vv.e_total, mean_score=x.points.mean()))
    per = pd.DataFrame(per)
    results["decomposition_median_league"] = {k: round(float(per[k].median()), 3) for k in per.columns} | {"league_seasons": int(len(per))}
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

    # --- 5b. The lineup layer, modelled. Mid-week (lineup not set): projected optimum plus the manager's own
    #         habit of starting less than it, shrunk to the league's (additive, empty slots included). At kickoff
    #         (lineup set): the starters' projection, which is Sleeper's matchup number.
    def gap_model(t: pd.DataFrame, k: float) -> pd.DataFrame:
        t = t.sort_values(["league_id", "season", "rid", "week"]).copy()
        t["gap"] = t.proj_st - t.proj_opt
        t["r"] = t.points - t.proj_opt
        t["rr"], t["one"] = t.r * t.r, 1.0
        cols = ["gap", "r", "rr", "one"]
        cum = t.groupby(["league_id", "season", "rid"])[cols].cumsum() - t[cols]
        for c in cols:
            t["c_" + c] = cum[c]
        wk = t.groupby(["league_id", "season", "week"])[cols].sum().groupby(level=[0, 1]).cumsum().groupby(level=[0, 1]).shift(1).fillna(0.0)
        wk.columns = ["L_" + c for c in cols]
        t = t.merge(wk, left_on=["league_id", "season", "week"], right_index=True)
        t = t[t.L_one > 0]
        lg = t.L_gap / t.L_one
        own = (t.c_gap + k * lg) / (t.c_one + k)
        t["mu"] = t.proj_opt + own
        # σ of (points − mu) over earlier weeks at today's gaps: Σ(r − g)² = Σr² − 2gΣr + n·g², summed over teams.
        t["e_sq"] = t.c_rr - 2 * own * t.c_r + t.c_one * own**2
        t["e_s"] = t.c_r - t.c_one * own
        agg = t.groupby(["league_id", "season", "week"]).agg(S2=("e_sq", "sum"), S1=("e_s", "sum"), N=("c_one", "sum"))
        agg["sigma"] = np.sqrt(((agg.S2 - agg.S1**2 / agg.N) / (agg.N - 1)).clip(lower=0))
        agg.loc[agg.N < 8, "sigma"] = 25.0
        t = t.merge(agg[["sigma"]], left_on=["league_id", "season", "week"], right_index=True)
        return games(t[["league_id", "season", "week", "rid", "opp", "points", "opp_points", "proj_opt", "proj_st", "mu", "sigma"]].reset_index(drop=True))

    gfit = []
    for k in [0, 1, 2, 4, 8, 16, 1e9]:
        b = gap_model(tw[tw.season.isin(TRAIN)], k)
        gfit.append(dict(k=k, logloss=round(float(logloss(winp(b.mu, b.mu_b, b.sigma), b.y).mean()), 5)))
    results["lineup_gap_fit"] = gfit
    k_gap = min(gfit, key=lambda r: r["logloss"])["k"]
    gm = gap_model(tw, k_gap)
    gm["p_gap"] = winp(gm.mu, gm.mu_b, gm.sigma)
    g = g.merge(gm[["league_id", "season", "week", "rid", "p_gap"]], on=["league_id", "season", "week", "rid"], how="left")

    # Player-level spread for the kickoff number: each starter's σ from his position and projection (the fits in
    # player_spread, MAD → σ), plus QB–receiver stacks on one NFL team, scaled by one constant fitted on train.
    sp = {r["pos"]: r for r in spread}
    stp = pl[pl.started == 1].copy()
    stp["sd"] = [1.2533 * (sp[p_]["mad_intercept"] + sp[p_]["mad_slope"] * x) if p_ in sp else 6.0 for p_, x in zip(stp.pos, stp.proj)]
    var = stp.groupby(["league_id", "season", "week", "rid"]).sd.apply(lambda x: float((x**2).sum())).rename("var_players")
    q = stp[stp.pos == "QB"][["league_id", "season", "week", "rid", "team", "sd"]]
    rcv = stp[stp.pos.isin(["WR", "TE"])][["league_id", "season", "week", "rid", "team", "sd"]]
    stk = q.merge(rcv, on=["league_id", "season", "week", "rid", "team"], suffixes=("_q", "_r"))
    rho = results["stack_corr"]["corr"] or 0.0
    stk["cov"] = 2 * rho * stk.sd_q * stk.sd_r
    cov_ = stk.groupby(["league_id", "season", "week", "rid"])["cov"].sum().rename("cov_stack")
    tv = pd.concat([var, cov_], axis=1).fillna(0.0).reset_index()
    tv["var_team"] = tv.var_players + tv.cov_stack
    g = g.merge(tv[["league_id", "season", "week", "rid", "var_team"]], on=["league_id", "season", "week", "rid"], how="left")
    g = g.merge(tv[["league_id", "season", "week", "rid", "var_team"]].rename(columns={"rid": "rid_b", "var_team": "var_team_b"}), on=["league_id", "season", "week", "rid_b"], how="left")
    ok = g.var_team.notna() & g.var_team_b.notna()
    trh = g[ok & g.season.isin(TRAIN)]
    cs = [(c, float(logloss(ndtr((trh.proj_st - trh.proj_st_b) / (c * np.sqrt(trh.var_team + trh.var_team_b))), trh.y).mean())) for c in np.arange(0.7, 1.31, 0.05)]
    c_best = min(cs, key=lambda x: x[1])[0]
    results["hetero_sigma_fit"] = dict(scale=round(float(c_best), 2), grid=[(round(c, 2), round(v, 5)) for c, v in cs])
    g["p_sleeper_hetero"] = np.where(ok, ndtr((g.proj_st - g.proj_st_b) / (c_best * np.sqrt(g.var_team.fillna(0) + g.var_team_b.fillna(0)).clip(lower=1))), g.p_sleeper)

    # Power rank: the results composite (lib/power computePower, no roster part) at several RESULTS_PRIOR_GAMES.
    def power_probs(t: pd.DataFrame, k: float, w=dict(allPlay=0.35, points=0.2, recent=0.15, efficiency=0.05)) -> pd.DataFrame:
        t = t.sort_values(["league_id", "season", "rid", "week"]).copy()
        wkg = t.groupby(["league_id", "season", "week"]).points
        t["ap_w"] = wkg.rank(method="average") - 1  # teams outscored that week, ties as half
        t["ap_g"] = wkg.transform("size") - 1
        t["one"] = 1.0
        cols = ["ap_w", "ap_g", "points", "optimal", "one"]
        cum = t.groupby(["league_id", "season", "rid"])[cols].cumsum() - t[cols]
        for c in cols:
            t["c_" + c] = cum[c]
        t["recent"] = t.groupby(["league_id", "season", "rid"]).points.transform(lambda x: x.shift().rolling(3, min_periods=1).mean())
        t = t[t.c_one > 0].copy()
        n = t.c_one
        comp = pd.DataFrame({"allPlay": t.c_ap_w / t.c_ap_g, "points": t.c_points / n, "recent": t.recent, "efficiency": t.c_points / t.c_optimal}, index=t.index)
        key = [t.league_id, t.season, t.week]
        z = (comp - comp.groupby(key).transform("mean")) / comp.groupby(key).transform(lambda x: x.std(ddof=0)).replace(0, 1)
        rel, rel_r = n / (n + k), np.minimum(n, 3) / (np.minimum(n, 3) + k)
        tot = sum(w.values())
        c_ = sum(w[c] / tot * z[c] * (rel_r if c == "recent" else rel) for c in w)
        spread = comp.points.groupby(key).transform(lambda x: x.std(ddof=0))
        t["pm"] = c_ * spread
        return t[["league_id", "season", "week", "rid", "pm"]]

    pfit = []
    for k in [2, 3.6, 5, 10, 20]:
        pm = power_probs(tw[tw.season.isin(TRAIN)], k)
        gg = g[g.season.isin(TRAIN)].merge(pm, on=["league_id", "season", "week", "rid"]).merge(pm.rename(columns={"rid": "rid_b", "pm": "pm_b"}), on=["league_id", "season", "week", "rid_b"])
        pfit.append(dict(k=k, logloss=round(float(logloss(winp(gg.pm, gg.pm_b, gg.sigma), gg.y).mean()), 5), n=int(len(gg))))
    results["power_prior_fit"] = pfit
    k_pow = min(pfit, key=lambda r: r["logloss"])["k"]
    for k, col in [(10, "p_power"), (k_pow, "p_power_fit")]:
        pm = power_probs(tw, k)
        g = g.merge(pm.rename(columns={"pm": "pm_" + col}), on=["league_id", "season", "week", "rid"], how="left").merge(pm.rename(columns={"rid": "rid_b", "pm": "pmb_" + col}), on=["league_id", "season", "week", "rid_b"], how="left")
        g[col] = winp(g["pm_" + col].fillna(0), g["pmb_" + col].fillna(0), g.sigma)

    # The re-fitted candidates against the shipped model and Sleeper, on the holdout.
    cand = {}
    for name, seasons in [("train", TRAIN), ("holdout", HOLD), ("live", [2026])]:
        d = g[g.season.isin(seasons)]
        if d.empty:
            continue
        cand[name] = {
            "logloss": {m: boot(d, f"p_{m}") for m in ["monke", "proj", "gap", "sleeper", "sleeper_hetero", "power", "power_fit", "elo"]},
            "accuracy": {m: round(float(((d[f"p_{m}"] > 0.5) == (d.y == 1)).mean()), 4) for m in ["monke", "proj", "gap", "sleeper", "power", "power_fit", "elo"]},
            "gap_minus_monke": boot(d, "p_gap", "p_monke"),
            "gap_minus_proj": boot(d, "p_gap", "p_proj"),
            "hetero_minus_sleeper": boot(d, "p_sleeper_hetero", "p_sleeper"),
            "power_fit_minus_power": boot(d, "p_power_fit", "p_power"),
            "reliability_gap": reliability(d.p_gap.values, d.y.values),
            "reliability_hetero": reliability(d.p_sleeper_hetero.values, d.y.values),
        }
        dis = d[(d.p_gap > 0.5) != (d.p_sleeper > 0.5)]
        cand[name]["opinion_gap_vs_sleeper"] = dict(disagree=int(len(dis)), gap_right=round(float(((dis.p_gap > 0.5) == (dis.y == 1)).mean()), 4) if len(dis) else None)
        dis = d[(d.p_sleeper_hetero > 0.5) != (d.p_sleeper > 0.5)]
        cand[name]["opinion_hetero_vs_sleeper"] = dict(disagree=int(len(dis)))
    results["candidates"] = cand

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

    # --- 7. The candidate (lineup habit in the rating, lib/forecast LINEUP_PRIOR_GAMES) against the shipped model, on
    #        the same seasons: playoff and title odds, holdout only for the verdict.
    if HC.exists():
        sc = read("season", HC)
        key = ["league_id", "season", "asof", "rid"]
        m = se.merge(sc[key + ["p_playoffs", "p_title"] + [c for c in sc.columns if c.startswith("po_")]], on=key, suffixes=("", "_cand"))
        comp = {}
        for name, seasons in [("train", TRAIN), ("holdout", HOLD)]:
            d = m[m.season.isin(seasons)].assign(y=lambda x: x.made.astype(float))
            comp[name] = dict(
                playoffs_cand_minus_base=boot(d, "p_playoffs_cand", "p_playoffs"),
                title_cand_minus_base=boot(d.assign(y=d.champ.astype(float)), "p_title_cand", "p_title"),
                extremes_cand=dict(p99_n=int((d.p_playoffs_cand >= 0.99).sum()), p99_missed=int(((d.p_playoffs_cand >= 0.99) & (d.y == 0)).sum()), p01_n=int((d.p_playoffs_cand <= 0.01).sum()), p01_made=int(((d.p_playoffs_cand <= 0.01) & (d.y == 1)).sum())),
                cells_cand=sorted([dict(cell=c[3:].replace("_cand", ""), logloss=round(float(logloss(d[c].values, d.y.values).mean()), 5)) for c in d.columns if c.startswith("po_") and c.endswith("_cand")], key=lambda r: r["logloss"])[:6],
                by_week={int(w): boot(dw, "p_playoffs_cand", "p_playoffs") for w, dw in d.groupby("asof")},
            )
        results["season_candidate"] = comp
        # Median-game leagues: how the odds do there now that their records count both results.
        med = se[se.season.isin(TRAIN + HOLD) & (se["median"] == 1)].assign(y=lambda x: x.made.astype(float))
        results["median_leagues"] = dict(n=int(len(med)), leagues=int(med.league_id.nunique()), logloss=boot(med, "p_playoffs") if len(med) else None)

    (OUT / "scorecard.json").write_text(json.dumps(results, indent=1, default=float))
    print(json.dumps(results, indent=1, default=float)[:20000])


if __name__ == "__main__":
    main()
