"""Turn the raw pulls into one DuckDB file (research/data/monke.duckdb) plus a parquet copy of every table.

    python3 -I research/scripts/build_dataset.py

Tables
  player_week    one row per player-week with a Sleeper projection or stat line (2018 on): projected and actual
                 half-PPR and PPR points, games played, position, NFL team, nflverse id, injury report status,
                 and the game's Vegas spread, total and the team's implied points
  nfl_game       nflverse schedule rows with closing spread and total
  league_season  each Sleeper league-season pulled: size, scoring, roster slots, playoff settings
  team_week      each team's week in each league-season: points, matchup, starters, roster
"""

import gzip
import json
import sys
from pathlib import Path

import duckdb
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent / "data"
RAW = ROOT / "raw"
NV = ROOT / "nflverse"


def load(p: Path):
    if not p.exists():
        return None
    with gzip.open(p) as f:
        return json.load(f)


def player_week() -> pd.DataFrame:
    players = load(RAW / "v1/players/nfl.json.gz") or {}
    pos = {k: (v or {}).get("position") for k, v in players.items()}
    team_now = {k: (v or {}).get("team") for k, v in players.items()}
    rows = []
    for sdir in sorted((RAW / "v1/projections/nfl/regular").iterdir()):
        season = int(sdir.name)
        for w in range(1, 19):
            proj = load(sdir / f"{w}.json.gz") or {}
            stats = load(RAW / f"v1/stats/nfl/regular/{season}/{w}.json.gz") or {}
            for pid in set(proj) | set(stats):
                p = proj.get(pid) or {}
                s = stats.get(pid) or {}
                ph = p.get("pts_half_ppr")
                ah = s.get("pts_half_ppr")
                if not ph and not ah:
                    continue
                rows.append(
                    dict(
                        season=season,
                        week=w,
                        player_id=pid,
                        pos=pos.get(pid) or ("DEF" if not pid.isdigit() else None),
                        proj_half=ph,
                        proj_ppr=p.get("pts_ppr"),
                        act_half=ah,
                        act_ppr=s.get("pts_ppr"),
                        gp=s.get("gp"),
                        off_snp=s.get("off_snp"),
                    )
                )
    df = pd.DataFrame(rows)
    df["team_now"] = df.player_id.map(team_now)
    return df


def main():
    con = duckdb.connect(str(ROOT / "monke.duckdb"))
    pw = player_week()
    con.register("pw_raw", pw)

    # nflverse: id map, weekly stats (for the team a player was on that week), injuries, schedule with lines.
    con.execute(f"create or replace table idmap as select cast(sleeper_id as varchar) sleeper_id, gsis_id from read_csv_auto('{NV}/db_playerids.csv', all_varchar=true) where sleeper_id is not null and sleeper_id <> 'NA' and gsis_id <> 'NA'")
    con.execute(f"""create or replace table nv_week as
        select season::int as season, week::int as "week", player_id gsis_id, team, opponent_team
        from read_csv_auto('{NV}/stats_player_week_*.csv', union_by_name=true, all_varchar=true) where season_type = 'REG'""")
    con.execute(f"""create or replace table injury as
        select season::int as season, week::int as "week", gsis_id, any_value(report_status) report_status, any_value(practice_status) practice_status
        from read_csv_auto('{NV}/injuries_*.csv', union_by_name=true, all_varchar=true) where game_type = 'REG' group by all""")
    con.execute(f"""create or replace table nfl_game as
        select game_id, season::int as season, week::int as "week", home_team, away_team, try_cast(home_score as double) home_score,
               try_cast(away_score as double) away_score, try_cast(spread_line as double) spread_line, try_cast(total_line as double) total_line
        from read_csv_auto('{NV}/games.csv', all_varchar=true) where game_type = 'REG' and season::int >= 2018""")
    # Each team-week's implied points: nflverse spread_line is home minus away, so home gets (total + spread) / 2.
    con.execute("""create or replace table team_line as
        select season, week, home_team team, spread_line spread, total_line total, (total_line + spread_line) / 2 implied from nfl_game
        union all select season, week, away_team, -spread_line, total_line, (total_line - spread_line) / 2 from nfl_game""")
    con.execute("""create or replace table player_week as
        select p.*, i.gsis_id, coalesce(n.team, case when p.pos = 'DEF' then p.player_id end) team,
               j.report_status, j.practice_status, l.spread, l.total, l.implied
        from pw_raw p
        left join idmap i on i.sleeper_id = p.player_id
        left join nv_week n on n.gsis_id = i.gsis_id and n.season = p.season and n.week = p.week
        left join injury j on j.gsis_id = i.gsis_id and j.season = p.season and j.week = p.week
        left join team_line l on l.team = coalesce(n.team, case when p.pos = 'DEF' then p.player_id end) and l.season = p.season and l.week = p.week""")

    # Leagues.
    ids = json.loads((RAW / "league_ids.json").read_text()) if (RAW / "league_ids.json").exists() else []
    ls_rows, tw_rows = [], []
    for lid in ids:
        lg = load(RAW / f"v1/league/{lid}.json.gz")
        if not lg:
            continue
        st = lg.get("settings") or {}
        sc = lg.get("scoring_settings") or {}
        start = st.get("playoff_week_start") or 15
        ls_rows.append(
            dict(
                league_id=lid,
                season=int(lg["season"]),
                status=lg.get("status"),
                n_teams=lg.get("total_rosters"),
                rec=sc.get("rec", 0),
                pass_td=sc.get("pass_td", 4),
                superflex="SUPER_FLEX" in (lg.get("roster_positions") or []),
                roster_positions=json.dumps(lg.get("roster_positions") or []),
                playoff_week_start=start,
                playoff_teams=st.get("playoff_teams"),
                playoff_round_type=st.get("playoff_round_type", 0),
                divisions=st.get("divisions") or 0,
                league_type=st.get("type", 0),
                previous_league_id=lg.get("previous_league_id"),
            )
        )
        for w in range(1, 19):
            for m in load(RAW / f"v1/league/{lid}/matchups/{w}.json.gz") or []:
                tw_rows.append(
                    dict(
                        league_id=lid,
                        season=int(lg["season"]),
                        week=w,
                        roster_id=m["roster_id"],
                        matchup_id=m.get("matchup_id"),
                        points=m.get("points"),
                        starters=json.dumps(m.get("starters") or []),
                        n_players=len(m.get("players") or []),
                    )
                )
    con.register("ls", pd.DataFrame(ls_rows))
    con.register("tw", pd.DataFrame(tw_rows))
    con.execute("create or replace table league_season as select * from ls")
    con.execute("create or replace table team_week as select * from tw")

    out = ROOT / "parquet"
    out.mkdir(exist_ok=True)
    for t in ["player_week", "nfl_game", "league_season", "team_week", "injury"]:
        con.execute(f"copy {t} to '{out}/{t}.parquet' (format parquet)")
    for t in ["player_week", "nfl_game", "league_season", "team_week", "injury"]:
        print(t, con.execute(f"select count(*) from {t}").fetchone()[0])
    print(con.execute("""select season, count(*) as n_rows, count(proj_half) with_proj, count(act_half) with_actual,
        count(*) filter (where proj_half > 0 and act_half is not null) pairs, count(implied) with_line
        from player_week group by 1 order by 1""").df().to_string(index=False))
    print(con.execute("""select season, count(*) leagues, sum(n_teams) teams from league_season where status = 'complete' or season = 2026 group by 1 order by 1""").df().to_string(index=False))


if __name__ == "__main__":
    sys.exit(main())
