<script setup lang="ts">
// Settings, as a full modal like the model picker: keywords per section, sources, search mode and credits, your
// recent feedback, and the agents' tools.
import { computed, onBeforeUnmount, onMounted, ref, watch, nextTick } from "vue";
import { BadgeCheck, Megaphone, Plus, Power, Trash2, Hash, X, Zap } from "@lucide/vue";
import {
  ago,
  type Keyword,
  type Source,
  type SourceKind,
  type TasteState,
  type ToolInfo,
} from "@dna/sdk";
import ArchiveRetention from "./ArchiveRetention.vue";
import JsonView from "./JsonView.vue";
import LoadingRows from "./LoadingRows.vue";
import { api, attempt, info, onFrame, refreshInfo, ui } from "../client/store";
import { clean } from "../client/text";

const KINDS = ["topic", "signal", "facts", "hype"] as const;
const ICONS = { topic: Hash, signal: Zap, facts: BadgeCheck, hype: Megaphone };
const SOURCE_KINDS: SourceKind[] = [
  "rss",
  "atom",
  "hn_front",
  "hn_search",
  "github_releases",
  "web_page",
];
const modal = ref<HTMLElement>();
const tab = ref<"keywords" | "sources" | "search" | "taste" | "tools" | "archive">("keywords");
watch(tab, async () => {
  await nextTick();
  if (modal.value) modal.value.scrollTop = 0;
});
const tools = ref<ToolInfo[]>();
async function openTools() {
  tab.value = "tools";
  tools.value ??= await attempt(() => api.tools());
}
const keywords = ref<Keyword[]>([]);
const sources = ref<Source[]>([]);
const taste = ref<TasteState>();
const drafts = ref<Record<string, string>>({});
const source = ref({ kind: "rss" as SourceKind, name: "", url: "" });

async function load() {
  const [kw, src, t] = await Promise.all([
    attempt(() => api.keywords()),
    attempt(() => api.sources()),
    attempt(() => api.taste()),
  ]);
  keywords.value = kw ?? [];
  sources.value = src ?? [];
  taste.value = t;
  void refreshInfo();
}
onMounted(load);
// Escape closes the modal, like the model picker's close button.
const onEscape = (e: KeyboardEvent) => {
  if (e.key === "Escape") ui.settings = false;
};
onMounted(() => addEventListener("keydown", onEscape));
onBeforeUnmount(() => removeEventListener("keydown", onEscape));
// The agent's keyword edits show up live.
onBeforeUnmount(
  onFrame((frame) => {
    if (frame.type === "taste.keywords") keywords.value = frame.keywords;
  }),
);
const byKind = computed(
  () =>
    Object.fromEntries(
      KINDS.map((kind) => [kind, keywords.value.filter((k) => k.kind === kind)]),
    ) as Record<(typeof KINDS)[number], Keyword[]>,
);

async function addKeyword(kind: (typeof KINDS)[number]) {
  const term = drafts.value[kind]?.trim();
  if (!term) return;
  if (await attempt(() => api.addKeyword({ kind, term }))) {
    drafts.value[kind] = "";
    await load();
  }
}
async function updateKeyword(k: Keyword, patch: { weight?: number; enabled?: boolean }) {
  if (await attempt(() => api.updateKeyword(k.id, patch))) await load();
}
async function removeKeyword(k: Keyword) {
  if (await attempt(() => api.removeKeyword(k.id))) await load();
}
async function addSource() {
  const s = source.value;
  if (!s.name.trim()) return;
  if (
    await attempt(() =>
      api.addSource({ kind: s.kind, name: s.name.trim(), url: s.url.trim() || undefined }),
    )
  ) {
    source.value = { kind: "rss", name: "", url: "" };
    await load();
  }
}
async function weighSource(s: Source, weight: number) {
  if (await attempt(() => api.updateSource(s.id, { weight }))) await load();
}
async function toggleSource(s: Source) {
  if (await attempt(() => api.updateSource(s.id, { enabled: !s.enabled }))) await load();
}
async function removeSource(s: Source) {
  if (await attempt(() => api.removeSource(s.id))) await load();
}
</script>

<template>
  <div class="modal-backdrop" @click.self="ui.settings = false">
    <section
      ref="modal"
      class="modal settings-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
    >
      <header>
        <h2>Settings</h2>
        <button class="icon-button" aria-label="Close settings" @click="ui.settings = false">
          <X :size="18" />
        </button>
      </header>
      <div class="tabs">
        <button
          class="tab"
          :class="{ on: tab === 'keywords' }"
          data-cap="keywords"
          @click="tab = 'keywords'"
        >
          Keywords
        </button>
        <button
          class="tab"
          :class="{ on: tab === 'sources' }"
          data-cap="sources"
          @click="tab = 'sources'"
        >
          Sources
        </button>
        <button class="tab" :class="{ on: tab === 'search' }" @click="tab = 'search'">
          Search
        </button>
        <button
          class="tab"
          :class="{ on: tab === 'taste' }"
          data-cap="taste.read"
          @click="tab = 'taste'"
        >
          Taste
        </button>
        <button
          class="tab"
          :class="{ on: tab === 'tools' }"
          data-cap="agent.tools"
          @click="openTools"
        >
          Tools
        </button>
        <button
          class="tab"
          :class="{ on: tab === 'archive' }"
          data-cap="archive.retention"
          @click="tab = 'archive'"
        >
          Archive
        </button>
      </div>
      <ArchiveRetention v-if="tab === 'archive'" />
      <div v-else-if="tab === 'tools'" class="drawer-body tools-body">
        <p class="muted small">
          Every tool the agents can call, as the model sees it. Required parameters are marked.
        </p>
        <LoadingRows v-if="!tools" kind="lines" :count="6" label="Loading the tools" />
        <details v-for="t in tools ?? []" :key="t.name" class="tool-doc" :data-tool-doc="t.name">
          <summary>
            <code class="tool-name">{{ t.name }}</code>
            <span v-for="a in t.agents" :key="a" class="agent-chip">{{ a }}</span>
            <span class="tool-summary">{{ clean(t.description.split(". ")[0]) }}</span>
          </summary>
          <p class="tool-desc">{{ clean(t.description) }}</p>
          <h4>Parameters</h4>
          <table v-if="t.params.length" class="param-table">
            <tbody>
              <tr v-for="p in t.params" :key="p.name">
                <td>
                  <code>{{ p.name }}</code
                  ><span v-if="p.required" class="req" title="Required">required</span>
                </td>
                <td class="ptype">{{ p.type }}</td>
                <td>
                  <span v-if="p.values" class="pvalues"
                    ><code v-for="v in p.values" :key="v">{{ v }}</code></span
                  >
                  <span v-else class="muted">{{ clean(p.description ?? "") }}</span>
                </td>
              </tr>
            </tbody>
          </table>
          <p v-else class="muted">None.</p>
          <h4>Returns</h4>
          <p>{{ clean(t.returns ?? "Text.") }}</p>
          <template v-if="t.example">
            <h4>Example call</h4>
            <JsonView :value="t.example" />
          </template>
          <details class="tool-definition">
            <summary>Definition</summary>
            <JsonView :value="t.definition" />
          </details>
        </details>
      </div>
      <div v-else-if="tab === 'keywords'" class="drawer-body">
        <section v-for="kind in KINDS" :key="kind" class="kw-section" :data-section="kind">
          <h3>
            <component :is="ICONS[kind]" :size="14" />{{
              kind === "topic" ? "Topics" : kind[0].toUpperCase() + kind.slice(1)
            }}
          </h3>
          <div
            v-for="k in byKind[kind]"
            :key="k.id"
            class="kw-row"
            :class="{ off: !k.enabled }"
            :data-keyword="k.term"
          >
            <span class="kw-term">{{ k.term }}</span>
            <input
              type="range"
              min="0.1"
              max="2"
              step="0.05"
              :value="k.weight"
              :aria-label="`Weight of ${k.term}`"
              @change="
                updateKeyword(k, { weight: Number(($event.target as HTMLInputElement).value) })
              "
            />
            <span class="mono kw-weight">{{ k.weight.toFixed(2) }}</span>
            <button
              class="icon-button small"
              :aria-label="`${k.enabled ? 'Turn off' : 'Turn on'} ${k.term}`"
              :aria-pressed="k.enabled"
              @click="updateKeyword(k, { enabled: !k.enabled })"
            >
              <Power :size="13" />
            </button>
            <button
              class="icon-button small"
              :aria-label="`Remove ${k.term}`"
              @click="removeKeyword(k)"
            >
              <Trash2 :size="13" />
            </button>
          </div>
          <form class="kw-add" @submit.prevent="addKeyword(kind)">
            <input
              v-model="drafts[kind]"
              :aria-label="`Add a ${kind} keyword`"
              placeholder="Add a keyword"
            />
            <button class="icon-button small" type="submit" :aria-label="`Add ${kind} keyword`">
              <Plus :size="14" />
            </button>
          </form>
        </section>
      </div>
      <div v-else-if="tab === 'sources'" class="drawer-body">
        <div v-for="s in sources" :key="s.id" class="src-row" :class="{ off: !s.enabled }">
          <div>
            <strong>{{ s.name }}</strong>
            <small class="muted"
              >{{ s.kind }}, {{ s.lastStatus ?? "never fetched"
              }}{{ s.lastFetchedAt ? `, ${ago(s.lastFetchedAt)}` : ""
              }}{{ s.failCount ? `, ${s.failCount} failures` : "" }}</small
            >
            <small v-if="s.origin === 'agent' || s.origin === 'upvote'" class="muted"
              >{{ s.origin === "agent" ? "Saved by the agent" : "Saved from your upvote"
              }}{{ s.reason ? `: ${s.reason}` : "" }}</small
            >
          </div>
          <span class="grow" />
          <input
            type="range"
            min="0.1"
            max="2"
            step="0.05"
            :value="s.weight"
            :aria-label="`Weight of ${s.name}`"
            title="Sweeps rank news from heavier sources higher"
            @change="weighSource(s, Number(($event.target as HTMLInputElement).value))"
          />
          <span class="mono kw-weight">{{ s.weight.toFixed(2) }}</span>
          <button
            class="icon-button small"
            :aria-label="`${s.enabled ? 'Turn off' : 'Turn on'} ${s.name}`"
            :aria-pressed="s.enabled"
            @click="toggleSource(s)"
          >
            <Power :size="13" />
          </button>
          <button
            class="icon-button small"
            :aria-label="`Remove ${s.name}`"
            @click="removeSource(s)"
          >
            <Trash2 :size="13" />
          </button>
        </div>
        <form class="src-add" @submit.prevent="addSource">
          <select v-model="source.kind" aria-label="Source kind">
            <option v-for="k in SOURCE_KINDS" :key="k" :value="k">{{ k }}</option>
          </select>
          <input v-model="source.name" aria-label="Source name" placeholder="Name" />
          <input v-model="source.url" aria-label="Source URL" placeholder="https URL" />
          <button class="button small" type="submit"><Plus :size="14" />Add</button>
        </form>
      </div>
      <div v-else-if="tab === 'search'" class="drawer-body">
        <dl class="facts-grid">
          <dt>Search mode</dt>
          <dd>{{ info?.searchMode }}</dd>
          <dt>Credits today</dt>
          <dd>{{ info?.firecrawl?.creditsToday ?? 0 }} of {{ info?.firecrawl?.dailyCap ?? 0 }}</dd>
          <dt>Per sweep cap</dt>
          <dd>{{ info?.firecrawl?.sweepCap ?? 0 }}</dd>
          <dt>Plan credits left</dt>
          <dd>{{ info?.firecrawl?.creditsLeft ?? "unknown" }}</dd>
          <dt>Schedule</dt>
          <dd class="mono">{{ info?.cronSchedule }}</dd>
          <dt>Device</dt>
          <dd>{{ info?.device }} {{ info?.mode }}, pi-durable {{ info?.piDurable }}</dd>
        </dl>
      </div>
      <div v-else class="drawer-body">
        <p v-if="!taste?.recent.length" class="muted">
          No feedback yet. Show me more, Show me less and labels on cards teach the agent.
        </p>
        <div v-for="r in taste?.recent ?? []" :key="`${r.cardId}${r.at}`" class="src-row">
          <div>
            <strong>{{ clean(r.title) }}</strong
            ><small class="muted"
              >{{ r.signal ? `show me ${r.signal}` : "" }} {{ r.labels.join(", ") }}
              {{ ago(r.at) }}</small
            >
          </div>
        </div>
      </div>
    </section>
  </div>
</template>
