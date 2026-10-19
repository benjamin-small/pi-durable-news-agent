// App state: one stream feeds the agent reducer (main conversation) and the feed reducer; REST fills the snapshot
// on every (re)connect, because streams never replay.
import { computed, reactive, ref, shallowRef, watch } from "vue";
import {
  AgentModel,
  DnaClient,
  DnaError,
  FeedModel,
  follow,
  type ConnectionState,
  type Frame,
  type Info,
  type Track,
  type ToolCallRow,
} from "@dna/sdk";
import { ACTIVE_TRACK_ID, trackStorageKey } from "./track";

export const api = new DnaClient("/api").forTrack(ACTIVE_TRACK_ID);
export const feed = new FeedModel();
export const feedState = shallowRef(feed.state);
feed.subscribe(() => (feedState.value = feed.state));
export const agent = new AgentModel();
export const agentView = shallowRef({ ...agent.state });
agent.subscribe(() => (agentView.value = { ...agent.state }));
export const info = shallowRef<Info>();
export const tracks = shallowRef<Track[]>([]);
export const agentState = computed(() => feedState.value.agent);
export const connection = ref<ConnectionState>("connecting");
/** Telemetry rows for the main agent's tool calls, by provider call id: duration, tokens, cost. */
export const toolRows = shallowRef(new Map<string, ToolCallRow>());
export const now = ref(Date.now());
setInterval(() => (now.value = Date.now()), 1000);

/** The composer's text, shared so a card can drop a reference into it. */
function savedDraft(): string {
  try {
    return sessionStorage.getItem(trackStorageKey("draft")) ?? "";
  } catch {
    return "";
  }
}
export const draft = ref(savedDraft());
watch(draft, (value) => {
  try {
    sessionStorage.setItem(trackStorageKey("draft"), value);
  } catch {}
});
/** Bumped to focus the composer. */
export const composerFocus = ref(0);
/** Append a reference to the composer and focus it. */
export function referenceInChat(text: string) {
  draft.value = draft.value.trim() ? `${draft.value.trimEnd()} ${text} ` : `${text} `;
  composerFocus.value++;
}
/** Listeners for frames the reducers don't keep: the agent's UI actions and keyword changes. */
const listeners = new Set<(frame: Frame) => void>();
export function onFrame(fn: (frame: Frame) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** True once the first snapshot (feed, sweeps, agent) has loaded. */
export const loaded = ref(false);

export const toast = ref<{ text: string; kind: "info" | "bad" }>();
let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function notify(text: string, kind: "info" | "bad" = "info") {
  toast.value = { text, kind };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = undefined), kind === "bad" ? 7000 : 3500);
}

/** Run an API call; failures become a toast and undefined. */
export async function attempt<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error) {
    notify(
      error instanceof DnaError ? error.message : String((error as Error).message ?? error),
      "bad",
    );
    return undefined;
  }
}

export async function refreshInfo() {
  info.value = await api.info();
}

async function loadSnapshot() {
  const [i, page, sweeps, questions, state] = await Promise.all([
    api.info(),
    api.feed({ limit: 1000 }),
    api.sweeps({ limit: 30 }),
    api.questions("open"),
    api.agent(),
  ]);
  info.value = i;
  feed.load({ cards: page.items, sweeps, questions, agent: state });
  loaded.value = true;
}

let toolTimer: ReturnType<typeof setTimeout> | undefined;
function refreshTools() {
  clearTimeout(toolTimer);
  toolTimer = setTimeout(async () => {
    const rows = await api.toolCalls({ limit: 300 }).catch(() => undefined);
    if (rows) toolRows.value = new Map(rows.map((r) => [r.callId, r]));
  }, 300);
}

export function start(): () => void {
  const stop = new AbortController();
  void new DnaClient("/api")
    .tracks()
    .then((available) => (tracks.value = available))
    .catch(() => {});
  void follow(
    (signal) => api.stream(signal),
    (frame) => {
      if (frame.trackId && frame.trackId !== ACTIVE_TRACK_ID) return;
      if (frame.type === "hello")
        void loadSnapshot().catch((e) => notify(String(e.message ?? e), "bad"));
      agent.apply(frame);
      feed.apply(frame);
      for (const fn of listeners) fn(frame);
      if (frame.type === "agent.snapshot") refreshTools();
      if (
        frame.type === "agent.batch" &&
        frame.events.some(
          (e) =>
            e.type === "tool_execution_end" || e.type === "run_end" || e.type === "message_end",
        )
      )
        refreshTools();
    },
    (state) => (connection.value = state),
    stop.signal,
  );
  return () => stop.abort();
}

/** Open dialogs and drawers. */
export const ui = reactive({
  settings: false,
  models: false,
  compaction: false,
  card: undefined as number | undefined,
});
