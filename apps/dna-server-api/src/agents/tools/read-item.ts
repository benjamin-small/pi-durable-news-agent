import { Type } from "@earendil-works/pi-ai";
import { defineAppTool, toolError, toolText } from "@dna/durable-agent";
import type { Deps } from "../../deps.ts";
import { clip, FixableError, requireItem } from "./shared.ts";

export function readItem(deps: Deps) {
  return defineAppTool({
    name: "read_item",
    returns:
      "Text: the item's title, source, dates, jev scores and findings, then its cached text clipped to max_chars.",
    description:
      "Read one item: title, source, url, dates, discussion, and its cached text (capped). Also shows findings and jev scores so far.",
    parameters: Type.Object({
      item_id: Type.Integer(),
      max_chars: Type.Optional(Type.Integer({ minimum: 200, maximum: 6000 })),
    }),
    replay: "safe",
    outputLimits: { maxBytes: 16_000 },
    execute: async (args, api) => {
      try {
        const item = requireItem(deps, args.item_id);
        const cached = item.cacheId
          ? deps.store.sources.cachedById(item.cacheId)
          : deps.store.sources.cached(item.url);
        const text =
          cached?.contentMd && cached.contentMd.length > (item.excerpt?.length ?? 0)
            ? cached.contentMd
            : item.excerpt;
        const hfs = deps.store.news.latestHfs(item.id);
        const findings = deps.store.news.findings(item.id);
        const lines = [
          `#${item.id} ${item.title}`,
          `source: ${item.sourceName ?? "unknown"} | url: ${item.url}${item.discussionUrl ? ` | discussion: ${item.discussionUrl}` : ""}`,
          `published: ${item.publishedAt ?? "unknown"} | status: ${item.status} | relevance ${Math.round((item.relevance ?? 0) * 100)} | worth ${Math.round((item.worth ?? 0) * 100)}`,
          hfs
            ? `jev hfs: ${hfs.ranked.map((r) => `${r.category} ${r.score}`).join(", ")}${hfs.suspectCombo ? " (suspect_combo)" : ""}`
            : "jev hfs: not classified yet",
          ...findings.map(
            (f) => `finding: ${f.summary} (actionability ${f.actionability ?? "unknown"})`,
          ),
          "",
          clip(text, args.max_chars ?? 3000) || "No cached text. Use scrape_url to fetch the page.",
        ];
        deps.store.evidence.record(
          deps.store.trackId,
          "read:item",
          { text: (text ?? "").slice(0, args.max_chars ?? 3000), output: lines.join("\n") },
          { itemId: item.id, conversationId: api.conversationId as number },
        );
        return toolText(lines.join("\n"));
      } catch (error) {
        if (error instanceof FixableError) return toolError(error.message, error.hints);
        throw error;
      }
    },
  });
}
