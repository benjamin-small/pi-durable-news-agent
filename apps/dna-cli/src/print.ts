// Plain text views for the dna command. --json skips these and prints the data.
import {
  ago,
  cleanText,
  k,
  ms,
  usd,
  type AgentState,
  type Card,
  type CardDetail,
  type Info,
  type Keyword,
  type RunDetail,
  type RunSummary,
  type SearchEngineHealth,
  type Source,
  type Sweep,
  type TasteQuestion,
  type TimelineSummary,
  type ToolInfo,
  type ToolCallDetail,
  type UsageDay,
} from "@dna/sdk";

const pad = (s: string | number, n: number) => String(s).padEnd(n);

export function hfs(card: Pick<Card, "hfs">): string {
  if (!card.hfs) return "not ranked";
  return card.hfs.ranked
    .map((r) => `${r.category[0].toUpperCase()}${r.category.slice(1)} ${r.score}`)
    .join("  ");
}

export function cardLine(c: Card): string {
  const timeline = c.timeline
    ? `  timeline ${c.timeline.id} ${c.timeline.index}/${c.timeline.count}`
    : "";
  return `#${pad(c.id, 4)} ${pad(c.component, 13)} ${cleanText(c.title).slice(0, 90)}\n       ${hfs(c)}${c.attention !== undefined ? `  attention ${c.attention}` : ""}${c.sourceName ? `  ${c.sourceName}` : ""}${timeline}${c.feedback?.signal ? `  you said ${c.feedback.signal}` : ""}`;
}

export function toolLines(t: ToolInfo): string {
  return [
    `${t.name}  (${t.agents.join(", ")})`,
    `  ${cleanText(t.description)}`,
    ...t.params.map(
      (p) =>
        `  ${p.required ? "*" : " "} ${pad(p.name, 14)} ${pad(p.type, 18)} ${p.values ? p.values.join(" | ") : cleanText(p.description ?? "")}`,
    ),
    t.returns ? `  returns: ${cleanText(t.returns)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export const timelineLine = (t: TimelineSummary) =>
  `timeline ${pad(t.id, 4)} ${cleanText(t.title)}  ${t.count} items  grew ${ago(t.updatedAt)}`;

export function cardDetail(d: CardDetail): string {
  const c = d.card;
  const props = Object.entries(c.props)
    .filter(([key]) => key !== "title")
    .map(([key, v]) => `  ${key}: ${Array.isArray(v) ? v.join("; ") : cleanText(String(v))}`);
  return [
    cardLine(c),
    c.url ? `  ${c.url}` : "",
    ...props,
    ...d.findings.map((f) => `  finding: ${cleanText(f.summary)}`),
    d.item
      ? `  relevance ${Math.round((d.item.relevance ?? 0) * 100)}  worth ${Math.round((d.item.worth ?? 0) * 100)}${d.item.matchedTopic ? `  topic ${d.item.matchedTopic}` : ""}`
      : "",
    d.toolCall
      ? `  presented by ${d.toolCall.toolName} in ${ms(d.toolCall.durationMs)} (tool call ${d.toolCall.id})`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** One engine per entry: "bing-news ok", "google-news resting until 14:05 (HTTP 503)", "duckduckgo unused". */
export function searchEngines(engines: SearchEngineHealth[]): string {
  return engines
    .map((e) => {
      const resting = e.coolingUntil && Date.parse(e.coolingUntil) > Date.now();
      if (resting)
        return `${e.name} resting until ${new Date(e.coolingUntil!).toLocaleTimeString()} (${e.lastError})`;
      if (!e.ok && !e.failed) return `${e.name} unused`;
      return `${e.name} ${e.streak ? `failing (${e.lastError})` : "ok"}`;
    })
    .join(", ");
}

export function status(info: Info, agent: AgentState, last?: Sweep): string {
  return [
    `${info.track?.name ?? "AI"} desk`,
    `${info.deviceName} (${info.device})  ${info.mode}  search ${info.searchMode}  pi-durable ${info.piDurable}`,
    `model ${agent.model}  thinking ${agent.thinkingLevel}  ${agent.busy ? "working" : "idle"}`,
    `context ${k(agent.contextTokens)} of ${k(agent.contextWindow)}  compaction ${k(agent.compaction.background)} and ${k(agent.compaction.force)}${agent.compaction.enabled ? "" : " (off)"}`,
    `spent ${usd(agent.spend?.totalUsd ?? agent.usage.costUsd)} in total (model ${usd(agent.spend?.modelUsd ?? agent.usage.costUsd)}, jev ${usd(agent.spend?.jevUsd ?? 0)}, images ${usd(agent.spend?.imageUsd ?? 0)}) on ${k(agent.usage.tokens)} tokens`,
    last
      ? `last sweep #${last.id} ${last.status} ${ago(last.endedAt ?? last.createdAt)}: ${last.candidates} candidates, ${last.presented} presented`
      : "no sweeps yet",
    `next sweep ${info.nextSweepAt ? new Date(info.nextSweepAt).toLocaleTimeString() : "not scheduled"}`,
    info.search?.engines.length ? `search engines: ${searchEngines(info.search.engines)}` : "",
    info.firecrawl
      ? `firecrawl ${info.firecrawl.creditsToday} of ${info.firecrawl.dailyCap} credits today${info.firecrawl.creditsLeft !== undefined ? `, ${info.firecrawl.creditsLeft} left on the plan` : ""}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export const sweepLine = (s: Sweep) =>
  `#${pad(s.id, 4)} ${pad(s.status, 10)} ${pad(s.trigger, 7)} gathered ${s.gathered}  kept ${s.kept}  presented ${s.presented}  ${usd((s.cost?.modelUsd ?? 0) + (s.cost?.jevUsd ?? 0) + (s.cost?.imageUsd ?? 0))}  credits ${s.firecrawlCreditsUsed}  ${ago(s.createdAt)}${s.reason ? `  ${s.reason}` : ""}`;

export function sweepDetail(
  s: Sweep & {
    toolCalls?: { id: number; toolName: string; isError: boolean; durationMs?: number }[];
  },
): string {
  return [
    sweepLine(s),
    ...s.phases.map(
      (p) =>
        `  ${pad(p.phase, 8)} ${pad(p.status, 8)} ${ms(p.endedAt ? p.endedAt - p.startedAt : undefined)}  ${p.note ?? ""}`,
    ),
    s.summary ? `  ${cleanText(s.summary)}` : "",
    s.audit
      ? `  audit: ${s.audit.missing.length ? `missing ${s.audit.missing.join(", ")}` : "every expected step ran"}`
      : "",
    ...(s.toolCalls ?? []).map(
      (t) =>
        `  tool ${pad(t.id, 5)} ${pad(t.toolName, 16)} ${t.isError ? "error" : "ok"}  ${ms(t.durationMs)}`,
    ),
  ]
    .filter(Boolean)
    .join("\n");
}

export const runLine = (r: RunSummary) =>
  `#${pad(r.runEntryId, 5)} ${pad(r.agent, 16)} ${pad(r.status, 8)} ${r.generations} gens  ${r.toolCalls} tools  ${k(r.tokensIn)} in  ${k(r.tokensOut)} out  ${usd(r.costUsd)}  ${ms(r.endedAt ? r.endedAt - r.startedAt : undefined)}${r.sweepId ? `  sweep ${r.sweepId}` : ""}`;

export function runDetail(r: RunDetail, depth = 0): string {
  const indent = "  ".repeat(depth);
  return [
    indent + runLine(r),
    ...r.toolCallRows.map(
      (t) =>
        `${indent}  tool ${pad(t.id, 5)} ${pad(t.toolName, 16)} ${t.isError ? "error" : "ok"}  ${ms(t.durationMs)}  context ${k(t.contextTokens ?? 0)}`,
    ),
    ...r.children.map((c) => runDetail(c, depth + 1)),
  ].join("\n");
}

export function toolDetail(t: ToolCallDetail): string {
  return [
    `tool ${t.id} ${t.toolName} ${t.isError ? "error" : "ok"} in ${ms(t.durationMs)}`,
    `  started ${t.startedAt ? new Date(t.startedAt).toISOString() : "unknown"}  ended ${t.endedAt ? new Date(t.endedAt).toISOString() : "running"}`,
    t.generation
      ? `  generation ${t.generation.entryId}: ${k(t.generation.inputTokens)} in  ${k(t.generation.outputTokens)} out  ${usd(t.generation.costUsd)}  context ${k(t.generation.contextTokens)}`
      : "",
    `  args ${JSON.stringify(t.args)}`,
    t.resultText ? `  result ${cleanText(t.resultText).slice(0, 600)}` : "",
    ...t.jevCalls.map((j) => `  jev ${j.command} ${ms(j.elapsedMs)} ${usd(j.costUsd)}`),
    ...t.firecrawlCalls.map(
      (f) => `  firecrawl ${f.endpoint} ${f.status} ${f.creditsUsed ?? 0} credits`,
    ),
    ...t.childRuns.map((r) => `  subagent ${runLine(r)}`),
  ]
    .filter(Boolean)
    .join("\n");
}

export const keywordLine = (kw: Keyword) =>
  `#${pad(kw.id, 4)} ${pad(kw.kind, 7)} ${pad(kw.term, 28)} weight ${kw.weight.toFixed(2)}${kw.enabled ? "" : "  off"}${kw.source === "user" ? "  yours" : ""}`;
const ORIGIN: Record<Source["origin"], string> = {
  config: "",
  user: "  yours",
  agent: "  saved by the agent",
  upvote: "  saved from your upvote",
};
export const sourceLine = (s: Source) =>
  `#${pad(s.id, 4)} ${pad(s.kind, 16)} ${pad(s.name, 26)} ${s.enabled ? "on " : "off"}  ${s.lastStatus ?? "never fetched"}${s.lastFetchedAt ? ` ${ago(s.lastFetchedAt)}` : ""}${ORIGIN[s.origin] ?? ""}`;
/** What an upvote left for the next sweep, or nothing. */
export const leadsLine = (leads: { site: string }[] | undefined) =>
  leads?.length
    ? `The next sweep looks at ${leads.map((l) => l.site).join(", ")} as a source.`
    : "";
export const questionLine = (q: TasteQuestion) =>
  `#${pad(q.id, 4)} ${q.status}  ${cleanText(q.question)}${q.cardId ? `  (card ${q.cardId})` : ""}`;
export const usageLine = (u: UsageDay) =>
  `${u.day}  model ${usd(u.modelUsd)}  jev ${usd(u.jevUsd)} (${u.jevCalls} calls)  images ${usd(u.imageUsd)}  ${k(u.tokensIn)} in  ${k(u.tokensOut)} out  firecrawl ${u.firecrawlCredits}  sweeps ${u.sweeps}`;

export interface DeviceStatus {
  device: string;
  online: boolean;
  url: string;
  pid?: number;
  error?: string;
  ui?: { url: string; running: boolean; hosted?: boolean; private?: boolean };
}

const uiNote = (x: DeviceStatus) =>
  !x.ui
    ? ""
    : !x.ui.running
      ? x.ui.hosted
        ? ` (not answering: just net deploy ${x.device})`
        : x.device === "local"
          ? " (not running: just net up local)"
          : " (not running: just browser all)"
      : x.ui.private
        ? " (private: exe.dev login)"
        : "";

/** One device: state, the API link, and the browser UI link (with how to start it when no hub serves it). */
export const deviceLine = (x: DeviceStatus) =>
  [
    pad(x.device, 8),
    pad(x.online ? "online" : "offline", 8),
    `api ${pad(x.url, 30)}`,
    x.ui ? `ui ${x.ui.url}${uiNote(x)}` : "",
    x.pid ? `pid ${x.pid}` : "",
    x.error ?? "",
  ]
    .filter(Boolean)
    .join("  ");
