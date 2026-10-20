<script setup lang="ts">
import { onMounted, ref } from "vue";
import { Activity, ExternalLink, X } from "@lucide/vue";
import { ms, type CardDetail } from "@dna/sdk";
import { go } from "../client/route";
import { api, attempt, ui } from "../client/store";
import { clean } from "../client/text";
import HfsPill from "./HfsPill.vue";
import LoadingRows from "./LoadingRows.vue";
import ArchiveHistory from "./ArchiveHistory.vue";

const props = defineProps<{ id: number }>();
const detail = ref<CardDetail>();
onMounted(async () => (detail.value = await attempt(() => api.card(props.id))));
const close = () => (ui.card = undefined);
function openTool(id: number) {
  close();
  go(`/executions/tool/${id}`);
}
</script>

<template>
  <div class="modal-backdrop" @click.self="close" @keydown.esc="close">
    <section class="modal card-detail" role="dialog" aria-modal="true" aria-label="Card details">
      <header>
        <h2>{{ detail ? clean(detail.card.title) : "Card" }}</h2>
        <button class="icon-button" aria-label="Close" @click="close"><X :size="18" /></button>
      </header>
      <template v-if="detail">
        <HfsPill :hfs="detail.card.hfs" />
        <dl v-if="detail.item" class="facts-grid">
          <dt>Source</dt>
          <dd>{{ clean(detail.item.sourceName ?? "") }}</dd>
          <dt>Relevance</dt>
          <dd>{{ Math.round((detail.item.relevance ?? 0) * 100) }}</dd>
          <dt>Worth attention</dt>
          <dd>{{ Math.round((detail.item.worth ?? 0) * 100) }}</dd>
          <dt v-if="detail.item.matchedTopic">Topic</dt>
          <dd v-if="detail.item.matchedTopic">{{ detail.item.matchedTopic }}</dd>
          <dt>Component</dt>
          <dd>{{ detail.card.component }}</dd>
        </dl>
        <p v-if="detail.item?.excerpt" class="muted">{{ clean(detail.item.excerpt) }}</p>
        <template v-if="(detail.card.sources?.length ?? 0) > 1">
          <h3>Story sources</h3>
          <div v-for="source in detail.card.sources" :key="source.itemId" class="finding">
            <a :href="source.url" target="_blank" rel="noopener">{{ clean(source.title) }}</a>
            <p class="muted">
              {{ source.sourceName
              }}<span v-if="source.role === 'evidence'">, additional evidence or correction</span>
            </p>
            <p v-if="source.excerpt">{{ clean(source.excerpt) }}</p>
          </div>
        </template>
        <h3 v-if="detail.findings.length">Research findings</h3>
        <div v-for="f in detail.findings" :key="f.id" class="finding">
          <p>{{ clean(f.summary) }}</p>
          <ul class="icon-list">
            <li v-for="c in f.claimSupport" :key="c.claim">
              <span
                class="claim-score"
                :class="{ ok: c.supported >= 0.7, bad: c.supported < 0.4 }"
                >{{ Math.round(c.supported * 100) }}</span
              >{{ clean(c.claim) }}
            </li>
          </ul>
        </div>
        <ArchiveHistory :card-id="id" />
        <footer>
          <a
            v-if="detail.card.url"
            class="button secondary"
            :href="detail.card.url"
            target="_blank"
            rel="noopener"
            ><ExternalLink :size="15" />Open the source</a
          >
          <button
            v-if="detail.toolCall"
            class="button secondary"
            data-cap="tool.read"
            @click="openTool(detail.toolCall.id)"
          >
            <Activity :size="15" />{{ detail.toolCall.toolName }} in
            {{ ms(detail.toolCall.durationMs) }}
          </button>
        </footer>
      </template>
      <LoadingRows v-else kind="lines" :count="5" label="Loading the card" />
    </section>
  </div>
</template>
