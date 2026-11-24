# Token Radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/tye59870-create/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/tye59870-create/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token Radar ranks the pre-token protocols by what their launch would be worth, and shows how to
farm each one. It reads a sealed snapshot of every protocol DefiLlama tracks, works out which ones
still record no token and are not a wrapped or staked product of one that trades, and hands in a web
dashboard: the board, a detail view for each protocol, and the steps to farm it.

## The model (radar-2)

Implied value follows only from the snapshot's own figures. No protocol name is special-cased.

```
implied = round(tvl_usd x ratio x growth x maturity x chains)
```

- **ratio** — the comparables argument: the median market-cap-to-TVL of the token-bearing
  protocols in the same category, computed from this snapshot (at least 3 comparables); a category
  whose token has never traded takes the market-wide median.
- **growth** — `1 + clamp(change_7d, -40, +60) / 100 x 0.6`.
- **maturity** — `0.7 + min(age_days, 1095) / 1095 x 0.3`: how long the protocol has run with no token.
- **chains** — `1 + 0.01 x min(chains - 1, 8)`: how widely it already reaches.

The board covers all 40 watchlist protocols and adds the pre-token protocols below the $50M floor
that the watchlist rule keeps — 178 rows in all. The live-token protocols are set aside with their
market caps shown, never mixed into the ranking. Each row carries a six-step farm plan derived from
the protocol's own category, chains, TVL and age, with what each step costs and how long it takes.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|directory>
```

Node 22, standard library only; there is nothing to install. The program writes `board.json`,
`data.js`, `dashboard/` and `screenshots/` to the output directory, then `dossier.json` with the
vendored make.fun library.

## Layout

| Path | What it is |
| --- | --- |
| `main.ts` | The entrypoint: reads the snapshot, builds the board, writes the output. |
| `lib/model.ts` | The radar-2 model, the farm plans, and the board builder. |
| `vendor/makefun-board.ts` | make.fun's dossier library, as shipped in the kit. |
| `dashboard/` | The static page: `index.html`, `app.css`, `app.js`. No network. |
| `screenshots/` | The board, a protocol's detail view, and a filtered view — stored as base64 text (`*.png.b64`, so the repository pushes as UTF-8) and decoded to PNG by `main.ts`. |

## Read it as a record, not a promise

A protocol on this board records no token in the snapshot; that is DefiLlama's record, not proof it
has none. Implied value is this entry's own claim about what a launch would be worth if the
protocol's record stayed as it is. It does not predict whether or when a token is issued.
