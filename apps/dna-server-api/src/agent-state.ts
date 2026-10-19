// The main agent's state for GET /v1/agent and the agent.state frame.
import { type AgentState } from "@dna/sdk";
import { deepResearchSetting } from "./news/deep-research.ts";
import type { App } from "./runtime.ts";

export async function agentState(app: App): Promise<AgentState> {
  const { harness, ctx } = app.harness;
  const agent = await app.main.agent(ctx);
  const model = await app.mainModel();
  const graph = await harness.taskGraph(ctx);
  let busy: boolean;
  try {
    busy = Object.values(graph.value.tasks).some(
      (t) => (t.conversationId as number) === (app.main.id as number) && !t.background,
    );
  } finally {
    graph.dispose();
  }
  const total = app.modelUsage();
  const spend = app.store.telemetry.spend();
  return {
    conversationId: app.main.id as number,
    model: model.id,
    thinkingLevel: agent.thinkingLevel ?? "low",
    quick: app.quick.setting(),
    deepResearch: deepResearchSetting(app.store),
    busy,
    contextTokens: app.store.telemetry.contextTokens(app.main.id as number),
    contextWindow: model.window,
    compaction: app.compactionState(),
    usage: {
      tokens: total.tokens,
      costUsd: total.cost,
      input: total.input,
      output: total.output,
      cacheRead: total.cacheRead,
      cacheWrite: total.cacheWrite,
    },
    spend: { ...spend, modelUsd: total.cost, totalUsd: total.cost + spend.jevUsd + spend.imageUsd },
    lastActivityAt: app.store.telemetry.lastActivityAt(),
    nextSweepAt: app.schedule.next()?.toISOString(),
    schedule: app.schedule.state(),
  };
}
