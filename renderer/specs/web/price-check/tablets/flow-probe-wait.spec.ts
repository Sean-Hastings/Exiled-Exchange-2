import { describe, expect, it } from "vitest";
import {
  FLOW_PROBE_MS,
  FLOW_PROBE_WAIT_SKIP_MS,
  remainingFlowProbeWaitMs,
} from "@/web/price-check/tablets/trade-price-estimators";

describe("remainingFlowProbeWaitMs", () => {
  const T0 = 1_000_000;

  it("returns positive remainder when middle work finished before the probe window", () => {
    const elapsed = 12_000;
    expect(remainingFlowProbeWaitMs(T0, T0 + elapsed, FLOW_PROBE_MS)).toBe(
      FLOW_PROBE_MS - elapsed,
    );
  });

  it("returns 0 when middle work already burned ≥ flowProbeMs (no idle wait)", () => {
    expect(remainingFlowProbeWaitMs(T0, T0 + FLOW_PROBE_MS, FLOW_PROBE_MS)).toBe(
      0,
    );
    expect(
      remainingFlowProbeWaitMs(T0, T0 + FLOW_PROBE_MS + 5_000, FLOW_PROBE_MS),
    ).toBe(0);
  });

  it("documents the ≤500ms skip threshold used by sync (sleep only when waitMore > skip)", () => {
    expect(FLOW_PROBE_WAIT_SKIP_MS).toBe(500);
    const justAbove = remainingFlowProbeWaitMs(
      T0,
      T0 + FLOW_PROBE_MS - 501,
      FLOW_PROBE_MS,
    );
    const atOrBelow = remainingFlowProbeWaitMs(
      T0,
      T0 + FLOW_PROBE_MS - 500,
      FLOW_PROBE_MS,
    );
    expect(justAbove).toBe(501);
    expect(justAbove > FLOW_PROBE_WAIT_SKIP_MS).toBe(true);
    expect(atOrBelow).toBe(500);
    expect(atOrBelow > FLOW_PROBE_WAIT_SKIP_MS).toBe(false);
  });

  it("accepts a custom flowProbeMs", () => {
    expect(remainingFlowProbeWaitMs(T0, T0 + 1_000, 10_000)).toBe(9_000);
  });
});
