<template>
  <div
    v-if="evaluation"
    class="rounded px-2 py-1.5 mb-2 text-sm border"
    :class="bannerClass"
  >
    <div class="flex items-start justify-between gap-2">
      <div class="min-w-0">
        <div class="font-semibold tracking-wide">
          {{ actionLabel }}
        </div>
        <div class="text-xs opacity-90 mt-0.5 leading-snug">
          {{ evaluation.explanation }}
        </div>
        <div class="text-xs mt-1 opacity-75 flex flex-wrap gap-x-3 gap-y-0.5">
          <span
            >List ~{{
              Number.isFinite(evaluation.currentMarketPrice)
                ? evaluation.currentMarketPrice.toFixed(2)
                : "NaN"
            }}ex</span
          >
          <span>Blank {{ evaluation.baseEV.blankStrategy }}</span>
          <span>Rare {{ evaluation.rareStrategy }}</span>
        </div>
      </div>
      <button
        type="button"
        class="shrink-0 btn text-xs px-2 py-1"
        :title="regex"
        @click="copyRegex"
      >
        Copy Stash Filter
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from "vue";
import type { ParsedItem } from "@/parser";
import { MainProcess } from "@/web/background/IPC";
import {
  ensureTabletMarketSynced,
  getHighValueModsForBase,
  parseTabletFromItem,
  STRAT_CORE_REGEX,
  tabletMarketCache,
  TabletEVEngine,
  TabletRegexBuilder,
  UNIVERSAL_CATCHALL_REGEX,
  type TabletItemEvaluation,
} from "@/web/price-check/tablets";

const props = defineProps<{
  item: ParsedItem;
}>();

const engine = computed(() => new TabletEVEngine(tabletMarketCache.value));

const tablet = computed(() => parseTabletFromItem(props.item));

const evaluation = computed<TabletItemEvaluation | null>(() => {
  if (!tablet.value) return null;
  return engine.value.evaluateCurrentItem(tablet.value);
});

onMounted(() => {
  void ensureTabletMarketSynced(false);
});

const actionLabel = computed(() => {
  switch (evaluation.value?.action) {
    case "SELL_AS_IS":
      return "SELL AS-IS";
    case "REROLL":
      return `REROLL (${evaluation.value.rareStrategy})`;
    case "VAAL_SLAM":
      return "VAAL CORRUPT";
    case "REFORGE":
      return "REFORGE 3:1";
    case "MERCHANT":
      return "MERCHANT LIST";
    case "EXALT":
      return "EXALT SLAM";
    default:
      return "";
  }
});

const bannerClass = computed(() => {
  switch (evaluation.value?.action) {
    case "SELL_AS_IS":
    case "MERCHANT":
      return "bg-green-900/60 border-green-600 text-green-100";
    case "REROLL":
    case "EXALT":
      return "bg-yellow-900/50 border-yellow-600 text-yellow-100";
    case "VAAL_SLAM":
    case "REFORGE":
      return "bg-red-900/50 border-red-600 text-red-100";
    default:
      return "bg-gray-800 border-gray-600";
  }
});

const regex = computed(() => {
  if (!tablet.value) return '""';
  const core = STRAT_CORE_REGEX[tablet.value.category];
  if (core && core.length <= 50) return core;

  const mods = getHighValueModsForBase(tablet.value.tabletBaseKey, 70);
  const built = TabletRegexBuilder.buildOptimizedRegex(
    mods.map((m) => ({
      id: m.id,
      name: m.name,
      regexHint: m.regexHint,
      minDesiredValue: Math.ceil((m.minValue + m.maxValue) / 2),
      priority: m.valueScore,
      highlightCategory: "high_value" as const,
    })),
  );
  return built.length <= 50 ? built : UNIVERSAL_CATCHALL_REGEX;
});

function copyRegex() {
  MainProcess.sendEvent({
    name: "CLIENT->MAIN::user-action",
    payload: { action: "stash-search", text: regex.value },
  });
}
</script>