// The text of an item's page, for jev: the cached body when there is one, else one plain http fetch (free) through
// Readability. A feed gives a sentence or two; judging Facts needs what the page actually says.
import type { Logger } from "@dna/sdk/node";
import type { Item } from "../db/repos/news.ts";
import type { Store } from "../db/store.ts";
import { extractArticle } from "./extract.ts";
import type { Http } from "./http.ts";

export async function pageRead(
  deps: { http: Http; store: Store; log?: Logger },
  item: Pick<Item, "id" | "url" | "title" | "excerpt" | "cacheId" | "sweepId">,
  max = 2400,
): Promise<{ text: string; sourceExtractionIds: number[] } | undefined> {
  const { value } = await deps.store.archive.capture(
    {
      kind: "article",
      trackId: deps.store.trackId,
      sweepId: item.sweepId,
      extractor: "readability/v1",
      config: { storedMaxChars: 12000, returnedMaxChars: max },
    },
    deps.http,
    (http) => pageTextBody({ ...deps, http }, item, max),
  );
  if (value)
    deps.store.evidence.record(
      deps.store.trackId,
      "read:page",
      { text: value.text },
      { itemId: item.id, url: item.url, sourceExtractionIds: value.sourceExtractionIds },
    );
  return value;
}

async function pageTextBody(
  deps: { http: Http; store: Store; log?: Logger },
  item: Pick<Item, "id" | "url" | "title" | "excerpt" | "cacheId" | "sweepId">,
  max: number,
): Promise<{ text: string; sourceExtractionIds: number[] } | undefined> {
  const cached = item.cacheId
    ? deps.store.sources.cachedById(item.cacheId)
    : deps.store.sources.cached(item.url);
  if ((cached?.contentMd?.length ?? 0) > 500)
    return {
      text: cached!.contentMd!.slice(0, max),
      sourceExtractionIds: cached?.archiveExtractionId ? [cached.archiveExtractionId] : [],
    };
  try {
    const res = await deps.http.get(item.url, {
      headers: { accept: "text/html,application/xhtml+xml" },
      timeoutMs: 12_000,
    });
    const article = extractArticle(res.text, res.url || item.url, 12_000);
    if (article.text.length < 200) return undefined;
    const input = {
      url: item.url,
      title: article.title ?? item.title,
      excerpt: article.excerpt ?? item.excerpt,
      contentMd: article.text,
      imageUrl: article.imageUrl,
      publishedAt: article.publishedAt,
      author: article.byline,
      fetchVia: "http",
      ttlMinutes: 24 * 60,
    };
    deps.store.sources.cache(input);
    const extraction = deps.store.archive.extraction(input);
    return { text: article.text.slice(0, max), sourceExtractionIds: [extraction] };
  } catch (error) {
    deps.log?.warn("page.fetch_failed", { itemId: item.id, error: String(error).slice(0, 200) });
    return undefined;
  }
}

export async function pageText(
  deps: Parameters<typeof pageRead>[0],
  item: Parameters<typeof pageRead>[1],
  max = 2400,
): Promise<string | undefined> {
  return (await pageRead(deps, item, max))?.text;
}
