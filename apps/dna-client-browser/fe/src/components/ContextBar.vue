<script setup lang="ts">
// The main agent's context window on one line: how full it is, a tick where a background summary starts (accent) and
// a tick where the next request waits for one (white), each with its token count above it (background to the left
// of its tick, force to the right, so the two never overlap). Both ticks drag or take arrow keys in 512 token steps and save
// through PATCH /v1/agent/compaction.
import { computed, ref } from "vue";
import { Info, Minimize2, X } from "@lucide/vue";
import { k, type CompactionState, type WireAssistantMessage } from "@dna/sdk";
import { agentState, agentView, api, attempt, feed, notify, ui } from "../client/store";

const STEP = 512;
const MIN_BACKGROUND = 4096;
const GAP = 1024;
const MIN_RESERVE = 16384;

const settings = computed<CompactionState | undefined>(() => agentState.value?.compaction);
const window = computed(() => settings.value?.window ?? agentState.value?.contextWindow ?? 0);
const used = computed(() => {
  const entries = agentView.value.entries;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].kind !== "pi.assistant") continue;
    const reply = entries[i].model?.find((m) => m.role === "assistant") as
      | WireAssistantMessage
      | undefined;
    if (reply?.usage)
      return (
        reply.usage.totalTokens ||
        reply.usage.input + reply.usage.output + reply.usage.cacheRead + reply.usage.cacheWrite
      );
  }
  return agentState.value?.contextTokens ?? 0;
});
const compacting = computed(() => agentView.value.compactions.length > 0);
const draft = ref<{ background: number; force: number }>();
const marks = computed(
  () =>
    draft.value ?? {
      background: settings.value?.background ?? 100_000,
      force: settings.value?.force ?? 200_000,
    },
);
const pct = (n: number) => `${Math.min(100, Math.max(0, (100 * n) / (window.value || 1)))}%`;
const fullness = computed(() => Math.round((100 * used.value) / (window.value || 1)));

function move(which: "background" | "force", tokens: number) {
  const t = Math.round(tokens / STEP) * STEP;
  const m = marks.value;
  draft.value =
    which === "force"
      ? {
          background: m.background,
          force: Math.min(window.value - MIN_RESERVE, Math.max(m.background + GAP, t)),
        }
      : { background: Math.min(m.force - GAP, Math.max(MIN_BACKGROUND, t)), force: m.force };
}

async function save(patch: { background?: number; force?: number; enabled?: boolean }) {
  const next = await attempt(() => api.setCompaction(patch));
  draft.value = undefined;
  if (next && agentState.value)
    feed.apply({ type: "agent.state", state: { ...agentState.value, compaction: next } });
}
function commit() {
  if (draft.value) void save(draft.value);
}

const bar = ref<HTMLElement>();
let dragging: "background" | "force" | undefined;
function down(which: "background" | "force", e: PointerEvent) {
  dragging = which;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}
function drag(e: PointerEvent) {
  if (!dragging || !bar.value) return;
  const rect = bar.value.getBoundingClientRect();
  move(dragging, ((e.clientX - rect.left) / rect.width) * window.value);
}
function up() {
  if (!dragging) return;
  dragging = undefined;
  commit();
}
function key(which: "background" | "force", e: KeyboardEvent) {
  const dir =
    e.key === "ArrowRight" || e.key === "ArrowUp"
      ? 1
      : e.key === "ArrowLeft" || e.key === "ArrowDown"
        ? -1
        : 0;
  if (!dir) return;
  e.preventDefault();
  move(which, marks.value[which] + dir * (e.shiftKey ? 8192 : STEP));
}
async function compactNow() {
  const r = await attempt(() => api.compact());
  if (r) notify(`Compaction task ${r.taskId} started`);
  ui.compaction = false;
}
</script>

<template>
  <section class="context-line" data-cap="agent.compaction" aria-label="Context">
    <span class="eyebrow">Context</span>
    <div
      ref="bar"
      class="context-bar"
      :class="{ off: settings && !settings.enabled }"
      @pointermove="drag"
      @pointerup="up"
      @pointercancel="up"
    >
      <div
        class="context-fill"
        :class="{ hot: used >= marks.background }"
        :style="{ width: pct(used) }"
      />
      <div class="context-reserve" :style="{ left: pct(marks.force) }" />
      <button
        type="button"
        class="context-marker background"
        role="slider"
        data-marker="background"
        aria-label="Background compaction starts at"
        :title="`Background compaction at ${k(marks.background)}`"
        :aria-valuemin="MIN_BACKGROUND"
        :aria-valuemax="marks.force - GAP"
        :aria-valuenow="marks.background"
        :aria-valuetext="`${k(marks.background)} tokens`"
        :style="{ left: pct(marks.background) }"
        @pointerdown="down('background', $event)"
        @keydown="key('background', $event)"
        @keyup="commit"
      >
        <span class="tick-label">{{ k(marks.background) }}</span>
      </button>
      <button
        type="button"
        class="context-marker force"
        role="slider"
        data-marker="force"
        aria-label="The next request waits for a summary at"
        :title="`The next request waits for a summary at ${k(marks.force)}`"
        :aria-valuemin="marks.background + GAP"
        :aria-valuemax="window - MIN_RESERVE"
        :aria-valuenow="marks.force"
        :aria-valuetext="`${k(marks.force)} tokens`"
        :style="{ left: pct(marks.force) }"
        @pointerdown="down('force', $event)"
        @keydown="key('force', $event)"
        @keyup="commit"
      >
        <span class="tick-label">{{ k(marks.force) }}</span>
      </button>
    </div>
    <span class="context-numbers"
      ><strong>{{ k(used) }}</strong> / {{ k(window) }}
      <span class="muted">{{ fullness }}%</span></span
    >
    <span v-if="compacting" class="context-compacting"><i />Compacting</span>
    <button
      type="button"
      class="icon-button small"
      aria-label="Compaction details"
      title="Compaction details"
      @click="ui.compaction = true"
    >
      <Info :size="14" />
    </button>
  </section>
  <Teleport to="body">
    <div v-if="ui.compaction" class="modal-backdrop" @click.self="ui.compaction = false">
      <section class="modal" role="dialog" aria-modal="true" aria-label="Context compaction">
        <header>
          <h2>Context compaction</h2>
          <button class="icon-button" aria-label="Close" @click="ui.compaction = false">
            <X :size="18" />
          </button>
        </header>
        <p>
          A summary starts in the background at <strong>{{ k(marks.background) }}</strong> while the
          agent keeps working. At <strong>{{ k(marks.force) }}</strong> the next request waits for
          it, keeping {{ k(window - marks.force) }} free for the answer.
        </p>
        <p v-if="settings?.shared" class="muted">
          Automatic compaction policy applies to both desks. Token points depend on each model.
          Compact now summarizes only this desk.
        </p>
        <p class="muted">Drag either marker on the bar, or focus one and use the arrow keys.</p>
        <label class="toggle"
          ><input
            type="checkbox"
            :checked="settings?.enabled ?? true"
            aria-label="Automatic compaction"
            @change="save({ enabled: ($event.target as HTMLInputElement).checked })"
          />Automatic compaction</label
        >
        <footer>
          <button class="button" data-cap="agent.compact" @click="compactNow">
            <Minimize2 :size="15" />Compact now
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>
