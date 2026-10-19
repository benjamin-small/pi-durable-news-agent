// One harness and shared collection services, with a persistent desk conversation and scoped tools per track.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  configure,
  defineDoc,
  UsageDoc,
  type Conversation,
  type ConversationId,
  type Cursor,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { JevClient, type Decide } from "@dna/jev";
import {
  DEFAULT_TRACK_ID,
  sumUsage,
  type UsageSummary,
  type CompactionState,
  type Track,
} from "@dna/sdk";
import {
  createModelCatalog,
  DEFAULT_POINTS,
  fit,
  fits,
  fromPolicy,
  installScriptedFaux,
  openDurableHarness,
  startProjector,
  toPolicy,
  validatePoints,
  type CompactionPoints,
  type DurableHarness,
} from "@dna/durable-agent";
import { createLogger, type Logger } from "@dna/sdk/node";
import { createAgents, type Agents } from "./agents/index.ts";
import { fauxRules } from "./agents/faux-script.ts";
import type { Config } from "./config.ts";
import { openStore, scopeStore } from "./db/store.ts";
import type { Deps } from "./deps.ts";
import { Bus } from "./events.ts";
import { ApiFault } from "./errors.ts";
import { Dates } from "./news/dates.ts";
import { fixtureDecide, fixtureHttp } from "./news/fixtures.ts";
import { Judge } from "./news/hfs.ts";
import { liveHttp } from "./news/http.ts";
import { Images } from "./news/images.ts";
import { Quick } from "./news/quick.ts";
import { CYBER_TRACK_ID } from "./news/profiles.ts";
import { Schedule } from "./news/schedule.ts";
import { closeStalledSweeps, withdrawStuckSweeps } from "./news/sweep.ts";
import { SearchService } from "./news/search/index.ts";

export interface CompactionSetting {
  points: CompactionPoints;
  enabled: boolean;
}
export interface App extends Deps {
  readonly track: Track;
  readonly desks: ReadonlyMap<string, App>;
  harness: DurableHarness;
  ctx: Context;
  agents: Agents;
  main: Conversation;
  compaction: CompactionSetting;
  modelUsage(): UsageSummary;
  mainModel(): Promise<{ id: string; window: number }>;
  setCompaction(next: Partial<CompactionSetting>): CompactionSetting;
  compactionState(): CompactionState;
  refreshModel(): Promise<{ id: string; window: number }>;
  readonly startedAt: number;
  close(): Promise<void>;
}

// Conversation creation and its receipt commit together in agent.sqlite. A crash before dna.sqlite's binding
// is written reuses the same conversation on restart, rather than creating a second security agent.
const DeskRoots = defineDoc<{ ids: Record<string, number> }>({
  kind: "dna.desk-roots",
  version: 1,
  scope: "session",
  initial: () => ({ ids: {} }),
});

function decideFor(config: Config): Decide {
  if (config.jevBackend === "fixture") return fixtureDecide();
  const client =
    config.jevBackend === "auto" ? new JevClient() : new JevClient({ provider: config.jevBackend });
  return (state, questions, opts) => client.systemOne(state, questions, opts);
}

export async function openApp(config: Config, options: { log?: Logger } = {}): Promise<App> {
  mkdirSync(config.dataDir, { recursive: true });
  const log = options.log ?? createLogger("api").child({ device: config.device });
  const owner = openStore(config.dataDir, config.configDir);
  const securityConfig = join(config.configDir, CYBER_TRACK_ID);
  const security = scopeStore(
    owner,
    CYBER_TRACK_ID,
    existsSync(securityConfig)
      ? securityConfig
      : join(import.meta.dirname, "../config", CYBER_TRACK_ID),
  );
  if (!security.settings.get("scheduleSeeded", false)) {
    security.settings.set("schedule", { everyMinutes: 30, cardsPerSweep: 5 });
    security.settings.set("scheduleSeeded", true);
  }
  const http = config.searchMode === "fixture" ? fixtureHttp() : liveHttp(log);
  const catalog = createModelCatalog({
    provider: config.provider,
    installFaux: (models) => installScriptedFaux(models, fauxRules()),
    defaultModel: config.provider === "faux" ? undefined : config.model,
  });
  // One reservation pool, engine cooldown state and canonical cache across all desks.
  const search = new SearchService(
    { http, store: { ...owner, telemetry: owner.globalTelemetry }, log },
    {
      mode: config.searchMode,
      firecrawlKey: config.firecrawlKey,
      sweepCap: config.sweepCredits,
      dailyCap: config.dailyCredits,
    },
  );
  const prepared = [owner, security].map((store) => {
    const deskLog = log.child({ trackId: store.trackId });
    const quick = new Quick({ catalog, store, log: deskLog });
    const deps: Deps = {
      config,
      store,
      log: deskLog,
      http,
      catalog,
      search,
      quick,
      bus: new Bus(store.trackId),
      dates: new Dates({ http, store, log: deskLog, quick }),
      judge: new Judge({
        decide: decideFor(config),
        store,
        log: deskLog,
        dir: join(config.promptsDir, "jev"),
      }),
      images: new Images({
        store,
        http,
        log: deskLog,
        dataDir: config.dataDir,
        promptsDir: config.promptsDir,
        model: config.imageModel,
        openaiKey: config.openaiKey,
        quality: config.imageQuality,
        offline: config.provider === "faux" || config.searchMode === "fixture",
      }),
      schedule: new Schedule({ store, cronSchedule: config.cronSchedule }),
    };
    return { deps, agents: createAgents(deps) };
  });
  const compaction = owner.settings.get<CompactionSetting>("compaction", {
    points: DEFAULT_POINTS,
    enabled: true,
  });
  // pi-durable 1.1's automatic compaction policy is harness-wide. Keep that policy shared and report
  // the actual effective points for each model, while transcripts and manual compaction stay separate.
  let minWindow = 1_000_000;
  const harness = await openDurableHarness({
    dbPath: join(config.dataDir, "agent.sqlite"),
    catalog,
    extensions: prepared.flatMap((p) => p.agents.all),
    defaults: prepared[0].agents.defaults,
    compaction: () => toPolicy(minWindow, compaction.points, compaction.enabled),
    logger: log,
  });
  const ctx = harness.ctx;
  const desks = new Map<string, App>();
  const windows = new Map<string, number>();
  const startedAt = Date.now();
  let closed = false;
  let stopProjector = () => {};
  let stopUsage = () => {};
  const usage = new Map<number, UsageSummary>();
  let stallTimer: ReturnType<typeof setInterval> | undefined;
  const close = async () => {
    if (closed) return;
    closed = true;
    clearInterval(stallTimer);
    stopProjector();
    stopUsage();
    await harness.close();
    owner.close();
    log.info("app.closed", {});
  };
  try {
    for (const { deps, agents } of prepared) {
      const id = deps.store.trackId;
      let main: Conversation;
      if (id === DEFAULT_TRACK_ID) {
        main = await harness.harness.root(ctx, {
          agent: { model: catalog.defaultModel, thinkingLevel: "low" },
        });
      } else {
        const bound = deps.store.tracks.get(id)!.conversationId;
        const conversationId = await harness.harness.commit(async (tx) => {
          const roots = await tx.doc(DeskRoots);
          const existing = roots.ids[id] ?? bound;
          if (existing !== undefined) {
            roots.ids[id] = existing;
            return existing;
          }
          const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
          await configure(tx, created.id, {
            extensions: agents.defaults,
            model: catalog.defaultModel,
            thinkingLevel: "low",
          });
          roots.ids[id] = created.id as number;
          return created.id as number;
        }, ctx);
        const conversation = await harness.harness.conversation(
          conversationId as ConversationId,
          ctx,
        );
        if (!conversation) throw new Error(`Missing durable desk conversation ${conversationId}`);
        main = conversation;
      }
      const track = owner.tracks.bindConversation(id, main.id as number);
      const mainModel = async () => {
        const agent = await main.agent(ctx);
        const modelId = agent.model?.modelId ?? catalog.defaultModel.modelId;
        return { id: modelId, window: catalog.info(modelId)?.contextWindow ?? 1_000_000 };
      };
      windows.set(id, (await mainModel()).window);
      const desk: App = {
        ...deps,
        track,
        desks,
        harness,
        ctx,
        agents,
        main,
        compaction,
        startedAt,
        mainModel,
        close,
        modelUsage() {
          const total = sumUsage();
          const ids = deps.store.db
            .prepare("SELECT conversation_id FROM agent_conversations WHERE track_id = ?")
            .all(id);
          for (const row of ids) {
            const own = usage.get(Number(row.conversation_id));
            if (own)
              for (const key of Object.keys(total) as (keyof UsageSummary)[])
                total[key] += own[key];
          }
          return total;
        },
        compactionState: () => ({
          ...fromPolicy(
            windows.get(id)!,
            toPolicy(minWindow, compaction.points, compaction.enabled),
          ),
          enabled: compaction.enabled,
          window: windows.get(id)!,
          shared: true,
        }),
        async refreshModel() {
          const model = await mainModel();
          windows.set(id, model.window);
          minWindow = Math.min(...windows.values());
          if (!fits(minWindow, compaction.points)) {
            compaction.points = fit(minWindow, compaction.points);
            owner.settings.set("compaction", compaction);
          }
          return model;
        },
        setCompaction(next) {
          if (next.points) {
            const window = windows.get(id)!;
            const reserve = window - next.points.force;
            const force = minWindow - reserve;
            const points = {
              force,
              background: force - (next.points.force - next.points.background),
            };
            const problem = validatePoints(minWindow, points);
            if (problem)
              throw new ApiFault(
                "invalid",
                `Shared policy must fit every desk's model. ${problem}`,
              );
            compaction.points = points;
          }
          if (next.enabled !== undefined) compaction.enabled = next.enabled;
          owner.settings.set("compaction", compaction);
          for (const desk of desks.values()) desk.bus.changed();
          return compaction;
        },
      };
      desks.set(id, desk);
    }
    minWindow = Math.min(...windows.values());
    compaction.points = fit(minWindow, compaction.points);
    // Reconstruct conversation ownership even if a crash happened before the telemetry projector ran.
    let cursor: Cursor | undefined;
    do {
      const page = await harness.harness.commit((tx) => tx.scanConversations({}, 200, cursor), ctx);
      for (const c of [...page.items].sort((a, b) => (a.id as number) - (b.id as number))) {
        const snapshot = await harness.harness.snapshot(UsageDoc, c.id, ctx);
        if (snapshot) usage.set(c.id as number, sumUsage(JSON.parse(JSON.stringify(snapshot))));
        owner.globalTelemetry.conversation({
          conversationId: c.id as number,
          ownerConversationId: c.owner?.conversationId as number | undefined,
          ownerTaskId: c.owner?.taskId as number | undefined,
          parentConversationId: c.parent?.conversationId as number | undefined,
        });
      }
      cursor = page.next;
    } while (cursor);
    stopUsage = harness.harness.subscribeCommits((publication) => {
      for (const change of publication.changes)
        if (
          change.type === "document" &&
          change.record.kind === UsageDoc.definition.kind &&
          change.conversationId !== undefined
        )
          usage.set(
            change.conversationId as number,
            sumUsage(JSON.parse(JSON.stringify(change.value ?? { models: {} }))),
          );
    });
    stopProjector = startProjector(harness.harness, owner.globalTelemetry, log);
    harness.harness.resume();
    stallTimer = setInterval(() => {
      for (const desk of desks.values()) {
        closeStalledSweeps(desk);
        void withdrawStuckSweeps(desk, {
          mainId: desk.main.id as number,
          withdraw: (id) => harness.harness.abortSubmission(id as SubmissionId, ctx, desk.main.id),
        }).catch((error) => desk.log.warn("sweep.withdraw_failed", { error: String(error) }));
      }
    }, 60_000);
    stallTimer.unref();
    log.info("app.opened", {
      device: config.device,
      desks: [...desks.values()].map((d) => ({ trackId: d.track.id, conversationId: d.main.id })),
      searchMode: search.mode,
    });
    return desks.get(DEFAULT_TRACK_ID)!;
  } catch (error) {
    await close();
    throw error;
  }
}
