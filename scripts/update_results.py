#!/usr/bin/env python3
"""Pull 2026 NFL regular-season results (and point spreads) into data/results.json.

Source: ESPN's public scoreboard feed (free, no API key), which also carries
sportsbook lines for upcoming games. Runs from the GitHub Action in
.github/workflows/update-results.yml, or by hand:

    python scripts/update_results.py              # scores, all 18 weeks
    python scripts/update_results.py --odds       # scores + refresh spreads
    python scripts/update_results.py --weeks 3 4

Spreads are only refreshed with --odds (the Action passes it on Tuesdays,
once the new week's lines are up). Other runs keep the last saved line, so a
finished game keeps the line it was last listed at.

The file is only rewritten when a game actually changed, so the Action
doesn't commit every time it wakes up.
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

SEASON = 2026
WEEKS = 18
URL = ("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard"
       "?dates={season}&seasontype=2&week={week}&limit=100")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "results.json")

# ESPN abbreviations that differ from the ones the app uses
ABBR = {"WSH": "WAS", "JAC": "JAX", "LA": "LAR"}

TEAMS = {
    "ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN", "DET",
    "GB", "HOU", "IND", "JAX", "KC", "LAC", "LAR", "LV", "MIA", "MIN", "NE",
    "NO", "NYG", "NYJ", "PHI", "PIT", "SEA", "SF", "TB", "TEN", "WAS",
}


def fetch(week, tries=4):
    url = URL.format(season=SEASON, week=week)
    # Leave the default Python User-Agent alone: ESPN's CDN answers 403 to
    # custom agents and to anything pretending to be a browser.
    req = urllib.request.Request(url)
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            client_err = isinstance(e, urllib.error.HTTPError) and 400 <= e.code < 500 and e.code != 429
            if client_err or attempt == tries - 1:
                raise
            wait = 2 ** (attempt + 1)
            print(f"  week {week}: {e} — retrying in {wait}s", file=sys.stderr)
            time.sleep(wait)


def score(c):
    try:
        return int(c.get("score"))
    except (TypeError, ValueError):
        return None


def parse_line(comp):
    """Spread and total from the first sportsbook listed, or None."""
    for o in comp.get("odds") or []:
        at, ht = o.get("awayTeamOdds") or {}, o.get("homeTeamOdds") or {}
        fav = "a" if at.get("favorite") else "h" if ht.get("favorite") else None
        try:
            spread = abs(float(o["spread"])) if o.get("spread") is not None else None
        except (TypeError, ValueError):
            spread = None
        if spread is None and fav is None:
            continue
        line = {"fav": fav if spread else None, "sp": spread or 0}
        if o.get("overUnder") is not None:
            line["ou"] = o["overUnder"]
        return line
    return None


def parse_week(week, payload):
    games = []
    for ev in payload.get("events", []):
        comp = ev["competitions"][0]
        side = {}
        for c in comp["competitors"]:
            ab = c["team"]["abbreviation"]
            side[c["homeAway"]] = (ABBR.get(ab, ab), c)
        if "home" not in side or "away" not in side:
            continue
        (a, ac), (h, hc) = side["away"], side["home"]
        if a not in TEAMS or h not in TEAMS:
            print(f"  week {week}: unknown team {a} or {h}, skipped", file=sys.stderr)
            continue

        st = ev["status"]["type"]
        state = st.get("state", "pre")  # pre | in | post
        if st.get("name") in ("STATUS_POSTPONED", "STATUS_CANCELED"):
            state = "pre"

        g = {"w": week, "a": a, "h": h, "kick": ev.get("date"), "st": state}
        line = parse_line(comp)
        if line and state == "pre":
            g["line"] = line
        if state in ("in", "post"):
            g["as"], g["hs"] = score(ac), score(hc)
        if state == "in":
            g["clock"] = st.get("shortDetail")
        if state == "post":
            if ac.get("winner"):
                g["win"] = "a"
            elif hc.get("winner"):
                g["win"] = "h"
            elif g["as"] is not None and g["as"] == g["hs"]:
                g["win"] = "t"
            elif g["as"] is not None and g["hs"] is not None:
                g["win"] = "a" if g["as"] > g["hs"] else "h"
            else:
                g["st"] = "pre"  # final with no scores: don't trust it
            detail = st.get("shortDetail") or ""
            if "OT" in detail:
                g["ot"] = True
        games.append(g)
    games.sort(key=lambda g: (g["kick"] or "", g["a"]))
    return games


def load_existing():
    try:
        with open(OUT) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {"season": SEASON, "games": []}


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--weeks", type=int, nargs="*", help="only refresh these weeks")
    ap.add_argument("--odds", action="store_true", help="also refresh point spreads")
    args = ap.parse_args()
    weeks = args.weeks or list(range(1, WEEKS + 1))

    old = load_existing()
    old_lines = {(g["w"], g["a"], g["h"]): g["line"] for g in old.get("games", []) if g.get("line")}
    by_week = {}
    for g in old.get("games", []):
        by_week.setdefault(g["w"], []).append(g)

    failed = 0
    for w in weeks:
        try:
            fresh = parse_week(w, fetch(w))
            for g in fresh:
                key = (g["w"], g["a"], g["h"])
                if not args.odds or "line" not in g:
                    # keep the saved line; only --odds runs replace it
                    g.pop("line", None)
                    if key in old_lines:
                        g["line"] = old_lines[key]
            by_week[w] = fresh
            done = sum(1 for g in by_week[w] if g["st"] == "post")
            print(f"week {w:2}: {len(by_week[w])} games, {done} final")
        except Exception as e:  # keep what we had for this week
            failed += 1
            print(f"week {w:2}: FAILED ({e}); keeping previous data", file=sys.stderr)

    games = [g for w in sorted(by_week) for g in by_week[w]]
    if failed == len(weeks):
        sys.exit("every request failed — leaving results.json alone")

    if games == old.get("games"):
        print("no changes")
        return

    out = {
        "season": SEASON,
        "source": "ESPN public scoreboard",
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
