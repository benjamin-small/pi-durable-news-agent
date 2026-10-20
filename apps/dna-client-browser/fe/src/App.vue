<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from "vue";
import AgentColumn from "./components/AgentColumn.vue";
import CardDetailDialog from "./components/CardDetailDialog.vue";
import ExecutionsView from "./components/ExecutionsView.vue";
import FeedColumn from "./components/FeedColumn.vue";
import DeskTabs from "./components/DeskTabs.vue";
import SettingsModal from "./components/SettingsModal.vue";
import TopBar from "./components/TopBar.vue";
import { layout } from "./client/layout";
import { route } from "./client/route";
import { start, toast, ui } from "./client/store";
import { ACTIVE_TRACK_ID } from "./client/track";

let stop: (() => void) | undefined;
onMounted(() => (stop = start()));
onBeforeUnmount(() => stop?.());

const grid = computed(() => {
  if (layout.feed && layout.agent)
    return { gridTemplateColumns: `minmax(320px, 1fr) 6px ${layout.agentWidth}px` };
  return { gridTemplateColumns: "1fr" };
});

let startX = 0;
let startWidth = 0;
function resizeStart(e: PointerEvent) {
  startX = e.clientX;
  startWidth = layout.agentWidth;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}
function resizeMove(e: PointerEvent) {
  if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return;
  const max = Math.round(window.innerWidth * 0.7);
  layout.agentWidth = Math.min(max, Math.max(380, startWidth - (e.clientX - startX)));
}
</script>

<template>
  <div class="app">
    <TopBar />
    <DeskTabs />
    <div
      id="desk-panels"
      class="desk-panels"
      role="tabpanel"
      :aria-labelledby="`desk-tab-${ACTIVE_TRACK_ID}`"
    >
      <main class="columns" :style="grid">
        <FeedColumn v-if="layout.feed" />
        <div
          v-if="layout.feed && layout.agent"
          class="resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the agent column"
          @pointerdown="resizeStart"
          @pointermove="resizeMove"
        />
        <AgentColumn v-if="layout.agent" />
      </main>
    </div>
    <ExecutionsView v-if="route.view === 'executions'" />
    <SettingsModal v-if="ui.settings" />
    <CardDetailDialog v-if="ui.card !== undefined" :id="ui.card" />
    <div v-if="toast" class="toast" :class="toast.kind" role="status">{{ toast.text }}</div>
  </div>
</template>
