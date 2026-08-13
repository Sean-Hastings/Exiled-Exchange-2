<template>
  <div
    class="text-xs border border-amber-800/60 rounded bg-gray-950/80 p-2 flex flex-col gap-2"
    @keydown="onKey"
  >
    <div class="flex items-center justify-between gap-2 text-amber-100">
      <div class="font-semibold">Manual Temple survey</div>
      <div class="text-gray-400">
        {{ progress.done }}/{{ progress.total }}
        · ~{{ Math.max(progress.total - progress.done, 0) }} left
      </div>
    </div>

    <div class="text-gray-400 leading-snug">
      On trade: set <b class="text-gray-200">Type</b> + filter as shown → glance
      at liquid asks → type the exalt price
      <b class="text-gray-200">you'd sell at</b> (undercut ok).
      <span class="text-gray-500">Enter save · N no results · ← back</span>
    </div>

    <div
      v-if="step"
      class="border border-gray-800 rounded p-2 bg-gray-900/50 flex flex-col gap-2"
    >
      <div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span class="text-sky-200 font-semibold">{{ idx + 1 }}. {{ step.label }}</span>
        <span v-if="step.quality" class="text-amber-300">{{ step.quality }}</span>
      </div>
      <div class="text-gray-200">{{ step.lookFor }}</div>

      <div class="grid gap-1 text-gray-300">
        <div>
          <span class="text-gray-500">Type</span>
          <span class="ml-1 text-green-300 font-mono">{{ step.typeName }}</span>
        </div>
        <div v-if="step.filterName" class="flex items-start gap-1">
          <span class="text-gray-500 shrink-0">Filter</span>
          <code
            class="flex-1 whitespace-normal break-words bg-black/50 border border-gray-700 rounded px-2 py-1 text-green-300 font-mono"
            :title="step.filterName"
          >{{ step.filterName }}</code>
          <button type="button" class="btn text-xs shrink-0" @click="copyFilter">
            {{ copied ? "Copied" : "Copy" }}
          </button>
        </div>
        <div v-else class="flex items-center gap-1">
          <span class="text-gray-500">Filter</span>
          <span class="text-gray-400 italic">none (type only)</span>
          <button type="button" class="btn text-xs shrink-0 ml-auto" @click="copyFilter">
            {{ copied ? "Copied" : "Copy type" }}
          </button>
        </div>
        <div v-if="step.filterRangeLabel">
          <span class="text-gray-500">Range</span>
          <span class="ml-1 text-amber-200 font-semibold">{{ step.filterRangeLabel }}</span>
          <span v-if="step.filterMin != null" class="text-gray-500 ml-1">
            → set min {{ step.filterMin }}
          </span>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-1">
        <input
          ref="priceInput"
          v-model="priceText"
          type="text"
          inputmode="decimal"
          placeholder="sell ex"
          class="w-24 bg-black/40 border border-gray-600 rounded px-2 py-1 text-gray-100"
          @keydown.enter.prevent="submitPrice"
        />
        <button type="button" class="btn text-xs" @click="submitPrice">
          Save
        </button>
        <button type="button" class="btn text-xs" @click="submitNoResults">
          No results
        </button>
        <button type="button" class="btn text-xs" @click="goBack" :disabled="idx <= 0">
          ←
        </button>
        <button
          type="button"
          class="btn text-xs"
          :disabled="idx >= steps.length - 1"
          @click="goNext"
        >
          →
        </button>
        <span v-if="existing" class="text-gray-500 ml-1">
          saved
          {{
            existing.noResults
              ? "no results"
              : `${existing.sellEx}ex`
          }}
        </span>
      </div>
    </div>

    <div v-else class="text-green-300">
      Done — {{ progress.done }}/{{ progress.total }} answers.
    </div>

    <div class="flex flex-wrap gap-1">
      <button type="button" class="btn text-xs" @click="copyJson">
        Copy JSON
      </button>
      <button type="button" class="btn text-xs" @click="resetSession">
        Reset
      </button>
      <button type="button" class="btn text-xs" @click="$emit('close')">
        Close
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import {
  analyzeTierSurvey,
  formatSurveyAnalysisMarkdown,
} from "@/web/price-check/tablets/tier-survey-analyze";
import {
  MANUAL_SURVEY_BASE_ID,
  buildManualSurveySteps,
  clearManualSession,
  emptyManualSession,
  filterCopyText,
  loadManualSession,
  manualProgress,
  manualSessionToSurveyDoc,
  recordManualAnswer,
  saveManualSession,
  type ManualSurveySession,
} from "@/web/price-check/tablets/manual-tier-survey";
import { tabletMarketCache } from "@/web/price-check/tablets/tablet-market-store";

defineEmits<{ close: [] }>();

const steps = buildManualSurveySteps(MANUAL_SURVEY_BASE_ID);
const session = ref<ManualSurveySession>(
  loadManualSession() ?? emptyManualSession(MANUAL_SURVEY_BASE_ID),
);
const idx = ref(0);
const priceText = ref("");
const copied = ref(false);
const priceInput = ref<HTMLInputElement | null>(null);

const progress = computed(() => manualProgress(session.value, steps));
const step = computed(() => steps[idx.value] ?? null);
const existing = computed(() =>
  step.value ? session.value.answers[step.value.key] : undefined,
);

function focusPrice() {
  void nextTick(() => priceInput.value?.focus());
}

function syncFromAnswer() {
  const a = existing.value;
  priceText.value =
    a && !a.noResults && a.sellEx != null ? String(a.sellEx) : "";
}

async function copyFilter() {
  if (!step.value) return;
  try {
    await navigator.clipboard.writeText(filterCopyText(step.value));
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 800);
  } catch {
    /* ignore */
  }
}

function advanceAfterSave() {
  if (idx.value < steps.length - 1) {
    idx.value += 1;
  } else {
    session.value.cursor = idx.value;
  }
  session.value.cursor = idx.value;
  saveManualSession(session.value);
  syncFromAnswer();
  void copyFilter();
  focusPrice();
}

function submitPrice() {
  if (!step.value) return;
  const n = Number(String(priceText.value).trim().replace(/,/g, ""));
  if (!Number.isFinite(n) || n < 0) return;
  session.value = recordManualAnswer(session.value, step.value, { sellEx: n });
  advanceAfterSave();
}

function submitNoResults() {
  if (!step.value) return;
  session.value = recordManualAnswer(session.value, step.value, {
    noResults: true,
  });
  advanceAfterSave();
}

function goBack() {
  if (idx.value <= 0) return;
  idx.value -= 1;
  session.value.cursor = idx.value;
  saveManualSession(session.value);
  syncFromAnswer();
  void copyFilter();
  focusPrice();
}

function goNext() {
  if (idx.value >= steps.length - 1) return;
  idx.value += 1;
  session.value.cursor = idx.value;
  saveManualSession(session.value);
  syncFromAnswer();
  void copyFilter();
  focusPrice();
}

function onKey(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement | null)?.tagName;
  if (e.key === "n" || e.key === "N") {
    if (tag === "INPUT" && priceText.value.trim() !== "") return;
    e.preventDefault();
    submitNoResults();
    return;
  }
  if (e.key === "ArrowLeft" && tag !== "INPUT") {
    e.preventDefault();
    goBack();
  }
  if (e.key === "ArrowRight" && tag !== "INPUT") {
    e.preventDefault();
    goNext();
  }
}

function copyJson() {
  const fx = tabletMarketCache.value.fx;
  const doc = manualSessionToSurveyDoc(session.value, steps, fx
    ? {
        exaltPerChaos: fx.exaltPerChaos,
        exaltPerDivine: fx.exaltPerDivine,
      }
    : undefined);
  const analysis = analyzeTierSurvey(doc);
  const payload = {
    survey: doc,
    analysis,
    analysisMarkdown: formatSurveyAnalysisMarkdown(analysis),
    manual: session.value,
  };
  const text = JSON.stringify(payload, null, 2);
  void (async () => {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      /* overlay often lacks clipboard permission when unfocused */
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    } catch {
      // Last resort: open a downloadable blob in-overlay
      const blob = new Blob([text], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "manual-temple-tier-survey.json";
      a.click();
      URL.revokeObjectURL(url);
    }
  })();
}

function resetSession() {
  clearManualSession();
  session.value = emptyManualSession(MANUAL_SURVEY_BASE_ID);
  idx.value = 0;
  priceText.value = "";
  void copyFilter();
  focusPrice();
}

watch(idx, () => {
  syncFromAnswer();
});

onMounted(() => {
  const p = manualProgress(session.value, steps);
  idx.value =
    session.value.cursor >= 0 && session.value.cursor < steps.length
      ? session.value.cursor
      : p.nextIndex < steps.length
        ? p.nextIndex
        : Math.max(steps.length - 1, 0);
  syncFromAnswer();
  void copyFilter();
  focusPrice();
});
</script>
