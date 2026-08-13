import type {
  AffixSide,
  FittedWeightSnapshot,
  ModPosteriorSummary,
  RawSeenAggregate,
  RawSeenCell,
} from "./roll-seen-types";
import { modQualityTier } from "./mod-tiers";
import { TABLET_BASES } from "./mod-weights";

const ALPHA0 = 1;
const BETA0 = 1;

/** Lanczos approximation for log-gamma (sufficient for Beta CI). */
function logGamma(z: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.984369654078761e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  const x = z - 1;
  let a = c[0]!;
  for (let i = 1; i < g + 2; i++) a += c[i]! / (x + i);
  const t = x + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function logBeta(a: number, b: number): number {
  return logGamma(a) + logGamma(b) - logGamma(a + b);
}

/** Regularized incomplete beta I_x(a,b) via continued fraction. */
function betainc(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lnFront =
    a * Math.log(x) + b * Math.log(1 - x) - logBeta(a, b) - Math.log(a);
  const useComplement = x > (a + 1) / (a + b + 2);
  const xx = useComplement ? 1 - x : x;
  const aa = useComplement ? b : a;
  const bb = useComplement ? a : b;

  // Lentz continued fraction for incomplete beta
  const maxIter = 200;
  const eps = 1e-12;
  let f = 1;
  let c = 1;
  let d = 1 - ((aa + bb) * xx) / (aa + 1);
  if (Math.abs(d) < 1e-30) d = 1e-30;
  d = 1 / d;
  f = d;
  for (let m = 1; m <= maxIter; m++) {
    const m2 = 2 * m;
    let num = (m * (bb - m) * xx) / ((aa + m2 - 1) * (aa + m2));
    d = 1 + num * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + num / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    f *= d * c;

    num = -((aa + m) * (aa + bb + m) * xx) / ((aa + m2) * (aa + m2 + 1));
    d = 1 + num * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + num / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    const delta = d * c;
    f *= delta;
    if (Math.abs(delta - 1) < eps) break;
  }
  const result = Math.exp(lnFront + Math.log(f));
  // Recompute lnFront for the (xx,aa,bb) used
  const ln =
    aa * Math.log(xx) +
    bb * Math.log(1 - xx) -
    logBeta(aa, bb) -
    Math.log(aa);
  const y = Math.exp(ln) * f;
  return useComplement ? 1 - y : y;
}

/** Equal-tailed Beta quantile via binary search on CDF. */
export function betaQuantile(
  p: number,
  alpha: number,
  beta: number,
): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  if (!(alpha > 0) || !(beta > 0)) return Number.NaN;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    const cdf = betainc(mid, alpha, beta);
    if (cdf < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export interface BetaPosterior {
  alpha: number;
  beta: number;
  mean: number;
  ci95: [number, number];
  mleRate: number;
  trials: number;
  hits: number;
}

/**
 * Display Beta–Binomial posterior (uniform prior α0=β0=1).
 * Fitter must use mleRate, never mean.
 */
export function betaPosterior(
  hits: number,
  trials: number,
  alpha0 = ALPHA0,
  beta0 = BETA0,
): BetaPosterior {
  const h = Math.max(0, hits);
  const n = Math.max(0, trials);
  const alpha = alpha0 + h;
  const beta = beta0 + Math.max(0, n - h);
  const mean = alpha / (alpha + beta);
  const mleRate = n > 0 ? h / n : Number.NaN;
  const ci95: [number, number] = [
    betaQuantile(0.025, alpha, beta),
    betaQuantile(0.975, alpha, beta),
  ];
  return { alpha, beta, mean, ci95, mleRate, trials: n, hits: h };
}

export function summarizePosteriors(
  aggregate: RawSeenAggregate,
): ModPosteriorSummary[] {
  return aggregate.cells.map((cell) => {
    const post = betaPosterior(cell.hits, cell.trials);
    return {
      baseId: cell.baseId,
      side: cell.side,
      modId: cell.modId,
      alpha: post.alpha,
      beta: post.beta,
      mean: post.mean,
      ci95: post.ci95,
      trials: post.trials,
      hits: post.hits,
      mleRate: post.mleRate,
    };
  });
}

export interface SideRateDraw {
  baseId: string;
  side: AffixSide;
  /** Measured cared mod rates from Dirichlet (no unmeasured non-junk). */
  caredRates: Record<string, number>;
  trashRate: number;
  alphas: Record<string, number>;
}

function gammaSample(rng: () => number, shape: number): number {
  // Marsaglia–Tsang for shape >= 1; boost for shape < 1
  if (shape < 1) {
    const u = Math.max(rng(), Number.EPSILON);
    return gammaSample(rng, shape + 1) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      // Box–Muller
      const u1 = rng();
      const u2 = rng();
      x =
        Math.sqrt(-2 * Math.log(Math.max(u1, Number.EPSILON))) *
        Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/**
 * Dirichlet α recipe (§3.7): measured cared + trash lump from sideTrials.
 * Unmeasured non-junk are NOT categories.
 */
export function drawSideRates(
  aggregate: RawSeenAggregate,
  baseId: string,
  side: AffixSide,
  rng: () => number = Math.random,
): SideRateDraw | null {
  const base = TABLET_BASES[baseId];
  if (!base) return null;
  const pool =
    side === "prefix" ? base.allowedPrefixPool : base.allowedSuffixPool;
  const sideEntry = aggregate.sideTrials.find(
    (s) => s.baseId === baseId && s.side === side,
  );
  const sideTrials = sideEntry?.sideTrials ?? 0;
  if (!(sideTrials > 0) && !aggregate.cells.some(
    (c) => c.baseId === baseId && c.side === side,
  )) {
    return null;
  }

  const caredCells = aggregate.cells.filter(
    (c) =>
      c.baseId === baseId &&
      c.side === side &&
      c.trials > 0 &&
      modQualityTier(c.modId) !== "Junk" &&
      pool.includes(c.modId),
  );

  const alphas: Record<string, number> = {};
  let H = 0;
  for (const cell of caredCells) {
    alphas[cell.modId] = 1 + cell.hits;
    H += cell.hits;
  }
  const alphaTrash = 1 + Math.max(0, sideTrials - H);
  alphas.__trash__ = alphaTrash;

  const keys = Object.keys(alphas);
  const gammas = keys.map((k) => gammaSample(rng, alphas[k]!));
  const sum = gammas.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return null;

  const caredRates: Record<string, number> = {};
  let trashRate = 0;
  for (let i = 0; i < keys.length; i++) {
    const p = gammas[i]! / sum;
    const k = keys[i]!;
    if (k === "__trash__") trashRate = p;
    else caredRates[k] = p;
  }

  return { baseId, side, caredRates, trashRate, alphas };
}

/** Cells for a base (helper for fit UI). */
export function cellsForBase(
  aggregate: RawSeenAggregate,
  baseId: string,
): RawSeenCell[] {
  return aggregate.cells.filter((c) => c.baseId === baseId);
}

/** Attach posteriors onto a fitted snapshot shape helper. */
export function withPosteriors(
  snap: Omit<FittedWeightSnapshot, "posteriors">,
  aggregate: RawSeenAggregate,
): FittedWeightSnapshot {
  return {
    ...snap,
    posteriors: summarizePosteriors(aggregate).filter(
      (p) => p.baseId === snap.baseId,
    ),
  };
}
