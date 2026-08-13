<template>
  <div
    class="text-xs border border-sky-800/50 rounded bg-gray-950/80 p-2 flex flex-col gap-1.5"
  >
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sky-100">
      <span class="font-semibold">Batch risk</span>
      <span class="text-gray-400 truncate" :title="policyLabel">
        Y · {{ policyLabel }}
      </span>
      <span class="text-gray-500">C={{ craftCountC }}</span>
      <span
        class="px-1 rounded bg-gray-800 text-gray-300"
        title="v1 method"
        >{{ methodChip }}</span
      >
      <span
        v-if="reforgeApprox"
        class="px-1 rounded bg-amber-900/70 text-amber-200"
        title="Reforge uses MDP 1/3 expected continuation; batch coupling not modeled"
        >approx</span
      >
    </div>

    <div class="flex flex-wrap gap-1 items-center">
      <button
        type="button"
        class="btn text-xs"
        :class="{ 'ring-1 ring-sky-400': mode === 'point' }"
        @click="mode = 'point'"
      >
        Point weights (§3)
      </button>
      <button
        type="button"
        class="btn text-xs"
        :class="{ 'ring-1 ring-violet-400': mode === 'mixture' }"
        @click="mode = 'mixture'"
      >
        Mixture (§9)
      </button>
      <button
        v-if="mode === 'mixture'"
        type="button"
        class="btn text-xs"
        :disabled="busy"
        @click="runFullMixture"
      >
        Full mixture (D=200)
      </button>
      <span v-if="busy" class="text-gray-400">
        {{ progressLabel }}
        <button type="button" class="btn text-xs ml-1" @click="cancel">
          Cancel
        </button>
      </span>
    </div>

    <div v-if="naReason" class="text-amber-300">{{ naReason }}</div>

    <template v-else-if="display">
      <div class="text-gray-200 leading-snug">
        <div>
          1a · 95% sure spend for {{ craftCountC }} crafts ≤
          <b class="text-sky-200">{{ fmtEx(display.zCapEx) }}</b> ex
          <span v-if="mode === 'mixture'" class="text-gray-500">
            (under weight uncertainty)
          </span>
        </div>
        <div>
          1b · 95% sure profit ≥
          <b class="text-green-300">{{ fmtEx(display.zProfitEx) }}</b> ex
        </div>
        <div
          v-if="mode === 'mixture' && mixtureEv"
          class="text-gray-400 mt-0.5"
        >
          EV · point {{ fmtEx(pointWhiteEv) }} · mixture
          {{ fmtEx(mixtureEv.band[0]) }}–{{ fmtEx(mixtureEv.band[1]) }}
          (mean {{ fmtEx(mixtureEv.mean) }})
        </div>
        <div
          v-if="mode === 'mixture' && mixtureResult?.note"
          class="text-amber-200/90 text-[11px] mt-0.5"
        >
          {{ mixtureResult.note }}
          <span v-if="mixtureResult.outerDrawsRequested">
            · requested {{ mixtureResult.outerDrawsRequested }}, used
            {{ mixtureResult.outerDraws }}
          </span>
        </div>
      </div>
    </template>

    <div v-else-if="busy" class="text-gray-500 italic">
      Computing…
    </div>

    <div v-else class="text-gray-500 italic">
      —
    </div>

    <div v-if="reforgeApprox" class="text-amber-200/80 text-[11px] leading-snug">
      Reforge uses MDP 1/3 expected continuation; batch coupling not modeled —
      bands are approximate.
    </div>
    <div class="text-gray-500 text-[11px] leading-snug">
      Spend ignores mid-batch sales. Y from point MDP.
      <span v-if="mode === 'mixture' && mixtureResult">
        · 95% under weight uncertainty (mixture).
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import {
  aggregateRawSeen,
  computeBatchLawAsync,
  computeMixtureRisk,
  loadRollSeen,
  MIXTURE_D_FULL,
  MIXTURE_D_INTERACTIVE,
  POINT_MC_BATCHES,
  policyToLegacyRare,
  policyUsesReforge,
  recommendPolicy,
  formatSplitStrategy,
  type BatchLawResult,
  type MixtureRiskResult,
  type MarketPriceCache,
  type ModWeightOpts,
} from "@/web/price-check/tablets";

const props = defineProps<{
  baseId: string;
  market: MarketPriceCache;
  craftCountC: number;
  weightOpts?: ModWeightOpts;
  /** Point whiteEV from dashboard row / MDP (unchanged column). */
  pointWhiteEv?: number;
}>();

const mode = ref<"point" | "mixture">("point");
const busy = ref(false);
const progress = ref({ done: 0, total: 0, label: "" });
const naReason = ref<string | null>(null);
const pointResult = ref<BatchLawResult | null>(null);
const mixtureResult = ref<MixtureRiskResult | null>(null);
const mixtureOuterD = ref(MIXTURE_D_INTERACTIVE);

let abort: AbortController | null = null;
let runGen = 0;

const recommended = computed(() =>
  recommendPolicy(props.market, props.baseId, props.weightOpts),
);

const policyLabel = computed(() => {
  const hit = recommended.value;
  if (!hit) return "—";
  return formatSplitStrategy(
    hit.policy.blank,
    policyToLegacyRare(hit.policy),
  );
});

const reforgeApprox = computed(() => {
  const p = recommended.value?.policy;
  if (!p) return false;
  return (
    policyUsesReforge(p) ||
    !!pointResult.value?.reforgeApprox ||
    !!mixtureResult.value?.reforgeApprox
  );
});

const methodChip = computed(() => {
  if (mode.value === "mixture") return "mc·mixture";
  return pointResult.value?.method ?? "mc";
});

const display = computed(() => {
  if (mode.value === "mixture") {
    const m = mixtureResult.value;
    if (!m) return null;
    return { zCapEx: m.zCapEx, zProfitEx: m.zProfitEx };
  }
  const p = pointResult.value;
  if (!p) return null;
  return { zCapEx: p.zCapEx, zProfitEx: p.zProfitEx };
});

const pointWhiteEv = computed(() => props.pointWhiteEv);

const mixtureEv = computed(() => {
  const m = mixtureResult.value;
  if (!m) return null;
  return { mean: m.evMeanEx, band: m.evBand };
});

const progressLabel = computed(() => {
  const { done, total, label } = progress.value;
  if (!total) return label || "Working…";
  return `${label || "MC"} ${done}/${total}`;
});

function fmtEx(n: number | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(1);
}

/** Cancel in-flight work; never leave perpetual Computing… */
function cancel(terminalReason = "Cancelled") {
  runGen++;
  abort?.abort();
  abort = null;
  busy.value = false;
  if (!pointResult.value && !mixtureResult.value) {
    naReason.value = terminalReason;
  }
}

async function recompute() {
  const gen = ++runGen;
  abort?.abort();
  abort = null;
  naReason.value = null;
  pointResult.value = null;
  mixtureResult.value = null;

  const hit = recommended.value;
  if (!hit) {
    naReason.value = "N/A — need market sync / policy";
    busy.value = false;
    return;
  }
  if (hit.policy.blank === "Skip-Blanks") {
    naReason.value = "N/A — Skip-Blanks (no craft batch)";
    busy.value = false;
    return;
  }
  const baseCost = props.market.basePrices[props.baseId];
  if (!Number.isFinite(baseCost)) {
    naReason.value = "N/A — need market sync (blank cost)";
    busy.value = false;
    return;
  }

  const overrides = props.weightOpts?.runtimeOverrides;
  abort = new AbortController();
  const signal = abort.signal;
  busy.value = true;
  progress.value = { done: 0, total: POINT_MC_BATCHES, label: "Point MC" };

  try {
    const point = await computeBatchLawAsync({
      baseId: props.baseId,
      market: props.market,
      policy: hit.policy,
      craftCountC: props.craftCountC,
      weightOverrides: overrides,
      mcBatches: POINT_MC_BATCHES,
      retainSamples: false,
      signal,
      onProgress: (done, total) => {
        if (gen !== runGen) return;
        progress.value = { done, total, label: "Point MC" };
      },
    });
    if (gen !== runGen) return;
    if (signal.aborted) {
      naReason.value = "Cancelled";
      return;
    }
    if (!point) {
      naReason.value = "N/A — batch law unavailable";
      return;
    }
    pointResult.value = point;

    if (mode.value !== "mixture") {
      return;
    }

    const D = mixtureOuterD.value;
    progress.value = { done: 0, total: D, label: "Mixture" };
    const aggregate = aggregateRawSeen(loadRollSeen());
    const mix = await computeMixtureRisk({
      baseId: props.baseId,
      market: props.market,
      policy: hit.policy,
      craftCountC: props.craftCountC,
      aggregate,
      outerDraws: D,
      signal,
      chunkSize: 1,
      onProgress: (done, total) => {
        if (gen !== runGen) return;
        progress.value = { done, total, label: "Mixture" };
      },
    });
    if (gen !== runGen) return;
    if (signal.aborted) {
      naReason.value = "Cancelled";
      mixtureResult.value = null;
      return;
    }
    if (!mix) {
      naReason.value =
        "N/A — mixture needs roll-seen mass (or fit failed too often)";
      mixtureResult.value = null;
    } else {
      mixtureResult.value = mix;
    }
  } catch (err) {
    if (gen === runGen) {
      naReason.value =
        err instanceof Error ? `N/A — ${err.message}` : "N/A — risk error";
      pointResult.value = null;
      mixtureResult.value = null;
    }
  } finally {
    if (gen === runGen) {
      busy.value = false;
      if (abort?.signal === signal) abort = null;
    }
  }
}

function runFullMixture() {
  mixtureOuterD.value = MIXTURE_D_FULL;
  void recompute();
}

watch(
  () =>
    [
      props.baseId,
      props.craftCountC,
      mode.value,
      mixtureOuterD.value,
      props.market,
      props.weightOpts,
    ] as const,
  () => {
    // Reset full→interactive when leaving mixture or changing base
    if (mode.value === "point") mixtureOuterD.value = MIXTURE_D_INTERACTIVE;
    void recompute();
  },
  { immediate: true },
);

watch(
  () => props.baseId,
  () => {
    mixtureOuterD.value = MIXTURE_D_INTERACTIVE;
    // recompute() in the combined watch already aborts prior work
  },
);

onUnmounted(() => {
  cancel();
});
</script>
