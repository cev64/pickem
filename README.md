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
```

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

**Games** — click a team to pick it. `TIE` sets a drawn game. Arrow keys move
between weeks. *Home teams* and *Coin flip week* fill a week in one go.

**Standings** — division tables and 1–7 seeding for each conference, with every
tiebreaker that fired listed underneath and explained.

**Playoffs** — click a team to advance it. **Save bracket image** exports a PNG
built for sharing; on Android you'll also get **Share bracket**, which opens the
system share sheet directly.

**Rules** — the tiebreaker ladder as implemented.

## Saving

Picks save to `localStorage` automatically. **Save file** downloads a JSON copy —
use that to move a board between devices, or before clearing. **Clear all** asks
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
