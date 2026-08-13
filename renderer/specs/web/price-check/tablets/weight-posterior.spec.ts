import { describe, expect, it } from "vitest";
import {
  betaPosterior,
  drawSideRates,
  summarizePosteriors,
} from "@/web/price-check/tablets/weight-posterior";
import type { RawSeenAggregate } from "@/web/price-check/tablets/roll-seen-types";
import { ROLL_SEEN_REVISION } from "@/web/price-check/tablets/roll-seen-types";

describe("weight-posterior", () => {
  it("separates MLE from Beta display mean (zero hits ≠ mean 0)", () => {
    const post = betaPosterior(0, 100);
    expect(post.mleRate).toBe(0);
    expect(post.mean).toBeGreaterThan(0);
    expect(post.mean).toBeCloseTo(1 / 102);
    expect(post.ci95[0]).toBeLessThan(post.ci95[1]);
    expect(post.ci95[0]).toBeGreaterThanOrEqual(0);
    expect(post.ci95[1]).toBeLessThanOrEqual(1);
  });

  it("MLE equals hits/trials for positive hits", () => {
    const post = betaPosterior(5, 100);
    expect(post.mleRate).toBeCloseTo(0.05);
    expect(post.mean).toBeCloseTo(6 / 102);
  });

  it("summarizePosteriors omits unmeasured (empty aggregate cells)", () => {
    const agg: RawSeenAggregate = {
      revision: ROLL_SEEN_REVISION,
      updatedAt: 1,
      cells: [
        {
          baseId: "temple_tablet",
          side: "suffix",
          modId: "temple_crystal_t1",
          hits: 5,
          trials: 100,
          batchCount: 1,
        },
      ],
      sideTrials: [
        { baseId: "temple_tablet", side: "suffix", sideTrials: 100 },
      ],
    };
    const posts = summarizePosteriors(agg);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.mleRate).toBeCloseTo(0.05);
  });

  it("Dirichlet α uses sideTrials trash lump; unmeasured non-junk not categories", () => {
    const agg: RawSeenAggregate = {
      revision: ROLL_SEEN_REVISION,
      updatedAt: 1,
      cells: [
        {
          baseId: "temple_tablet",
          side: "suffix",
          modId: "temple_crystal_t1",
          hits: 5,
          trials: 40,
          batchCount: 1,
        },
      ],
      sideTrials: [
        { baseId: "temple_tablet", side: "suffix", sideTrials: 40 },
        { baseId: "temple_tablet", side: "prefix", sideTrials: 40 },
      ],
    };
    let i = 0;
    const rng = () => {
      i += 1;
      return (i % 97) / 97;
    };
    const draw = drawSideRates(agg, "temple_tablet", "suffix", rng)!;
    expect(draw.alphas.temple_crystal_t1).toBe(1 + 5);
    expect(draw.alphas.__trash__).toBe(1 + Math.max(0, 40 - 5));
    // Only measured cared + trash
    expect(Object.keys(draw.caredRates)).toEqual(["temple_crystal_t1"]);
    expect(draw.trashRate).toBeGreaterThan(0);
    const sum =
      Object.values(draw.caredRates).reduce((a, b) => a + b, 0) +
      draw.trashRate;
    expect(sum).toBeCloseTo(1, 5);
  });
});
