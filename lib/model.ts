// Token Radar model (radar-2): deterministic scoring, ranking, and farm-plan generation
// from a single DefiLlama protocol snapshot.
//
// Scope of the ranked board:
// - Includes every protocol listed in snapshot.watchlist (the coverage floor).
// - Adds pre-token protocols below snapshot.floor_usd that pass the watchlist filter
//   (no recorded token, and not a wrapped/staked/bridged or exchange-branded derivative).
// - Excludes live-token protocols from the ranking, setting them aside with market caps.
//
// Implied valuation formula (applied uniformly; no protocol name is special-cased):
//   ratio      = category median (mcap_usd / tvl_usd) for token-bearing protocols with >= 3
//                comparables, otherwise the market-wide median across all token-bearing protocols.
//   growth     = clamp(change_7d ?? 0, -40, +60)
//   growthMult = 1 + (growth / 100) * 0.6
//   maturity   = 0.7 + (clamp(age_days ?? 365, 0, 1095) / 1095) * 0.3
//   chains     = 1 + 0.01 * clamp(chains.length - 1, 0, 8)
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
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
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
  growth_weight: 0.6,
  growth_floor: -40,
  growth_cap: 60,
  maturity_floor: 0.7,
  maturity_range: 0.3,
  maturity_days: 1095,
  unknown_age_days: 365,
  chain_step: 0.01,
  chain_cap: 8,
  min_comparables: 3,
};

export const MODEL_VERSION = 'radar-2';

export const LIVE_ROWS = 24;

const MS_PER_DAY = 86_400_000;
const FALLBACK_GLOBAL_RATIO = 0.2;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const VERSION_SUFFIX_RE = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const DERIVATIVE_WORD_RE = /\b(wrapped|staked|staking)\b/i;

const EXCLUDED_CATEGORIES: ReadonlySet<string> = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
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

const LOW_GAS_CHAINS: ReadonlySet<string> = new Set([
  'Base',
  'Arbitrum',
  'Optimism',
  'Solana',
  'Polygon',
  'BSC',
  'BNB Chain',
  'Avalanche',
  'Blast',
  'Linea',
  'Scroll',
  'zkSync Era',
  'Mode',
  'Sonic',
  'Plasma',
  'Hyperliquid',
  'Sui',
  'Aptos',
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

/**
 * Computes median mcap/TVL comparables from all token-bearing protocols in the snapshot.
 * Categories with fewer than `min` comparables are omitted and fall back to `global`.
 */
export function comparables(snapshot: Snapshot, min: number): ComparableTable {
  const categoryBuckets = new Map<string, number[]>();
  const allRatios: number[] = [];

  for (const protocol of snapshot.protocols) {
    if (
      protocol.mcap_usd === null ||
      protocol.gecko_id === null ||
      protocol.symbol === null
    ) {
      continue;
    }
    if (!(protocol.tvl_usd > 0) || !(protocol.mcap_usd > 0)) continue;

    const ratio = protocol.mcap_usd / protocol.tvl_usd;
    allRatios.push(ratio);

    if (protocol.category !== null) {
      let bucket = categoryBuckets.get(protocol.category);
      if (bucket === undefined) {
        bucket = [];
        categoryBuckets.set(protocol.category, bucket);
      }
      bucket.push(ratio);
    }
  }

  const global = computeMedian(allRatios) ?? FALLBACK_GLOBAL_RATIO;
  const byCategory = new Map<string, CategoryComparable>();

  for (const [category, ratios] of categoryBuckets) {
    if (ratios.length < min) continue;
    const med = computeMedian(ratios);
    if (med !== null) {
      byCategory.set(category, { ratio: med, n: ratios.length });
    }
  }

  return { byCategory, global };
}

/** Resolves the comparable ratio and provenance for a single protocol. */
export function ratioFor(
  p: SnapshotProtocol,
  table: ComparableTable,
): { ratio: number; n: number; source: string } {
  const catStats = p.category === null ? undefined : table.byCategory.get(p.category);
  if (catStats !== undefined) {
    return {
      ratio: catStats.ratio,
      n: catStats.n,
      source: `${p.category} median`,
    };
  }
  return {
    ratio: table.global,
    n: 0,
    source: 'market-wide median',
  };
}

/** Evaluates all multipliers and the final implied USD valuation for one protocol. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
  table: ComparableTable,
): ValuationResult {
  const age = ageDays(asOf, protocol.listed_at);
  const { ratio, n: ratioN, source: ratioSource } = ratioFor(protocol, table);

  const rawGrowth = finiteOr(protocol.change_7d, 0);
  const growthPct = clamp(rawGrowth, model.growth_floor, model.growth_cap);
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;

  const modeledAge = clamp(age ?? model.unknown_age_days, 0, model.maturity_days);
  const maturityMult =
    model.maturity_floor + (modeledAge / model.maturity_days) * model.maturity_range;

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
 * pre-token, not in an excluded derivative/bridge/CEX category, not version-suffixed,
 * not named as wrapped/staked/staking, and not prefixed with a major exchange name.
 */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
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
    keywords: ['curator', 'allocator'],
    setup: ({ name, capital, chain }) =>
      `Deposit $${capital} into a ${name} vault on ${chain} and keep the vault shares in the same wallet.`,
    weekly: ({ name }) =>
      `Top up the vault or move between ${name} vaults once a week so the wallet shows fresh activity.`,
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

function selectPlaybook(category: string | null): CategoryPlaybook {
  const normalized = (category ?? '').toLowerCase();
  for (const playbook of CATEGORY_PLAYBOOKS) {
    if (playbook.keywords.some((kw) => normalized.includes(kw))) {
      return playbook;
    }
  }
  return DEFAULT_PLAYBOOK;
}

function primaryChain(protocol: SnapshotProtocol): string {
  return protocol.chains.length > 0 ? protocol.chains[0]! : 'its main chain';
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
  if (chain === 'Ethereum') return 'about $8 of gas';
  if (LOW_GAS_CHAINS.has(chain)) return 'about $0.50 of gas';
  return 'about $2 of gas';
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

/** Builds a six-step farm plan derived solely from the protocol's category, chains, TVL, and age. */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = primaryChain(p);
  const capital = suggestedCapital(p.tvl_usd);
  const holdDays = holdWindowDays(age);
  const gas = estimatedGas(chain);
  const playbook = selectPlaybook(p.category);
  const ctx: PlaybookContext = { name: p.name, capital, chain };

  return [
    {
      text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.',
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: playbook.setup(ctx),
      cost: `$${capital} of capital and ${gas}`,
      time: '15 minutes to set up',
    },
    {
      text: playbook.weekly(ctx),
      cost: `${gas} a week`,
      time: '10 minutes a week',
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
  const table = comparables(snapshot, model.min_comparables);
  return assembleBoard(snapshot, model, table);
}

/** Returns the top live-token non-CEX protocols ordered by market cap then TVL. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
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
  const table = comparables(snapshot, model.min_comparables);
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
  }

  return null;
}

/** Emits the self-contained browser script defining window.RADAR. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
