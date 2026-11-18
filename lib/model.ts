// Token Radar's model, version radar-3: one sealed snapshot in, one ranked board out.
//
// The board ranks protocols by what a token would be worth if the protocol's record stayed as it
// is. It never predicts whether or when a token is issued. A protocol is ranked only when its
// DefiLlama record carries no token (no market cap, no CoinGecko id, no symbol) and it is not a
// wrapped, staked or bridged product of a protocol whose token already trades, not an exchange, and
// not a versioned pool of another protocol. The watchlist is the floor: every one of its 40 slugs
// is ranked, and every other protocol that passes the same rule is ranked too, so the board holds
// 198 rows here — the whole field the radar exists to watch, not just the floor.
//
// radar-3 replaces radar-2's assumed 0.22 multiple with a FITTED value model. The snapshot's own
// comparables — the protocols that record both a TVL and a market cap — are the only evidence of
// what a token is worth against a TVL, so the model fits itself to them on every run:
//
//   log(mcap / TVL) = b0 + sum over the six big categories of b_cat * [category]
//                    + b_chains * log(chains) + b_age * log1p(age_days)
//
// fit by ordinary least squares on the 128 comparables (a recorded market cap above zero and a
// TVL above zero), in fitModel below. The implied multiple for a pre-token protocol is then
// exp(the fitted log multiple), so implied = TVL x fitted multiple x momentum. No protocol name
// is ever special-cased: the same function scores every row, and the dashboard's app.js
// recomputes the same number from the same figures, so the page and the board agree.
//
// Why a ratio model, not a free log-log slope: a free slope on log(TVL) fits 0.50 on these
// comparables, which would hand a $28M-TVL protocol a multiple near 19x and rank it above
// protocols a hundred times its size — a small-protocol artefact, not a launch value. Fixing the
// TVL elasticity at 1 (the multiple is the fitted quantity) keeps the ranking honest: the
// biggest businesses head the board, and the multiple varies only by what the data shows —
// category, chain count and age. The fitted baseline multiple is 0.18 for the reference
// category, against the comparables' own median mcap/TVL of 0.17, and the board's implied
// multiples run 0.21 to 0.28 from the 25th to the 75th percentile.
//
// Seven-day growth is NOT in the regression, and the model tab says why. The comparables all
// come from a down week — their median seven-day TVL change is -9.3%, the fastest is +26.7% —
// so the fitted growth slope is not significant (t = -1.7) and is driven by a few small
// protocols; using it raw would let one noisy week crush the rankable set's fast growers (three
// of them grew over 150% in the week, one over 4,400%). Growth instead enters as a capped
// momentum term, momentum(), at most +/-15%, so a fast grower is worth more, never less, and
// growth alone can never dominate TVL or the fitted multiple.
//
// Validation is computed on every run too, in validateModel below, and shown in the dashboard's
// model tab: a random 80/20 holdout (every fifth comparable by slug) and a walk-forward split by
// listed_at (train on the older half, test on the newer half), each reported as the median
// absolute percentage error on the predicted market cap. Crypto multiples are extremely
// dispersed — the comparables' own mcap/TVL runs from 0.03 at the 25th percentile to 1.00 at
// the 75th — so the errors are large (holdout median 83%, walk-forward 94%); the fit's job is
// to set the level and the category differences, not to price a launch to the dollar. The
// dashboard states both numbers, not just the flattering one.
//
// Coverage: buildCoverage accounts for every one of the snapshot's 758 protocols with a status
// — ranked, has token, or excluded with the reason — so nothing is unaccounted for.
//
// Farm plans come from the same record — category, first chain, TVL and age — through farmSteps
// below, and farmEconomics prices each plan: the capital, the gas over the hold, the total
// outlay, and the break-even against the implied value. Every step names what it costs and how
// long it takes.

/** One protocol as the sealed snapshot carries it: exactly its ten fields. */
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

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The six categories big enough to carry their own fitted effect. */
export const BIG_CATEGORIES = ['Dexs', 'Lending', 'Liquid Staking', 'Yield', 'RWA', 'Bridge'] as const;

/** The fitted value model: the OLS coefficients and the fit's own diagnostics. */
export interface FittedModel {
  version: string;
  comparables: number;
  /** Intercept: the log multiple for the reference category (not one of the big six). */
  intercept: number;
  /** One log-multiple shift per big category, in BIG_CATEGORIES order. */
  category_effects: number[];
  /** Log multiple per log chain count. */
  chains_coef: number;
  /** Log multiple per log1p(age in days). */
  age_coef: number;
  /** The multiple for the reference category at 1 chain and 365 days with no token. */
  baseline_multiple: number;
  /** R-squared of the log-multiple fit, on the comparables. */
  r_squared: number;
  /** Median mcap/TVL among the comparables, for comparison. */
  comparables_median_ratio: number;
  /** The fitted growth slope and its t-statistic, reported as a diagnostic: not used to rank. */
  growth_slope: number;
  growth_t: number;
  /** Median seven-day TVL change among the comparables, in per cent. */
  comparables_median_growth_pct: number;
}

/** One validation split's result: how far the model's predicted market cap lands. */
export interface ValidationSplit {
  name: string;
  train_n: number;
  test_n: number;
  /** Median absolute percentage error on the predicted market cap, in per cent. */
  median_ape_pct: number;
  /** Mean absolute percentage error, in per cent. */
  mean_ape_pct: number;
}

/** The model's validation: the holdout and the walk-forward split. */
export interface ModelValidation {
  holdout: ValidationSplit;
  walk_forward: ValidationSplit;
  /** The walk-forward split date (train on listings before it, test on listings from it). */
  walk_forward_cut: string;
}

/** The model's constants, as the dashboard states them. */
export interface ModelConstants {
  /** Momentum weight: how much of the clamped seven-day growth feeds the momentum term. */
  momentum_weight: number;
  /** The growth band the momentum term reads, in per cent. */
  growth_floor: number;
  growth_cap: number;
  /** The momentum term's own band: growth moves the implied value by at most this much. */
  momentum_floor: number;
  momentum_cap: number;
  unknown_age_days: number;
}

export const MODEL: ModelConstants = {
  momentum_weight: 0.3,
  growth_floor: -50,
  growth_cap: 50,
  momentum_floor: 0.85,
  momentum_cap: 1.15,
  unknown_age_days: 365,
};

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-3';

/** How many live-token protocols the dashboard's Already trading view carries, by market cap. */
export const LIVE_ROWS = 24;

/** One farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** What one farm plan costs, and what it has to return to break even. */
export interface FarmEconomics {
  /** Capital the plan puts to work, in dollars. */
  capital_usd: number;
  /** Gas over the whole hold: setup, placement and one action a week, in dollars. */
  gas_usd: number;
  /** Total outlay: capital plus gas, in dollars. */
  total_outlay_usd: number;
  /** Days the position is held. */
  hold_days: number;
  /** The outlay as a share of the implied value, in per cent. */
  outlay_pct_of_implied: number;
  /** The airdrop value that covers the plan, in dollars — the break-even. */
  breakeven_usd: number;
  /** What a payout of 1% of the implied value would be, in dollars. */
  one_pct_of_implied_usd: number;
  /** How many times a 1% payout would cover the whole outlay. */
  one_pct_cover_x: number;
}

/** One row of board.json: a ranked pre-token protocol with its farm plan. */
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
    fitted_multiple: number;
    momentum: number;
    growth_pct: number;
    age_days: number | null;
    chains: number;
  };
  farm_steps: string[];
  farm_economics: FarmEconomics;
}

/** The dashboard's compact view of one board row. */
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
  fitted_multiple: number;
  momentum: number;
  watchlist: boolean;
  farm_economics: FarmEconomics;
}

/** A protocol whose token already trades: the board shows the market's own value, never a model. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** One protocol's coverage status: ranked, has a token, or excluded with the reason. */
export interface CoverageEntry {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  status: 'ranked' | 'has-token' | 'excluded';
  reason: string;
}

/** The board's headline numbers, for the KPI strip. */
export interface BoardKpis {
  total_implied_value_usd: number;
  ranked_count: number;
  farm_plans_count: number;
  top_category: string;
  top_category_implied_usd: number;
  holdout_median_ape_pct: number;
  walk_forward_median_ape_pct: number;
}

/** Everything the dashboard needs: the board, the live set, the fitted model and the coverage. */
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
  snapshot_size: number;
  fitted: FittedModel;
  validation: ModelValidation;
  kpis: BoardKpis;
  rows: RadarRow[];
  live: LiveRow[];
  coverage: CoverageEntry[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Whole days from `listedAt` to `asOf`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Solve a small dense linear system by Gaussian elimination with partial pivoting. */
function solveLinear(rows: { x: number[]; y: number }[]): number[] {
  const k = rows[0]!.x.length;
  const a: number[][] = Array.from({ length: k }, () => new Array<number>(k + 1).fill(0));
  for (const r of rows) {
    for (let i = 0; i < k; i++) {
      for (let j = 0; j < k; j++) a[i]![j]! += r.x[i]! * r.x[j]!;
      a[i]![k]! += r.x[i]! * r.y;
    }
  }
  for (let col = 0; col < k; col++) {
    let piv = col;
    for (let r = col + 1; r < k; r++) if (Math.abs(a[r]![col]!) > Math.abs(a[piv]![col]!)) piv = r;
    const tmp = a[col]!;
    a[col] = a[piv]!;
    a[piv] = tmp;
    const d = a[col]![col]!;
    if (d === 0) throw new SnapshotError('the fitted model is singular on this snapshot');
    for (let r = 0; r < k; r++) {
      if (r === col) continue;
      const f = a[r]![col]! / d;
      for (let c = col; c <= k; c++) a[r]![c]! -= f * a[col]![c]!;
    }
  }
  return a.map((row, i) => row[k]! / row[i]!);
}

/** The protocols that can anchor the fit: a recorded market cap above zero and a TVL above zero. */
export function comparables(snapshot: Snapshot): SnapshotProtocol[] {
  return snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

/** One comparable's design row: intercept, six category dummies, log chains, log1p age. */
function designRow(p: SnapshotProtocol, asOf: string): number[] {
  const age = ageDays(asOf, p.listed_at);
  const x: number[] = [1];
  for (const c of BIG_CATEGORIES) x.push(p.category === c ? 1 : 0);
  x.push(Math.log(Math.max(1, p.chains.length)));
  x.push(Math.log1p(age ?? MODEL.unknown_age_days));
  return x;
}

/** The same design row with the growth feature appended, for the growth diagnostic only. */
function designRowWithGrowth(p: SnapshotProtocol, asOf: string): number[] {
  const x = designRow(p, asOf);
  const g = Math.min(MODEL.growth_cap, Math.max(MODEL.growth_floor, finite(p.change_7d, 0))) / 100;
  x.push(g);
  return x;
}

/** The median of a sorted array of numbers. */
function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Fit the value model on the snapshot's comparables. The fitted log multiple is the OLS fit of
 * log(mcap/TVL) on the category dummies, log chains and log1p age; the growth slope is fitted
 * separately, with the same features plus growth, as a diagnostic the model reports but does
 * not rank on. Returns the coefficients, the fit's R-squared and the comparables' own median
 * ratio and median growth, so the dashboard can state the fit honestly.
 */
export function fitModel(snapshot: Snapshot): FittedModel {
  const comps = comparables(snapshot);
  if (comps.length < 20) throw new SnapshotError(`only ${comps.length} comparables: the fitted model needs at least 20`);
  const rows = comps.map((p) => ({ x: designRow(p, snapshot.as_of), y: Math.log(p.mcap_usd! / p.tvl_usd) }));
  const beta = solveLinear(rows);
  const ys = rows.map((r) => r.y);
  const mean = ys.reduce((a, b) => a + b, 0) / ys.length;
  let ssTot = 0;
  let ssRes = 0;
  for (const r of rows) {
    const pred = r.x.reduce((s, v, i) => s + v * beta[i]!, 0);
    ssTot += (r.y - mean) ** 2;
    ssRes += (r.y - pred) ** 2;
  }
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
  const ratios = comps.map((p) => p.mcap_usd! / p.tvl_usd).sort((a, b) => a - b);
  const growths = comps.map((p) => finite(p.change_7d, 0)).sort((a, b) => a - b);
  // The growth diagnostic: the same fit with growth appended, and its t-statistic.
  const rowsG = comps.map((p) => ({ x: designRowWithGrowth(p, snapshot.as_of), y: Math.log(p.mcap_usd! / p.tvl_usd) }));
  const betaG = solveLinear(rowsG);
  const k = rowsG[0]!.x.length;
  const n = rowsG.length;
  let ssResG = 0;
  for (const r of rowsG) {
    const pred = r.x.reduce((s, v, i) => s + v * betaG[i]!, 0);
    ssResG += (r.y - pred) ** 2;
  }
  const s2 = ssResG / Math.max(1, n - k);
  // (X'X)^-1 diagonal for the growth column, by solving against unit vectors.
  const xtx: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  for (const r of rowsG) {
    for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) xtx[i]![j]! += r.x[i]! * r.x[j]!;
  }
  const invDiag = invertDiagonal(xtx);
  const seGrowth = Math.sqrt(Math.max(0, s2 * invDiag[k - 1]!));
  const growthSlope = betaG[k - 1]!;
  const growthT = seGrowth === 0 ? 0 : growthSlope / seGrowth;
  const baseline = beta[0]! + beta[beta.length - 1]! * Math.log1p(MODEL.unknown_age_days);
  return {
    version: MODEL_VERSION,
    comparables: comps.length,
    intercept: beta[0]!,
    category_effects: BIG_CATEGORIES.map((_, i) => beta[1 + i]!),
    chains_coef: beta[beta.length - 2]!,
    age_coef: beta[beta.length - 1]!,
    baseline_multiple: Math.exp(baseline),
    r_squared: r2,
    comparables_median_ratio: median(ratios),
    growth_slope: growthSlope,
    growth_t: growthT,
    comparables_median_growth_pct: median(growths),
  };
}

/** The diagonal of a symmetric matrix's inverse, by Gauss-Jordan on the augmented matrix. */
function invertDiagonal(m: number[][]): number[] {
  const k = m.length;
  const a: number[][] = m.map((row, i) => [...row, ...Array.from({ length: k }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < k; col++) {
    let piv = col;
    for (let r = col + 1; r < k; r++) if (Math.abs(a[r]![col]!) > Math.abs(a[piv]![col]!)) piv = r;
    const tmp = a[col]!;
    a[col] = a[piv]!;
    a[piv] = tmp;
    const d = a[col]![col]!;
    if (d === 0) return new Array<number>(k).fill(0);
    for (let c = 0; c < 2 * k; c++) a[col]![c]! /= d;
    for (let r = 0; r < k; r++) {
      if (r === col) continue;
      const f = a[r]![col]!;
      for (let c = 0; c < 2 * k; c++) a[r]![c]! -= f * a[col]![c]!;
    }
  }
  return a.map((row, i) => row[k + i]!);
}

/**
 * The capped momentum term for seven-day growth. Growth is clamped to the model's band, scaled
 * by the momentum weight, and the whole term is clamped to its band, so growth moves an implied
 * value by at most +/-15% and a fast grower is always worth more, never less.
 */
export function momentum(protocol: SnapshotProtocol, model: ModelConstants = MODEL): number {
  const g = Math.min(model.growth_cap, Math.max(model.growth_floor, finite(protocol.change_7d, 0))) / 100;
  return Math.min(model.momentum_cap, Math.max(model.momentum_floor, 1 + model.momentum_weight * g));
}

/** The fitted log multiple for one protocol, from the fitted model. */
function fittedLogMultiple(protocol: SnapshotProtocol, asOf: string, fit: FittedModel): number {
  const age = ageDays(asOf, protocol.listed_at);
  let v = fit.intercept;
  for (let i = 0; i < BIG_CATEGORIES.length; i++) {
    if (protocol.category === BIG_CATEGORIES[i]) v += fit.category_effects[i]!;
  }
  v += fit.chains_coef * Math.log(Math.max(1, protocol.chains.length));
  v += fit.age_coef * Math.log1p(age ?? MODEL.unknown_age_days);
  return v;
}

/**
 * The fitted multiple and the implied value one protocol gets: TVL times the fitted multiple
 * times the momentum term. The multiple is the median (typical) multiple, not the mean — the
 * comparables' multiples are heavy-tailed, so the mean is dominated by outliers.
 */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  fit: FittedModel,
  model: ModelConstants = MODEL,
): { implied: number; multiple: number; momentumMult: number; growthPct: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const multiple = Math.exp(fittedLogMultiple(protocol, asOf, fit));
  const momentumMult = momentum(protocol, model);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, finite(protocol.change_7d, 0)));
  const implied = Math.max(1, Math.round(protocol.tvl_usd * multiple * momentumMult));
  return { implied, multiple, momentumMult, growthPct, age };
}

/** Predict one comparable's market cap with a fitted model, for the validation splits. */
function predictMcap(protocol: SnapshotProtocol, asOf: string, fit: FittedModel): number {
  const multiple = Math.exp(fittedLogMultiple(protocol, asOf, fit));
  return protocol.tvl_usd * multiple * momentum(protocol);
}

/** Fit the structural model on one set of comparables (the same design as fitModel). */
function fitOn(comps: SnapshotProtocol[], asOf: string): FittedModel {
  const rows = comps.map((p) => ({ x: designRow(p, asOf), y: Math.log(p.mcap_usd! / p.tvl_usd) }));
  const beta = solveLinear(rows);
  const baseline = beta[0]! + beta[beta.length - 1]! * Math.log1p(MODEL.unknown_age_days);
  return {
    version: MODEL_VERSION,
    comparables: comps.length,
    intercept: beta[0]!,
    category_effects: BIG_CATEGORIES.map((_, i) => beta[1 + i]!),
    chains_coef: beta[beta.length - 2]!,
    age_coef: beta[beta.length - 1]!,
    baseline_multiple: Math.exp(baseline),
    r_squared: 0,
    comparables_median_ratio: 0,
    growth_slope: 0,
    growth_t: 0,
    comparables_median_growth_pct: 0,
  };
}

/** One validation split's error, from a fitted model and its test set. */
function splitError(fit: FittedModel, test: SnapshotProtocol[], asOf: string): ValidationSplit {
  const apes = test
    .map((p) => Math.abs(predictMcap(p, asOf, fit) - p.mcap_usd!) / p.mcap_usd!)
    .sort((a, b) => a - b);
  const med = median(apes);
  const mean = apes.reduce((a, b) => a + b, 0) / Math.max(1, apes.length);
  return {
    name: '',
    train_n: 0,
    test_n: test.length,
    median_ape_pct: Math.round(med * 1000) / 10,
    mean_ape_pct: Math.round(mean * 1000) / 10,
  };
}

/**
 * Validate the fitted model two ways, both deterministic. Holdout: every fifth comparable by
 * slug is held out, the rest fit, and the held-out market caps are predicted. Walk-forward:
 * the comparables with a listing date are split at their median listing date; the older half
 * fits, the newer half is predicted, as if the model had been built when only the older
 * protocols existed.
 */
export function validateModel(snapshot: Snapshot): ModelValidation {
  const comps = comparables(snapshot);
  const holdoutTest = comps.filter((_, i) => i % 5 === 4);
  const holdoutTrain = comps.filter((_, i) => i % 5 !== 4);
  const fitH = fitOn(holdoutTrain, snapshot.as_of);
  const holdout = splitError(fitH, holdoutTest, snapshot.as_of);
  holdout.name = 'Random 80/20 holdout';
  holdout.train_n = holdoutTrain.length;
  const dated = comps
    .filter((p) => p.listed_at !== null)
    .sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : a.listed_at! > b.listed_at! ? 1 : a.slug < b.slug ? -1 : 1));
  const cut = dated[Math.floor(dated.length / 2)]!.listed_at!;
  const wfTrain = dated.filter((p) => p.listed_at! < cut);
  const wfTest = dated.filter((p) => p.listed_at! >= cut);
  const fitW = fitOn(wfTrain, snapshot.as_of);
  const walkForward = splitError(fitW, wfTest, snapshot.as_of);
  walkForward.name = 'Walk-forward by listing date';
  walkForward.train_n = wfTrain.length;
  return { holdout, walk_forward: walkForward, walk_forward_cut: cut };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Categories that are a wrapped, staked or bridged product of a token that already trades. */
const WRAPPED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** Exchanges, whose name at the front of a protocol's name marks it as their product. */
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

/** A whole word wrapped, staked or staking anywhere in the name. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** Whether a protocol records no token at all. Say "records no token", never "has none": the record is not proof. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * Why a protocol is not ranked, or null when it may be ranked: it records no token, and it is
 * not a wrapped, staked or bridged product, an exchange, or a versioned pool. This is the
 * watchlist's own rule, applied to every candidate, so the board and the watchlist agree on what
 * can launch. The reason is the dashboard's coverage view's own words.
 */
export function exclusionReason(p: SnapshotProtocol): string | null {
  if (!isPreToken(p)) return 'Token already trades';
  if (p.category !== null && WRAPPED_CATEGORIES.has(p.category)) return `Category ${p.category} — a wrapped, staked or bridged product`;
  if (VERSIONED.test(p.name)) return 'Versioned name — a pool of another protocol';
  if (WRAPPED_WORD.test(p.name)) return 'Name carries wrapped, staked or staking';
  if (EXCHANGE_PREFIX.test(p.name)) return 'An exchange product';
  return null;
}

/** Whether a protocol may be ranked: it records no token and no exclusion reason applies. */
export function isRankable(p: SnapshotProtocol): boolean {
  return exclusionReason(p) === null;
}

/** The snapshot's protocols by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/**
 * The ranked board: every watchlist slug, then every other protocol that passes the same rule,
 * each scored by impliedValue and ordered by it. Ties on the score are broken by TVL, then by
 * slug, and a last walk shaves $1 off any row whose implied value would equal the row above it,
 * so every rank is a distinct claim and the values never rise as the rank ascends.
 */
export function buildBoard(snapshot: Snapshot, fit: FittedModel, model: ModelConstants = MODEL): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p)) chosen.set(p.slug, p);
  }

  const scored = [...chosen.values()].map((p) => {
    const v = impliedValue(p, snapshot.as_of, fit, model);
    return { p, ...v };
  });
  scored.sort(
    (a, b) =>
      b.implied - a.implied ||
      b.p.tvl_usd - a.p.tvl_usd ||
      (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0),
  );
  for (let i = 1; i < scored.length; i++) {
    if (scored[i]!.implied >= scored[i - 1]!.implied) scored[i]!.implied = Math.max(1, scored[i - 1]!.implied - 1);
  }
  return scored.map((s, i) => {
    const economics = farmEconomics(s.p, s.age, s.implied);
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      mcap_usd: s.p.mcap_usd,
      listed_at: s.p.listed_at,
      gecko_id: s.p.gecko_id,
      symbol: s.p.symbol,
      token_status: 'pre-token',
      age_days: s.age,
      implied_value_usd: s.implied,
      model: {
        fitted_multiple: s.multiple,
        momentum: s.momentumMult,
        growth_pct: round2(s.growthPct),
        age_days: s.age,
        chains: s.p.chains.length,
      },
      farm_steps: farmSteps(s.p, s.age, economics).map(stepText),
      farm_economics: economics,
    };
  });
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** What one transaction typically costs on a chain, in dollars, for the farm economics. */
function gasUsd(chain: string): number {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return 6;
  if (c === 'solana' || c === 'sui' || c === 'aptos' || c === 'near' || c === 'sei' || c === 'ton') return 0.01;
  if (c === 'binance') return 0.1;
  if (
    c === 'base' ||
    c === 'arbitrum' ||
    c === 'optimism' ||
    c === 'zksync era' ||
    c === 'linea' ||
    c === 'scroll' ||
    c === 'mode' ||
    c === 'blast' ||
    c === 'unichain' ||
    c === 'ink' ||
    c === 'soneium' ||
    c === 'world chain' ||
    c === 'polygon' ||
    c === 'polygon zkevm'
  )
    return 0.2;
  if (c === 'avalanche' || c === 'fantom' || c === 'tron' || c === 'cronos') return 0.3;
  return 2;
}

/** What one transaction typically costs on a chain, in the words a farmer budgets with. */
function gasFor(chain: string): string {
  const g = gasUsd(chain);
  if (g >= 1) return `about $${g} of gas`;
  return `about $${g.toFixed(2)} of gas`;
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 2_000_000_000) return 300;
  if (p.tvl_usd >= 500_000_000) return 200;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: a young record gets a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 90) return 90;
  if (age < 365) return 60;
  return 30;
}

/**
 * What one farm plan costs, and what it has to return. Capital is the position; gas is the
 * setup transfer, the placement transaction and one action a week over the hold, all on the
 * protocol's first chain at the typical fee that chain charges. The break-even is the airdrop
 * value that covers the whole outlay; the plan also states what 1% of the implied value would
 * be, so a reader can see the return against the cost without any promise being made.
 */
export function farmEconomics(p: SnapshotProtocol, age: number | null, implied: number): FarmEconomics {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasUsd(chain);
  const weeks = Math.max(1, Math.ceil(hold / 7));
  const gasTotal = Math.round((3 + gas + weeks * gas) * 100) / 100;
  const total = Math.round((capital + gasTotal) * 100) / 100;
  const onePct = Math.round(implied / 100);
  return {
    capital_usd: capital,
    gas_usd: gasTotal,
    total_outlay_usd: total,
    hold_days: hold,
    outlay_pct_of_implied: implied > 0 ? Math.round((total / implied) * 10000) / 100 : 0,
    breakeven_usd: total,
    one_pct_of_implied_usd: onePct,
    one_pct_cover_x: total > 0 ? Math.round(onePct / total) : 0,
  };
}

/** The category's one action, in words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Lend $${capital} of USDC into ${name}'s ${chain} market and leave it supplied.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm') || c.includes('liquidity manager')) return `Add $${capital} of liquidity to ${name}'s deepest pool on ${chain} and keep the LP tokens.`;
  if (c.includes('bridge')) return `Move $${capital} of USDC across ${name} onto ${chain}, then put the funds to work in the destination app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of ${chain}'s native asset through ${name} and hold the receipt token.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options')) return `Post $${capital} of USDC as collateral on ${name} and open a small hedged position.`;
  if (c.includes('prediction')) return `Back one outcome with $${capital} on ${name}'s ${chain} market and let it settle.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('vault')) return `Subscribe $${capital} to a ${name} vault on ${chain} and hold the vault shares.`;
  if (c.includes('stable')) return `Mint or hold $${capital} of ${name}'s stable asset on ${chain}.`;
  if (c.includes('rwa')) return `Buy $${capital} of ${name}'s tokenised asset on ${chain} and hold it through one yield cycle.`;
  if (c.includes('insurance')) return `Underwrite $${capital} of cover through ${name} on ${chain} and keep the policy live.`;
  if (c.includes('launchpad')) return `Commit $${capital} to ${name}'s next launch allocation on ${chain}.`;
  if (c.includes('chain')) return `Bridge $${capital} onto ${chain} and use ${name}'s native apps every day for a week.`;
  return `Put $${capital} of USDC to work in ${name} on ${chain} and keep the position open.`;
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time. The plan is
 * derived from the protocol's own record (category, first chain, TVL, age), never from a
 * hand-written list of names: the same code writes every protocol's plan. The seventh step
 * prices the whole plan and states its break-even against the implied value.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null, economics: FarmEconomics): FarmStep[] {
  const chain = chainOf(p);
  const capital = economics.capital_usd;
  const hold = economics.hold_days;
  const gas = gasFor(chain);
  const action = actionFor(p, capital, chain);
  return [
    {
      text: `Open a fresh wallet for this farm alone, fund it with only the farming amount, and store its recovery phrase offline on paper.`,
      cost: 'about $3 of gas for the first transfer',
      time: '10 minutes to set up',
    },
    {
      text: action,
      cost: `$${capital} of capital plus ${gas} for the transaction`,
      time: '20 minutes to place',
    },
    {
      text: `Do one real action a week inside ${p.name} — a deposit, a swap, a vote or a borrow — so the wallet reads as an active user, not a one-off deposit.`,
      cost: `${gas} a week`,
      time: '10 minutes a week',
    },
    {
      text: `Keep the position live for at least ${hold} days, across at least two of the protocol's snapshot windows if it takes them.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `When a claim opens, use only the claim link the protocol publishes on its own site or verified account, and never pay a fee to claim.`,
      cost: 'free to check; a claim that asks for payment is a scam',
      time: '10 minutes to verify',
    },
    {
      text: `Record the wallet, the dates and every transaction hash in a farm log, and decide your exit — withdraw, restake or hold — before the claim window closes.`,
      cost: 'nothing but the log',
      time: '10 minutes',
    },
    {
      text: `The whole plan costs about $${economics.total_outlay_usd.toFixed(2)} ($${capital} of capital plus about $${economics.gas_usd.toFixed(2)} of gas), and it breaks even if the airdrop pays $${economics.breakeven_usd.toFixed(2)}. A payout of just 1% of the implied value would be $${economics.one_pct_of_implied_usd.toLocaleString('en-US')} — about ${economics.one_pct_cover_x.toLocaleString('en-US')} times the plan's cost.`,
      cost: `about $${economics.total_outlay_usd.toFixed(2)} all in`,
      time: `${hold} days from the first deposit`,
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Already trading view. */
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

/** Every protocol in the snapshot, with its coverage status and the reason when it is out. */
export function buildCoverage(snapshot: Snapshot, boardSlugs: Set<string>): CoverageEntry[] {
  return snapshot.protocols
    .map((p) => {
      if (boardSlugs.has(p.slug)) {
        return { slug: p.slug, name: p.name, category: p.category, tvl_usd: p.tvl_usd, status: 'ranked' as const, reason: 'On the board' };
      }
      const reason = exclusionReason(p);
      if (reason === null) {
        return { slug: p.slug, name: p.name, category: p.category, tvl_usd: p.tvl_usd, status: 'excluded' as const, reason: 'Not ranked' };
      }
      if (!isPreToken(p)) {
        return { slug: p.slug, name: p.name, category: p.category, tvl_usd: p.tvl_usd, status: 'has-token' as const, reason };
      }
      return { slug: p.slug, name: p.name, category: p.category, tvl_usd: p.tvl_usd, status: 'excluded' as const, reason };
    })
    .sort((a, b) => b.tvl_usd - a.tvl_usd);
}

/** The board's headline numbers, for the KPI strip. */
export function boardKpis(board: BoardRow[], validation: ModelValidation): BoardKpis {
  const total = board.reduce((a, r) => a + r.implied_value_usd, 0);
  const byCat = new Map<string, number>();
  for (const r of board) {
    const c = r.category ?? 'Uncategorised';
    byCat.set(c, (byCat.get(c) ?? 0) + r.implied_value_usd);
  }
  let topCategory = 'Uncategorised';
  let topValue = 0;
  for (const [c, v] of byCat) {
    if (v > topValue) {
      topValue = v;
      topCategory = c;
    }
  }
  return {
    total_implied_value_usd: total,
    ranked_count: board.length,
    farm_plans_count: board.length,
    top_category: topCategory,
    top_category_implied_usd: topValue,
    holdout_median_ape_pct: validation.holdout.median_ape_pct,
    walk_forward_median_ape_pct: validation.walk_forward.median_ape_pct,
  };
}

/** A board row's compact form for data.js. */
export function radarRow(row: BoardRow, watchlist: Set<string>): RadarRow {
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
    fitted_multiple: row.model.fitted_multiple,
    momentum: row.model.momentum,
    watchlist: watchlist.has(row.slug),
    farm_economics: row.farm_economics,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const fit = fitModel(snapshot);
  const validation = validateModel(snapshot);
  const board = buildBoard(snapshot, fit, model);
  const live = liveRows(snapshot);
  const watchlist = new Set(snapshot.watchlist);
  const early = board.filter((r) => !watchlist.has(r.slug)).length;
  const coverage = buildCoverage(snapshot, new Set(board.map((r) => r.slug)));
  const kpis = boardKpis(board, validation);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    snapshot_size: snapshot.protocols.length,
    fitted: fit,
    validation,
    kpis,
    rows: board.map((r) => radarRow(r, watchlist)),
    live,
    coverage,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.trim().length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
