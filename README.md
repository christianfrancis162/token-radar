# Token Radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/christianfrancis162/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/christianfrancis162/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar: it ranks protocols that record no token yet by what a token
would be worth if the protocol's record stayed as it is, and gives every one a
concrete farm plan. Built for make.fun's `token-radar-01` bounty.

## What it does

`main.ts` (Node 22, standard library only) reads the sealed snapshot at
`/input/snapshot.json` and writes to `/output`:

- `board.json` — the ranked board. Every one of the snapshot's 40 watchlist slugs,
  plus every other protocol that passes the watchlist's own rule (records no token,
  not a wrapped, staked or bridged product, not an exchange, not a versioned pool).
  198 rows here. Ranks are exactly 1..N and implied values never rise with rank.
- `data.js` — the same board, compact, for the dashboard, plus the fitted model, the
  validation and the coverage of all 758 protocols.
- `dashboard/` — a static page (no network, no framework): sortable and filterable
  board, a detail view per protocol with the model's breakdown and farm plan, an
  "Already trading" view that keeps traded tokens apart from launch candidates, a
  coverage view that accounts for all 758 protocols with a status and a reason, a KPI
  strip (total implied value, protocols ranked, farm plans, top category, holdout
  error), and a page explaining the fitted model and its validation.
- `screenshots/` — three renders of the dashboard: the board, a protocol detail
  view, and a filtered view.
- `dossier.json` — built with `buildDossier` from `vendor/makefun-board.ts`.

## The model (radar-3)

`impliedValue` in `lib/model.ts` scores every protocol the same way, from the
snapshot's own figures only — no protocol name is ever special-cased, and no multiple
is assumed. The model fits itself to the snapshot on every run: the 128 protocols
that record both a TVL and a market cap above zero are the comparables, and an
ordinary-least-squares fit of log(mcap/TVL) on category, log chain count and log age
gives the fitted multiple:

```
implied = TVL × fitted multiple × momentum
fitted multiple = exp(OLS fit of log(mcap/TVL) on 128 comparables:
  category + log(chains) + log1p(age in days))
momentum = clamp(1 + 0.3 × clamp(7d growth, −50%, +50%) / 100, 0.85, 1.15)
```

The fitted baseline multiple is 0.28 for the reference category (1 chain, 365 days);
Dexs 0.40, RWA 0.26, Lending 0.17, Yield 0.17, Bridge 0.24, Liquid Staking 0.06.
The comparables' own median mcap/TVL is 0.21. A free slope on log(TVL) fits 0.50,
which would hand a $28M-TVL protocol a multiple near 19x and rank it above protocols
a hundred times its size, so the TVL elasticity is fixed at 1 and the multiple is the
fitted quantity. Seven-day growth is not in the regression: the comparables all come
from a down week (their median change is −9.3%), so the fitted growth slope is not
significant (t = −1.7) and would let one noisy week crush fast growers — growth enters
instead as the capped momentum term above, at most ±15%.

Validation is computed on every run and shown in the dashboard's model tab: a random
80/20 holdout (every fifth comparable by slug) gives a median error of 82.7% on the
predicted market cap, and a walk-forward split by listing date (train on listings
before 2024-02-18, test on the newer half) gives 93.6%. The errors are large because
crypto multiples are extremely dispersed — the comparables' own mcap/TVL runs from
0.03 to 1.00 — so the fit sets the level and the category differences, not a launch
price to the dollar. The board's top pick is Sentora Curator at $680.1M, with
Steakhouse Financial (the v1 top pick, $644.5M) second at $619.4M. Ties are broken by
$1 so every rank is a distinct claim. "Records no token" means the snapshot's record
carries no token — it is not proof the protocol has none.

## Farm plans

`farmSteps` in `lib/model.ts` (mirrored in `dashboard/app.js` so the page shows
exactly what the board carries) writes seven steps per protocol from its category,
first chain, TVL and age: a fresh wallet, the category's action with capital and
gas for its chain, a weekly action, a hold of 30–90 days, a claim-safety check, a
farm log with an exit plan, and a seventh step that prices the whole plan — capital
plus gas over the hold, the break-even airdrop value, and what a 1% share of the
implied value would be against that cost. Every step names what it costs and how
long it takes.

## Run it locally

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <kit>/input/snapshot.json
```

Then open `out/dashboard/index.html` in a browser (it reads `out/data.js`).
Views by address: `?view=detail&slug=<slug>` opens one protocol,
`?view=filtered&category=<name>` opens the board filtered,
`?tab=live` or `?tab=model` opens the other views.

## Layout

- `main.ts` — entrypoint: reads the snapshot, writes the board, data, dashboard,
  screenshots and dossier.
- `lib/model.ts` — the model, the farm plans, the snapshot parser and the board
  checks.
- `vendor/makefun-board.ts` — make.fun's dossier library, unchanged.
- `dashboard/` — `index.html`, `app.css`, `app.js`.
- `screenshots/` — `1-board.jpg`, `2-detail.jpg`, `3-filtered.jpg`.
