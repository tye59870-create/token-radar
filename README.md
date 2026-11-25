# Token Radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/tye59870-create/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/tye59870-create/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token Radar ranks the pre-token protocols by what their launch would be worth, and shows how to
farm each one. It reads a sealed snapshot of every protocol DefiLlama tracks, works out which ones
still record no token and are not a wrapped or staked product of one that trades, and hands in a web
dashboard: the board, a detail view for each protocol, and the steps to farm it.

## The model (radar-3)

Implied value follows only from the snapshot's own figures. No protocol name is special-cased.

```
implied = round(tvl_usd x ratio x (1 + clamp(change_7d, -25, +40) / 100 x 0.3)
                x maturity(age) x (1 + 0.015 x min(chains - 1, 10)))
```

- **ratio** — the comparables argument: the median market-cap-to-TVL of the token-bearing
  protocols in the same category, computed from this snapshot, with each token's market cap
  divided by the combined TVL of every protocol carrying its symbol, so one token shared across
  versions cannot inflate its ratio. A category with at least 3 comparables uses its own median;
  a thinner category takes the smaller of its median and its family median (Vaults & Curators,
  Lending & CDP, RWA & Yield); a category with no comparables takes the family median, or the
  market-wide median when it has no family. Centralised-exchange, bridge, liquid-staking and
  liquid-restaking protocols never enter the comparables pool.
- **growth** — `1 + clamp(change_7d, -25, +40) / 100 x 0.3`: a single week's move can no longer
  swing a valuation by 1.8x.
- **maturity** — a capped, non-monotone curve: it rises from 0.85x to 1.0x over the first 6 months,
  peaks at 1.0x for 6–18 months (the launch window for a radar), then falls to 0.85x by 3 years
  and 0.8x after that. Very old no-token protocols are less likely to launch, not more.
- **chains** — `1 + 0.015 x min(chains - 1, 10)`: how widely it already reaches.
- **launch signal** — a 0–100 score per row: age in the launch window, 7-day growth, chain count,
  and how much evidence its category ratio rests on.

The board covers all 40 watchlist protocols and adds the pre-token protocols below the $50M floor
that the watchlist rule keeps — 178 rows in all, after removing six sub-protocols whose parent
token already trades. The live-token protocols are set aside with their market caps shown, never
mixed into the ranking. Each row carries a six-step farm plan derived from the protocol's own
category, chains, TVL and age, with what each step costs and how long it takes. The plan is built
on the protocol's cheapest-gas chain, and an Ethereum-only plan recurs monthly rather than weekly,
so gas never exceeds the deposit it farms.

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
| `lib/model.ts` | The radar-3 model, the farm plans, and the board builder. |
| `vendor/makefun-board.ts` | make.fun's dossier library, as shipped in the kit. |
| `dashboard/` | The static page: `index.html`, `app.css`, `app.js`. No network. |
| `screenshots/` | The board, a protocol's detail view, a filtered view, and the live-token page — stored as base64 text (`*.png.b64`, so the repository pushes as UTF-8) and decoded to PNG by `main.ts`. |

## Read it as a record, not a promise

A protocol on this board records no token in the snapshot; that is DefiLlama's record, not proof it
has none. Implied value is this entry's own claim about what a launch would be worth if the
protocol's record stayed as it is. It does not predict whether or when a token is issued.
