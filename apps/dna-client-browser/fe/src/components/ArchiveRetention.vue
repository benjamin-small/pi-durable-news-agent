<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { ArchiveRetentionReport } from "@dna/sdk";
import { api, attempt } from "../client/store";
const report = ref<ArchiveRetentionReport>();
const ordinary = ref(90),
  cited = ref(365),
  budget = ref(1024),
  busy = ref(false),
  message = ref("");
const size = (bytes: number) => `${(bytes / 1048576).toFixed(2)} MiB`;
async function load() {
  report.value = await attempt(() => api.archiveRetention());
  if (report.value) {
    ordinary.value = report.value.policy.ordinaryDays;
    cited.value = report.value.policy.citedDays;
    budget.value = report.value.policy.storageBudgetBytes / 1048576;
  }
}
onMounted(load);
async function save() {
  busy.value = true;
  try {
    const saved = await attempt(() =>
      api.archivePolicy({
        ordinaryDays: ordinary.value,
        citedDays: cited.value,
        storageBudgetBytes: Math.round(budget.value * 1048576),
        enforcement: "disabled",
      }),
    );
    if (saved) {
      message.value = "Policy saved. Cleanup is disabled. Review the new preview before enabling.";
      await load();
    }
  } finally {
    busy.value = false;
  }
}
async function toggle() {
  if (!report.value) return;
  busy.value = true;
  try {
    const enabled = report.value.policy.enforcement === "enabled";
    const saved = await attempt(() =>
      api.archivePolicy({ enforcement: enabled ? "disabled" : "enabled" }, report.value!.token),
    );
    if (saved) {
      message.value = enabled
        ? "Scheduled cleanup disabled."
        : "Scheduled cleanup enabled for both desks. Expired originals will be deleted in hourly batches.";
      await load();
    }
  } finally {
    busy.value = false;
  }
}
async function cleanup() {
  if (!report.value) return;
  busy.value = true;
  try {
    const result = await attempt(() => api.archiveCleanup(report.value!.token));
    if (result) {
      message.value =
        result.status === "deferred"
          ? "Processing is active. Nothing was deleted."
          : `Cleanup ${result.status}: ${result.deleted} files removed, ${size(result.bytes)} reclaimed.`;
      await load();
    }
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section class="drawer-body retention" aria-label="Archive retention">
    <h3>Source retention</h3>
    <p>
      This policy is shared by the AI and Cyber Security desks. Ordinary bodies expire from first
      capture. Cited versions expire after their latest card publication. Rechecking an unchanged
      document does not reset its clock.
    </p>
    <p>
      Pins last until removed and protect their captured inputs. Shared files stay until all
      protections expire. Metadata, hashes, cards and findings remain after body expiry.
      Conversation transcripts, copied quotations and backups have separate lifecycles.
    </p>
    <template v-if="report">
      <p>
        <strong>Scheduled cleanup {{ report.policy.enforcement }}</strong
        >. One batch per hour, at most 100 archived files. Active processing defers cleanup.
      </p>
      <dl class="facts-grid">
        <dt>Compressed archive on disk</dt>
        <dd>{{ size(report.storedBytes) }}</dd>
        <dt>Eligible for expiry</dt>
        <dd>{{ report.candidateCount }} bodies, {{ size(report.reclaimableBytes) }}</dd>
        <dt>Pinned bodies</dt>
        <dd>{{ size(report.pinnedBytes) }}</dd>
        <dt>Cited bodies</dt>
        <dd>{{ size(report.citedBytes) }} (may overlap pins)</dd>
        <dt>Unreferenced files</dt>
        <dd>
          {{ size(report.orphanBytes) }}, {{ report.orphanCandidateCount }} past the 24-hour grace
          period
        </dd>
        <dt>Pending physical deletion</dt>
        <dd>{{ size(report.pendingBytes) }}</dd>
      </dl>
      <p v-if="report.overBudget" class="retention-warning">
        Archive exceeds its storage warning budget. Protected evidence will be retained. Free space
        or revise the policy and preview again.
      </p>
      <p v-if="report.active" class="muted">
        A source acquisition or sweep is active. Cleanup will wait.
      </p>
      <div class="retention-controls">
        <label
          >Ordinary body days<input v-model.number="ordinary" type="number" min="1" max="3650"
        /></label>
        <label
          >Cited body days<input v-model.number="cited" type="number" min="1" max="3650"
        /></label>
        <label
          >Storage warning budget (MiB)<input v-model.number="budget" type="number" min="1"
        /></label>
      </div>
      <div class="retention-actions">
        <button class="button secondary" :disabled="busy" @click="save">
          Save policy with cleanup disabled
        </button>
        <button class="button secondary" :disabled="busy" @click="load">Refresh dry run</button>
        <button class="button secondary" :disabled="busy" @click="toggle">
          {{
            report.policy.enforcement === "enabled"
              ? "Disable scheduled cleanup"
              : "Enable scheduled cleanup"
          }}
        </button>
        <button
          v-if="report.policy.enforcement === 'enabled'"
          class="button secondary"
          :disabled="busy || report.active"
          @click="cleanup"
        >
          Delete eligible bodies in this batch
        </button>
      </div>
      <p class="muted">
        Enabling cleanup permits permanent deletion under this policy. Dry runs never delete files.
        The preview must still match when it is applied.
      </p>
      <p v-if="message" role="status">{{ message }}</p>
      <details v-if="report.candidates.length">
        <summary>
          Expiry preview, first {{ report.candidates.length }} of {{ report.candidateCount }}
        </summary>
        <ul class="retention-candidates">
          <li v-for="candidate in report.candidates" :key="candidate.hash">
            <code>{{ candidate.hash }}</code
            ><br />{{ candidate.reason }}, due {{ new Date(candidate.expiresAt).toLocaleString() }},
            {{ size(candidate.storedBytes) }}
          </li>
        </ul>
      </details>
      <h4 v-if="report.recentRuns.length">Cleanup history</h4>
      <ul>
        <li v-for="run in report.recentRuns" :key="run.id">
          #{{ run.id }}, {{ new Date(run.startedAt).toLocaleString() }}, {{ run.status
          }}<span v-if="run.error">, {{ run.error }}</span>
        </li>
      </ul>
    </template>
  </section>
</template>
<style scoped>
.retention-controls {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 1rem;
}
.retention-controls label {
  display: grid;
  gap: 0.4rem;
}
.retention-controls input {
  width: 100%;
  min-width: 0;
}
.retention-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin: 1rem 0;
}
.retention-candidates {
  padding-left: 1rem;
}
.retention-candidates code {
  overflow-wrap: anywhere;
}
.retention-warning {
  color: var(--accent, #f78fb4);
}
</style>
