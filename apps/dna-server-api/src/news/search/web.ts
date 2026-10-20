// Search with no paid API, as chains of free engines with a cooldown per engine. News: Bing News RSS, then Google News
// RSS when Bing fails or finds nothing, with Hacker News search (Algolia) beside them and matches in the cached feeds.
// Web (deep research): Bing web RSS, then DuckDuckGo's HTML results. Pages are read by fetching their URLs directly.
import type { SearchEngineHealth } from "@dna/sdk";
import type { Logger } from "@dna/sdk/node";
import { XMLParser } from "fast-xml-parser";
import type { Store } from "../../db/store.ts";
import { decodeEntities, stripHtml, type Http } from "../http.ts";
import { HN_API, hitToEntry } from "../sources/hn.ts";
import { parseFeed } from "../sources/rss.ts";
import { hostOf, type SearchHit } from "./index.ts";

export const BING_NEWS = "https://www.bing.com/news/search";
export const BING_WEB = "https://www.bing.com/search";
export const GOOGLE_NEWS = "https://news.google.com/rss/search";
export const DUCKDUCKGO = "https://html.duckduckgo.com/html/";
const GOOGLE_DECODE = "https://news.google.com/_/DotsSplashUi/data/batchexecute";
/** Google News hits per search: each new-style link costs two requests to resolve. */
const GOOGLE_MAX_HITS = 10;

export type Engine = "firecrawl" | FreeEngine;
export type FreeEngine = "bing-news" | "google-news" | "hn" | "bing-web" | "duckduckgo";
/** News engines in order: the first that answers with hits ends the chain. */
export const NEWS_CHAIN: FreeEngine[] = ["bing-news", "google-news"];
/** Whole-web engines for deep research, in order. */
export const WEB_CHAIN: FreeEngine[] = ["bing-web", "duckduckgo"];

/** An engine that failed rests 2 minutes, doubling with each failure in a row, up to 30 minutes. */
const COOLDOWN_MS = 2 * 60_000;
const MAX_COOLDOWN_MS = 30 * 60_000;
/** A rate limit or a block is the engine's answer for now: cool down instead of retrying. */
export const NO_RETRY = [403, 429];

/** Per engine: answers, failures and the cooldown after a failure. Lives as long as the process. */
export class EngineHealth {
  private readonly engines = new Map<Engine, SearchEngineHealth>();
  constructor(
    engines: Engine[],
    private readonly now = () => Date.now(),
  ) {
    for (const name of engines) this.state(name);
  }

  private state(name: Engine): SearchEngineHealth {
    let s = this.engines.get(name);
    if (!s) this.engines.set(name, (s = { name, ok: 0, failed: 0, streak: 0 }));
    return s;
  }

  cooling(name: Engine): boolean {
    const until = this.engines.get(name)?.coolingUntil;
    return !!until && Date.parse(until) > this.now();
  }

  ok(name: Engine): void {
    const s = this.state(name);
    s.ok++;
    s.streak = 0;
    s.lastOkAt = new Date(this.now()).toISOString();
    s.coolingUntil = undefined;
  }

  fail(name: Engine, error: unknown): void {
    const s = this.state(name);
    s.failed++;
    s.streak++;
    s.lastError = shortError(error);
    s.lastErrorAt = new Date(this.now()).toISOString();
    const rest = Math.min(MAX_COOLDOWN_MS, COOLDOWN_MS * 2 ** (s.streak - 1));
    s.coolingUntil = new Date(this.now() + rest).toISOString();
  }

  list(): SearchEngineHealth[] {
    return [...this.engines.values()].map((s) => ({ ...s }));
  }
}

const shortError = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 160);

/** Which engines answered, failed or were resting for one search. */
export interface SearchReport {
  answered: { engine: Engine | "cache"; hits: number }[];
  failed: { engine: Engine; error: string }[];
  cooling: Engine[];
}

export const newReport = (): SearchReport => ({ answered: [], failed: [], cooling: [] });

/** One line for tool results and logs: "bing-news 10, hn 3, cache 2; failed google-news (HTTP 503); resting duckduckgo". */
export function describeReport(r: SearchReport): string {
  const parts = [r.answered.map((a) => `${a.engine} ${a.hits}`).join(", ") || "no engine answered"];
  if (r.failed.length)
    parts.push(`failed ${r.failed.map((f) => `${f.engine} (${f.error})`).join(", ")}`);
  if (r.cooling.length) parts.push(`resting ${r.cooling.join(", ")}`);
  return parts.join("; ");
}

/** A captcha, consent or block page comes back as HTML where a feed was asked for. */
function feedText(engine: Engine, text: string): string {
  if (/^\s*(<!doctype html|<html)/i.test(text))
    throw new Error(`${engine} returned HTML, not RSS (a captcha, consent or block page)`);
  return text;
}

const get = (http: Http, url: string, accept: string) =>
  http.get(url, { headers: { accept }, noRetryOn: NO_RETRY });
const RSS = "application/rss+xml, text/xml";

/** Bing News links go through apiclick.aspx; the article URL is its url parameter. */
export function unwrapBing(url: string): string {
  try {
    const u = new URL(url);
    const inner = u.hostname.endsWith("bing.com") ? u.searchParams.get("url") : null;
    return inner && /^https?:\/\//.test(inner) ? inner : url;
  } catch {
    return url;
  }
}

/** Bing News' date filter: a day, a week or a month. Wider windows (or none) search every date. */
function bingInterval(hours?: number): string | undefined {
  if (hours === undefined) return undefined;
  if (hours <= 24) return 'interval="7"';
  if (hours <= 168) return 'interval="8"';
  if (hours <= 720) return 'interval="9"';
  return undefined;
}

/** Newest first. `hours` keeps results published in that window; without it, any date. Words, not a phrase. */
export async function bingNews(
  http: Http,
  query: string,
  hours: number | undefined,
  limit: number,
): Promise<SearchHit[]> {
  const interval = bingInterval(hours);
  const url = `${BING_NEWS}?q=${encodeURIComponent(query.trim())}&format=rss&sortby=date${interval ? `&qft=${encodeURIComponent(interval)}` : ""}`;
  const res = await get(http, url, RSS);
  return parseFeed(feedText("bing-news", res.text))
    .slice(0, limit)
    .map((e) => {
      const target = unwrapBing(e.url);
      return {
        url: target,
        ...(res.captureId ? { captureIds: [res.captureId] } : {}),
        title: e.title,
        excerpt: e.excerpt,
        publishedAt: e.publishedAt,
        imageUrl: e.imageUrl,
        sourceName: hostOf(target),
      };
    });
}

/**
 * Google News links wrap the article: news.google.com/rss/articles/<id>. Older ids are base64 with the article URL
 * inside; newer ones are opaque (see resolveGoogle).
 */
export function unwrapGoogle(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname !== "news.google.com") return url;
    const id = u.pathname.match(/\/articles\/([^/?]+)/)?.[1];
    if (!id) return url;
    const bytes = Buffer.from(id.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
      "latin1",
    );
    return bytes.match(/https?:\/\/[\x21-\x7e]+/)?.[0] ?? url;
  } catch {
    return url;
  }
}

/**
 * An opaque Google News id resolves through the article page's signature and Google's own decode call: two
 * requests. Any failure keeps the Google link, which still redirects in a browser.
 */
export async function resolveGoogle(http: Http, url: string, captures?: number[]): Promise<string> {
  const id = url.match(/news\.google\.com\/rss\/articles\/([^/?]+)/)?.[1];
  if (!id || !http.postForm) return url;
  try {
    const page = await http.get(`https://news.google.com/rss/articles/${id}`, {
      headers: { accept: "text/html" },
      noRetryOn: NO_RETRY,
    });
    if (page.captureId) captures?.push(page.captureId);
    const sg = page.text.match(/data-n-a-sg="([^"]+)"/)?.[1];
    const ts = page.text.match(/data-n-a-ts="([^"]+)"/)?.[1];
    if (!sg || !ts) return url;
    const inner = JSON.stringify([
      "garturlreq",
      [
        [
          "X",
          "X",
          ["X", "X"],
          null,
          null,
          1,
          1,
          "US:en",
          null,
          1,
          null,
          null,
          null,
          null,
          null,
          0,
          1,
        ],
        "X",
        "X",
        1,
        [1, 1, 1],
        1,
        1,
        null,
        0,
        0,
        null,
        0,
      ],
      id,
      Number(ts),
      sg,
    ]);
    const res = await http.postForm(
      GOOGLE_DECODE,
      `f.req=${encodeURIComponent(JSON.stringify([[["Fbv4je", inner, null, "generic"]]]))}`,
      { noRetryOn: NO_RETRY },
    );
    if (res.captureId) captures?.push(res.captureId);
    const target = res.text.match(/garturlres\\",\\"(https?:[^"\\]+)/)?.[1];
    return target ?? url;
  } catch {
    return url;
  }
}

/** Google News' window: hours under a day, otherwise days. */
const googleWhen = (hours?: number) =>
  hours === undefined ? "" : hours < 24 ? ` when:${hours}h` : ` when:${Math.ceil(hours / 24)}d`;

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  processEntities: true,
  htmlEntities: true,
});
const textOf = (v: unknown): string | undefined =>
  typeof v === "string" || typeof v === "number"
    ? String(v)
    : v && typeof v === "object" && "#text" in v
      ? String((v as { "#text": unknown })["#text"])
      : undefined;

/**
 * Newest first, at most 10, each link resolved to its article. Titles end in " - Publisher": that part becomes the
 * source name.
 */
export async function googleNews(
  http: Http,
  query: string,
  hours: number | undefined,
  limit: number,
): Promise<SearchHit[]> {
  const url = `${GOOGLE_NEWS}?q=${encodeURIComponent(query.trim() + googleWhen(hours))}&hl=en-US&gl=US&ceid=US:en`;
  const res = await get(http, url, RSS);
  const doc = xml.parse(feedText("google-news", res.text));
  if (!doc?.rss?.channel) throw new Error("google-news returned no RSS channel");
  const items = [doc.rss.channel.item ?? []].flat() as Record<string, unknown>[];
  const hits = items.flatMap((item): SearchHit[] => {
    const link = textOf(item.link);
    const publisher = textOf(item.source);
    let title = stripHtml(textOf(item.title), 300);
    if (!link || !title) return [];
    if (publisher && title.endsWith(` - ${publisher}`))
      title = title.slice(0, -publisher.length - 3);
    const target = unwrapGoogle(link);
    const date = Date.parse(textOf(item.pubDate) ?? "");
    return [
      {
        url: target,
        ...(res.captureId ? { captureIds: [res.captureId] } : {}),
        title,
        publishedAt: Number.isFinite(date) ? new Date(date).toISOString() : undefined,
        sourceName: publisher ?? hostOf(target),
      },
    ];
  });
  const at = (h: SearchHit) => (h.publishedAt ? Date.parse(h.publishedAt) : 0);
  const newest = hits.sort((a, b) => at(b) - at(a)).slice(0, Math.min(limit, GOOGLE_MAX_HITS));
  // Four at a time, so one search never fires twenty requests at Google at once.
  for (let i = 0; i < newest.length; i += 4)
    await Promise.all(
      newest.slice(i, i + 4).map(async (h) => {
        h.url = await resolveGoogle(http, h.url, h.captureIds);
        if (!h.url.includes("news.google.com")) h.sourceName ??= hostOf(h.url);
      }),
    );
  return newest;
}

/** Bing web search as RSS, best match first: company sites, docs and reports that a news search misses. */
export async function bingWeb(
  http: Http,
  query: string,
  _hours: number | undefined,
  limit: number,
): Promise<SearchHit[]> {
  const url = `${BING_WEB}?q=${encodeURIComponent(query.trim())}&format=rss&count=${limit}`;
  const res = await get(http, url, RSS);
  return parseFeed(feedText("bing-web", res.text))
    .slice(0, limit)
    .map((e) => ({
      url: e.url,
      ...(res.captureId ? { captureIds: [res.captureId] } : {}),
      title: e.title,
      excerpt: e.excerpt,
      publishedAt: e.publishedAt,
      sourceName: hostOf(e.url),
    }));
}

/** DuckDuckGo's links go through duckduckgo.com/l/; the article URL is its uddg parameter. */
export function unwrapDuckDuckGo(href: string): string {
  try {
    const u = new URL(decodeEntities(href), "https://duckduckgo.com");
    const inner = u.hostname.endsWith("duckduckgo.com") ? u.searchParams.get("uddg") : null;
    return inner && /^https?:\/\//.test(inner) ? inner : u.toString();
  } catch {
    return href;
  }
}

/** DuckDuckGo's HTML results, best match first. Ads are skipped. A page with no result list is a bot check. */
export async function duckDuckGo(
  http: Http,
  query: string,
  _hours: number | undefined,
  limit: number,
): Promise<SearchHit[]> {
  const res = await get(
    http,
    `${DUCKDUCKGO}?q=${encodeURIComponent(query.trim())}`,
    "text/html,application/xhtml+xml",
  );
  const blocks = res.text.split(/<div\b[^>]*class="result(?=[\s"])/).slice(1);
  if (!blocks.length && !/class="no-results"/.test(res.text))
    throw new Error("duckduckgo returned no result list (a bot check)");
  // DuckDuckGo bolds the query words inline: drop those tags without adding a space.
  const bold = (html?: string) => html?.replace(/<\/?b>/g, "");
  return blocks
    .filter((b) => !/^[^>]*result--ad/.test(b))
    .flatMap((b): SearchHit[] => {
      const a = b.match(/<a\b([^>]*class="result__a"[^>]*)>([\s\S]*?)<\/a\s*>/);
      const href = a?.[1].match(/href="([^"]+)"/)?.[1];
      if (!a || !href) return [];
      const url = unwrapDuckDuckGo(href);
      const title = stripHtml(bold(a[2]), 300);
      if (!title || !/^https?:\/\//.test(url)) return [];
      const snippet = b.match(
        /<(a|div)\b[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/\1\s*>/,
      )?.[2];
      return [
        {
          url,
          title,
          excerpt: stripHtml(bold(snippet), 600),
          sourceName: hostOf(url),
          ...(res.captureId ? { captureIds: [res.captureId] } : {}),
        },
      ];
    })
    .slice(0, limit);
}

async function hnSearch(
  http: Http,
  query: string,
  hours: number | undefined,
  limit: number,
): Promise<SearchHit[]> {
  const window =
    hours === undefined
      ? ""
      : `&numericFilters=${encodeURIComponent(`created_at_i>${Math.floor((Date.now() - hours * 3_600_000) / 1000)}`)}`;
  // A window means news: newest first. Without one, the best matches of any date.
  const url = `${HN_API}/${hours === undefined ? "search" : "search_by_date"}?query=${encodeURIComponent(query)}&tags=story${window}&hitsPerPage=${limit}`;
  const res = await get(http, url, "application/json");
  const body = JSON.parse(res.text) as { hits: unknown[] };
  return (body.hits ?? []).flatMap((hit) => {
    const e = hitToEntry(hit as never);
    return e
      ? [
          {
            url: e.url,
            title: e.title,
            excerpt: e.excerpt,
            publishedAt: e.publishedAt,
            sourceName: "Hacker News",
            ...(res.captureId ? { captureIds: [res.captureId] } : {}),
          },
        ]
      : [];
  });
}

type EngineFn = (
  http: Http,
  query: string,
  hours: number | undefined,
  limit: number,
) => Promise<SearchHit[]>;

const ENGINES: Record<FreeEngine, EngineFn> = {
  "bing-news": bingNews,
  "google-news": googleNews,
  hn: hnSearch,
  "bing-web": bingWeb,
  duckduckgo: duckDuckGo,
};

export interface WebDeps {
  http: Http;
  store: Store;
  health: EngineHealth;
  log?: Logger;
}

/** Try each engine in order: skip resting ones, record failures, stop at the first that answers with hits. */
export async function runChain(
  deps: WebDeps,
  chain: FreeEngine[],
  query: string,
  hours: number | undefined,
  limit: number,
  report: SearchReport,
): Promise<SearchHit[]> {
  for (const engine of chain) {
    if (deps.health.cooling(engine)) {
      report.cooling.push(engine);
      continue;
    }
    try {
      const hits = await ENGINES[engine](deps.http, query, hours, limit);
      deps.health.ok(engine);
      report.answered.push({ engine, hits: hits.length });
      if (hits.length) return hits;
    } catch (error) {
      deps.health.fail(engine, error);
      report.failed.push({ engine, error: shortError(error) });
      deps.log?.warn("web.search_failed", { engine, query, error: String(error) });
    }
  }
  return [];
}

/** Merged in chain order, deduped by url, kept to the window. */
export function mergeHits(lists: SearchHit[][], hours?: number): SearchHit[] {
  const cutoff = hours === undefined ? 0 : Date.now() - hours * 3_600_000;
  const out = new Map<string, SearchHit>();
  for (const h of lists.flat())
    if (!out.has(h.url) && (!h.publishedAt || Date.parse(h.publishedAt) >= cutoff))
      out.set(h.url, h);
  return [...out.values()];
}

/** News search: the news chain and Hacker News at once, then matches in the cached feeds. Newest first. */
export async function webSearch(
  deps: WebDeps,
  query: string,
  hours: number | undefined,
  limit: number,
  report: SearchReport = newReport(),
): Promise<{ hits: SearchHit[]; report: SearchReport }> {
  const [news, hn] = await Promise.all([
    runChain(deps, NEWS_CHAIN, query, hours, limit, report),
    runChain(deps, ["hn"], query, hours, limit, report),
  ]);
  const cutoff = hours === undefined ? 0 : Date.now() - hours * 3_600_000;
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2);
  const cached = deps.store.sources
    .searchCache(
      terms.length ? [query.toLowerCase(), ...terms.slice(0, 3)] : [],
      new Date(cutoff).toISOString(),
      limit,
    )
    .map((doc) => ({
      url: doc.url,
      title: doc.title ?? doc.url,
      excerpt: doc.excerpt,
      publishedAt: doc.publishedAt,
      imageUrl: doc.imageUrl,
      sourceName: hostOf(doc.url),
      captureIds: deps.store.archive.inputsForExtraction(doc.archiveExtractionId),
    }));
  if (cached.length) report.answered.push({ engine: "cache", hits: cached.length });
  // Newest first: new information always beats old.
  const at = (h: SearchHit) => (h.publishedAt ? Date.parse(h.publishedAt) : 0);
  const hits = mergeHits([news, hn, cached], hours).sort((a, b) => at(b) - at(a));
  deps.log?.info("web.search", { query, results: hits.length, engines: describeReport(report) });
  return { hits: hits.slice(0, limit), report };
}
