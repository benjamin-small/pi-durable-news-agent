// GitHub releases through the public Atom feed. Titles get the repo name so a bare tag reads well.
import { parseFeed } from "./rss.ts";
import type { Fetcher } from "./types.ts";

export const fetchGithubReleases: Fetcher = async (source, ctx) => {
  const headers: Record<string, string> = {};
  if (ctx.validators?.etag) headers["if-none-match"] = ctx.validators.etag;
  const res = await ctx.http.get(source.url, { headers, allowStatus: [304] });
  if (res.status === 304)
    return { ok: true, status: "304 not modified", entries: [], notModified: true };
  const repo = source.url.match(/github\.com\/([^/]+\/[^/]+)/)?.[1] ?? source.name;
  const entries = parseFeed(res.text, source.url)
    .filter((e) => !e.publishedAt || Date.parse(e.publishedAt) >= ctx.since.getTime())
    .map((e) => ({
      ...e,
      captureIds: res.captureId ? [res.captureId] : undefined,
      title: e.title.toLowerCase().includes(repo.split("/")[1].toLowerCase())
        ? e.title
        : `${repo} ${e.title}`,
    }));
  return {
    ok: true,
    status: `200 ${entries.length} releases`,
    entries,
    etag: res.headers.get("etag") ?? undefined,
  };
};
