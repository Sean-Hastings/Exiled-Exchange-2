<template>
  <span
    :class="fallbackPriceClass(source)"
    :title="title || undefined"
  >{{ text }}<template v-if="showTag"> {{ tag }}</template></span>
</template>

<script setup lang="ts">
import { computed } from "vue";
import {
  fallbackPriceClass,
  fallbackPriceTag,
  fallbackPriceTitle,
  isFallbackPriceSource,
  type PriceSource,
} from "./market-sanity";

const props = defineProps<{
  value: number;
  source?: PriceSource;
  digits?: number;
  suffix?: string;
}>();

const text = computed(() => {
  const n = props.value;
  const digits = props.digits ?? 0;
  const body = Number.isFinite(n) ? n.toFixed(digits) : "NaN";
  return body + (props.suffix ?? "");
});
const tag = computed(() => fallbackPriceTag(props.source));
const showTag = computed(
  () => isFallbackPriceSource(props.source) && !!tag.value,
);
const title = computed(() => fallbackPriceTitle(props.source));
</script>
