<template>
  <div
    class="text-xs border border-violet-800/50 rounded bg-gray-950/80 p-2 flex flex-col gap-2"
  >
    <div class="flex items-center justify-between gap-2 text-violet-100">
      <div class="font-semibold">Roll seen logger</div>
      <div class="text-gray-400 truncate">
        {{ baseLabel }} · empty = unmeasured
      </div>
    </div>

    <div
      class="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-gray-400 leading-snug"
    >
      <span
        :class="{
          'text-green-300': syncState.status === 'synced' || syncState.status === 'bootstrapped',
          'text-amber-300': syncState.status === 'local-only' || syncState.status === 'saving' || syncState.status === 'loading',
          'text-red-300': syncState.status === 'error',
        }"
        :title="syncState.error ?? syncState.path ?? ''"
      >
        {{ syncStatusLabel }}
      </span>
      <span v-if="syncState.path" class="text-gray-500 truncate max-w-[18rem]" :title="syncState.path">
        {{ shortSyncPath }}
      </span>
      <button type="button" class="btn text-xs" :disabled="syncBusy" @click="reloadFromRepo">
        Reload
      </button>
      <button type="button" class="btn text-xs" :disabled="syncBusy" @click="syncNow">
        Sync
      </button>
    </div>

    <div class="text-gray-400 leading-snug">
      Rolled
      <input
        v-model.number="affixesPerTablet"
        type="number"
        min="1"
        max="8"
        class="w-10 bg-black/40 border border-gray-700 rounded px-1 py-0.5 text-gray-100 mx-0.5"
      />
      affixes on each of
      <input
        v-model.number="tablets"
        type="number"
        min="1"
        max="5000"
        class="w-14 bg-black/40 border border-gray-700 rounded px-1 py-0.5 text-gray-100 mx-0.5"
      />
      tablets
      <span class="text-gray-500">(T={{ totalTrials }})</span>.
      Weights fitted to one-affix appearance; MDP still uses 2p+2s.
    </div>

    <div v-if="caredMods.length" class="grid gap-1 max-h-40 overflow-auto">
      <label
        v-for="mod in caredMods"
        :key="mod.id"
        class="flex items-center gap-2 text-gray-300"
      >
        <span class="w-44 truncate text-sky-200" :title="mod.id">{{
          mod.name
        }}</span>
        <input
          type="text"
          inputmode="numeric"
          class="w-16 bg-black/40 border border-gray-700 rounded px-1 py-0.5 text-gray-100 placeholder:text-gray-600"
          placeholder="—"
          :value="hitText[mod.id] ?? ''"
          @input="onHitInput(mod.id, $event)"
        />
        <span class="text-gray-600">{{ mod.side }}</span>
      </label>
    </div>
    <div v-else class="text-gray-500 italic">No cared (non-Junk) mods for this base.</div>

    <div v-if="error" class="text-red-300">{{ error }}</div>

    <div class="flex flex-wrap gap-1">
      <button type="button" class="btn text-xs" @click="addBatch">
        Add batch
      </button>
      <button type="button" class="btn text-xs" @click="runFit">
        Fit weights
      </button>
      <button
        type="button"
        class="btn text-xs"
        :disabled="!lastFit?.converged"
        :title="
          lastFit && !lastFit.converged
            ? lastFit.failureReason ?? 'fit did not converge'
            : 'Apply runtime overrides (what-if)'
        "
        @click="applyFit"
      >
        Apply Fit
      </button>
      <button type="button" class="btn text-xs" @click="clearFit">
        Clear runtime fit
      </button>
      <button type="button" class="btn text-xs" @click="exportRaw">
        Export raw JSON
      </button>
      <button type="button" class="btn text-xs" @click="copyAggregate">
        Copy aggregate
      </button>
    </div>

    <div
      v-if="lastFit"
      class="border border-gray-800 rounded p-2 bg-gray-900/40 space-y-1"
    >
      <div class="flex flex-wrap gap-x-3 gap-y-1 text-gray-300">
        <span>
          Fit:
          <b
            :class="
              lastFit.converged ? 'text-green-300' : 'text-amber-300'
            "
            >{{ lastFit.converged ? "converged" : "failed" }}</b
          >
        </span>
        <span v-if="lastFit.failureReason" class="text-amber-300">{{
          lastFit.failureReason
        }}</span>
        <span>iters {{ lastFit.iterations }}</span>
        <span>maxAbs {{ fmt(lastFit.maxAbsErr) }}</span>
        <span>trash {{ lastFit.trashMode }}</span>
        <span class="text-gray-500">{{ weightBadge }}</span>
      </div>
      <table class="w-full text-left">
        <thead class="text-gray-500">
          <tr>
            <th class="px-1">mod</th>
            <th class="px-1 text-right">hits</th>
            <th class="px-1 text-right">trials</th>
            <th class="px-1 text-right">MLE</th>
            <th class="px-1 text-right">post μ</th>
            <th class="px-1 text-right">95% CI</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="p in lastFit.posteriors"
            :key="p.modId"
            class="border-t border-gray-900 text-gray-300"
          >
            <td class="px-1 truncate max-w-[9rem]" :title="p.modId">
              {{ p.modId }}
            </td>
            <td class="px-1 text-right">{{ p.hits }}</td>
            <td class="px-1 text-right">{{ p.trials }}</td>
            <td class="px-1 text-right">{{ pct(p.mleRate) }}</td>
            <td class="px-1 text-right">{{ pct(p.mean) }}</td>
            <td class="px-1 text-right">
              {{ pct(p.ci95[0]) }}–{{ pct(p.ci95[1]) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="batchesForBase.length" class="max-h-28 overflow-auto space-y-1">
      <div
        v-for="b in batchesForBase"
        :key="b.id"
        class="flex items-center gap-2 text-gray-400 border border-gray-900 rounded px-2 py-0.5"
      >
        <span
          >{{ b.affixesPerTablet }}×{{ b.tablets }} ·
          {{ measuredCount(b) }} measured</span
        >
        <button type="button" class="btn text-xs ml-auto" @click="removeBatch(b.id)">
          Delete
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { TABLET_BASES, TABLET_MOD_WEIGHTS } from "@/web/price-check/tablets/mod-weights";
import { modQualityTier } from "@/web/price-check/tablets/mod-tiers";
import {
  aggregateRawSeen,
  attributeModSide,
  deleteBatch,
  loadRollSeen,
  upsertBatch,
  SideAttributionError,
} from "@/web/price-check/tablets/roll-seen-store";
import { copyRollSeenJsonToClipboard } from "@/web/price-check/tablets/roll-seen-export";
import type {
  FittedWeightSnapshot,
  ModHitObservation,
  RollSeenDocument,
} from "@/web/price-check/tablets/roll-seen-types";
import {
  fitTargetsFromAggregateCells,
  fitWeightOverridesFromRates,
} from "@/web/price-check/tablets/weight-fitter";
import {
  applyRuntimeWeightFit,
  clearRuntimeWeightFit,
  getWeightFitForBase,
  runtimeOverridesForBase,
  upsertWeightFit,
} from "@/web/price-check/tablets/weight-fit-store";
import {
  getRollSeenSyncState,
  hydrateRollSeenFromRepo,
  onRollSeenSyncState,
  pushRollSeenToRepo,
  type RollSeenSyncState,
} from "@/web/price-check/tablets/tablet-roll-seen-host-bridge";

const props = defineProps<{
  baseId: string;
}>();

const emit = defineEmits<{
  (e: "fit-applied"): void;
}>();

const doc = ref<RollSeenDocument>(loadRollSeen());
const affixesPerTablet = ref(4);
const tablets = ref(20);
const hitText = reactive<Record<string, string>>({});
const error = ref("");
const lastFit = ref<FittedWeightSnapshot | null>(
  getWeightFitForBase(props.baseId),
);
const syncState = ref<RollSeenSyncState>(getRollSeenSyncState());
let unsubSync: (() => void) | null = null;

const syncBusy = computed(
  () =>
    syncState.value.status === "loading" ||
    syncState.value.status === "saving",
);

const syncStatusLabel = computed(() => {
  switch (syncState.value.status) {
    case "synced":
      return "synced to tablet_roll_seen.json";
    case "bootstrapped":
      return "bootstrapped → tablet_roll_seen.json";
    case "saving":
      return "saving to repo…";
    case "loading":
      return "loading from repo…";
    case "local-only":
      return "localStorage only (repo unreachable)";
    case "error":
      return `repo sync error${syncState.value.error ? `: ${syncState.value.error}` : ""}`;
    default:
      return "repo sync idle";
  }
});

const shortSyncPath = computed(() => {
  const p = syncState.value.path;
  if (!p) return "";
  const norm = p.replace(/\\/g, "/");
  const parts = norm.split("/");
  return parts.slice(-2).join("/");
});

const baseLabel = computed(
  () => TABLET_BASES[props.baseId]?.name ?? props.baseId,
);

const totalTrials = computed(
  () => Math.max(1, affixesPerTablet.value) * Math.max(1, tablets.value),
);

const caredMods = computed(() => {
  const base = TABLET_BASES[props.baseId];
  if (!base) return [] as Array<{ id: string; name: string; side: string }>;
  const out: Array<{ id: string; name: string; side: string }> = [];
  for (const id of [
    ...base.allowedPrefixPool,
    ...base.allowedSuffixPool,
  ]) {
    if (modQualityTier(id) === "Junk") continue;
    let side: string;
    try {
      side = attributeModSide(props.baseId, id);
    } catch {
      continue;
    }
    out.push({
      id,
      name: TABLET_MOD_WEIGHTS[id]?.name ?? id,
      side,
    });
  }
  return out;
});

const batchesForBase = computed(() =>
  doc.value.batches.filter((b) => b.baseId === props.baseId).slice().reverse(),
);

const weightBadge = computed(() => {
  if (runtimeOverridesForBase(props.baseId)) return "runtime fit";
  const committed = TABLET_BASES[props.baseId]?.weightOverrides;
  if (committed && Object.keys(committed).length) return "committed overrides";
  if (lastFit.value && !lastFit.value.converged) return "fit failed";
  return "seed weights";
});

watch(
  () => props.baseId,
  (id) => {
    lastFit.value = getWeightFitForBase(id);
    error.value = "";
    for (const k of Object.keys(hitText)) delete hitText[k];
  },
);

onMounted(() => {
  unsubSync = onRollSeenSyncState((s) => {
    syncState.value = s;
  });
  void reloadFromRepo();
});

onUnmounted(() => {
  unsubSync?.();
  unsubSync = null;
});

async function reloadFromRepo() {
  error.value = "";
  doc.value = await hydrateRollSeenFromRepo();
}

async function syncNow() {
  error.value = "";
  const r = await pushRollSeenToRepo(doc.value);
  if (!r.ok) {
    error.value = r.error ?? "Sync failed";
  }
}

function onHitInput(modId: string, ev: Event) {
  const el = ev.target as HTMLInputElement;
  hitText[modId] = el.value;
}

function parseHits(): ModHitObservation[] {
  const hits: ModHitObservation[] = [];
  for (const mod of caredMods.value) {
    const raw = (hitText[mod.id] ?? "").trim();
    if (!raw) {
      // empty = unmeasured — omit from sparse list (or include null)
      continue;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
      throw new Error(`Invalid hits for ${mod.id}`);
    }
    hits.push({ modId: mod.id, hits: n });
  }
  return hits;
}

function measuredCount(b: { hits: ModHitObservation[] }) {
  return b.hits.filter((h) => h.hits != null).length;
}

function addBatch() {
  error.value = "";
  try {
    const hits = parseHits();
    doc.value = upsertBatch(doc.value, {
      baseId: props.baseId,
      affixesPerTablet: Math.max(1, Math.round(affixesPerTablet.value) || 4),
      tablets: Math.max(1, Math.round(tablets.value) || 1),
      hits,
    });
    for (const k of Object.keys(hitText)) delete hitText[k];
  } catch (e) {
    error.value =
      e instanceof SideAttributionError
        ? e.message
        : e instanceof Error
          ? e.message
          : String(e);
  }
}

function removeBatch(id: string) {
  doc.value = deleteBatch(doc.value, id);
}

function runFit() {
  error.value = "";
  const agg = aggregateRawSeen(doc.value);
  const targets = fitTargetsFromAggregateCells(
    props.baseId,
    agg.cells,
  ).filter((t) => modQualityTier(t.modId) !== "Junk");
  const snap = fitWeightOverridesFromRates(props.baseId, targets, {
    trashMode: "seed",
    maxIters: 200,
  });
  lastFit.value = snap;
  upsertWeightFit(snap);
  if (!snap.converged) {
    error.value = `Fit did not converge: ${snap.failureReason ?? "unknown"}`;
  }
}

function applyFit() {
  if (!applyRuntimeWeightFit(props.baseId)) {
    error.value = "Apply Fit requires a converged fit";
    return;
  }
  emit("fit-applied");
}

function clearFit() {
  clearRuntimeWeightFit(props.baseId);
  emit("fit-applied");
}

async function exportRaw() {
  await copyRollSeenJsonToClipboard(doc.value, {
    fit: lastFit.value ?? undefined,
  });
}

async function copyAggregate() {
  await copyRollSeenJsonToClipboard(doc.value, {
    fit: lastFit.value ?? undefined,
    aggregateOnly: true,
  });
}

function pct(n: number) {
  if (!Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(n >= 0.1 ? 1 : 2)}%`;
}
function fmt(n: number) {
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(4);
}
</script>
