# Pick 'Em '26

A single-page app for picking all 272 games of the 2026 NFL regular season, then
running your own playoff bracket. Real NFL tiebreakers decide the standings and
seeding. Installable on Android as a PWA, works offline once installed.

## What's here

```
index.html              the whole app — markup, styles, schedule, engine
manifest.webmanifest    PWA metadata (name, icons, colours, start URL)
sw.js                   service worker: offline cache for the app shell
icons/                  app icons, including maskable versions for Android
logos/                  team logos, one PNG per team abbreviation
data/results.json       real scores and finals, refreshed automatically
scripts/update_results.py   pulls results from ESPN's free public scoreboard
.github/workflows/update-results.yml   runs that script on a schedule
```

## Live results

`scripts/update_results.py` reads ESPN's public scoreboard feed (no API key,
standard library only) and writes `data/results.json`. The **Update game
results** GitHub Action runs it every 20 minutes during game windows and every
two hours otherwise, and commits only when a score actually changed. Pages
redeploys on each commit.

In the app, finished games are filled in and locked, standings start from the
real season, and you pick the rest. Picks you made before a game are graded
(**picks correct**). The site opens on the current week: the first week with
games still to play, rolling over Tuesday morning after Monday night football.

Scheduled workflows only run from the default branch, so the Action starts once
this is merged to `main`. Run it by hand from the Actions tab (*Run workflow*),
or locally with `python scripts/update_results.py`. In the repo's Settings →
Actions → General, workflow permissions must allow **Read and write**.

Everything uses relative paths, so it works from any subdirectory.

## Publishing on GitHub Pages

1. Push this folder to a repo.
2. Settings → Pages → Source: **Deploy from a branch**, branch `main`, folder `/ (root)`
   (or `/docs` if you put these files there).
3. Open the published URL on Android in Chrome. You'll get an **Install app**
   button in the header, or use Chrome's ⋮ → *Add to Home screen*.

The service worker needs HTTPS, which GitHub Pages provides. Opening
`index.html` straight off disk still works — you just don't get offline caching
or the install prompt.

### Updating after you change the app

Browsers cache aggressively once a service worker is installed. Bump `VERSION`
in `sw.js` whenever you edit `index.html`:

```js
const VERSION = 'v1.0.1';   // was v1.0.0
```

The old caches get deleted on the next visit and the new files load.

## Using it

**Games** — click a team to pick it. *Tie* sets a drawn game. Arrow keys move
between weeks. *Home teams* and *Random* fill the unplayed games of a week in
one go. Finished games show the final score and can't be changed.

**Games → By team** — pick one team's whole season at once, with *Win out* /
*Lose out* shortcuts.

**Standings** — division tables and 1–7 seeding for each conference, with every
tiebreaker that fired listed underneath and explained.

**Standings → 2027 Draft order** — round 1 as your season stands (before
trades): non-playoff teams by worst record, then playoff teams by the round they
go out in your bracket, ties broken by strength of schedule.

**Playoffs** — a full bracket: AFC on the left, NFC on the right, Super Bowl in
the middle. Nothing is picked until you click a team to advance it. **Save bracket image** exports a PNG
built for sharing; on Android you'll also get **Share bracket**, which opens the
system share sheet directly.

**Rules** — the tiebreaker ladder as implemented.

## Saving

Picks save to `localStorage` automatically. **Board ▾ → Save picks to file** downloads a JSON copy —
use that to move a board between devices, or before clearing. **Clear all picks** asks
first and tells you how much you're about to lose.

## Known limitation

Six of the NFL's tiebreakers compare points scored and allowed. This board records
who won, not by how much, so those steps can't run. A tie that survives strength
of schedule goes to a coin toss, shown on the Standings tab with a **Flip** button
so you can set it yourself. Across 1,500 simulated seasons that happened 11 times.

## Data

The 2026 schedule is the league's May 14, 2026 release — all 272 games including
the nine international games and every bye week. Week 16, 17 and 18 kickoff
times were still TBD at release; the matchups themselves are final, which is all
this app needs.

## Ads (Google AdSense)

Two 160×600 ad slots sit in the side margins, fixed in place and outside the
page layout, so they can't shift or slow the app. They only appear on screens
at least 1660px wide, where there is empty margin; phones and laptops never
load the ad script. Until configured they show a dashed placeholder.

To switch them on:

1. Put the site on a domain you own (AdSense won't approve a `github.io`
   address) — GitHub Pages supports custom domains.
2. Get approved in AdSense, then create two *Display* ad units, fixed size
   160×600.
3. In `index.html`, fill in `ADSENSE.client` (`ca-pub-…`) and the two slot IDs.
4. Add an `ads.txt` file at the site root with the line AdSense gives you.
5. Leave AdSense **Auto ads off** — they inject ads into the content and cause
   the jank the fixed rails are there to avoid.
