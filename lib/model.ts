// Token Radar model (radar-3): deterministic scoring, ranking, and farm-plan generation
// from a single DefiLlama protocol snapshot.
//
// radar-3 changes over radar-2:
// - Comparables are aggregated by parent symbol: a token's market cap is divided by the
//   combined TVL of every protocol carrying that symbol. aave-v2 no longer reads Aave's
//   whole $1.72B market cap against its $90.9M v2 TVL (18.96x -> 0.11x).
// - Centralised-exchange, bridge, liquid-staking and liquid-restaking protocols are
//   excluded from the comparables pool, so they no longer drag the medians.
// - A category with fewer than 3 comparables no longer falls back to the market-wide
//   median: it is capped by its family-group median (Vaults & Curators, Lending & CDP,
//   RWA & Yield), or by the market median when it has no family. A single outlier
//   (Api3 at 2.97x) can no longer price a whole family, and thin families stop
//   inheriting the market rate. Veda's category (Onchain Capital Allocator) has two
//   live peers at 0.0191 and 0.0059, so Veda is now priced near them instead of at
//   the market rate.
// - Maturity is no longer "older is better": it peaks in the 6-18 month window when a
//   launch is most likely, and falls away for very young and very old protocols.
// - A week's price move is damped (weight 0.3, clamped to -25..+40) so one volatile
//   week cannot swing a valuation by 1.8x; chains count a little more (0.015 each).
// - Six sub-protocols whose parent token already trades are removed from the board.
// - Every row carries a launch/mining signal score (0-100).
//
// Scope of the ranked board:
// - Includes every protocol listed in snapshot.watchlist (the coverage floor).
// - Adds pre-token protocols below snapshot.floor_usd that pass the watchlist filter.
// - Fills the board to 178 rows from the largest pre-token protocols above the floor
//   that are not on the watchlist, so removing a launched sub-protocol does not shrink
//   the board.
// - Excludes live-token protocols from the ranking, setting them aside with market caps.
//
// Implied valuation formula (applied uniformly; no protocol name is special-cased):
//   ratio      = category median (mcap_usd / tvl_usd) for token-bearing protocols with >= 3
//                comparables, otherwise the smaller of the category median and its
//                family-group median, otherwise the market-wide median.
//   growth     = clamp(change_7d ?? 0, -25, +40)
//   growthMult = 1 + (growth / 100) * 0.3
//   maturity   = 0.85 + 0.15 * age/180                 (age < 180)
//              = 1.0                                    (180 <= age <= 540)
//              = 1.0 - 0.15 * (age-540)/555             (540 < age <= 1095)
//              = 0.85 - 0.05 * min(1, (age-1095)/1095)  (age > 1095)
//              = 0.9                                    (age unknown)
//   chains     = 1 + 0.015 * clamp(chains.length - 1, 0, 10)
//   implied    = max(1, round(tvl_usd * ratio * growthMult * maturity * chains))

// ---------------------------------------------------------------------------
// Public data structures
// ---------------------------------------------------------------------------

/** Single protocol record carried by the sealed snapshot input. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** Top-level sealed snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** Tunable parameters exposed to both the scorer and the dashboard. */
export interface ModelConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_young_floor: number;
  maturity_peak: number;
  maturity_sweet_start: number;
  maturity_sweet_end: number;
  maturity_decline_end: number;
  maturity_old_floor: number;
  unknown_maturity: number;
  chain_step: number;
  chain_cap: number;
  min_comparables: number;
}

/** One structured step in a protocol's farm plan. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** Ranked pre-token entry emitted to board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  signal_score: number;
  model: {
    ratio: number;
    ratio_n: number;
    ratio_source: string;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    chain_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** Compact per-protocol projection shipped to the static dashboard in data.js. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  signal_score: number;
  ratio: number;
  ratio_n: number;
  ratio_source: string;
  growth_multiplier: number;
  maturity_multiplier: number;
  chain_multiplier: number;
}

/** Category comparable summary for the dashboard's methodology panel. */
export interface RatioRow {
  category: string;
  ratio: number;
  n: number;
}

/** Live-token protocol displayed in the separate "Live token" view. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Complete payload serialized into window.RADAR for the dashboard. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  live_total: number;
  global_ratio: number;
  ratios: RatioRow[];
  watchlist: string[];
  rows: RadarRow[];
  live: LiveRow[];
}

/** Raised when snapshot.json fails schema or type validation. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

// ---------------------------------------------------------------------------
// Internal helper types & model constants
// ---------------------------------------------------------------------------

interface CategoryComparable {
  ratio: number;
  n: number;
}

interface ComparableTable {
  byCategory: Map<string, CategoryComparable>;
  byGroup: Map<string, number>;
  global: number;
}

interface ValuationResult {
  implied: number;
  ratio: number;
  ratioN: number;
  ratioSource: string;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  chainMult: number;
  age: number | null;
  signal: number;
}

interface PlaybookContext {
  name: string;
  capital: number;
  chain: string;
}

interface CategoryPlaybook {
  keywords: readonly string[];
  setup: (ctx: PlaybookContext) => string;
  weekly: (ctx: PlaybookContext) => string;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.3,
  growth_floor: -25,
  growth_cap: 40,
  maturity_young_floor: 0.85,
  maturity_peak: 1.0,
  maturity_sweet_start: 180,
  maturity_sweet_end: 540,
  maturity_decline_end: 1095,
  maturity_old_floor: 0.8,
  unknown_maturity: 0.9,
  chain_step: 0.015,
  chain_cap: 10,
  min_comparables: 3,
};

export const MODEL_VERSION = 'radar-3';

/** The board is filled to this many rows. */
export const BOARD_TARGET = 178;

const MS_PER_DAY = 86_400_000;
const FALLBACK_GLOBAL_RATIO = 0.2;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const VERSION_SUFFIX_RE = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const DERIVATIVE_WORD_RE = /\b(wrapped|staked|staking)\b/i;

/** Sub-protocols whose parent token already trades: they are not pre-token launches. */
const LAUNCHED_SUBPROTOCOLS: ReadonlySet<string> = new Set([
  'manta-cedefi',
  'bouncebit-prime',
  'xrpl-dex',
  'metalx-swap',
  'kava-mint',
  'flying-tulip-ftusd',
]);

const EXCLUDED_CATEGORIES: ReadonlySet<string> = new Set([
  'Bridge',
  'Canonical Bridge',
  'Cross Chain Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

/** Families of categories that share a valuation basis. A thin category is capped by its family. */
const CATEGORY_FAMILIES: ReadonlyMap<string, readonly string[]> = new Map([
  [
    'Vaults & Curators',
    ['Risk Curators', 'Onchain Capital Allocator', 'Yield Aggregator', 'Liquidity Manager', 'Vaults', 'Restaking'],
  ],
  [
    'Lending & CDP',
    ['Lending', 'CDP', 'Collateral Markets', 'Collateral Management', 'CDP Manager'],
  ],
  [
    'RWA & Yield',
    ['RWA', 'Yield', 'Stablecoins', 'Dual-Token Stablecoin'],
  ],
]);

const EXCHANGE_PREFIXES: readonly string[] = [
  'Binance',
  'Coinbase',
  'Bybit',
  'Kraken',
  'Bitget',
  'OKX',
  'Bitfinex',
  'Gemini',
];

/** Chains whose gas is cheap enough to farm weekly. Ethereum is the expensive outlier. */
const LOW_GAS_CHAINS: ReadonlySet<string> = new Set([
  'Base', 'Arbitrum', 'Optimism', 'Solana', 'Polygon', 'BSC', 'BNB Chain', 'Binance',
  'Avalanche', 'Blast', 'Linea', 'Scroll', 'zkSync Era', 'Mode', 'Sonic', 'Plasma',
  'Hyperliquid', 'Hyperliquid L1', 'Sui', 'Aptos', 'Monad', 'Stellar', 'Ink', 'Tron',
  'Mantle', 'Starknet', 'Stable', 'Robinhood Chain', 'Katana', 'Arc', 'Tempo', 'BOB',
  'Plume Mainnet', 'Fluent', 'Citrea', 'Mezo', 'Corn', 'Morph', 'Proton', 'Ripple',
  'Kava', 'Flare', 'Berachain', 'Unichain', 'Sei', 'Soneium', 'World Chain', 'Zora',
]);

const MIN_STEP_CHARS = 20;
const MAX_STEP_CHARS = 600;
const MIN_STEPS_PER_ROW = 3;
const MAX_STEPS_PER_ROW = 12;

// ---------------------------------------------------------------------------
// Generic math & comparison helpers
// ---------------------------------------------------------------------------

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function compareLex(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function roundTo4(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

function computeMedian(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when `text` contains `keyword` as a whole word or phrase (not as a substring). */
function hasKeyword(text: string, keyword: string): boolean {
  return new RegExp(`\\b${escapeRegExp(keyword)}`, 'i').test(text);
}

// ---------------------------------------------------------------------------
// Valuation & comparables
// ---------------------------------------------------------------------------

/** Whole days elapsed from `listedAt` to `asOf` (clamped at 0), or null if unavailable/invalid. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const endMs = Date.parse(`${asOf}T00:00:00Z`);
  const startMs = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(endMs) || !Number.isFinite(startMs)) return null;
  return Math.max(0, Math.floor((endMs - startMs) / MS_PER_DAY));
}

/** The family a category belongs to, or null when it has none. */
export function familyOf(category: string | null): string | null {
  if (category === null) return null;
  for (const [family, members] of CATEGORY_FAMILIES) {
    if (members.includes(category)) return family;
  }
  return null;
}

/**
 * Computes median mcap/TVL comparables from the token-bearing protocols in the snapshot.
 * Ratios are aggregated by parent symbol first: a token's market cap is divided by the
 * combined TVL of every protocol carrying that symbol, so a parent token's cap is never
 * read against one sub-protocol's TVL. Centralised-exchange, bridge, liquid-staking
 * and liquid-restaking protocols are excluded from the pool entirely.
 * Categories with fewer than `min` comparables are omitted from byCategory; their
 * family-group medians are computed from the same pool.
 */
export function comparables(snapshot: Snapshot): ComparableTable {
  const symbolTvl = new Map<string, number>();
  const symbolMcap = new Map<string, number>();
  const symbolCategory = new Map<string, string | null>();

  for (const protocol of snapshot.protocols) {
    const symbol = protocol.symbol;
    if (symbol === null) continue;
    symbolTvl.set(symbol, (symbolTvl.get(symbol) ?? 0) + (protocol.tvl_usd > 0 ? protocol.tvl_usd : 0));
    if (
      protocol.mcap_usd !== null &&
      protocol.gecko_id !== null &&
      protocol.mcap_usd > 0
    ) {
      const prev = symbolMcap.get(symbol);
      if (prev === undefined || protocol.mcap_usd > prev) {
        symbolMcap.set(symbol, protocol.mcap_usd);
        symbolCategory.set(symbol, protocol.category);
      }
    }
  }

  const categoryBuckets = new Map<string, number[]>();
  const familyBuckets = new Map<string, number[]>();
  const allRatios: number[] = [];

  for (const [symbol, mcap] of symbolMcap) {
    const category = symbolCategory.get(symbol) ?? null;
    if (category !== null && EXCLUDED_CATEGORIES.has(category)) continue;
    const tvl = symbolTvl.get(symbol) ?? 0;
    if (!(tvl > 0)) continue;

    const ratio = mcap / tvl;
    allRatios.push(ratio);

    if (category !== null) {
      let bucket = categoryBuckets.get(category);
      if (bucket === undefined) {
        bucket = [];
        categoryBuckets.set(category, bucket);
      }
      bucket.push(ratio);

      const family = familyOf(category);
      if (family !== null) {
        let familyBucket = familyBuckets.get(family);
        if (familyBucket === undefined) {
          familyBucket = [];
          familyBuckets.set(family, familyBucket);
        }
        familyBucket.push(ratio);
      }
    }
  }

  const global = computeMedian(allRatios) ?? FALLBACK_GLOBAL_RATIO;
  const byCategory = new Map<string, CategoryComparable>();
  for (const [category, ratios] of categoryBuckets) {
    const med = computeMedian(ratios);
    if (med !== null) {
      byCategory.set(category, { ratio: med, n: ratios.length });
    }
  }

  const byGroup = new Map<string, number>();
  for (const [family, ratios] of familyBuckets) {
    const med = computeMedian(ratios);
    if (med !== null) byGroup.set(family, med);
  }

  return { byCategory, byGroup, global };
}

/**
 * Resolves the comparable ratio and provenance for a single protocol.
 * A category with at least `min` comparables uses its own median. A thin category
 * uses the smaller of its own median and its family median, so one outlier (Api3
 * at 2.97x in Risk Curators) cannot inflate it, while a category whose own peers
 * are genuinely cheap (Onchain Capital Allocator at 0.0125) keeps its own level.
 * A category with no comparables uses its family median, or the market-wide median
 * when it has no family.
 */
export function ratioFor(
  p: SnapshotProtocol,
  table: ComparableTable,
  min: number,
): { ratio: number; n: number; source: string } {
  const catStats = p.category === null ? undefined : table.byCategory.get(p.category);
  if (catStats !== undefined && catStats.n >= min) {
    return {
      ratio: catStats.ratio,
      n: catStats.n,
      source: `${p.category} median`,
    };
  }

  const family = familyOf(p.category);
  const familyMedian = family === null ? undefined : table.byGroup.get(family);
  const cap = familyMedian !== undefined ? familyMedian : table.global;
  const capName = familyMedian !== undefined ? `${family} median` : 'market-wide median';

  if (catStats !== undefined) {
    return {
      ratio: Math.min(catStats.ratio, cap),
      n: catStats.n,
      source: `${p.category} median capped by ${capName}`,
    };
  }
  if (familyMedian !== undefined) {
    return { ratio: familyMedian, n: 0, source: `${family} median` };
  }
  return { ratio: table.global, n: 0, source: 'market-wide median' };
}

/**
 * The maturity multiplier: it peaks in the 6-18 month window when a token launch is
 * most likely, and falls away for very young protocols (unproven) and very old ones
 * (a protocol that has run for years with no token is less likely to launch one).
 * A `listed_at` shared by a whole category (DefiLlama's tracking start, not the
 * protocol's age) is treated like any other date: the curve is flat across the
 * sweet spot, so the cluster earns no artificial boost.
 */
export function maturityMultiplier(age: number | null, model: ModelConstants): number {
  if (age === null) return model.unknown_maturity;
  if (age < model.maturity_sweet_start) {
    return (
      model.maturity_young_floor +
      (model.maturity_peak - model.maturity_young_floor) * (age / model.maturity_sweet_start)
    );
  }
  if (age <= model.maturity_sweet_end) return model.maturity_peak;
  if (age <= model.maturity_decline_end) {
    const span = model.maturity_decline_end - model.maturity_sweet_end;
    return (
      model.maturity_peak -
      (model.maturity_peak - model.maturity_young_floor) * ((age - model.maturity_sweet_end) / span)
    );
  }
  const over = Math.min(1, (age - model.maturity_decline_end) / model.maturity_decline_end);
  return model.maturity_young_floor - (model.maturity_young_floor - model.maturity_old_floor) * over;
}

/**
 * A 0-100 launch/mining signal: how attractive this protocol is to farm right now.
 * Age in the 6-18 month sweet spot, positive momentum, many chains, and a category
 * whose tokens have actually launched all raise it.
 */
export function signalScore(
  protocol: SnapshotProtocol,
  age: number | null,
  ratioN: number,
): number {
  let ageScore: number;
  if (age === null) ageScore = 50;
  else if (age >= 180 && age <= 540) ageScore = 100;
  else if ((age >= 90 && age < 180) || (age > 540 && age <= 1095)) ageScore = 70;
  else if (age < 90) ageScore = 40;
  else ageScore = 30;

  const growthScore = clamp(50 + finiteOr(protocol.change_7d, 0), 0, 100);
  const chainScore = Math.min(100, protocol.chains.length * 10);
  const categoryScore = ratioN >= 3 ? 80 : ratioN >= 1 ? 50 : 30;

  return Math.round(
    0.35 * ageScore + 0.25 * growthScore + 0.15 * chainScore + 0.25 * categoryScore,
  );
}

/** Evaluates all multipliers and the final implied USD valuation for one protocol. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
  table: ComparableTable,
): ValuationResult {
  const age = ageDays(asOf, protocol.listed_at);
  const { ratio, n: ratioN, source: ratioSource } = ratioFor(protocol, table, model.min_comparables);

  const rawGrowth = finiteOr(protocol.change_7d, 0);
  const growthPct = clamp(rawGrowth, model.growth_floor, model.growth_cap);
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;

  const maturityMult = maturityMultiplier(age, model);

  const extraChains = clamp(protocol.chains.length - 1, 0, model.chain_cap);
  const chainMult = 1 + model.chain_step * extraChains;

  const rawImplied = protocol.tvl_usd * ratio * growthMult * maturityMult * chainMult;
  const implied = Math.max(1, Math.round(rawImplied));

  return {
    implied,
    ratio,
    ratioN,
    ratioSource,
    growthPct,
    growthMult,
    maturityMult,
    chainMult,
    age,
    signal: signalScore(protocol, age, ratioN),
  };
}

// ---------------------------------------------------------------------------
// Pre-token & eligibility rules
// ---------------------------------------------------------------------------

/** True when the snapshot records no market cap, CoinGecko id, or symbol. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * True when a protocol qualifies for the pre-token radar under the watchlist rule:
 * pre-token, not a launched sub-protocol, not in an excluded derivative/bridge/CEX
 * category, not version-suffixed, not named as wrapped/staked/staking, and not
 * prefixed with a major exchange name.
 */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (LAUNCHED_SUBPROTOCOLS.has(p.slug)) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSION_SUFFIX_RE.test(p.name)) return false;
  if (DERIVATIVE_WORD_RE.test(p.name)) return false;
  if (EXCHANGE_PREFIXES.some((prefix) => p.name.startsWith(prefix))) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Farm plan derivation
// ---------------------------------------------------------------------------

const CATEGORY_PLAYBOOKS: readonly CategoryPlaybook[] = [
  {
    keywords: ['collateral markets'],
    setup: ({ name, capital, chain }) =>
      `Supply $${capital} of collateral assets through ${name} on ${chain} and keep the position open.`,
    weekly: ({ name }) =>
      `Top up the collateral or move it between ${name} markets once a week so the wallet shows fresh activity.`,
  },
  {
    keywords: ['curator', 'allocator'],
    setup: ({ name, capital, chain }) =>
      `Deposit $${capital} into a ${name} vault on ${chain} and keep the vault shares in the same wallet.`,
    weekly: ({ name }) =>
      `Top up the vault or move between ${name} vaults once a week so the wallet shows fresh activity.`,
  },
  {
    keywords: ['indexes'],
    setup: ({ name, capital, chain }) =>
      `Buy $${capital} of the index token through ${name} on ${chain} and hold it in the same wallet.`,
    weekly: ({ name }) =>
      `Rebalance or top up the ${name} index position once a week.`,
  },
  {
    keywords: ['liquidity manager'],
    setup: ({ name, capital, chain }) =>
      `Deposit $${capital} into a ${name} managed liquidity position on ${chain} and keep it open.`,
    weekly: ({ name }) =>
      `Rebalance the ${name} position once a week.`,
  },
  {
    keywords: ['cedefi'],
    setup: ({ name, capital, chain }) =>
      `Deposit $${capital} into the ${name} CeDeFi vault on ${chain} and keep the position open.`,
    weekly: ({ name }) =>
      `Top up or rebalance the ${name} vault once a week.`,
  },
  {
    keywords: ['anchor btc'],
    setup: ({ name, capital, chain }) =>
      `Deposit $${capital} of BTC-backed collateral through ${name} on ${chain} and keep the position open.`,
    weekly: ({ name }) =>
      `Top up the ${name} position once a week.`,
  },
  {
    keywords: ['crypto card', 'card issuer'],
    setup: ({ name, capital }) =>
      `Order the card from ${name}, load $${capital} onto it and spend from it.`,
    weekly: ({ name }) =>
      `Make one card payment through ${name} each week.`,
  },
  {
    keywords: ['rwa'],
    setup: ({ name, capital, chain }) =>
      `Mint $${capital} of the yield-bearing asset on ${chain} through ${name} and hold it in the same wallet.`,
    weekly: ({ name }) =>
      `Claim or compound the yield on your ${name} position once a week so it stays active.`,
  },
  {
    keywords: ['lend', 'cdp', 'collateral'],
    setup: ({ name, capital, chain }) =>
      `Supply $${capital} of USDC to ${name} on ${chain}, then borrow a small amount against it and keep the position open.`,
    weekly: ({ name }) =>
      `Repay and re-borrow a small amount on ${name} each week to keep the position active.`,
  },
  {
    keywords: ['dex', 'leveraged farm'],
    setup: ({ name, capital, chain }) =>
      `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`,
    weekly: ({ name, chain }) =>
      `Swap a small amount through ${name}'s pool on ${chain} once a week.`,
  },
  {
    keywords: ['yield'],
    setup: ({ name, capital, chain }) =>
      `Deposit $${capital} into ${name}'s yield vault on ${chain} and keep the receipt token.`,
    weekly: ({ name }) =>
      `Harvest or compound the yield on ${name} once a week.`,
  },
  {
    keywords: ['basis trad'],
    setup: ({ name, capital }) =>
      `Deposit $${capital} of USDC as margin on ${name} and open one small delta-neutral position.`,
    weekly: ({ name }) =>
      `Roll or rebalance the ${name} position once a week.`,
  },
  {
    keywords: ['perpetual', 'derivative'],
    setup: ({ name, capital }) =>
      `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`,
    weekly: ({ name }) =>
      `Roll or rebalance the ${name} position once a week.`,
  },
  {
    keywords: ['insurance'],
    setup: ({ name, capital, chain }) =>
      `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active.`,
    weekly: ({ name }) =>
      `Check the ${name} policy each week and renew it before it lapses.`,
  },
  {
    keywords: ['staking', 'restak', 'staking pool'],
    setup: ({ name, capital }) =>
      `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt token.`,
    weekly: ({ name }) =>
      `Top up the stake on ${name} by a small amount once a week.`,
  },
  {
    keywords: ['governance'],
    setup: ({ name, capital, chain }) =>
      `Deposit $${capital} into ${name} on ${chain} and vote in its governance with the same wallet.`,
    weekly: ({ name }) =>
      `Vote on one ${name} proposal a week with the farming wallet.`,
  },
  {
    keywords: ['stable'],
    setup: ({ name, capital, chain }) =>
      `Mint $${capital} of the stable asset through ${name} on ${chain} and hold it in the same wallet.`,
    weekly: ({ name }) =>
      `Use the minted asset in ${name}'s app once a week.`,
  },
  {
    keywords: ['bridge'],
    setup: ({ name, capital, chain }) =>
      `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`,
    weekly: ({ name }) =>
      `Bridge a small amount through ${name} once a week.`,
  },
  {
    keywords: ['payment'],
    setup: ({ name, capital, chain }) =>
      `Open a channel and route $${capital} of payments through ${name} on ${chain}.`,
    weekly: ({ name }) =>
      `Route one payment through ${name} each week.`,
  },
  {
    keywords: ['chain'],
    setup: ({ name, capital }) =>
      `Bridge $${capital} to ${name} and use its apps in small amounts: one swap, one lend and one stake.`,
    weekly: ({ name }) =>
      `Do one on-chain action a week on ${name}: a swap, a lend or a stake.`,
  },
  {
    keywords: ['prediction'],
    setup: ({ name, capital }) =>
      `Fund $${capital} and place one market position on ${name}.`,
    weekly: ({ name }) =>
      `Place one small market position a week on ${name}.`,
  },
];

const DEFAULT_PLAYBOOK: CategoryPlaybook = {
  keywords: [],
  setup: ({ name, capital, chain }) =>
    `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`,
  weekly: () =>
    'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.',
};

/** Matches a category against the playbooks on whole words, so "Indexes" never matches "dex". */
function selectPlaybook(category: string | null): CategoryPlaybook {
  const normalized = (category ?? '').toLowerCase();
  for (const playbook of CATEGORY_PLAYBOOKS) {
    if (playbook.keywords.some((kw) => hasKeyword(normalized, kw))) {
      return playbook;
    }
  }
  return DEFAULT_PLAYBOOK;
}

/** The gas cost of one transaction on a chain, in dollars. */
export function gasCostUsd(chain: string): number {
  if (chain === 'Ethereum') return 8;
  if (LOW_GAS_CHAINS.has(chain)) return 0.5;
  return 2;
}

/** The cheapest chain a protocol runs on (first listed wins a tie), or its main chain. */
export function cheapestChain(protocol: SnapshotProtocol): string {
  if (protocol.chains.length === 0) return 'its main chain';
  let best = protocol.chains[0]!;
  let bestCost = gasCostUsd(best);
  for (const chain of protocol.chains) {
    const cost = gasCostUsd(chain);
    if (cost < bestCost) {
      best = chain;
      bestCost = cost;
    }
  }
  return best;
}

function suggestedCapital(tvlUsd: number): number {
  if (tvlUsd >= 5_000_000_000) return 250;
  if (tvlUsd >= 1_000_000_000) return 150;
  if (tvlUsd >= 100_000_000) return 100;
  return 50;
}

function holdWindowDays(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

function estimatedGas(chain: string): string {
  const cost = gasCostUsd(chain);
  if (cost >= 8) return 'about $8 of gas';
  if (cost <= 0.5) return 'about $0.50 of gas';
  return 'about $2 of gas';
}

function firstTxCost(chain: string): string {
  const cost = gasCostUsd(chain);
  if (cost >= 8) return 'about $8 of gas for the first transaction';
  if (cost <= 0.5) return 'under $1 of gas for the first transaction';
  return 'under $3 of gas for the first transaction';
}

/** Formats one structured FarmStep into a gate-compliant 20..600 character string. */
export function stepText(step: FarmStep): string {
  let formatted = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (formatted.length > MAX_STEP_CHARS) {
    formatted = `${formatted.slice(0, MAX_STEP_CHARS - 4)}...`;
  }
  if (formatted.length < MIN_STEP_CHARS) {
    formatted = `${formatted} Hold the position and check the protocol's own page.`;
  }
  return formatted;
}

/**
 * Builds a six-step farm plan derived solely from the protocol's category, chains, TVL, and age.
 * The plan farms on the protocol's cheapest chain. When the only chain is Ethereum, the
 * recurring step runs monthly instead of weekly: $8 of gas a week to farm a $50 deposit
 * would cost more than the deposit itself.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = cheapestChain(p);
  const capital = suggestedCapital(p.tvl_usd);
  const holdDays = holdWindowDays(age);
  const gas = estimatedGas(chain);
  const playbook = selectPlaybook(p.category);
  const ctx: PlaybookContext = { name: p.name, capital, chain };

  const monthly = gasCostUsd(chain) >= 8;
  const cadence = monthly ? 'month' : 'week';
  const weeklyText = playbook.weekly(ctx);
  const recurringText = monthly
    ? weeklyText
        .replace(/once a week/g, 'once a month')
        .replace(/each week/g, 'each month')
        .replace(/a week/g, 'a month')
    : weeklyText;

  return [
    {
      text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.',
      cost: firstTxCost(chain),
      time: '5 minutes',
    },
    {
      text: playbook.setup(ctx),
      cost: `$${capital} of capital and ${gas}`,
      time: '15 minutes to set up',
    },
    {
      text: recurringText,
      cost: `${gas} a ${cadence}`,
      time: `10 minutes a ${cadence}`,
    },
    {
      text: `Hold the position for at least ${holdDays} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${holdDays} days`,
    },
    {
      text: "Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.",
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: 'Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.',
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

// ---------------------------------------------------------------------------
// Board & dashboard dataset builders
// ---------------------------------------------------------------------------

function assembleBoard(
  snapshot: Snapshot,
  model: ModelConstants,
  table: ComparableTable,
): BoardRow[] {
  const index = new Map<string, SnapshotProtocol>();
  for (const protocol of snapshot.protocols) {
    index.set(protocol.slug, protocol);
  }

  const selected = new Map<string, SnapshotProtocol>();

  // Watchlist coverage floor first.
  for (const slug of snapshot.watchlist) {
    if (LAUNCHED_SUBPROTOCOLS.has(slug)) continue;
    const protocol = index.get(slug);
    if (protocol !== undefined) {
      selected.set(slug, protocol);
    }
  }

  // Early pre-token candidates below the TVL floor, ordered by TVL desc then slug asc.
  const earlyCandidates = snapshot.protocols
    .filter((p) => !selected.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || compareLex(a.slug, b.slug));

  for (const protocol of earlyCandidates) {
    selected.set(protocol.slug, protocol);
  }

  // Fill the board to its target from the largest pre-token protocols above the
  // floor that are not on the watchlist, so removing a launched sub-protocol
  // does not shrink the board.
  if (selected.size < BOARD_TARGET) {
    const fillCandidates = snapshot.protocols
      .filter((p) => !selected.has(p.slug) && isRankable(p) && p.tvl_usd >= snapshot.floor_usd)
      .sort((a, b) => b.tvl_usd - a.tvl_usd || compareLex(a.slug, b.slug));
    for (const protocol of fillCandidates) {
      if (selected.size >= BOARD_TARGET) break;
      selected.set(protocol.slug, protocol);
    }
  }

  const scored = [...selected.values()]
    .map((protocol) => ({
      protocol,
      valuation: impliedValue(protocol, snapshot.as_of, model, table),
    }))
    .sort(
      (a, b) =>
        b.valuation.implied - a.valuation.implied ||
        compareLex(a.protocol.slug, b.protocol.slug),
    );

  return scored.map(({ protocol, valuation }, idx) => ({
    rank: idx + 1,
    slug: protocol.slug,
    name: protocol.name,
    category: protocol.category,
    chains: protocol.chains,
    tvl_usd: protocol.tvl_usd,
    change_7d: protocol.change_7d,
    mcap_usd: protocol.mcap_usd,
    listed_at: protocol.listed_at,
    gecko_id: protocol.gecko_id,
    symbol: protocol.symbol,
    token_status: 'pre-token' as const,
    age_days: valuation.age,
    implied_value_usd: valuation.implied,
    signal_score: valuation.signal,
    model: {
      ratio: valuation.ratio,
      ratio_n: valuation.ratioN,
      ratio_source: valuation.ratioSource,
      growth_pct: valuation.growthPct,
      growth_multiplier: valuation.growthMult,
      maturity_multiplier: valuation.maturityMult,
      chain_multiplier: valuation.chainMult,
      age_days: valuation.age,
    },
    farm_steps: farmSteps(protocol, valuation.age).map(stepText),
  }));
}

/** Builds the complete ranked pre-token board from a snapshot. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const table = comparables(snapshot);
  return assembleBoard(snapshot, model, table);
}

/** Returns every live-token non-CEX protocol, ordered by market cap then TVL. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** Projects a BoardRow into the compact RadarRow shape written into data.js. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    signal_score: row.signal_score,
    ratio: row.model.ratio,
    ratio_n: row.model.ratio_n,
    ratio_source: row.model.ratio_source,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    chain_multiplier: row.model.chain_multiplier,
  };
}

/** Builds both the ranked board and the full dashboard RadarData payload. */
export function buildRadar(
  snapshot: Snapshot,
  model: ModelConstants = MODEL,
): { board: BoardRow[]; radar: RadarData } {
  const table = comparables(snapshot);
  const board = assembleBoard(snapshot, model, table);
  const live = liveRows(snapshot);

  const watchlistSet = new Set(snapshot.watchlist);
  let earlySize = 0;
  for (const row of board) {
    if (!watchlistSet.has(row.slug)) earlySize += 1;
  }

  const ratios: RatioRow[] = [...table.byCategory.entries()]
    .map(([category, stats]) => ({
      category,
      ratio: roundTo4(stats.ratio),
      n: stats.n,
    }))
    .sort((a, b) => b.n - a.n || compareLex(a.category, b.category));

  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: earlySize,
    live_size: live.length,
    live_total: live.length,
    global_ratio: roundTo4(table.global),
    ratios,
    watchlist: snapshot.watchlist,
    rows: board.map(radarRow),
    live,
  };

  return { board, radar };
}

// ---------------------------------------------------------------------------
// Parsing, gate validation, and serialization
// ---------------------------------------------------------------------------

function parseProtocolRecord(entry: unknown, index: number): SnapshotProtocol {
  if (!isPlainRecord(entry)) {
    throw new SnapshotError(`snapshot.json's protocol ${index} is not an object`);
  }
  if (
    typeof entry.slug !== 'string' ||
    typeof entry.name !== 'string' ||
    typeof entry.tvl_usd !== 'number' ||
    !Number.isFinite(entry.tvl_usd)
  ) {
    throw new SnapshotError(
      `snapshot.json's protocol ${index} lacks a slug, a name or a TVL`,
    );
  }

  const chains = Array.isArray(entry.chains)
    ? entry.chains.filter((c): c is string => typeof c === 'string')
    : [];

  return {
    slug: entry.slug,
    name: entry.name,
    category: typeof entry.category === 'string' ? entry.category : null,
    chains,
    tvl_usd: entry.tvl_usd,
    change_7d:
      typeof entry.change_7d === 'number' && Number.isFinite(entry.change_7d)
        ? entry.change_7d
        : null,
    mcap_usd:
      typeof entry.mcap_usd === 'number' && Number.isFinite(entry.mcap_usd)
        ? entry.mcap_usd
        : null,
    listed_at: typeof entry.listed_at === 'string' ? entry.listed_at : null,
    gecko_id: typeof entry.gecko_id === 'string' ? entry.gecko_id : null,
    symbol: typeof entry.symbol === 'string' ? entry.symbol : null,
  };
}

/** Parses and validates snapshot JSON text, throwing SnapshotError on malformed input. */
export function parseSnapshot(text: string): Snapshot {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }

  if (!isPlainRecord(decoded)) {
    throw new SnapshotError('snapshot.json is not a JSON object');
  }

  if (typeof decoded.as_of !== 'string' || !ISO_DATE_RE.test(decoded.as_of)) {
    throw new SnapshotError('snapshot.json has no as_of date');
  }
  if (typeof decoded.source !== 'string') {
    throw new SnapshotError('snapshot.json has no source');
  }
  if (
    typeof decoded.floor_usd !== 'number' ||
    !Number.isSafeInteger(decoded.floor_usd) ||
    decoded.floor_usd <= 0
  ) {
    throw new SnapshotError('snapshot.json has no floor_usd');
  }
  if (!Array.isArray(decoded.protocols)) {
    throw new SnapshotError('snapshot.json has no protocols array');
  }
  if (!Array.isArray(decoded.watchlist) || decoded.watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapshotError('snapshot.json has no watchlist of slugs');
  }

  const protocols = decoded.protocols.map((entry, idx) => parseProtocolRecord(entry, idx));

  return {
    as_of: decoded.as_of,
    source: decoded.source,
    floor_usd: decoded.floor_usd,
    protocols,
    watchlist: decoded.watchlist as string[],
  };
}

/** Validates board invariants required by the gate; returns a diagnostic string or null if valid. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const presentSlugs = new Set(board.map((row) => row.slug));
  const missing = snapshot.watchlist.filter((slug) => !presentSlugs.has(slug));
  if (missing.length > 0) {
    const suffix = missing.length === 1 ? '' : 's';
    return `the board misses ${missing.length} watchlist slug${suffix}: ${missing.slice(0, 5).join(', ')}`;
  }

  const sortedRanks = board.map((row) => row.rank).sort((a, b) => a - b);
  for (let i = 0; i < sortedRanks.length; i++) {
    if (sortedRanks[i] !== i + 1) {
      return `rank ${i + 1} is ${sortedRanks[i]}`;
    }
  }

  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) {
      return `row ${i + 1} outranks row ${i} on implied value`;
    }
  }

  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }

  for (const row of board) {
    const { farm_steps: steps } = row;
    if (steps.length < MIN_STEPS_PER_ROW || steps.length > MAX_STEPS_PER_ROW) {
      return `${row.slug} has ${steps.length} farm steps`;
    }
    for (const step of steps) {
      if (step.length < MIN_STEP_CHARS || step.length > MAX_STEP_CHARS) {
        return `${row.slug} has a farm step of ${step.length} characters`;
      }
    }
    if (!Number.isSafeInteger(row.implied_value_usd) || row.implied_value_usd <= 0) {
      return `${row.slug} has implied value ${row.implied_value_usd}`;
    }
    if (!Number.isSafeInteger(row.signal_score) || row.signal_score < 0 || row.signal_score > 100) {
      return `${row.slug} has signal score ${row.signal_score}`;
    }
  }

  return null;
}

/** Emits the self-contained browser script defining window.RADAR. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
