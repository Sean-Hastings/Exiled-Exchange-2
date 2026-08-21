<template>
  <div
    class="text-xs border border-amber-800/50 rounded bg-gray-950/80 p-2 flex flex-col gap-2"
  >
    <div class="flex items-center justify-between gap-2 text-amber-100">
      <div class="font-semibold">Tier uncertainty</div>
      <div class="text-gray-400 truncate">
        {{ baseLabel }} · mod quality + combo rare tiers
      </div>
      <button type="button" class="btn text-xs shrink-0" @click="emit('close')">
        Close
      </button>
    </div>

    <div class="text-gray-400 leading-snug">
      Edits update this panel live (mods + combo auto). Click
      <span class="text-amber-200">Apply to EV</span> to push tiers into MDP /
      strat / regex (avoids freezing on every click).
    </div>

    <div class="overflow-auto max-h-72 border border-gray-800 rounded">
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
            :class="{ 'bg-amber-950/25': row.isMarked }"
          >
            <td class="px-1 py-0.5 truncate max-w-[9rem]" :title="row.modId">
              {{ row.name }}
            </td>
            <td class="px-1 py-0.5">
              <span :class="modTierClass(row.tier)">{{ row.tier }}</span>
            </td>
            <td class="px-1 py-0.5 text-right text-amber-200">
              {{ row.score }}
            </td>
            <td class="px-1 py-0.5 text-gray-500 max-w-[10rem] truncate">
              {{ reasonText(row) }}
            </td>
            <td class="px-1 py-0.5 whitespace-nowrap">
              <button
                v-for="t in modTiers"
                :key="t"
                type="button"
                class="btn text-[10px] px-1 py-0 mr-0.5"
                :class="{ 'ring-1 ring-amber-400': row.tier === t }"
                @click="setModTier(row.modId, t)"
              >
                {{ t }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="border border-gray-800 rounded">
      <button
        type="button"
        class="w-full text-left px-2 py-1 text-amber-100 font-semibold flex items-center justify-between"
        @click="showCombos = !showCombos"
      >
        <span>Combo tiers (A / S / SS)</span>
        <span class="text-gray-500 font-normal">{{ showCombos ? "▼" : "▶" }}</span>
      </button>

      <div v-if="showCombos" class="px-2 pb-2 flex flex-col gap-2">
        <div class="flex flex-wrap gap-1 items-center">
          <button
            type="button"
            class="btn text-xs"
            :class="{ 'ring-1 ring-amber-400': showDefineCombo }"
            @click="showDefineCombo = !showDefineCombo"
          >
            {{ showDefineCombo ? "Cancel define" : "+ Define combo" }}
          </button>
          <span class="text-gray-500">{{ comboRows.length }} rows</span>
        </div>

        <div
          v-if="showDefineCombo"
          class="border border-gray-800 rounded p-2 flex flex-col gap-2 bg-gray-950/60"
        >
          <div class="flex flex-wrap gap-2 items-end">
            <label class="flex flex-col gap-0.5 text-gray-400">
              Prefix1
              <select
                v-model="definePrefix1Id"
                class="bg-gray-900 border border-gray-700 rounded px-1 py-0.5 text-gray-200 max-w-[12rem]"
              >
                <option value="">—</option>
                <option v-for="id in prefixPool" :key="id" :value="id">
                  {{ modLabel(id) }}
                </option>
              </select>
            </label>
            <label class="flex flex-col gap-0.5 text-gray-400">
              Prefix2
              <select
                v-model="definePrefix2Id"
                class="bg-gray-900 border border-gray-700 rounded px-1 py-0.5 text-gray-200 max-w-[12rem]"
              >
                <option value="">—</option>
                <option v-for="id in prefixPool" :key="id" :value="id">
                  {{ modLabel(id) }}
                </option>
              </select>
            </label>
            <label class="flex flex-col gap-0.5 text-gray-400">
              Suffix1
              <select
                v-model="defineSuffix1Id"
                class="bg-gray-900 border border-gray-700 rounded px-1 py-0.5 text-gray-200 max-w-[12rem]"
              >
                <option value="">—</option>
                <option v-for="id in suffixPool" :key="id" :value="id">
                  {{ modLabel(id) }}
                </option>
              </select>
            </label>
            <label class="flex flex-col gap-0.5 text-gray-400">
              Suffix2
              <select
                v-model="defineSuffix2Id"
                class="bg-gray-900 border border-gray-700 rounded px-1 py-0.5 text-gray-200 max-w-[12rem]"
              >
                <option value="">—</option>
                <option v-for="id in suffixPool" :key="id" :value="id">
                  {{ modLabel(id) }}
                </option>
              </select>
            </label>
            <label class="flex flex-col gap-0.5 text-gray-400">
              Tier
              <select
                v-model="defineTier"
                class="bg-gray-900 border border-gray-700 rounded px-1 py-0.5 text-gray-200"
              >
                <option v-for="t in rareTiers" :key="t" :value="t">
                  {{ t }}
                </option>
              </select>
            </label>
            <button
              type="button"
              class="btn text-xs"
              :disabled="!canDefineCombo"
              @click="saveDefinedCombo"
            >
              Save combo
            </button>
          </div>
          <div v-if="defineError" class="text-red-400">{{ defineError }}</div>
        </div>

        <div class="overflow-auto max-h-48 border border-gray-800 rounded">
          <table class="w-full text-left">
            <thead class="text-gray-500 sticky top-0 bg-gray-950">
              <tr>
                <th class="px-1 py-0.5">combo</th>
                <th class="px-1 py-0.5">auto→tier</th>
                <th class="px-1 py-0.5 text-right">price</th>
                <th class="px-1 py-0.5">set</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in comboRows"
                :key="row.comboKey"
                class="border-t border-gray-900 text-gray-300"
              >
                <td
                  class="px-1 py-0.5 truncate max-w-[10rem]"
                  :title="row.comboKey"
                >
                  {{ comboLabel(row) }}
                </td>
                <td class="px-1 py-0.5 whitespace-nowrap">
                  <span v-if="row.source === 'override'" class="text-amber-300">
                    {{ row.autoTier }}→
                  </span>
                  <span :class="rareTierClass(row.tier)">{{ row.tier }}</span>
                  <span
                    v-if="row.isCustom"
                    class="ml-1 text-[10px] text-violet-300"
                  >
                    custom
                  </span>
                </td>
                <td class="px-1 py-0.5 text-right text-gray-400">
                  {{ row.measuredEx != null ? `${row.measuredEx}ex` : "—" }}
                </td>
                <td class="px-1 py-0.5 whitespace-nowrap">
                  <button
                    v-for="t in rareTiers"
                    :key="t"
                    type="button"
                    class="btn text-[10px] px-1 py-0 mr-0.5"
                    :class="{ 'ring-1 ring-amber-400': row.tier === t }"
                    @click="setComboTier(row, t)"
                  >
                    {{ t }}
                  </button>
                  <button
                    type="button"
                    class="btn text-[10px] px-1 py-0 ml-0.5 text-gray-500"
                    @click="clearComboTier(row)"
                  >
                    Clear
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="flex flex-wrap gap-1 items-center">
      <button
        type="button"
        class="btn text-xs"
        :class="{
          'ring-1 ring-amber-400 text-amber-100': tiersDirty,
          'opacity-50': !tiersDirty,
        }"
        :disabled="!tiersDirty"
        @click="applyTiers"
      >
        {{ tiersDirty ? "Apply to EV / MDP" : "EV up to date" }}
      </button>
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
import { computed, onMounted, ref, shallowRef } from "vue";
import ManualTierSurveyPanel from "./ManualTierSurveyPanel.vue";
import {
  RARE_TIERS,
  TABLET_BASES,
  TABLET_MOD_WEIGHTS,
  enumerateComboTierRows,
  hydrateComboTierOverrides,
  rankTierUncertainty,
  removeComboOverride,
  setSessionComboTier,
  setSessionModTier,
  snapshotComboTierOverrides,
  snapshotSessionModTiers,
  tabletTierSurvey,
  validateComboMods,
  type ComboTierRow,
  type MarketPriceCache,
  type ModQualityTier,
  type RareTier,
  type TierUncertaintyRow,
} from "@/web/price-check/tablets";
import {
  commitTierOverrides,
  emptyTierOverridesDocument,
} from "@/web/price-check/tablets/tier-overrides-store";

const props = defineProps<{
  baseId: string;
  market: MarketPriceCache;
}>();

const emit = defineEmits([
  "close",
  "refresh-selected",
  "tiers-applied",
]);

const modTiers: ModQualityTier[] = ["S", "A", "B", "Junk"];
const rareTiers: RareTier[] = RARE_TIERS;
const showManual = ref(false);
const showCombos = ref(true);
const showDefineCombo = ref(false);
const definePrefix1Id = ref("");
const definePrefix2Id = ref("");
const defineSuffix1Id = ref("");
const defineSuffix2Id = ref("");
const defineTier = ref<RareTier>("SS");
const defineError = ref("");
/** Bump to recompute ranking after session tier writes. */
const tick = shallowRef(0);
/** True until Apply pushes session tiers into EV/MDP. */
const tiersDirty = ref(false);

onMounted(() => {
  hydrateComboTierOverrides();
});

const baseLabel = computed(
  () => TABLET_BASES[props.baseId]?.name ?? props.baseId,
);

const prefixPool = computed(
  () => TABLET_BASES[props.baseId]?.allowedPrefixPool ?? [],
);
const suffixPool = computed(
  () => TABLET_BASES[props.baseId]?.allowedSuffixPool ?? [],
);

const topRows = computed(() => {
  void tick.value;
  // Full pool: score-0 (perfect certainty) stays visible so tiers can be
  // reassigned. Sort already puts marked first, then uncertain → certain.
  return rankTierUncertainty(
    props.baseId,
    props.market,
    tabletTierSurvey.value,
  );
});

const comboRows = computed(() => {
  void tick.value;
  return enumerateComboTierRows(props.baseId, props.market);
});

const canDefineCombo = computed(
  () =>
    !!definePrefix1Id.value ||
    !!definePrefix2Id.value ||
    !!defineSuffix1Id.value ||
    !!defineSuffix2Id.value,
);

function modLabel(modId: string): string {
  return TABLET_MOD_WEIGHTS[modId]?.name ?? modId;
}

function comboLabel(row: ComboTierRow): string {
  return row.modLabels.join(" + ");
}

function reasonText(row: TierUncertaintyRow): string {
  const bits: string[] = [];
  if (row.reasons.noExplicitTier) bits.push("no explicit");
  if (row.reasons.notSaleTouching) bits.push("no sale");
  if (row.reasons.valueScoreFallback) bits.push("score fallback");
  if (row.reasons.noAutoSurvey) bits.push("no auto survey");
  return bits.join(", ") || "—";
}

function modTierClass(t: ModQualityTier): string {
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

function rareTierClass(t: RareTier): string {
  switch (t) {
    case "SS":
      return "text-amber-200 font-semibold";
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

function markTiersDirty() {
  tick.value++;
  tiersDirty.value = true;
}

function applyTiers() {
  if (!tiersDirty.value) return;
  const comboSnap = snapshotComboTierOverrides();
  const doc = {
    ...emptyTierOverridesDocument(),
    updatedAt: Date.now(),
    modTiersByBase: snapshotSessionModTiers(),
    comboByBase: comboSnap.byBase,
  };
  commitTierOverrides(doc);
  tiersDirty.value = false;
  emit("tiers-applied");
}

function setModTier(modId: string, tier: ModQualityTier) {
  setSessionModTier(props.baseId, modId, tier);
  markTiersDirty();
}

function setComboTier(row: ComboTierRow, tier: RareTier) {
  setSessionComboTier(props.baseId, row.modIds, tier, {
    isCustom: row.isCustom,
  });
  markTiersDirty();
}

function clearComboTier(row: ComboTierRow) {
  removeComboOverride(props.baseId, row.modIds);
  markTiersDirty();
}

function saveDefinedCombo() {
  defineError.value = "";
  const picked = [
    definePrefix1Id.value,
    definePrefix2Id.value,
    defineSuffix1Id.value,
    defineSuffix2Id.value,
  ].filter(Boolean);
  const modIds = [...new Set(picked)];
  if (!modIds.length) {
    defineError.value = "Pick at least one prefix or suffix.";
    return;
  }
  if (picked.length !== modIds.length) {
    defineError.value = "Duplicate mods are not allowed.";
    return;
  }
  if (!validateComboMods(props.baseId, modIds)) {
    defineError.value = "Invalid combo for this base.";
    return;
  }
  setSessionComboTier(props.baseId, modIds, defineTier.value, {
    isCustom: true,
  });
  definePrefix1Id.value = "";
  definePrefix2Id.value = "";
  defineSuffix1Id.value = "";
  defineSuffix2Id.value = "";
  showDefineCombo.value = false;
  markTiersDirty();
}
</script>
