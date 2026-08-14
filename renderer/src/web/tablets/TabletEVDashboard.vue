<template>
  <Widget :config="config" move-handles="corners" :inline-edit="false">
    <div
      class="widget-default-style p-2 flex flex-col gap-2 overflow-hidden"
      :style="
        showDebug
          ? 'min-width: 60rem; max-width: 110rem; max-height: 92vh'
          : 'min-width: 56rem; max-width: 104rem; max-height: 90vh'
      "
    >
      <div class="flex items-center justify-between gap-2 text-gray-100">
        <div class="font-semibold truncate">Tablet EV Dashboard</div>
        <div class="text-xs text-gray-400 shrink-0">
          {{ config.toggleKey || "no hotkey" }}
        </div>
      </div>

      <div class="flex flex-wrap gap-1 items-center">
        <button
          type="button"
          class="btn text-xs"
          :disabled="isRefreshing"
          @click="refresh"
        >
          {{ isRefreshing && !refreshScope ? "Refreshing…" : "Force Market Refresh" }}
        </button>
        <button
          type="button"
          class="btn text-xs"
          :disabled="isRefreshing || !selectedRow"
          :title="selectedRow ? `Re-price only ${selectedRow.baseName}` : 'Select a tablet row first'"
          @click="refreshSelected"
        >
          {{
            isRefreshing && refreshScope
              ? `Refreshing ${refreshScope}…`
              : selectedRow
                ? `Refresh ${shortBaseName(selectedRow.baseName)}`
                : "Refresh Selected"
          }}
        </button>
        <label
          class="flex items-center gap-1 text-xs text-gray-400 px-1"
          title="Off: Instant Buyout (in-game marketplace) only. On: if Instant Buyout is empty, also search in-person / trade-site listings."
        >
          <input
            type="checkbox"
            class="accent-sky-400"
            :checked="includeWhisper"
            :disabled="isRefreshing"
            @change="onIncludeWhisperInput"
          />
          Include in-person (trade site)
        </label>
        <label
          class="flex items-center gap-1 text-xs text-gray-400 px-1"
          title="Buy count B: blank unit cost = mean of the cheapest B Instant Buyout asks (hot→min(B,10), warm→min(B,25), cold→B). Instant Buyout only unless ‘Include in-person (trade site)’ is on."
        >
          Buy B
          <input
            type="number"
            min="5"
            max="50"
            step="1"
            class="w-12 bg-gray-900 border border-gray-700 rounded px-1 py-0.5 text-gray-100"
            :value="buyCountB"
            :disabled="isRefreshing"
            @change="onBuyCountBInput"
          />
        </label>
        <span
          class="text-[10px] text-gray-500 max-w-[14rem] leading-tight"
          title="Ship note: blank unit cost is mean of cheapest B Instant Buyout asks (regime-capped). Instant Buyout only unless in-person toggle is on."
        >
          Blank cost = mean@B (mkt-first)
        </span>
        <label
          class="flex items-center gap-1 text-xs text-gray-400 px-1"
          title="Craft count C: batch size for risk UI only (does not change blank buy price)."
        >
          Craft C
          <input
            type="number"
            min="1"
            max="500"
            step="1"
            class="w-12 bg-gray-900 border border-gray-700 rounded px-1 py-0.5 text-gray-100"
            :value="craftCountC"
            @change="onCraftCountCInput"
          />
        </label>
        <button type="button" class="btn text-xs" @click="copySelectedRegex">
          Copy Stash Regex
        </button>
        <button type="button" class="btn text-xs" @click="runSimulation">
          Simulate 1000 Crafts
        </button>
        <button
          type="button"
          class="btn text-xs"
          :class="{ 'ring-1 ring-violet-400': showRollSeen }"
          title="Log experiential affix hits for weight fitting"
          @click="showRollSeen = !showRollSeen"
        >
          {{ showRollSeen ? "Hide Roll Log" : "Roll Log" }}
        </button>
        <button
          type="button"
          class="btn text-xs"
          :class="{ 'ring-1 ring-amber-400': showTierUncertainty }"
          title="Which mods are we least sure how to tier (S/A/B/Junk)?"
          @click="showTierUncertainty = !showTierUncertainty"
        >
          {{ showTierUncertainty ? "Hide Tier Uncertainty" : "Tier Uncertainty" }}
        </button>
        <button
          type="button"
          class="btn text-xs"
          :class="{ 'ring-1 ring-amber-400': showDebug }"
          @click="showDebug = !showDebug"
        >
          {{ showDebug ? "Hide Debug" : "Debug Prices" }}
        </button>
      </div>

      <TierUncertaintyPanel
        v-if="showTierUncertainty && selectedId"
        :base-id="selectedId"
        :market="market"
        @close="showTierUncertainty = false"
        @refresh-selected="refreshSelected"
        @tier-changed="recompute"
      />

      <div
        v-if="simResult"
        class="text-xs text-gray-300 bg-gray-900/60 rounded px-2 py-1"
      >
        {{ selectedRow?.baseName }} ·
        <span class="text-sky-300">{{ simResult.policyLabel }}</span>
        — {{ simResult.hits }}/1000 non-trash
        ({{ (simResult.hitRate * 100).toFixed(1) }}%), avg sale
        {{ fmtEx(simResult.averageValue) }}ex, net
        {{ fmtEx(simResult.netProfit) }}ex
        <span v-if="simResult.avgChaosRolls > 0" class="text-gray-400">
          · {{ simResult.avgChaosRolls.toFixed(2) }} chaos/item
        </span>
        <span v-if="simResult.truncated" class="text-amber-300">
          · {{ simResult.truncated }} truncated
        </span>
        <div class="text-gray-500 mt-0.5">
          Simulate net profit includes sales; ≠ 1a spend (1a is liquid spend only, no sale offsets).
        </div>
      </div>

      <RollSeenPanel
        v-if="showRollSeen && selectedId"
        :base-id="selectedId"
        @fit-applied="onFitApplied"
      />

      <div
        v-if="confidenceRows.length"
        class="text-xs border border-gray-800 rounded bg-gray-950/60 px-2 py-1"
      >
        <div class="flex flex-wrap gap-x-3 gap-y-1 text-gray-400 mb-1">
          <span class="text-violet-200 font-semibold">Weight confidence</span>
          <span>{{ confidenceBadge }}</span>
          <span v-if="confidenceFitResidual" class="text-gray-500">
            {{ confidenceFitResidual }}
          </span>
        </div>
        <div class="overflow-auto max-h-28">
          <table class="w-full text-left">
            <thead class="text-gray-500">
              <tr>
                <th class="px-1">mod</th>
                <th class="px-1 text-right">n</th>
                <th class="px-1 text-right">hits</th>
                <th class="px-1 text-right">MLE</th>
                <th class="px-1 text-right">μ</th>
                <th class="px-1 text-right">CI95</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="r in confidenceRows"
                :key="r.modId"
                class="border-t border-gray-900 text-gray-300"
              >
                <td class="px-1 truncate max-w-[8rem]" :title="r.modId">
                  {{ r.modId }}
                </td>
                <td class="px-1 text-right">{{ r.trials }}</td>
                <td class="px-1 text-right">{{ r.hits }}</td>
                <td class="px-1 text-right">{{ pct(r.mleRate) }}</td>
                <td class="px-1 text-right">{{ pct(r.mean) }}</td>
                <td class="px-1 text-right">
                  {{ pct(r.ci95[0]) }}–{{ pct(r.ci95[1]) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div
        class="flex gap-3 min-h-0 flex-1 overflow-hidden"
        style="min-height: 14rem"
      >
        <div
          v-if="selectedId && selectedRow"
          class="flex flex-col min-h-0 min-w-0 flex-1 overflow-auto"
        >
          <BatchRiskPanel
            :base-id="selectedId"
            :market="market"
            :craft-count-c="craftCountC"
            :weight-opts="selectedWeightOpts"
            :point-white-ev="selectedRow.netEV"
          />
        </div>

        <div
          class="flex flex-col gap-2 min-h-0 min-w-0 flex-1 overflow-auto"
        >
          <div class="overflow-auto min-h-0 border border-gray-700 rounded flex-1">
            <table class="w-full text-xs text-left">
              <thead class="bg-gray-900 text-gray-300 sticky top-0">
                <tr>
                  <th class="px-2 py-1">Tablet</th>
                  <th class="px-2 py-1 text-right">Base</th>
                  <th class="px-2 py-1 text-right">Net EV</th>
                  <th class="px-2 py-1 text-right">ex/hr</th>
                  <th class="px-2 py-1">Blank→</th>
                  <th class="px-2 py-1">Rare→</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="row in rows"
                  :key="row.baseId"
                  class="border-t border-gray-800 cursor-pointer hover:bg-gray-800/80"
                  :class="{
                    'bg-gray-800': selectedId === row.baseId,
                    'text-green-300': Number.isFinite(row.netEV) && row.netEV > 0,
                    'text-red-300': Number.isFinite(row.netEV) && row.netEV <= 0,
                    'text-gray-500': !Number.isFinite(row.netEV),
                  }"
                  @click="selectedId = row.baseId"
                >
                  <td class="px-2 py-1 text-gray-100">{{ row.baseName }}</td>
                  <td class="px-2 py-1 text-right">{{ fmtEx(row.baseCost) }}</td>
                  <td class="px-2 py-1 text-right">{{ fmtEx(row.netEV) }}</td>
                  <td class="px-2 py-1 text-right">{{ fmtEx(row.profitPerHour, 1) }}</td>
                  <td class="px-2 py-1 text-sky-300" :title="`EV ${fmtEx(row.blankNetEV)}ex`">
                    {{ blankLabel(row.blankStrategy) }}
                  </td>
                  <td class="px-2 py-1 text-amber-300" :title="`EV ${fmtEx(row.rareNetEV)}ex`">
                    {{ rareLabel(row.rareStrategy) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div
            v-if="selectedRow"
            class="text-xs text-gray-300 bg-gray-900/60 rounded px-2 py-1 leading-snug shrink-0"
          >
            <span class="text-sky-300">Blank:</span>
            {{ blankLabel(selectedRow.blankStrategy) }}
            ({{ fmtEx(selectedRow.blankNetEV) }}ex) ·
            <span class="text-amber-300">Rare:</span>
            {{ rareLabel(selectedRow.rareStrategy) }}
            ({{ fmtEx(selectedRow.rareNetEV) }}ex)
          </div>
        </div>

        <div
          v-if="selectedExplain"
          class="text-xs border border-sky-800/50 rounded bg-gray-950/70 overflow-hidden flex flex-col min-h-0 min-w-0 flex-1"
        >
          <div
            class="px-2 py-1 bg-sky-950/40 text-sky-100 border-b border-sky-900/50 flex flex-wrap gap-x-3 gap-y-1 shrink-0"
          >
            <span class="font-semibold">Strategy revenue</span>
            <span>
              roll E[rev]
              <b class="text-white">{{ fmtEx(selectedExplain.expectedRollRevenueEx) }}</b>ex
            </span>
            <span>
              dump
              <FallbackEx
                :value="selectedExplain.dumpFloorEx"
                :source="selectedExplain.dumpFloorSource"
                :digits="0"
                suffix="ex"
              />
              · base
              {{ fmtEx(selectedExplain.baseCost, 0) }}ex · measured
              {{ ((selectedExplain.measuredFrac || 0) * 100).toFixed(0) }}%
            </span>
            <span class="text-sky-200/70">
              measured % = sync coverage (diagnostic) · rates = P · value → revenue
            </span>
          </div>
          <div class="overflow-auto min-h-0 p-2 space-y-3 text-gray-300">
            <div>
              <div class="text-sky-200 mb-1">Alch roll → S / A / Trash</div>
              <table class="w-full text-left mb-2">
                <thead class="text-gray-500">
                  <tr>
                    <th class="px-1">bucket</th>
                    <th class="px-1 text-right">P</th>
                    <th class="px-1 text-right">avg ex</th>
                    <th class="px-1 text-right">rev</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="o in selectedExplain.rollOutcomes"
                    :key="o.kind + o.label"
                    class="border-t border-gray-900"
                    :class="outcomeClass(o.kind)"
                  >
                    <td class="px-1">{{ o.label }}</td>
                    <td class="px-1 text-right">{{ pct(o.prob) }}</td>
                    <td class="px-1 text-right">
                      <FallbackEx :value="o.avgValueEx" :source="o.priceSource" :digits="0" />
                    </td>
                    <td class="px-1 text-right">{{ fmtEx(o.revenueEx, 1) }}</td>
                  </tr>
                </tbody>
              </table>
              <div class="text-sky-200/90 mb-1 mt-2">
                Stash triage regex (S→A; no match → Trash)
              </div>
              <div
                v-for="tr in selectedExplain.tierRegexes"
                :key="'rx-' + tr.tier"
                class="border border-gray-800 rounded mb-1 px-2 py-1 flex flex-wrap items-center gap-x-2 gap-y-1"
              >
                <span
                  class="font-semibold w-4"
                  :class="{
                    'text-amber-200': tr.tier === 'S',
                    'text-sky-200': tr.tier === 'A',
                    'text-gray-200': tr.tier === 'B',
                  }"
                >{{ tr.tier }}</span>
                <code class="text-green-300/90 break-all flex-1 min-w-0">{{
                  stripRegexQuotes(tr.regex)
                }}</code>
                <button
                  type="button"
                  class="btn text-xs shrink-0"
                  :disabled="!tr.modIds.length"
                  :title="tr.note"
                  @click="copyTierRegex(tr.regex)"
                >
                  Copy
                </button>
                <span class="text-gray-500 w-full text-[10px] leading-tight">{{
                  tr.note
                }}</span>
              </div>
            </div>

            <div>
              <div class="text-sky-200 mb-1">From blank</div>
              <div
                v-for="s in selectedExplain.blank"
                :key="'b-' + s.strategy"
                class="border border-gray-800 rounded mb-1"
              >
                <div class="px-2 py-1 bg-gray-900 flex flex-wrap gap-x-2">
                  <span class="text-sky-300">{{ blankLabel(s.strategy as any) }}</span>
                  <span>
                    rev <b class="text-white">{{ fmtEx(s.expectedRevenueEx) }}</b>
                    · cost {{ fmtEx(s.costEx) }} · EV
                    <span :class="s.netEV > 0 ? 'text-green-300' : 'text-red-300'">
                      {{ fmtEx(s.netEV) }}
                    </span>
                  </span>
                  <span v-if="s.note" class="text-gray-500 w-full">{{ s.note }}</span>
                </div>
                <table class="w-full text-left">
                  <tbody>
                    <tr
                      v-for="o in s.outcomes"
                      :key="o.label"
                      class="border-t border-gray-900"
                      :class="outcomeClass(o.kind)"
                    >
                      <td class="px-2 py-0.5">{{ o.label }}</td>
                      <td class="px-1 text-right w-14">{{ pct(o.prob) }}</td>
                      <td class="px-1 text-right w-16">
                        <FallbackEx :value="o.avgValueEx" :source="o.priceSource" :digits="0" />
                      </td>
                      <td class="px-1 text-right w-16">{{ fmtEx(o.revenueEx, 1) }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div>
              <div class="text-amber-200 mb-1">
                Per rare tier (EV = marginal vs sell-as-is at that tier = 0)
              </div>
              <div
                v-for="s in selectedExplain.rare"
                :key="'r-' + s.strategy"
                class="border border-gray-800 rounded mb-1"
              >
                <div class="px-2 py-1 bg-gray-900 flex flex-wrap gap-x-2">
                  <span class="text-amber-300">{{ s.strategy }}</span>
                  <span>
                    list
                    <b class="text-white">
                      <FallbackEx
                        :value="s.expectedRevenueEx"
                        :source="s.priceSource"
                        :digits="2"
                      />
                    </b>
                    · ΔEV
                    <span :class="s.netEV > 0 ? 'text-green-300' : 'text-red-300'">
                      {{ s.netEV > 0 ? "+" : "" }}{{ fmtEx(s.netEV) }}
                    </span>
                  </span>
                  <span v-if="s.note" class="text-gray-500 w-full">{{ s.note }}</span>
                </div>
                <table class="w-full text-left">
                  <tbody>
                    <tr
                      v-for="o in s.outcomes"
                      :key="o.label"
                      class="border-t border-gray-900"
                      :class="outcomeClass(o.kind)"
                    >
                      <td class="px-2 py-0.5">{{ o.label }}</td>
                      <td class="px-1 text-right w-16">{{ fmtEx(o.avgValueEx, 0) }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div
        v-if="showDebug"
        class="text-xs border border-amber-700/60 rounded bg-gray-950/80 overflow-hidden flex flex-col min-h-0"
        style="max-height: 40vh"
      >
        <div
          class="flex flex-wrap items-center gap-2 px-2 py-1 bg-amber-950/40 text-amber-100 border-b border-amber-800/50"
        >
          <span class="font-semibold">Price debug</span>
          <span v-if="debug" class="text-amber-200/80">
            r{{ debug.revision }} · {{ debug.leagueId }} · floor
            {{ fmtEx(debug.buyFloorEx, 0) }} · ceil
            {{ fmtEx(debug.buyCeilingEx, 0) }} ·
            {{ fmtEx(debug.fx.exaltPerChaos, 1) }}ex/c ·
            {{ fmtEx(debug.fx.exaltPerDivine, 0) }}ex/div · alch
            {{ fmtEx(debug.fx.alchemy, 2) }} · vaal
            {{ fmtEx(debug.fx.vaal, 2) }}
          </span>
          <span v-else class="text-amber-200/70">
            No trace yet — Force Market Refresh first
          </span>
          <button
            type="button"
            class="btn text-xs ml-auto"
            :disabled="!debug"
            @click="copyDebugJson"
          >
            Copy JSON
          </button>
        </div>

        <div class="overflow-auto p-2 space-y-2 text-gray-300">
          <div v-if="selectedBaseDebug">
            <div class="text-amber-200 mb-1">
              {{ selectedBaseDebug.baseName }} → final buy
              <span class="text-white font-semibold">
                {{ fmtEx(selectedBaseDebug.finalBuy) }}ex
              </span>
              <span v-if="selectedBaseDebug.finalStatus">
                ({{ selectedBaseDebug.finalStatus }})
              </span>
              · tried {{ selectedBaseDebug.typeNamesTried.join(" → ") }}
            </div>

            <div
              v-for="(search, si) in selectedBaseDebug.searches"
              :key="si"
              class="mb-2 border border-gray-800 rounded"
            >
              <div
                class="px-2 py-1 bg-gray-900 cursor-pointer flex flex-wrap gap-x-2"
                @click="toggleSearch(si)"
              >
                <span class="text-sky-300">{{ search.kind }}</span>
                <span v-if="search.statusOption" class="text-amber-200">
                  status={{ search.statusOption }}
                </span>
                <span>{{ search.typeName }}</span>
                <span>
                  hits={{ search.totalHits ?? "?" }} fetched={{ search.fetched }}
                  kept={{ search.kept }} →
                  <b class="text-white">{{ fmtEx(search.estimate) }}</b>
                  ({{ search.estimateNote }})
                </span>
                <span class="text-gray-500">{{ search.mix }}</span>
                <span v-if="search.error" class="text-red-300">{{ search.error }}</span>
              </div>
              <pre
                v-if="expandedSearch === si && search.queryBody"
                class="px-2 py-1 text-[10px] text-gray-500 overflow-auto max-h-24 border-t border-gray-900"
              >{{ JSON.stringify(search.queryBody, null, 2) }}</pre>
              <div v-if="expandedSearch === si" class="overflow-auto max-h-48">
                <table class="w-full text-left">
                  <thead class="text-gray-500 sticky top-0 bg-gray-950">
                    <tr>
                      <th class="px-1">#</th>
                      <th class="px-1">raw</th>
                      <th class="px-1">ccy</th>
                      <th class="px-1 text-right">ex</th>
                      <th class="px-1">keep</th>
                      <th class="px-1">who</th>
                      <th class="px-1">age</th>
                      <th class="px-1">indexed</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="(row, ri) in search.listings"
                      :key="ri"
                      class="border-t border-gray-900"
                      :class="{
                        'text-gray-500': row.keep !== 'ok',
                        'text-green-300': row.keep === 'ok',
                        'text-red-300': row.keep === 'ceiling' || row.keep === 'no-convert',
                      }"
                    >
                      <td class="px-1">{{ ri + 1 }}</td>
                      <td class="px-1">{{ row.amount }}</td>
                      <td class="px-1">{{ row.currency }}</td>
                      <td class="px-1 text-right">{{ fmtEx(row.priceEx, 1) }}</td>
                      <td class="px-1">{{ row.keep }}</td>
                      <td class="px-1">
                        <span v-if="row.isInstantBuyout" class="text-amber-300">mkt</span>
                        <span v-else>{{ row.accountStatus ?? "?" }}</span>
                      </td>
                      <td class="px-1 text-gray-400">{{ ageLabel(row.indexedAt) }}</td>
                      <td class="px-1 text-gray-500 whitespace-nowrap">
                        {{ row.indexedAt ?? "" }}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div v-if="selectedCombos.length" class="mt-2">
              <div class="text-amber-200 mb-1">Combos (sell)</div>
              <div
                v-for="(c, ci) in selectedCombos"
                :key="ci"
                class="border border-gray-800 rounded mb-1"
              >
                <div
                  class="px-2 py-1 bg-gray-900 cursor-pointer"
                  @click="toggleCombo(ci)"
                >
                  {{ c.comboKey }} →
                  <b class="text-white">{{ fmtEx(c.finalSell) }}ex</b>
                  · kept {{ c.search.kept }}/{{ c.search.fetched }} ·
                  {{ c.search.mix }}
                </div>
                <div v-if="expandedCombo === ci" class="overflow-auto max-h-40 px-1">
                  <div
                    v-for="(row, ri) in c.search.listings.slice(0, 30)"
                    :key="ri"
                    class="flex gap-2 border-t border-gray-900 py-0.5"
                    :class="row.keep === 'ok' ? 'text-green-300' : 'text-gray-500'"
                  >
                    <span>{{ row.amount }} {{ row.currency }}</span>
                    <span>→ {{ fmtEx(row.priceEx, 1) }}ex</span>
                    <span>{{ row.keep }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div v-else-if="debug" class="text-gray-500">
            Select a tablet row above to inspect its query path.
          </div>
        </div>
      </div>

      <div class="text-xs text-gray-400 leading-snug">
        {{ statusText }} ·
        {{ fmtEx(market.fx?.exaltPerChaos ?? market.currencyCosts.chaos, 0) }}ex/c
        ·
        {{ fmtEx(market.fx?.exaltPerDivine, 0) }}ex/div · Alch
        {{ fmtEx(market.currencyCosts.alchemy, 3) }}ex · Chaos
        {{ fmtEx(market.currencyCosts.chaos, 0) }}ex
      </div>
    </div>
  </Widget>
</template>

<script lang="ts">
import type { WidgetSpec } from "../overlay/interfaces";
import type { TabletEVWidget } from "./widget";

export default {
  widget: {
    type: "tablet-ev",
    instances: "single",
    trNameKey: "tablet_ev.name",
    initInstance: (): TabletEVWidget => ({
      wmId: 0,
      wmType: "tablet-ev",
      wmTitle: "Tablet EV",
      wmWants: "hide",
      wmZorder: null,
      wmFlags: ["invisible-on-blur"],
      anchor: {
        pos: "tl",
        x: 28,
        y: 18,
      },
      toggleKey: "Shift + T",
    }),
  } satisfies WidgetSpec,
};
</script>

<script setup lang="ts">
import { computed, inject, onMounted, onUnmounted, ref } from "vue";
import Widget from "../overlay/Widget.vue";
import BatchRiskPanel from "./BatchRiskPanel.vue";
import RollSeenPanel from "./RollSeenPanel.vue";
import TierUncertaintyPanel from "./TierUncertaintyPanel.vue";
import { Host, MainProcess } from "@/web/background/IPC";
import type { WidgetManager } from "../overlay/interfaces";
import {
  BLANK_STRATEGY_LABELS,
  ensureTabletMarketSynced,
  getHighValueModsForBase,
  getWeightFitForBase,
  RARE_STRATEGY_LABELS,
  runtimeOverridesForBase,
  setTabletBuyCountB,
  setTabletCraftCountC,
  setTabletIncludeWhisper,
  summarizeMarketForUi,
  tabletBuyCountB,
  tabletCraftCountC,
  tabletIncludeWhisper,
  tabletMarketCache,
  tabletMarketDebug,
  tabletMarketStatus,
  tabletRuntimeWeightOverrides,
  TabletEVEngine,
  TabletRegexBuilder,
  type BlankCraftStrategy,
  type OutcomeKind,
  type RareDispositionStrategy,
  type TabletEVResult,
} from "@/web/price-check/tablets";
import { hydrateRollSeenFromRepo } from "@/web/price-check/tablets/tablet-roll-seen-host-bridge";
import { TABLET_BASES } from "@/web/price-check/tablets/mod-weights";
import FallbackEx from "@/web/price-check/tablets/FallbackEx.vue";

const props = defineProps<{
  config: TabletEVWidget;
}>();

const wm = inject<WidgetManager>("wm")!;

if (props.config.wmFlags[0] === "uninitialized") {
  props.config.wmFlags = ["invisible-on-blur"];
  props.config.anchor = {
    pos: "tl",
    x: 28,
    y: 18,
  };
  props.config.toggleKey = props.config.toggleKey ?? "Shift + T";
  wm.show(props.config.wmId);
}

const isRefreshing = ref(false);
/** Short name shown while a single-base refresh is in flight */
const refreshScope = ref<string | null>(null);
const buyCountB = tabletBuyCountB;
const craftCountC = tabletCraftCountC;
const includeWhisper = tabletIncludeWhisper;
const showDebug = ref(false);
const showTierUncertainty = ref(false);
const showRollSeen = ref(false);
const expandedSearch = ref<number | null>(0);
const expandedCombo = ref<number | null>(null);
const market = tabletMarketCache;
const debug = tabletMarketDebug;
const selectedId = ref("breach_tablet");
const simResult = ref<{
  hits: number;
  hitRate: number;
  averageValue: number;
  netProfit: number;
  avgChaosRolls: number;
  truncated: number;
  policyLabel: string;
} | null>(null);

/** Per-base maps only — never flatten/merge (shared mod ids must not stomp). */
function engineWeightOpts() {
  const all = tabletRuntimeWeightOverrides.value;
  if (!all || !Object.keys(all).length) return undefined;
  return { runtimeOverridesByBase: all };
}

const weightOpts = computed(() => engineWeightOpts());

/** Selected base only — Simulate / BatchRisk / explain. */
const selectedWeightOpts = computed(() => {
  const o = runtimeOverridesForBase(selectedId.value);
  return o && Object.keys(o).length
    ? { runtimeOverrides: o }
    : undefined;
});

const engine = computed(
  () => new TabletEVEngine(market.value, weightOpts.value),
);
const rows = ref<TabletEVResult[]>(engine.value.calculateAllBaseEVs());
if (!rows.value.some((r) => r.baseId === selectedId.value) && rows.value[0]) {
  selectedId.value = rows.value[0].baseId;
}

const selectedRow = computed(() =>
  rows.value.find((r) => r.baseId === selectedId.value),
);

const confidenceRows = computed(() => {
  const fit = getWeightFitForBase(selectedId.value);
  return fit?.posteriors ?? [];
});

const confidenceBadge = computed(() => {
  if (runtimeOverridesForBase(selectedId.value)) return "runtime fit";
  const fit = getWeightFitForBase(selectedId.value);
  if (fit && !fit.converged) return "fit failed";
  const committed = TABLET_BASES[selectedId.value]?.weightOverrides;
  if (committed && Object.keys(committed).length) return "committed overrides";
  return "seed weights";
});

const confidenceFitResidual = computed(() => {
  const fit = getWeightFitForBase(selectedId.value);
  if (!fit) return null;
  const abs = Number.isFinite(fit.maxAbsErr)
    ? fit.maxAbsErr.toExponential(2)
    : "—";
  const rel = Number.isFinite(fit.maxRelErr)
    ? (fit.maxRelErr * 100).toFixed(2)
    : "—";
  return `fit residual max|Δp|=${abs} · max rel=${rel}%${
    fit.converged ? "" : " (!converged)"
  }`;
});

const selectedExplain = computed(() => {
  if (!selectedId.value) return null;
  // Per-base opts so shared mods from other applied fits never leak in.
  return new TabletEVEngine(
    market.value,
    selectedWeightOpts.value,
  ).explainStrategies(selectedId.value);
});

const selectedBaseDebug = computed(() =>
  debug.value?.bases.find((b) => b.baseId === selectedId.value),
);

const selectedCombos = computed(
  () => debug.value?.combos.filter((c) => c.baseId === selectedId.value) ?? [],
);

const statusText = computed(() =>
  summarizeMarketForUi(rows.value, tabletMarketStatus.value),
);

function blankLabel(s: BlankCraftStrategy) {
  return BLANK_STRATEGY_LABELS[s];
}
function rareLabel(s: RareDispositionStrategy) {
  return RARE_STRATEGY_LABELS[s];
}
function fmtEx(n: number | undefined | null, digits = 2): string {
  return n != null && Number.isFinite(n) ? n.toFixed(digits) : "NaN";
}

function pct(p: number): string {
  if (!Number.isFinite(p)) return "—";
  return `${(p * 100).toFixed(p >= 0.1 ? 1 : 2)}%`;
}

function outcomeClass(kind: OutcomeKind): string {
  if (kind === "jackpot") return "text-amber-200";
  if (kind === "hit") return "text-sky-200";
  return "text-gray-400";
}

function ageLabel(indexedAt?: string): string {
  if (!indexedAt) return "";
  const t = Date.parse(indexedAt);
  if (!Number.isFinite(t)) return indexedAt;
  const hours = (Date.now() - t) / 3_600_000;
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${hours.toFixed(0)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function toggleSearch(i: number) {
  expandedSearch.value = expandedSearch.value === i ? null : i;
}
function toggleCombo(i: number) {
  expandedCombo.value = expandedCombo.value === i ? null : i;
}

function copyDebugJson() {
  if (!debug.value) return;
  const payload = selectedBaseDebug.value
    ? {
        fx: debug.value.fx,
        buyFloorEx: debug.value.buyFloorEx,
        buyCeilingEx: debug.value.buyCeilingEx,
        base: selectedBaseDebug.value,
        combos: selectedCombos.value,
        strategyExplain: selectedExplain.value,
      }
    : debug.value;
  void navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
}

function recompute() {
  rows.value = new TabletEVEngine(
    market.value,
    weightOpts.value,
  ).calculateAllBaseEVs();
  simResult.value = null;
  expandedSearch.value = 0;
  expandedCombo.value = null;
}

function shortBaseName(name: string) {
  return name.replace(/\s*Tablet\s*$/i, "") || name;
}

function onBuyCountBInput(ev: Event) {
  const el = ev.target as HTMLInputElement;
  setTabletBuyCountB(Number(el.value));
}

function onCraftCountCInput(ev: Event) {
  const el = ev.target as HTMLInputElement;
  setTabletCraftCountC(Number(el.value));
}

function onIncludeWhisperInput(ev: Event) {
  const el = ev.target as HTMLInputElement;
  setTabletIncludeWhisper(el.checked);
}

function onFitApplied() {
  recompute();
}

async function refresh() {
  if (isRefreshing.value) return;
  isRefreshing.value = true;
  refreshScope.value = null;
  try {
    await ensureTabletMarketSynced(true);
    recompute();
  } finally {
    isRefreshing.value = false;
    refreshScope.value = null;
  }
}

async function refreshSelected() {
  if (isRefreshing.value || !selectedId.value) return;
  const name = selectedRow.value?.baseName ?? selectedId.value;
  isRefreshing.value = true;
  refreshScope.value = shortBaseName(name);
  try {
    await ensureTabletMarketSynced(true, { baseIds: [selectedId.value] });
    recompute();
  } finally {
    isRefreshing.value = false;
    refreshScope.value = null;
  }
}

function stripRegexQuotes(regex: string): string {
  return regex.replace(/^"|"$/g, "");
}

function copyTierRegex(regex: string) {
  const text = stripRegexQuotes(regex);
  if (!text) return;
  MainProcess.sendEvent({
    name: "CLIENT->MAIN::user-action",
    payload: { action: "stash-search", text: `"${text}"` },
  });
}

function selectedRegex(): string {
  const mods = getHighValueModsForBase(selectedId.value, 70);
  return TabletRegexBuilder.buildOptimizedRegex(
    mods.map((m) => ({
      id: m.id,
      name: m.name,
      regexHint: m.regexHint,
      minDesiredValue: Math.ceil((m.minValue + m.maxValue) / 2),
      priority: m.valueScore,
      highlightCategory: "high_value" as const,
    })),
  );
}

function copySelectedRegex() {
  MainProcess.sendEvent({
    name: "CLIENT->MAIN::user-action",
    payload: { action: "stash-search", text: selectedRegex() },
  });
}

function runSimulation() {
  simResult.value = engine.value.simulateCrafts(selectedId.value, 1000);
}

const hotkeyController = Host.onEvent("MAIN->CLIENT::widget-action", (e) => {
  if (e.target !== "tablet-ev") return;
  if (props.config.wmWants === "hide") {
    wm.show(props.config.wmId);
  } else {
    wm.hide(props.config.wmId);
  }
});

onMounted(() => {
  void hydrateRollSeenFromRepo();
  void refresh();
});

onUnmounted(() => {
  hotkeyController.abort();
});
</script>
