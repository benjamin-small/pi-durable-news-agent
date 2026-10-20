// The route table: every v1 route with its scope. The server mounts from this table and DnaClient calls by id,
// so the server, the clients and the docs cannot drift.
import type { Scope } from "./api.ts";

export type Method = "GET" | "POST" | "PATCH" | "DELETE";

export interface RouteSpec {
  readonly method: Method;
  readonly path: string;
  /** "open" needs no token. */
  readonly scope: Scope | "open";
  readonly summary: string;
}

export const ROUTES = {
  "archive.history": {
    method: "GET",
    path: "/v1/cards/:id/archive",
    scope: "read",
    summary: "Immutable publication evidence and source version history",
  },
  "archive.preview": {
    method: "GET",
    path: "/v1/archive/:kind/:id",
    scope: "read",
    summary: "Plain text archive preview",
  },
  "archive.download": {
    method: "GET",
    path: "/v1/archive/:kind/:id/download",
    scope: "read",
    summary: "Download immutable archived bytes as an attachment",
  },
  "archive.pin": {
    method: "PATCH",
    path: "/v1/archive/:kind/:id/pin",
    scope: "settings",
    summary: "Pin or unpin this exact version for the selected desk",
  },
  "tracks.list": {
    method: "GET",
    path: "/v1/tracks",
    scope: "read",
    summary: "Available editorial desks and their durable conversation identities",
  },
  healthz: {
    method: "GET",
    path: "/healthz",
    scope: "open",
    summary: "Liveness: ok, version, device, uptime",
  },
  info: {
    method: "GET",
    path: "/v1/info",
    scope: "read",
    summary: "Device, mode, search mode, models, schedule, next sweep, versions",
  },
  "workflow.newsSweep": {
    method: "POST",
    path: "/v1/workflows/news-sweep",
    scope: "workflow",
    summary: "Start a news sweep (cron calls this)",
  },
  "schedule.get": {
    method: "GET",
    path: "/v1/schedule",
    scope: "read",
    summary: "How often scheduled sweeps run, the presets and the next sweep",
  },
  "schedule.set": {
    method: "PATCH",
    path: "/v1/schedule",
    scope: "settings",
    summary: "How often sweeps run (a preset, or null for off) and how many cards each presents",
  },
  "sweeps.list": {
    method: "GET",
    path: "/v1/sweeps",
    scope: "read",
    summary: "Sweeps with counts, costs, credits and phases",
  },
  "sweeps.get": {
    method: "GET",
    path: "/v1/sweeps/:id",
    scope: "read",
    summary: "One sweep with its audit and tool calls",
  },
  feed: {
    method: "GET",
    path: "/v1/feed",
    scope: "read",
    summary: "Cards oldest to newest, up to 1000 a page, paged backwards by cursor",
  },
  "feed.search": {
    method: "GET",
    path: "/v1/feed/search",
    scope: "read",
    summary: "News cards matching a search, a keyword or a url, newest published first",
  },
  "timelines.list": {
    method: "GET",
    path: "/v1/timelines",
    scope: "read",
    summary: "Timelines, most recently grown first",
  },
  "timelines.get": {
    method: "GET",
    path: "/v1/timelines/:id",
    scope: "read",
    summary: "One timeline with its news cards, oldest published first",
  },
  "cards.get": {
    method: "GET",
    path: "/v1/cards/:id",
    scope: "read",
    summary: "Card detail with item, findings and the tool call",
  },
  "cards.feedback": {
    method: "POST",
    path: "/v1/cards/:id/feedback",
    scope: "feedback",
    summary: "Show me more or less, and H F S labels",
  },
  "taste.get": {
    method: "GET",
    path: "/v1/taste",
    scope: "read",
    summary: "Keywords and recent feedback",
  },
  "taste.questions": {
    method: "GET",
    path: "/v1/taste-questions",
    scope: "read",
    summary: "Taste questions from the agent",
  },
  "taste.answer": {
    method: "POST",
    path: "/v1/taste-questions/:id/answer",
    scope: "feedback",
    summary: "Answer a taste question with labels",
  },
  "keywords.list": {
    method: "GET",
    path: "/v1/keywords",
    scope: "read",
    summary: "Keywords per section with weights",
  },
  "keywords.add": {
    method: "POST",
    path: "/v1/keywords",
    scope: "settings",
    summary: "Add a keyword",
  },
  "keywords.update": {
    method: "PATCH",
    path: "/v1/keywords/:id",
    scope: "settings",
    summary: "Change a keyword weight, term or enabled",
  },
  "keywords.remove": {
    method: "DELETE",
    path: "/v1/keywords/:id",
    scope: "settings",
    summary: "Remove a keyword",
  },
  "sources.list": {
    method: "GET",
    path: "/v1/sources",
    scope: "read",
    summary: "Sources with last status",
  },
  "sources.add": {
    method: "POST",
    path: "/v1/sources",
    scope: "settings",
    summary: "Add a source",
  },
  "sources.update": {
    method: "PATCH",
    path: "/v1/sources/:id",
    scope: "settings",
    summary: "Change a source",
  },
  "sources.remove": {
    method: "DELETE",
    path: "/v1/sources/:id",
    scope: "settings",
    summary: "Remove a source",
  },
  "agent.get": {
    method: "GET",
    path: "/v1/agent",
    scope: "read",
    summary: "Model, thinking, context used, compaction, cost totals",
  },
  "agent.tools": {
    method: "GET",
    path: "/v1/agent/tools",
    scope: "read",
    summary: "Every tool the agents have: definition, params and return",
  },
  "agent.config": {
    method: "PATCH",
    path: "/v1/agent/config",
    scope: "settings",
    summary: "Change model or thinking level",
  },
  "agent.compaction.get": {
    method: "GET",
    path: "/v1/agent/compaction",
    scope: "read",
    summary: "Background and force compaction points",
  },
  "agent.compaction.set": {
    method: "PATCH",
    path: "/v1/agent/compaction",
    scope: "settings",
    summary: "Move the compaction points",
  },
  "agent.compact": {
    method: "POST",
    path: "/v1/agent/compact",
    scope: "settings",
    summary: "Compact the context now",
  },
  "agent.messages": {
    method: "POST",
    path: "/v1/agent/messages",
    scope: "chat",
    summary: "Send a message (followUp or steer)",
  },
  "agent.abort": {
    method: "POST",
    path: "/v1/agent/abort",
    scope: "chat",
    summary: "Stop the current run",
  },
  "agent.transcript": {
    method: "GET",
    path: "/v1/agent/transcript",
    scope: "read",
    summary: "Transcript of the main agent or a subagent",
  },
  stream: {
    method: "GET",
    path: "/v1/stream",
    scope: "read",
    summary: "One SSE stream: agent, feed, sweeps, taste, usage",
  },
  "executions.runs": {
    method: "GET",
    path: "/v1/executions",
    scope: "read",
    summary: "Agent runs",
  },
  "executions.run": {
    method: "GET",
    path: "/v1/executions/runs/:id",
    scope: "read",
    summary: "One run with generations, tool calls, jev, Firecrawl and children",
  },
  "executions.toolCalls": {
    method: "GET",
    path: "/v1/executions/tool-calls",
    scope: "read",
    summary: "Light tool call rows for a conversation or sweep, newest last",
  },
  "executions.toolCall": {
    method: "GET",
    path: "/v1/executions/tool-calls/:id",
    scope: "read",
    summary: "One tool call with timings, tokens, cost and paid calls",
  },
  usage: { method: "GET", path: "/v1/usage", scope: "read", summary: "Per day totals" },
  logs: {
    method: "GET",
    path: "/v1/logs",
    scope: "read",
    summary: "Tail of the JSONL logs with filters",
  },
  "images.get": {
    method: "GET",
    path: "/v1/images/:id",
    scope: "read",
    summary: "Card image bytes",
  },
} as const satisfies Record<string, RouteSpec>;

export type RouteId = keyof typeof ROUTES;

/** Fill `:name` params: path("cards.get", { id: 3 }) is "/v1/cards/3". */
export function routePath(
  id: RouteId,
  params: Record<string, string | number> = {},
  query?: Record<string, string | number | boolean | undefined>,
): string {
  const path = ROUTES[id].path.replace(/:(\w+)/g, (_, name: string) => {
    if (params[name] === undefined) throw new Error(`Route ${id} needs ${name}`);
    return encodeURIComponent(String(params[name]));
  });
  const q = Object.entries(query ?? {}).filter(([, v]) => v !== undefined && v !== "");
  return q.length
    ? `${path}?${new URLSearchParams(q.map(([k, v]): [string, string] => [k, String(v)]))}`
    : path;
}
