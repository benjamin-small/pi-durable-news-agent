<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { ArchiveEntry, ArchiveHistory, ArchivePreview } from "@dna/sdk";
import { api, attempt } from "../client/store";
const props = defineProps<{ cardId: number }>();
const history = ref<ArchiveHistory>();
const selected = ref<ArchivePreview>();
const busy = ref(false);
const load = async () => {
  history.value = await attempt(() => api.archiveHistory(props.cardId));
};
onMounted(load);
async function preview(entry: ArchiveEntry) {
  selected.value = await attempt(() => api.archivePreview(entry.kind, entry.id));
}
async function previewSource(id: number) {
  selected.value = await attempt(() => api.archivePreview("extraction", id));
}
async function pin() {
  if (!selected.value || busy.value) return;
  busy.value = true;
  try {
    const { kind, id, pinned } = selected.value.entry;
    selected.value = await attempt(() => api.archivePin(kind, id, !pinned));
    await load();
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section class="archive-history" aria-label="Source archive">
    <h3>Source archive</h3>
    <p class="muted">
      Evidence is frozen when a card is published. Version history may include later captures. URL
      mentions alone are not proof that a source was read.
    </p>
    <template v-if="history">
      <p v-if="!history.evidence.length" class="muted">
        This card predates evidence tracking. Historical inputs cannot be reconstructed.
      </p>
      <template
        v-for="group in [
          { label: 'Published evidence', entries: history.evidence },
          { label: 'Extracted text history', entries: history.extractions },
          { label: 'Original responses', entries: history.versions },
        ]"
        :key="group.label"
      >
        <h4 v-if="group.entries.length">{{ group.label }}</h4>
        <ul class="archive-list">
          <li v-for="entry in group.entries" :key="`${entry.kind}-${entry.id}`">
            <button class="button secondary" @click="preview(entry)">
              {{ entry.label }} #{{ entry.id }}, {{ new Date(entry.at).toLocaleString() }}
            </button>
            <span class="muted">
              {{ entry.bytes.toLocaleString() }} bytes,
              {{
                entry.expiredAt
                  ? "Expired under policy"
                  : (entry.provenance ?? entry.completeness ?? "Exact input")
              }}{{ entry.pinned ? ", Pinned" : "" }}</span
            >
          </li>
        </ul>
      </template>
      <section v-if="selected" aria-label="Archived version preview">
        <p>
          <strong>{{ selected.entry.label }} #{{ selected.entry.id }}</strong>
        </p>
        <p v-if="selected.entry.url" class="muted">{{ selected.entry.url }}</p>
        <p v-if="selected.entry.observations" class="muted">
          {{ selected.entry.observations }} fetch observations, last seen
          {{ new Date(selected.entry.lastSeenAt!).toLocaleString() }}. Rechecking does not reset
          retention.
        </p>
        <p class="muted">SHA-256 {{ selected.entry.hash }}</p>
        <p v-if="selected.entry.expiredAt">
          Original expired under retention policy on
          {{ new Date(selected.entry.expiredAt).toLocaleString() }}.
        </p>
        <template v-else>
          <div class="actions">
            <a
              class="button secondary"
              :href="api.archiveDownloadUrl(selected.entry.kind, selected.entry.id)"
              download
              >Download original bytes</a
            >
            <button class="button secondary" :disabled="busy" @click="pin">
              {{ selected.entry.pinned ? "Unpin this version" : "Pin this version" }}
            </button>
          </div>
          <p v-if="selected.entry.protectedByOtherDesk" class="muted">
            Another desk also pins this version.
          </p>
          <div v-if="selected.entry.kind === 'evidence' && selected.entry.sources.length">
            Captured passages from extraction
            <button
              v-for="source in selected.entry.sources"
              :key="source"
              class="button secondary"
              @click="previewSource(source)"
            >
              #{{ source }}
            </button>
          </div>
          <p
            v-if="selected.entry.kind === 'evidence' && !selected.entry.sources.length"
            class="muted"
          >
            Exact input preserved; no matching captured source passage. This may contain
            caller-supplied text.
          </p>
          <p v-if="selected.clipped" class="muted">
            Preview limited to 32 KB. Download contains all retained bytes.
          </p>
          <pre class="archive-preview">{{ selected.text }}</pre>
        </template>
      </section>
    </template>
  </section>
</template>
<style scoped>
.archive-list {
  list-style: none;
  padding: 0;
  display: grid;
  gap: 0.6rem;
}
.archive-list li {
  display: grid;
  gap: 0.2rem;
}
.archive-preview {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 22rem;
  overflow: auto;
  padding: 1rem;
  background: var(--surface-2, #15191e);
  border-radius: 0.5rem;
  font-size: 0.8rem;
}
.archive-history {
  min-width: 0;
}
.archive-history p {
  overflow-wrap: anywhere;
}
.actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
</style>
