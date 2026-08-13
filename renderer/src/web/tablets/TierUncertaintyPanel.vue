<template>
  <div
    class="text-xs border border-amber-800/50 rounded bg-gray-950/80 p-2 flex flex-col gap-2"
  >
    <div class="flex items-center justify-between gap-2 text-amber-100">
      <div class="font-semibold">Tier uncertainty</div>
      <div class="text-gray-400 truncate">
        {{ baseLabel }} · least sure → set S/A/B/Junk
      </div>
      <button type="button" class="btn text-xs shrink-0" @click="emit('close')">
        Close
      </button>
    </div>

    <div class="text-gray-400 leading-snug">
      Ranked by how unsure we are of quality tiers (not prices). Auto Breach
      survey stays available separately. Manual price entry is secondary.
    </div>

    <div class="overflow-auto max-h-56 border border-gray-800 rounded">
      <table class="w-full text-left">
        <thead class="text-gray-500 sticky top-0 bg-gray-950">
          <tr>
            <th class="px-1 py-0.5">mod</th>
            <th class="px-1 py-0.5">tier</th>
            <th class="px-1 py-0.5 text-right">score</th>
            <th class="px-1 py-0.5">why</th>
            <th class="px-1 py-0.5">set</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in topRows"
            :key="row.modId"
            class="border-t border-gray-900 text-gray-300"
          >
            <td class="px-1 py-0.5 truncate max-w-[9rem]" :title="row.modId">
              {{ row.name }}
            </td>
            <td class="px-1 py-0.5">
              <span :class="tierClass(row.tier)">{{ row.tier }}</span>
            </td>
            <td class="px-1 py-0.5 text-right text-amber-200">
              {{ row.score }}
            </td>
            <td class="px-1 py-0.5 text-gray-500 max-w-[10rem] truncate">
              {{ reasonText(row) }}
            </td>
            <td class="px-1 py-0.5 whitespace-nowrap">
              <button
                v-for="t in tiers"
                :key="t"
                type="button"
                class="btn text-[10px] px-1 py-0 mr-0.5"
                :class="{ 'ring-1 ring-amber-400': row.tier === t }"
                @click="setTier(row.modId, t)"
              >
                {{ t }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="flex flex-wrap gap-1 items-center">
      <button type="button" class="btn text-xs" @click="emit('refresh-selected')">
        Refresh selected market
      </button>
      <button
        type="button"
        class="btn text-xs"
        :class="{ 'ring-1 ring-amber-400': showManual }"
        @click="showManual = !showManual"
      >
        {{ showManual ? "Hide price entry" : "Manual price entry (legacy)" }}
      </button>
    </div>

    <ManualTierSurveyPanel v-if="showManual" @close="showManual = false" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, shallowRef } from "vue";
import ManualTierSurveyPanel from "./ManualTierSurveyPanel.vue";
import {
  rankTierUncertainty,
  setSessionModTier,
  TABLET_BASES,
  tabletTierSurvey,
  type MarketPriceCache,
  type ModQualityTier,
  type TierUncertaintyRow,
} from "@/web/price-check/tablets";

const props = defineProps<{
  baseId: string;
  market: MarketPriceCache;
}>();

const emit = defineEmits<{
  close: [];
  "refresh-selected": [];
  "tier-changed": [];
}>();

const tiers: ModQualityTier[] = ["S", "A", "B", "Junk"];
const showManual = ref(false);
/** Bump to recompute ranking after session tier writes. */
const tick = shallowRef(0);

const baseLabel = computed(
  () => TABLET_BASES[props.baseId]?.name ?? props.baseId,
);

const topRows = computed(() => {
  void tick.value;
  const rows = rankTierUncertainty(
    props.baseId,
    props.market,
    tabletTierSurvey.value,
  );
  return rows.filter((r) => r.score > 0).slice(0, 24);
});

function reasonText(row: TierUncertaintyRow): string {
  const bits: string[] = [];
  if (row.reasons.noExplicitTier) bits.push("no explicit");
  if (row.reasons.notSaleTouching) bits.push("no sale");
  if (row.reasons.valueScoreFallback) bits.push("score fallback");
  if (row.reasons.noAutoSurvey) bits.push("no auto survey");
  return bits.join(", ") || "—";
}

function tierClass(t: ModQualityTier): string {
  switch (t) {
    case "S":
      return "text-yellow-300";
    case "A":
      return "text-sky-300";
    case "B":
      return "text-gray-300";
    default:
      return "text-gray-500";
  }
}

function setTier(modId: string, tier: ModQualityTier) {
  setSessionModTier(modId, tier);
  tick.value++;
  emit("tier-changed");
}
</script>
