import { RATE_LIMIT_RULES } from "@/web/price-check/trade/common";
import { RateLimiter } from "@/web/price-check/trade/RateLimiter";

/** Parse "Please wait N seconds" from trade API errors. */
export function parseRateLimitWaitSec(errMsg: string | undefined | null): number | null {
  if (!errMsg) return null;
  const m = errMsg.match(/wait\s+(\d+)\s+seconds/i);
  if (!m) return /rate limit/i.test(errMsg) ? 60 : null;
  return Math.min(360, Math.max(5, parseInt(m[1], 10)));
}

/**
 * Global survey trade gate — one cooldown for the whole survey so 429s don't
 * thrash per-item. Rides ~edge of SEARCH limiter with optional micro-pad.
 */
export class SurveyTradeGate {
  private cooldownUntil = 0;
  private chain: Promise<void> = Promise.resolve();
  /** Consecutive server waits ≥ this many seconds. */
  private consecutiveLongWaits = 0;
  private readonly longWaitSec: number;
  private readonly pauseAfterLong: number;
  private readonly microPadMs: number;

  constructor(opts?: {
    longWaitSec?: number;
    pauseAfterLong?: number;
    microPadMs?: number;
  }) {
    this.longWaitSec = opts?.longWaitSec ?? 120;
    this.pauseAfterLong = opts?.pauseAfterLong ?? 3;
    this.microPadMs = opts?.microPadMs ?? 200;
  }

  /** True when the account is in a deep hole — caller should pause the job. */
  shouldPause(): boolean {
    return this.consecutiveLongWaits >= this.pauseAfterLong;
  }

  resetPauseCounters(): void {
    this.consecutiveLongWaits = 0;
  }

  /**
   * Serialize survey traffic: honor cooldown, then predictive SEARCH wait.
   * Does not borrow tokens — requestTradeResultList still calls waitMulti.
   */
  acquire(progress?: (msg: string) => void): Promise<void> {
    const run = async () => {
      const now = Date.now();
      if (this.cooldownUntil > now) {
        const sec = Math.ceil((this.cooldownUntil - now) / 1000);
        progress?.(`Survey gate — cooldown ${sec}s`);
        await sleep(this.cooldownUntil - now);
      }
      const est = RateLimiter.estimateTime(1, RATE_LIMIT_RULES.SEARCH);
      if (est > 500) {
        progress?.(`Survey gate — SEARCH wait ~${Math.ceil(est / 1000)}s`);
        await sleep(est);
      }
    };
    const next = this.chain.then(run, run);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** After a successful trade call — light pad when nearly empty. */
  async noteSuccess(): Promise<void> {
    this.consecutiveLongWaits = 0;
    const est = RateLimiter.estimateTime(1, RATE_LIMIT_RULES.SEARCH);
    if (est > 0 || this.tokensTight()) {
      await sleep(this.microPadMs);
    }
  }

  /**
   * Server 429 / rate-limit error — block all survey traffic for waitSec (+pad).
   */
  async noteRateLimit(
    waitSec: number,
    progress?: (msg: string) => void,
  ): Promise<void> {
    const pad = 2;
    const sec = Math.min(360, Math.max(5, waitSec + pad));
    if (sec >= this.longWaitSec) this.consecutiveLongWaits++;
    else this.consecutiveLongWaits = 0;
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + sec * 1000);
    progress?.(
      `Survey gate — rate limit, global cooldown ${sec}s` +
        (this.shouldPause() ? " (pause threshold)" : ""),
    );
    await sleep(sec * 1000);
  }

  private tokensTight(): boolean {
    for (const lim of RATE_LIMIT_RULES.SEARCH) {
      if (lim.stack.length >= Math.max(1, lim.max - 1)) return true;
    }
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}
