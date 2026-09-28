#!/usr/bin/env python3
"""Pull 2026 NFL regular-season results (and point spreads) into data/results.json.

Source: the nflverse schedules dataset — a free, public, documented NFL data
set published under CC BY 4.0 (https://github.com/nflverse/nflverse-data).
No API key. One small CSV covers the whole season: kickoff times, final
scores, overtime, and the betting spread and total for the current and next
week. The site credits nflverse, as the license requires.

Runs from the GitHub Action in .github/workflows/update-results.yml, or by hand:

    python scripts/update_results.py              # scores
    python scripts/update_results.py --odds       # scores + refresh spreads

The Action runs this once a day at 8 AM Eastern with --odds: it finalizes
every game played since the previous morning and refreshes the lines for games
still to be played. Without --odds the saved lines are kept; either way a
finished game keeps the line it was last listed at.

The file is only rewritten when a game actually changed, so the Action
doesn't commit every time it wakes up.
"""
import argparse
import csv
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

SEASON = 2026
URL = "https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "results.json")
EASTERN = ZoneInfo("America/New_York")   # nflverse kickoff times are US Eastern

# nflverse abbreviations that differ from the ones the app uses
ABBR = {"LA": "LAR", "WSH": "WAS", "JAC": "JAX"}

TEAMS = {
    "ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN", "DET",
    "GB", "HOU", "IND", "JAX", "KC", "LAC", "LAR", "LV", "MIA", "MIN", "NE",
    "NO", "NYG", "NYJ", "PHI", "PIT", "SEA", "SF", "TB", "TEN", "WAS",
}


def fetch(tries=4):
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(URL, timeout=60) as r:
                return r.read().decode("utf-8")
        except (urllib.error.URLError, TimeoutError) as e:
            client_err = isinstance(e, urllib.error.HTTPError) and 400 <= e.code < 500 and e.code != 429
            if client_err or attempt == tries - 1:
                raise
            wait = 2 ** (attempt + 1)
            print(f"  {e} — retrying in {wait}s", file=sys.stderr)
            time.sleep(wait)


def num(v, kind=float):
    try:
        return kind(v) if v not in ("", "NA", None) else None
    except ValueError:
        return None


def kickoff(day, clock):
    """'2026-09-27', '13:00' (Eastern) -> '2026-09-27T17:00Z'"""
    try:
        local = datetime.strptime(f"{day} {clock or '13:00'}", "%Y-%m-%d %H:%M").replace(tzinfo=EASTERN)
    except ValueError:
        return None
    return local.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%MZ")


def parse(text, now):
    games = []
    for r in csv.DictReader(io.StringIO(text)):
        if r.get("season") != str(SEASON) or r.get("game_type") != "REG":
            continue
        a, h = ABBR.get(r["away_team"], r["away_team"]), ABBR.get(r["home_team"], r["home_team"])
        if a not in TEAMS or h not in TEAMS:
            print(f"  unknown team {a} or {h}, skipped", file=sys.stderr)
            continue
        g = {"w": int(r["week"]), "a": a, "h": h, "kick": kickoff(r["gameday"], r["gametime"])}
        a_s, h_s = num(r["away_score"], int), num(r["home_score"], int)
        if a_s is not None and h_s is not None:
            g["st"] = "post"
            g["as"], g["hs"] = a_s, h_s
            g["win"] = "a" if a_s > h_s else "h" if h_s > a_s else "t"
            if r.get("overtime") == "1":
                g["ot"] = True
        else:
            # this data set has no live scores: a game that has kicked off but
            # has no final yet is shown as in progress
            k = datetime.strptime(g["kick"], "%Y-%m-%dT%H:%MZ").replace(tzinfo=timezone.utc) if g["kick"] else None
            g["st"] = "in" if k and k <= now < k + timedelta(hours=5) else "pre"
            # spread_line is from the home side: positive = home favoured
            sp, ou = num(r.get("spread_line")), num(r.get("total_line"))
            if sp is not None:
                g["line"] = {"fav": "h" if sp > 0 else "a" if sp < 0 else None, "sp": abs(sp)}
                if ou is not None:
                    g["line"]["ou"] = ou
        games.append(g)
    games.sort(key=lambda g: (g["w"], g["kick"] or "", g["a"]))
    return games


def load_existing():
    try:
        with open(OUT) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {"season": SEASON, "games": []}


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--odds", action="store_true", help="also refresh point spreads")
    args = ap.parse_args()

    old = load_existing()
    old_lines = {(g["w"], g["a"], g["h"]): g["line"] for g in old.get("games", []) if g.get("line")}

    try:
        games = parse(fetch(), datetime.now(timezone.utc))
    except Exception as e:
        sys.exit(f"fetch failed ({e}) — leaving results.json alone")
    if len(games) < 200:
        sys.exit(f"only {len(games)} games in the feed — looks wrong, leaving results.json alone")

    for g in games:
        key = (g["w"], g["a"], g["h"])
        fresh = g.pop("line", None)
        if g["st"] == "pre" and args.odds and fresh:
            g["line"] = fresh
        elif key in old_lines:
            g["line"] = old_lines[key]   # keep the saved line; only --odds runs replace it

    if games == old.get("games"):
        print("no changes")
        return

    out = {
        "season": SEASON,
        "source": "nflverse (CC BY 4.0)",
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "games": games,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(out, f, separators=(",", ":"))
        f.write("\n")
    print(f"wrote {len(games)} games, {sum(g['st'] == 'post' for g in games)} final, "
          f"{sum('line' in g for g in games)} with spreads")


if __name__ == "__main__":
    main()
