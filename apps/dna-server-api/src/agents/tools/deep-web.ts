// The deep-research agent's view of the web: deep_search searches the whole web (not only news) and open_page reads a
// page in full with the links on it, so a researcher can follow a trail 2 to 10 links deep. Firecrawl when
// FIRECRAWL_API_KEY is set, the free Bing web search and direct fetches when not. Neither adds items to the news feed.
import { Type } from "@earendil-works/pi-ai";
import { defineAppTool, toolError, toolText } from "@dna/durable-agent";
import type { Deps } from "../../deps.ts";
import { CHUNK_CHARS, savedText, scrapeFile, saveScrape, savedSource } from "./hyper-fetch.ts";
import { ref } from "./shared.ts";

export function deepSearch(deps: Deps) {
  return defineAppTool({
    name: "deep_search",
    returns:
      "Text: how many results and from where, then one block per hit (number, title, site, url, snippet and date when known).",
    description:
      "Search the whole web, not only news: company sites, docs, filings, papers, repos, reporting and discussion. Best match first. Leave hours out to search any date. Open the promising hits with open_page.",
    parameters: Type.Object({
      query: Type.String({ minLength: 2, maxLength: 300 }),
      hours: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: "Only results published in the last N hours. Leave out for any date.",
        }),
      ),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }),
    example: { query: "durable execution for AI agents checkpoint replay" },
    replay: "safe",
    execute: async (args, api, ctx) => {
      const cached = await api.memo<string>("search-result", ctx);
      if (cached) return toolText(cached);
      const { hits, via, engines, credits } = await deps.search.deepSearch(
        args.query,
        ref(api, undefined, deps.store.trackId),
        {
          hours: args.hours,
          limit: args.limit ?? 10,
        },
      );
      const text = [
        `${hits.length} results via ${via}${engines ? ` (${engines})` : ""}${credits ? `, ${credits} credits` : ""}.`,
        ...hits.map((h, i) =>
          [
            `${i + 1}. ${h.title} (${h.sourceName ?? "web"})${h.publishedAt ? ` ${h.publishedAt.slice(0, 10)}` : ""}`,
            `   ${h.url}`,
            h.excerpt ? `   ${h.excerpt.replace(/\s+/g, " ").slice(0, 240)}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        ),
      ].join("\n");
      await api.memo("search-result", text, ctx);
      return toolText(text);
    },
  });
}

export function openPage(deps: Deps) {
  return defineAppTool({
    name: "open_page",
    returns:
      "Text: the page title, how it was fetched and which chunk of how many, then that chunk as markdown. The last chunk ends with every link on the page (text and url) to follow next.",
    description: `Read one web page in full and see the links on it, so you can follow them to the next page. Pages longer than ${CHUNK_CHARS} characters come in chunks: call again with the next chunk. The links on the page are listed at the end of the last chunk. Give url, or item_id for a news item's page. A page read in the last day is read again for free.`,
    parameters: Type.Object({
      url: Type.Optional(Type.String()),
      item_id: Type.Optional(Type.Integer()),
      chunk: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    example: { url: "https://www.anthropic.com/engineering", chunk: 1 },
    replay: "safe",
    outputLimits: { maxBytes: 48_000 },
    execute: async (args, api) => {
      const item = args.item_id ? deps.store.news.item(args.item_id) : undefined;
      if (args.item_id && !item) return toolError(`No item #${args.item_id}.`);
      const url = (item?.url ?? args.url)?.trim();
      if (!url) return toolError("open_page needs url or item_id.");
      if (!/^https?:\/\//.test(url))
        return toolError(`${url} is not a web address.`, ["Give a full http or https url."]);
      const file = scrapeFile(deps.config.dataDir, `deep:${url}`);
      let text = savedText(file);
      let fetched = "saved copy";
      if (!text) {
        try {
          const page = await deps.search.deepScrape(url, ref(api, undefined, deps.store.trackId));
          if (!page.markdown.trim() && !page.links.length)
            return toolError(`${url} has no readable text.`, [
              "Try another result, or search for the same page elsewhere.",
            ]);
          text = [
            `# ${page.title ?? url}`,
            page.markdown.trim() || "(no readable text)",
            `## Links on this page (${page.links.length})`,
            ...page.links.map((l) => `- ${l.text || "(no text)"}: ${l.url}`),
          ].join("\n\n");
          saveScrape(file, text, page.archiveExtractionId);
          fetched = `${page.via}${page.credits ? `, ${page.credits} credits` : ""}`;
        } catch (error) {
          return toolError(`Could not open ${url}: ${String(error).slice(0, 200)}`, [
            "Try another result, or search for the same page elsewhere.",
          ]);
        }
      }
      const chunks = Math.ceil(text.length / CHUNK_CHARS);
      const chunk = args.chunk ?? 1;
      if (chunk > chunks)
        return toolError(`${url} has ${chunks} chunk${chunks === 1 ? "" : "s"}.`, [
          `Give chunk 1 to ${chunks}.`,
        ]);
      deps.store.evidence.record(
        deps.store.trackId,
        "read:open-page",
        { text: text.slice((chunk - 1) * CHUNK_CHARS, chunk * CHUNK_CHARS) },
        {
          itemId: item?.id,
          url,
          conversationId: api.conversationId as number,
          sourceExtractionIds: savedSource(file, text),
        },
      );
      return toolText(
        [
          `${url} (via ${fetched}), chunk ${chunk} of ${chunks}`,
          text.slice((chunk - 1) * CHUNK_CHARS, chunk * CHUNK_CHARS),
          chunk < chunks
            ? `More on this page: open_page with chunk ${chunk + 1} of ${chunks}. The links are listed at the end of chunk ${chunks}.`
            : "End of page.",
        ].join("\n"),
      );
    },
  });
}
