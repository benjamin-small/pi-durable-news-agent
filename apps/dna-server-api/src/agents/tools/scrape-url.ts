import { Type } from "@earendil-works/pi-ai";
import { defineAppTool, toolError, toolText } from "@dna/durable-agent";
import type { Deps } from "../../deps.ts";
import { activeSweepId, clip, ref } from "./shared.ts";

export function scrapeUrl(deps: Deps) {
  return defineAppTool({
    name: "scrape_url",
    returns:
      "Text: the page title and how it was fetched, then its text as markdown clipped to max_chars.",
    description:
      "Read a page in full by fetching its URL directly (cache first). Give item_id to read an item's page, or a url.",
    parameters: Type.Object({
      item_id: Type.Optional(Type.Integer()),
      url: Type.Optional(Type.String()),
      max_chars: Type.Optional(Type.Integer({ minimum: 500, maximum: 8000 })),
    }),
    replay: "safe",
    outputLimits: { maxBytes: 20_000 },
    execute: async (args, api) => {
      const item = args.item_id ? deps.store.news.item(args.item_id) : undefined;
      if (args.item_id && !item) return toolError(`No item #${args.item_id}.`);
      const url = item?.url ?? args.url;
      if (!url) return toolError("scrape_url needs item_id or url.");
      try {
        const { doc, via, credits } = await deps.search.scrape(
          url,
          ref(api, activeSweepId(deps, item?.sweepId), deps.store.trackId),
        );
        if (item && doc.contentMd && (item.excerpt?.length ?? 0) < 200)
          deps.store.news.updateItem(item.id, {
            excerpt: (doc.excerpt ?? doc.contentMd).slice(0, 1000),
            imageUrl: item.imageUrl ?? doc.imageUrl,
          });
        deps.store.evidence.record(
          deps.store.trackId,
          "read:scrape",
          { text: (doc.contentMd ?? "").slice(0, args.max_chars ?? 4000) },
          { itemId: item?.id, url, conversationId: api.conversationId as number },
        );
        return toolText(
          `${doc.title ?? url} (via ${via}${credits ? `, ${credits} credits` : ""})\n${clip(doc.contentMd, args.max_chars ?? 4000)}`,
        );
      } catch (error) {
        return toolError(`Could not read ${url}: ${String(error).slice(0, 200)}`, [
          "Use read_item for the cached text, or skip this item.",
        ]);
      }
    },
  });
}
