// RSS 2.0 and Atom, one parser. Conditional GET with etag and last-modified.
import { XMLParser } from "fast-xml-parser";
import { stripHtml } from "../http.ts";
import type { FeedEntry, Fetcher } from "./types.ts";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  processEntities: true,
  htmlEntities: true,
});

const list = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];
const text = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "object" && "#text" in (value as object))
    return String((value as { "#text": unknown })["#text"]);
  return undefined;
};
const iso = (value: unknown): string | undefined => {
  const t = text(value);
  if (!t) return undefined;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
};

function mediaUrl(node: any): string | undefined {
  for (const key of ["media:thumbnail", "media:content", "enclosure", "itunes:image"]) {
    for (const m of list(node?.[key])) {
      const url = m?.["@_url"] ?? m?.["@_href"];
      const type = m?.["@_type"] ?? "image";
      if (url && /image|jpe?g|png|webp|gif/i.test(`${type} ${url}`)) return url;
    }
  }
  const html =
    text(node?.["content:encoded"]) ?? text(node?.description) ?? text(node?.content) ?? "";
  return html.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1];
}

export function parseFeed(xml: string, base?: string): FeedEntry[] {
  const doc = parser.parse(xml);
  if (doc?.rss?.channel || doc?.["rdf:RDF"]) {
    const items = list(doc.rss?.channel?.item ?? doc["rdf:RDF"]?.item);
    return items
      .map((item: any): FeedEntry | undefined => {
        const url = text(item.link) ?? text(item.guid);
        const title = stripHtml(text(item.title), 300);
        if (!url || !title) return undefined;
        const body = text(item["content:encoded"]) ?? text(item.description);
        return {
          url: new URL(url.trim(), base).toString(),
          title,
          excerpt: stripHtml(body, 600),
          contentMd: stripHtml(body, 8000),
          publishedAt: iso(item.pubDate ?? item["dc:date"]),
          author: text(item["dc:creator"]) ?? text(item.author),
          imageUrl: mediaUrl(item),
          discussionUrl: text(item.comments),
        };
      })
      .filter((e): e is FeedEntry => !!e);
  }
  if (doc?.feed) {
    return list(doc.feed.entry)
      .map((entry: any): FeedEntry | undefined => {
        const links = list(entry.link);
        const href =
          links.find((l: any) => !l?.["@_rel"] || l["@_rel"] === "alternate")?.["@_href"] ??
          links[0]?.["@_href"];
        const title = stripHtml(text(entry.title), 300);
        if (!href || !title) return undefined;
        const body = text(entry.content) ?? text(entry.summary);
        return {
          url: new URL(href, base).toString(),
          title,
          excerpt: stripHtml(body, 600),
          contentMd: stripHtml(body, 8000),
          publishedAt: iso(entry.published ?? entry.updated),
          author: text(list(entry.author)[0]?.name),
          imageUrl: mediaUrl(entry),
        };
      })
      .filter((e): e is FeedEntry => !!e);
  }
  throw new Error("Not an RSS or Atom document");
}

export const fetchFeed: Fetcher = async (source, ctx) => {
  const headers: Record<string, string> = {
    accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5",
  };
  if (ctx.validators?.etag) headers["if-none-match"] = ctx.validators.etag;
  if (ctx.validators?.lastModified) headers["if-modified-since"] = ctx.validators.lastModified;
  const res = await ctx.http.get(source.url, { headers, allowStatus: [304] });
  if (res.status === 304)
    return { ok: true, status: "304 not modified", entries: [], notModified: true };
  const entries = parseFeed(res.text, source.url)
    .map((entry) => ({ ...entry, captureIds: res.captureId ? [res.captureId] : undefined }))
    .filter((e) => !e.publishedAt || Date.parse(e.publishedAt) >= ctx.since.getTime());
  return {
    ok: true,
    status: `200 ${entries.length} entries`,
    entries,
    etag: res.headers.get("etag") ?? undefined,
    lastModified: res.headers.get("last-modified") ?? undefined,
  };
};
