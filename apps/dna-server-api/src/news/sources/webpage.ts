// A listing page without a feed (for example anthropic.com/news): article links on the same host.
import { parseHTML } from "linkedom";
import type { FeedEntry, Fetcher } from "./types.ts";

export function listingLinks(html: string, pageUrl: string, limit = 30): FeedEntry[] {
  const { document } = parseHTML(html);
  const page = new URL(pageUrl);
  const prefix = page.pathname.replace(/\/+$/, "");
  const seen = new Set<string>();
  const out: FeedEntry[] = [];
  for (const a of [...document.querySelectorAll("a[href]")] as any[]) {
    let url: URL;
    try {
      url = new URL(a.getAttribute("href"), page);
    } catch {
      continue;
    }
    if (
      url.host !== page.host ||
      !url.pathname.startsWith(`${prefix}/`) ||
      url.pathname.replace(/\/+$/, "") === prefix
    )
      continue;
    const title = String(a.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim();
    url.hash = "";
    const key = url.toString();
    if (title.length < 12 || seen.has(key)) continue;
    seen.add(key);
    out.push({ url: key, title: title.slice(0, 300) });
    if (out.length >= limit) break;
  }
  return out;
}

export const fetchWebPage: Fetcher = async (source, ctx) => {
  const res = await ctx.http.get(source.url, { headers: { accept: "text/html" } });
  const entries = listingLinks(res.text, source.url).map((entry) => ({
    ...entry,
    captureIds: res.captureId ? [res.captureId] : undefined,
  }));
  return { ok: true, status: `200 ${entries.length} links`, entries };
};
