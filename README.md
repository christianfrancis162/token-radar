# Token Radar

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
- `data.js` — the same board, compact, for the dashboard.
- `dashboard/` — a static page (no network, no framework): sortable and filterable
  board, a detail view per protocol with the model's breakdown and farm plan, an
  "Already trading" view that keeps traded tokens apart from launch candidates, and
  a page explaining the model.
- `screenshots/` — three renders of the dashboard: the board, a protocol detail
  view, and a filtered view.
- `dossier.json` — built with `buildDossier` from `vendor/makefun-board.ts`.

## The model (radar-2)

`impliedValue` in `lib/model.ts` scores every protocol the same way, from the
snapshot's own figures only — no protocol name is ever special-cased:

```
implied = TVL × 0.22
        × (1 + clamp(7d growth, −50%, +150%) / 100 × 0.6)
        × (0.55 + 0.45 × (1 − e^(−age days / 365)))
        × (1 + 0.04 × extra chains, up to 5)
```

TVL is the size of the business a token would capitalise; seven-day growth is the
only momentum the snapshot carries and is clamped hard; maturity saturates over one
year, because a protocol that has run a year with no token has already proved it can
wait; breadth pays for the distribution a launch would reach. Ties are broken by
$1 so every rank is a distinct claim. "Records no token" means the snapshot's record
carries no token — it is not proof the protocol has none.

## Farm plans

`farmSteps` in `lib/model.ts` (mirrored in `dashboard/app.js` so the page shows
exactly what the board carries) writes six steps per protocol from its category,
first chain, TVL and age: a fresh wallet, the category's action with capital and
gas for its chain, a weekly action, a hold of 30–90 days, a claim-safety check, and
a farm log with an exit plan. Every step names what it costs and how long it takes.

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
