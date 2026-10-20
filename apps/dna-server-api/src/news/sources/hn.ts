// Hacker News through the free Algolia API: the front page, and keyword search over the last day.
import type { FeedEntry, Fetcher } from "./types.ts";

export const HN_API = "https://hn.algolia.com/api/v1";

interface Hit {
  objectID: string;
  title?: string;
  story_title?: string;
  url?: string | null;
  points?: number;
  num_comments?: number;
  created_at?: string;
  author?: string;
  story_text?: string | null;
}

export function hitToEntry(hit: Hit): FeedEntry | undefined {
  const title = hit.title ?? hit.story_title;
  if (!title) return undefined;
  const discussionUrl = `https://news.ycombinator.com/item?id=${hit.objectID}`;
  return {
    url: hit.url || discussionUrl,
    title,
    excerpt: hit.story_text ? hit.story_text.replace(/<[^>]+>/g, " ").slice(0, 600) : undefined,
    publishedAt: hit.created_at,
    author: hit.author,
    discussionUrl,
    points: hit.points,
    comments: hit.num_comments,
  };
}

const entries = (body: string) =>
  ((JSON.parse(body) as { hits: Hit[] }).hits ?? [])
    .map(hitToEntry)
    .filter((e): e is FeedEntry => !!e);

export const fetchHnFront: Fetcher = async (_source, ctx) => {
  const res = await ctx.http.get(`${HN_API}/search?tags=front_page&hitsPerPage=50`);
  const out = entries(res.text).map((entry) => ({
    ...entry,
    captureIds: res.captureId ? [res.captureId] : undefined,
  }));
  return { ok: true, status: `200 ${out.length} stories`, entries: out };
};

export const fetchHnSearch: Fetcher = async (_source, ctx) => {
  // New stories from the last week, newest first, before they collect many points.
  const since = Math.floor(Math.max(ctx.since.getTime(), Date.now() - 7 * 86_400_000) / 1000);
  const out: FeedEntry[] = [];
  for (const query of ctx.queries ?? []) {
    const url = `${HN_API}/search_by_date?query=${encodeURIComponent(query)}&tags=story&numericFilters=${encodeURIComponent(`created_at_i>${since},points>2`)}&hitsPerPage=20`;
    const res = await ctx.http.get(url);
    out.push(
      ...entries(res.text).map((entry) => ({
        ...entry,
        captureIds: res.captureId ? [res.captureId] : undefined,
      })),
    );
  }
  return {
    ok: true,
    status: `200 ${out.length} stories for ${ctx.queries?.length ?? 0} queries`,
    entries: out,
  };
};
