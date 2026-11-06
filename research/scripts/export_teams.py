"""Per season: each player's NFL team by week (nflverse, last known), and each NFL team's bye weeks, for the TS harness.

    python3 -I research/scripts/export_teams.py
"""
import json
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parent.parent / "data"
con = duckdb.connect(str(ROOT / "monke.duckdb"), read_only=True)
out = ROOT / "derived"
out.mkdir(exist_ok=True)
for (season,) in con.execute("select distinct season from player_week where season >= 2019 order by 1").fetchall():
    teams = {}
    for pid, week, team in con.execute("select player_id, week, team from player_week where season = ? and team is not null", [season]).fetchall():
        teams.setdefault(pid, {})[week] = team
    played = {}
    for team, week in con.execute("select home_team, week from nfl_game where season = ? union all select away_team, week from nfl_game where season = ?", [season, season]).fetchall():
        played.setdefault(team, set()).add(week)
    weeks = sorted({w for s in played.values() for w in s})
    byes = {t: [w for w in weeks if w not in s] for t, s in played.items()}
    (out / f"teams_{season}.json").write_text(json.dumps({"teams": teams, "byes": byes}))
    print(season, len(teams), "players")
