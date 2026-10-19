<script setup lang="ts">
// Enter sends, Shift+Enter adds a newline. When the agent is busy a message waits for the run (follow up) or
// steers it. The pending requestId lives in sessionStorage so a retried send never submits twice. The Model toggle
// shows the context line and the model and thinking controls together on top; off, neither shows.
import { computed, nextTick, ref, watch } from "vue";
import { Cpu, Send, Square } from "@lucide/vue";
import { newRequestId, type WhenBusy } from "@dna/sdk";
import { layout } from "../client/layout";
import { agentState, api, attempt, composerFocus, draft, notify } from "../client/store";
import ContextBar from "./ContextBar.vue";
import ModelControls from "./ModelControls.vue";
import { migrateTrackStorage, trackStorageKey } from "../client/track";

const PENDING = trackStorageKey("pending");
const text = draft;
const box = ref<HTMLTextAreaElement>();
watch(composerFocus, async () => {
  await nextTick();
  box.value?.focus();
  box.value?.setSelectionRange(text.value.length, text.value.length);
});
const mode = ref<WhenBusy>("followUp");
const sending = ref(false);
const busy = computed(() => agentState.value?.busy ?? false);

function pendingId(content: string): string {
  try {
    migrateTrackStorage(sessionStorage, "dna.pending", "pending");
    const p = JSON.parse(sessionStorage.getItem(PENDING) ?? "null") as {
      requestId: string;
      content: string;
    } | null;
    if (p?.content === content) return p.requestId;
  } catch {}
  const requestId = newRequestId();
  sessionStorage.setItem(PENDING, JSON.stringify({ requestId, content }));
  return requestId;
}

async function send() {
  const content = text.value.trim();
  if (!content || sending.value) return;
  sending.value = true;
  const r = await attempt(() =>
    api.send({ content, requestId: pendingId(content), mode: mode.value }),
  );
  sending.value = false;
  if (!r) return;
  sessionStorage.removeItem(PENDING);
  text.value = "";
}
function onKey(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    void send();
  }
}
async function abort() {
  if (await attempt(() => api.abort())) notify("Stopped");
}
</script>

<template>
  <form class="composer" @submit.prevent="send">
    <template v-if="layout.modelBar">
      <ContextBar />
      <ModelControls />
    </template>
    <textarea
      ref="box"
      v-model="text"
      rows="2"
      aria-label="Message the agent"
      placeholder="Ask about the news, or tell the agent what to watch"
      @keydown="onKey"
    />
    <div class="composer-row">
      <label class="when-busy"
        ><span>When busy</span>
        <select v-model="mode" aria-label="When busy">
          <option value="followUp">Follow up</option>
          <option value="steer">Steer</option>
        </select>
      </label>
      <button
        type="button"
        class="button secondary small model-toggle"
        :aria-pressed="layout.modelBar"
        @click="layout.modelBar = !layout.modelBar"
      >
        <Cpu :size="13" />Model
      </button>
      <span class="grow" />
      <button
        type="button"
        class="button secondary small"
        data-cap="chat.abort"
        :disabled="!busy"
        aria-label="Stop the agent"
        @click="abort"
      >
        <Square :size="13" />Stop
      </button>
      <button
        type="submit"
        class="button small"
        data-cap="chat.send"
        :disabled="!text.trim() || sending"
        aria-label="Send message"
      >
        <Send :size="14" />Send
      </button>
    </div>
  </form>
</template>
