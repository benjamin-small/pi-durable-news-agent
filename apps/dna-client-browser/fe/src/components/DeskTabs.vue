<script setup lang="ts">
import { computed, ref } from "vue";
import { info, tracks } from "../client/store";
import { ACTIVE_TRACK_ID, selectTrack } from "../client/track";

// Desk selection owns both columns. The feed's searches and timelines remain separate views below it.
const desks = computed(() => {
  const available = tracks.value.map(({ id, name }) => ({ id, name }));
  if (available.some((desk) => desk.id === ACTIVE_TRACK_ID)) return available;
  return [
    {
      id: ACTIVE_TRACK_ID,
      name: info.value?.track?.name ?? (ACTIVE_TRACK_ID === "ai" ? "AI" : ACTIVE_TRACK_ID),
    },
    ...available,
  ];
});
const focused = ref(ACTIVE_TRACK_ID);

// Manual activation: arrows move focus; Enter/Space select a desk using the native button behavior.
function moveFocus(event: KeyboardEvent) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabs = Array.from(
    (event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  );
  const index = tabs.indexOf(event.target as HTMLButtonElement);
  if (index < 0) return;
  event.preventDefault();
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next]?.focus();
}
</script>

<template>
  <nav class="desk-tabs" role="tablist" aria-label="News desks" @keydown="moveFocus">
    <button
      v-for="desk in desks"
      :id="`desk-tab-${desk.id}`"
      :key="desk.id"
      class="desk-tab"
      role="tab"
      :data-desk-tab="desk.id"
      :aria-selected="desk.id === ACTIVE_TRACK_ID"
      aria-controls="desk-panels"
      :tabindex="desk.id === focused ? 0 : -1"
      @focus="focused = desk.id"
      @click="selectTrack(desk.id)"
    >
      {{ desk.name }}
    </button>
  </nav>
</template>
