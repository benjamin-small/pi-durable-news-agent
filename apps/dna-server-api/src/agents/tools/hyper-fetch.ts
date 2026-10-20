// hyper_fetch: one article in full for a breakdown the reader asked for. Firecrawl scrapes it when FIRECRAWL_API_KEY is
// set; without a key, or when Firecrawl fails, the page is fetched directly and read with Readability. The whole page
// is saved to data/scrapes/, and the agent reads it chunk by chunk, so a long article is never cut off. A saved copy
// under a day old is read again instead of fetching (or paying) twice.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineAppTool, toolError, toolText } from "@dna/durable-agent";
import type { Deps } from "../../deps.ts";
import { ref } from "./shared.ts";

export const CHUNK_CHARS = 15_000;
const SAVED_FOR_MS = 24 * 60 * 60_000;

/** Where an article's scrape is saved. */
export const scrapeFile = (dataDir: string, url: string) =>
  join(dataDir, "scrapes", `${createHash("sha256").update(url).digest("hex").slice(0, 16)}.md`);

export function savedText(file: string): string | undefined {
  try {
    if (Date.now() - statSync(file).mtimeMs > SAVED_FOR_MS) return undefined;
    return readFileSync(file, "utf8") || undefined;
  } catch {
    return undefined;
  }
}

export function hyperFetch(deps: Deps) {
  return defineAppTool({
    name: "hyper_fetch",
    returns:
      "Text: the article title, how it was fetched (firecrawl with its credits, a direct fetch, or the saved copy) and which chunk of how many, then that chunk of the article as markdown, then the next chunk to read or the end.",
    description:
      "Read one article in full (through Firecrawl when it is set up, otherwise a direct fetch). Use it only when the reader explicitly asks for a breakdown of an article. Long articles come back in chunks: read every chunk, calling again with the next chunk until the result says end of article, then break it down for the reader. Never use it during a sweep or for research: read_item and scrape_url cover those. Give url, or item_id for an item's page. Only the first chunk fetches the page; later chunks read the saved copy.",
    parameters: Type.Object({
      url: Type.Optional(Type.String()),
      item_id: Type.Optional(Type.Integer()),
      chunk: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    example: { url: "https://example.com/blog/launch", chunk: 1 },
    replay: "safe",
    outputLimits: { maxBytes: 48_000 },
    execute: async (args, api) => {
      const item = args.item_id ? deps.store.news.item(args.item_id) : undefined;
      if (args.item_id && !item) return toolError(`No item #${args.item_id}.`);
      const url = item?.url ?? args.url;
      if (!url) return toolError("hyper_fetch needs url or item_id.");
      const file = scrapeFile(deps.config.dataDir, url);
      let text = savedText(file);
      let fetched = "saved copy";
      if (!text) {
        try {
          const page = await deps.search.hyperFetch(url, ref(api, undefined, deps.store.trackId));
          if (!page.markdown)
            return toolError(`No article text found at ${url}.`, [
              "Try scrape_url, or tell the reader the page could not be read.",
            ]);
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, page.markdown);
          text = page.markdown;
          fetched =
            page.via === "firecrawl" ? `firecrawl, ${page.credits} credits` : "direct fetch";
        } catch (error) {
          return toolError(`Could not read ${url}: ${String(error).slice(0, 200)}`, [
            "Tell the reader the page could not be read, or try another source for the story.",
          ]);
        }
      }
      const chunks = Math.ceil(text.length / CHUNK_CHARS);
      const chunk = args.chunk ?? 1;
      if (chunk > chunks)
        return toolError(`${url} has ${chunks} chunk${chunks === 1 ? "" : "s"}.`, [
          `Give chunk 1 to ${chunks}.`,
        ]);
      const title = deps.store.sources.cached(url)?.title ?? url;
      return toolText(
        [
          `${title} (via ${fetched}), chunk ${chunk} of ${chunks}, ${text.length} chars in all`,
          text.slice((chunk - 1) * CHUNK_CHARS, chunk * CHUNK_CHARS),
          chunk < chunks
            ? `More to read: call hyper_fetch with chunk ${chunk + 1}, and keep going to chunk ${chunks} before the breakdown.`
            : "End of article.",
        ].join("\n"),
      );
    },
  });
}
