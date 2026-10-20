import { Type } from "@earendil-works/pi-ai";
import { defineAppTool, toolText } from "@dna/durable-agent";
import type { Deps } from "../../deps.ts";
import { activeSweepId, ref } from "./shared.ts";

export function searchWeb(deps: Deps) {
  return defineAppTool({
    name: "search_web",
    returns:
      "Text: how many results and from where, then one line per hit (new item id, title, source, excerpt).",
    description:
      "Search news on the web (Bing News, Hacker News and the cached feeds), newest first. Leave hours out to search any date, or set hours to keep only results published in that window (24 a day, 168 a week, 720 a month, 8760 a year). Each hit becomes an item you can read, classify and present.",
    parameters: Type.Object({
      query: Type.String({ minLength: 2 }),
      hours: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: "Only results published in the last N hours. Leave out for any date.",
        }),
      ),
      sweep_id: Type.Optional(Type.Integer()),
    }),
    replay: "safe",
    execute: async (args, api, ctx) => {
      const sweepId = activeSweepId(deps, args.sweep_id);
      const cached = await api.memo<string>("search-result", ctx);
      if (cached) return toolText(cached);
      const { hits, via, engines, credits } = await deps.search.search(
        args.query,
        ref(api, sweepId, deps.store.trackId),
        {
          hours: args.hours,
          limit: 8,
        },
      );
      const lines = hits.map((h) => {
        const doc = deps.store.sources.cache({
          url: h.url,
          title: h.title,
          excerpt: h.excerpt,
          captureIds: h.captureIds,
          publishedAt: h.publishedAt,
          imageUrl: h.imageUrl,
          fetchVia: "feed",
          ttlMinutes: 24 * 60,
        });
        const { item } = deps.store.news.upsertItem({
          sweepId,
          cacheId: doc.id,
          url: h.url,
          title: h.title,
          sourceName: h.sourceName,
          publishedAt: h.publishedAt,
          excerpt: h.excerpt,
          imageUrl: h.imageUrl,
        });
        return `#${item.id} ${item.title} (${h.sourceName ?? "web"})${h.excerpt ? `: ${h.excerpt.slice(0, 160)}` : ""}`;
      });
      const text = `${hits.length} results via ${via}${engines ? ` (${engines})` : ""}${credits ? `, ${credits} credits` : ""}.\n${lines.join("\n")}`;
      await api.memo("search-result", text, ctx);
      return toolText(text);
    },
  });
}
