// The capability registry: everything a reader can do. The browser, the TUI and the CLI each map every capability
// to a control or command, and tests fail when one is missing.
import type { RouteId } from "./routes.ts";

export interface Capability {
  readonly summary: string;
  readonly routes: readonly RouteId[];
}

export const CAPABILITIES = {
  status: {
    summary: "Device, track, model, agent state and next sweep",
    routes: ["info", "agent.get", "tracks.list"],
  },
  "feed.read": { summary: "News cards, oldest first", routes: ["feed"] },
  "feed.search": {
    summary: "Search the news by words, a keyword or a url, in its own tab",
    routes: ["feed.search"],
  },
  "timelines.read": {
    summary: "Open a timeline: related news in date order",
    routes: ["timelines.list", "timelines.get"],
  },
  "card.read": {
    summary: "One card with its item, findings and tool call",
    routes: ["cards.get", "archive.history", "archive.preview", "archive.download", "archive.pin"],
  },
  "feedback.more": { summary: "Show me more like this card", routes: ["cards.feedback"] },
  "feedback.less": { summary: "Show me less like this card", routes: ["cards.feedback"] },
  "feedback.label": { summary: "Label a card hype, facts or signal", routes: ["cards.feedback"] },
  "taste.read": { summary: "Keywords and recent feedback", routes: ["taste.get"] },
  "taste.answer": {
    summary: "Answer the agent's taste questions",
    routes: ["taste.questions", "taste.answer"],
  },
  "chat.send": { summary: "Send the agent a message, or steer it", routes: ["agent.messages"] },
  "chat.watch": {
    summary: "Watch the agent and its tool calls live",
    routes: ["stream", "agent.transcript"],
  },
  "chat.abort": { summary: "Stop the current run", routes: ["agent.abort"] },
  "agent.model": { summary: "Pick the model", routes: ["agent.config", "info"] },
  "agent.thinking": { summary: "Pick the thinking level", routes: ["agent.config"] },
  "agent.tools": {
    summary: "See every tool the agent has: definition, params and return",
    routes: ["agent.tools"],
  },
  schedule: {
    summary:
      "How often sweeps run (every 1 to 60 minutes, or off) and how many cards each presents",
    routes: ["schedule.get", "schedule.set"],
  },
  "agent.compaction": {
    summary: "Move the background and force compaction points",
    routes: ["agent.compaction.get", "agent.compaction.set"],
  },
  "agent.compact": { summary: "Compact the context now", routes: ["agent.compact"] },
  keywords: {
    summary: "List, add, weight, toggle and remove keywords",
    routes: ["keywords.list", "keywords.add", "keywords.update", "keywords.remove"],
  },
  "archive.retention": {
    summary: "Preview retention, inspect storage and safely enable shared cleanup",
    routes: ["archive.retention", "archive.policy", "archive.cleanup"],
  },
  sources: {
    summary: "List, add, toggle and remove sources",
    routes: ["sources.list", "sources.add", "sources.update", "sources.remove"],
  },
  "sweeps.read": {
    summary: "Sweeps with counts, phases, costs and audit",
    routes: ["sweeps.list", "sweeps.get"],
  },
  "runs.read": {
    summary: "Agent runs with generations, tool calls and subagents",
    routes: ["executions.runs", "executions.run"],
  },
  "tool.read": {
    summary: "Tool calls with timings, tokens, cost and context",
    routes: ["executions.toolCalls", "executions.toolCall"],
  },
  usage: { summary: "Per day cost, tokens, jev calls and Firecrawl credits", routes: ["usage"] },
  logs: { summary: "Tail the logs with filters", routes: ["logs"] },
} as const satisfies Record<string, Capability>;

export type CapabilityId = keyof typeof CAPABILITIES;
export const CAPABILITY_IDS = Object.keys(CAPABILITIES) as CapabilityId[];

/** Routes no capability needs: liveness, the cron-only workflow, and image bytes behind <img>. */
export const INFRA_ROUTES: readonly RouteId[] = ["healthz", "workflow.newsSweep", "images.get"];
