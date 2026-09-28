# Bracketeer

A single-page app for picking all 272 games of the 2026 NFL regular season, then
running your own playoff bracket. Real NFL tiebreakers decide the standings and
seeding. Installable on Android as a PWA, works offline once installed.

## What's here

```
index.html              the whole app — markup, styles, schedule, engine
manifest.webmanifest    PWA metadata (name, icons, colours, start URL)
sw.js                   service worker: offline cache for the app shell
icons/                  app icons, including maskable versions for Android
logos/                  team logos (off by default — see Team logos)
data/results.json       real scores and finals, refreshed automatically
scripts/update_results.py   pulls scores and spreads from the nflverse data set
.github/workflows/update-results.yml   runs that script on a schedule
```

## Results

`scripts/update_results.py` reads the schedules file from
[nflverse](https://github.com/nflverse/nflverse-data) — a free, public,
documented NFL data set published under **CC BY 4.0**, so it can be used on a
commercial site as long as it's credited (the page footer and the bracket
image both do). No API key, standard library only; one CSV covers the whole
season. It writes `data/results.json`.

There is no free *official* NFL API — the league's own feeds are licensed to
partners only — so nflverse is the most established openly licensed source.
It isn't live, which suits a board built around picking the games that haven't
been played. The **Update game results** GitHub Action runs it once a day at
**8:00 AM Eastern**: every game played since the last run (Thursday, Sunday and
Monday nights, international mornings) is finalized and locked on everyone's
board, and the betting lines are refreshed. It commits only when something
actually changed, and Pages redeploys on each commit.

GitHub schedules in UTC with no daylight saving, so the workflow is triggered
at both 12:00 and 13:00 UTC and keeps whichever one is 8 AM in New York that
day (decided from New York's UTC offset, so a late start by GitHub still
counts). Run it by hand any time from the Actions tab (*Run workflow*).

In the app, finished games are filled in and locked, standings start from the
real season, and you pick the rest. The site opens on the current week: the first week with
games still to play, rolling over Tuesday morning after Monday night football.

### Point spreads

The same script saves the point spread and over/under for upcoming games from
the same nflverse file, which carries lines for the current and next week. The
daily 8 AM run refreshes them (`--odds`) for every game not yet played, so line
moves show up each morning; a finished game keeps the last line it had. Game cards show them, and **Favorites** picks the favoured side of every
game left in a week. Run *Update game results* by hand from the Actions tab to
refresh lines any time.

Scheduled workflows only run from the default branch, so the Action starts once
this is merged to `main`. Run it by hand from the Actions tab (*Run workflow*),
or locally with `python scripts/update_results.py`. In the repo's Settings →
Actions → General, workflow permissions must allow **Read and write**.

Everything uses relative paths, so it works from any subdirectory.

## Publishing on GitHub Pages

1. Push this folder to a repo.
2. Settings → Pages → Source: **Deploy from a branch**, branch `main`, folder `/ (root)`
   (or `/docs` if you put these files there).
3. Open the published URL on a phone and tap **Install** in the header.

## Installing as an app

- **Android (Chrome, Edge, Samsung Internet):** **Install** opens the
  browser's own install sheet, with screenshots from `icons/screenshots/`.
  Android crops the icon to the device's shape using the maskable icons.
- **iPhone / iPad:** iOS gives websites no install prompt, so **Install**
  shows the two taps it takes: Share → *Add to Home Screen* (Safari, or Chrome
  on iOS 16.4+). The home-screen icon is `icons/apple-touch-icon.png`,
  full-bleed so iOS can round its corners.
- Installed, it opens full-screen, respects the notch and home indicator, and
  works offline. Long-press the icon on Android for *Playoff bracket* and
  *Standings* shortcuts; `#playoffs`, `#standings` and `#rules` links open
  those tabs directly.

`icons/logo-master.png` is the full-size logo (1254px, background cleaned,
mark centred); every icon is generated from it: rounded tiles for
desktop/Android (`icon-*.png`), full-bleed for iOS (`apple-touch-icon*.png`),
maskable with the mark inside Android's safe circle, and bolder, tighter-cropped
favicons (`favicon-16/32.png`) so the strokes survive at tab size.

After changing icons, bump `VERSION` in `sw.js`. iOS caches home-screen icons
hard, so an already-installed iPhone copy may need removing and re-adding to
pick up a new icon.

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

**Games** — click a team to pick it. **Share** makes an image of the week (or,
in *By team*, that team's season) and opens the phone's share sheet. *Tie* sets a drawn game. Arrow keys move
between weeks. *Favorites* (or *Home teams*, for weeks
whose betting lines aren't out yet) and *Random* fill the unplayed games of a
week in one go. Finished games show the final score and can't be changed.

**Games → By team** — pick one team's whole season at once, with *Win out* /
*Lose out* shortcuts.

**Standings** — division tables and 1–7 seeding for each conference, with every
tiebreaker that fired listed underneath and explained.

**Standings → 2027 Draft order** — round 1 as your season stands (before
trades): non-playoff teams by worst record, then playoff teams by the round they
go out in your bracket, ties broken by strength of schedule.

**Playoffs** — a full bracket: AFC on the left, NFC on the right, Super Bowl in
the middle. Nothing is picked until you click a team to advance it. **Share**
(top right, and again under the champion) makes an image of the bracket and
opens the phone's share sheet (it downloads the image where sharing files isn't
supported). **Clear** resets just the bracket; *Clear* on the Games tab opens a
small menu: clear just that week (or team), or all picks — and resets the bracket
either way, since changing picks reshuffles the seeds.

**Rules** — the tiebreaker ladder as implemented.

## Saving

Picks save to `localStorage` automatically, so they're there when you come back
on the same device and browser. There's no file export or cross-device sync for
now — that's planned to come back with accounts/login. *Clear* on the Games tab
resets a week (and the bracket); *Clear* on the Playoffs tab resets the bracket.

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

## Team logos and colours

Logos are **off** by default (`USE_LOGOS = false` in `index.html`): the team
logos in `logos/` are NFL trademarks. Instead every team shows as a round
badge filled with its official primary colour and ringed in its official
secondary colour (`k` and `k2` in `TEAMS`, taken from each club's brand
palette), with the abbreviation in white or near-black, whichever has more
contrast. Small badges that sit next to the team's name drop the text.

Setting `USE_LOGOS = true` switches the page and the shared bracket image to
the logo images, no other changes needed.

## Ads (Google AdSense)

Ad slots are placed so they can't slow the app down or get in the way:

- **Wide screens (1660px+):** side rails in the empty margins, up to three
  160×600 units per side. Each sits in its own ~1150px stretch of the page and
  stays pinned while that stretch scrolls by, so each one is actually seen.
  Short pages (like Playoffs) just show one; the rest never load.
- **Laptops (941–1659px):** one 300×250 per tab at a natural break, plus one
  under the Playoff picture in the sidebar on screens at least 900px tall
  (where the card and the ad both fit without scrolling past each other).
- **Phones (≤880px):** in-feed 300×250s at natural breaks, never above the
  first screen and kept ~550px+ apart:
  - *Games:* after games 4 and 9, and before the Playoff picture.
  - *Standings:* after each conference's division tables, between AFC and
    NFC, before the draft order and before the tiebreakers.
  - *Playoffs:* between the AFC and NFC brackets, and below the Super Bowl.
  - *Rules:* two, between sections.

  That keeps ads at 15–24% of each tab's height, under the 30% mobile
  ad-density ceiling Google enforces via the Better Ads Standards. Never
  sticky, never a pop-up, and kept clear of the pick buttons to avoid
  accidental taps.
- Every slot has its size reserved up front (nothing jumps), sits outside the
  parts of the page that re-render when you pick (an ad is never reloaded by a
  tap), and only loads once the page is idle and the slot is about to scroll
  into view. An empty fill folds away.

Until AdSense is configured the slots show dashed placeholders
(`ADSENSE.placeholders: false` hides them). To switch real ads on:

1. Put the site on a domain you own (AdSense won't approve a `github.io`
   address) — GitHub Pages supports custom domains.
2. Get approved in AdSense, then create two *Display* ad units with fixed
   sizes: 160×600 (rail) and 300×250 (inline).
3. In `index.html`, fill in `ADSENSE.client` (`ca-pub-…`) and the two slot IDs.
4. Add an `ads.txt` file at the site root with the line AdSense gives you.
5. Leave AdSense **Auto ads off** — they inject ads into the content and cause
   the jank this layout is designed to avoid.
