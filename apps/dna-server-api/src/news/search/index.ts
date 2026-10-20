// Search and scrape for sweeps and agents. The default web mode is free: a chain of free engines (Bing News, then
// Google News, with Hacker News and cached feed matches beside them; see web.ts) and direct fetches with Readability.
// Firecrawl is opt in (DNA_SEARCH_MODE=firecrawl) and budgeted, and it falls back to the free chain on any failure.
import type { SearchEngineHealth } from "@dna/sdk";
import type { Logger } from "@dna/sdk/node";
import type { CachedDoc } from "../../db/repos/sources.ts";
import type { Store } from "../../db/store.ts";
import { extractArticle, htmlLinks, markdownLinks, type PageLink } from "../extract.ts";
import type { Http } from "../http.ts";
import {
  describeReport,
  EngineHealth,
  mergeHits,
  newReport,
  runChain,
  WEB_CHAIN,
  webSearch,
  type Engine,
} from "./web.ts";
import { FirecrawlClient } from "./firecrawl.ts";
import type { CaptureContext } from "../../archive/archive.ts";

/** web: free search and direct URLs (the default). firecrawl: opt in with DNA_SEARCH_MODE=firecrawl. */
export type SearchMode = "firecrawl" | "web" | "fixture";

export interface CallRef {
  trackId?: string;
  sweepId?: number;
  conversationId?: number;
  callId?: string;
}

export interface SearchResult {
  hits: SearchHit[];
  via: "firecrawl" | "web";
  /** For web: which engines answered, failed or were resting. */
  engines?: string;
  credits: number;
}

export interface SearchHit {
  captureIds?: number[];
  url: string;
  title: string;
  excerpt?: string;
  publishedAt?: string;
  imageUrl?: string;
  sourceName?: string;
}

export const SEARCH_MODES = ["auto", "web", "fallback", "firecrawl", "fixture"] as const;

export interface SearchOptions {
  /** auto and fallback mean web. Anything else is reported by modeWarning and searches the web. */
  mode: string;
  firecrawlKey?: string;
  sweepCap: number;
  dailyCap: number;
}

export interface Budget {
  sweepUsed: number;
  dailyUsed: number;
  sweepCap: number;
  dailyCap: number;
  /** Credits still allowed for this sweep and day. */
  available: number;
}

/** firecrawl needs a key; every other mode but fixture, known or not, is the free web. */
export function resolveMode(mode: string, key?: string): SearchMode {
  if (mode === "fixture") return "fixture";
  if (mode === "firecrawl" && key) return "firecrawl";
  return "web";
}

/** What is wrong with DNA_SEARCH_MODE, if anything: an unknown value, or firecrawl without a key. */
export function modeWarning(mode: string, key?: string): string | undefined {
  if (!(SEARCH_MODES as readonly string[]).includes(mode))
    return `DNA_SEARCH_MODE=${mode} is not one of ${SEARCH_MODES.join(", ")}: searching the free web.`;
  if (mode === "firecrawl" && !key)
    return "DNA_SEARCH_MODE=firecrawl needs FIRECRAWL_API_KEY: searching the free web.";
  return undefined;
}

/** What one call costs: a web plus news search reports 4 credits, a scrape 1. */
export const SEARCH_CREDITS = 4;
export const SCRAPE_CREDITS = 1;

/** Firecrawl's date filter: a day, a week, a month or a year; none means any date. */
function firecrawlWindow(hours?: number): string | undefined {
  if (hours === undefined) return undefined;
  if (hours <= 24) return "qdr:d";
  if (hours <= 168) return "qdr:w";
  if (hours <= 720) return "qdr:m";
  if (hours <= 8760) return "qdr:y";
  return undefined;
}

export class SearchService {
  readonly mode: SearchMode;
  private readonly pending = { daily: 0, bySweep: new Map<number, number>() };
  private readonly firecrawl?: FirecrawlClient;
  /** Firecrawl for hyper_fetch and deep research: on whenever FIRECRAWL_API_KEY is set, in any search mode. */
  private readonly hyper?: FirecrawlClient;
  private readonly health: EngineHealth;

  constructor(
    private readonly deps: { http: Http; store: Store; log?: Logger },
    private readonly options: SearchOptions,
  ) {
    this.deps = { ...deps, http: deps.store.archive.transport(deps.http) };
    deps = this.deps;
    this.mode = resolveMode(options.mode, options.firecrawlKey);
    const warning = modeWarning(options.mode, options.firecrawlKey);
    if (warning) deps.log?.warn("search.mode", { warning, mode: this.mode });
    if (this.mode === "fixture") this.firecrawl = new FirecrawlClient(deps.http, "fixture");
    else if (this.mode === "firecrawl" && options.firecrawlKey)
      this.firecrawl = new FirecrawlClient(deps.http, options.firecrawlKey);
    if (options.firecrawlKey)
      this.hyper = this.firecrawl ?? new FirecrawlClient(deps.http, options.firecrawlKey);
    const engines: Engine[] = ["bing-news", "google-news", "hn", "bing-web", "duckduckgo"];
    this.health = new EngineHealth(
      this.firecrawl || this.hyper ? ["firecrawl", ...engines] : engines,
    );
  }

  /** Firecrawl scrapes hyper_fetch pages when FIRECRAWL_API_KEY is set; without it they are fetched directly. */
  get hyperFetchVia(): "firecrawl" | "http" {
    return this.hyper ? "firecrawl" : "http";
  }

  /** Every engine since the API started, for /v1/info and dna doctor. */
  engineHealth(): SearchEngineHealth[] {
    return this.health.list();
  }

  private get web() {
    return { ...this.deps, health: this.health };
  }

  budget(sweepId?: number): Budget {
    const t = this.deps.store.telemetry;
    const dailyUsed = t.creditsToday();
    const sweepUsed = sweepId ? t.creditsForSweep(sweepId) : 0;
    const available = Math.max(
      0,
      Math.min(this.options.sweepCap - sweepUsed, this.options.dailyCap - dailyUsed),
    );
    return {
      sweepUsed,
      dailyUsed,
      sweepCap: this.options.sweepCap,
      dailyCap: this.options.dailyCap,
      available,
    };
  }

  /**
   * Reserve credits before a call, so parallel calls (research subagents scrape at once) cannot all pass the same
   * check. Returns the release, or undefined when the sweep or daily cap would be crossed.
   */
  private reserve(call: CallRef, credits: number): (() => void) | undefined {
    if (!this.firecrawl) return undefined;
    const budget = this.budget(call.sweepId);
    const sweepPending = call.sweepId ? (this.pending.bySweep.get(call.sweepId) ?? 0) : 0;
    const available = Math.min(
      budget.sweepCap - budget.sweepUsed - sweepPending,
      budget.dailyCap - budget.dailyUsed - this.pending.daily,
    );
    if (available < credits) {
      this.deps.log?.warn("firecrawl.budget_exhausted", {
        ...call,
        ...budget,
        pending: this.pending.daily,
        wanted: credits,
      });
      return undefined;
    }
    const sweepId = call.sweepId;
    this.pending.daily += credits;
    if (sweepId) this.pending.bySweep.set(sweepId, sweepPending + credits);
    return () => {
      this.pending.daily -= credits;
      if (!sweepId) return;
      const left = (this.pending.bySweep.get(sweepId) ?? credits) - credits;
      if (left > 0) this.pending.bySweep.set(sweepId, left);
      else this.pending.bySweep.delete(sweepId);
    };
  }

  private context(kind: CaptureContext["kind"], call: CallRef): CaptureContext {
    const db = this.deps.store.db;
    const track =
      call.sweepId !== undefined
        ? db.prepare("SELECT track_id FROM sweeps WHERE id=?").get(call.sweepId)
        : call.conversationId !== undefined
          ? db
              .prepare(
                "SELECT track_id FROM agent_conversations WHERE conversation_id=? UNION SELECT id track_id FROM tracks WHERE conversation_id=? LIMIT 1",
              )
              .get(call.conversationId, call.conversationId)
          : undefined;
    return {
      kind,
      trackId:
        call.trackId ??
        (track as { track_id: string } | undefined)?.track_id ??
        (call.sweepId === undefined && call.conversationId === undefined
          ? this.deps.store.trackId
          : undefined),
      sweepId: call.sweepId,
      conversationId: call.conversationId,
      extractor: kind === "article" ? "readability-or-firecrawl/v1" : "search-results/v1",
      config:
        kind === "article"
          ? { directCacheMaxChars: 12000, providerCacheMaxChars: 40000, fullReadMaxChars: 200000 }
          : {},
    };
  }

  async search(
    query: string,
    call: CallRef = {},
    options: { limit?: number; hours?: number } = {},
  ): Promise<SearchResult> {
    const { value } = await this.deps.store.archive.capture(
      this.context("search", call),
      this.deps.http,
      () => this.searchBody(query, call, options),
    );
    return value;
  }

  async deepSearch(
    query: string,
    call: CallRef = {},
    options: { limit?: number; hours?: number } = {},
  ): Promise<SearchResult> {
    const { value } = await this.deps.store.archive.capture(
      this.context("search", call),
      this.deps.http,
      () => this.deepSearchBody(query, call, options),
    );
    return value;
  }

  async deepScrape(url: string, call: CallRef = {}) {
    return (
      await this.deps.store.archive.capture(
        this.context("article", call),
        this.deps.http,
        async () => {
          const value = await this.deepScrapeBody(url, call);
          const archiveExtractionId = this.deps.store.archive.extraction({
            url,
            title: value.title,
            contentMd: value.markdown,
            fetchVia: value.via,
            fullRead: true,
          });
          return { ...value, archiveExtractionId };
        },
      )
    ).value;
  }

  async scrape(url: string, call: CallRef = {}) {
    return (
      await this.deps.store.archive.capture(this.context("article", call), this.deps.http, () =>
        this.scrapeBody(url, call),
      )
    ).value;
  }

  async hyperFetch(url: string, call: CallRef = {}) {
    return (
      await this.deps.store.archive.capture(
        this.context("article", call),
        this.deps.http,
        async () => {
          const value = await this.hyperFetchBody(url, call);
          const archiveExtractionId = this.deps.store.archive.extraction({
            url,
            title: value.doc.title,
            contentMd: value.markdown,
            fetchVia: value.via,
            fullRead: true,
          });
          return { ...value, archiveExtractionId };
        },
      )
    ).value;
  }

  private async searchBody(
    query: string,
    call: CallRef = {},
    /** hours keeps results published in that window; leave it out to search any date. */
    options: { limit?: number; hours?: number } = {},
  ): Promise<SearchResult> {
    const limit = options.limit ?? 10;
    const release = this.health.cooling("firecrawl")
      ? undefined
      : this.reserve(call, SEARCH_CREDITS);
    if (release) {
      try {
        return await this.firecrawlSearch(this.firecrawl!, query, call, limit, options.hours);
      } catch {
        // Logged; fall through to the free web search.
      } finally {
        release();
      }
    }
    const { hits, report } = await webSearch(this.web, query, options.hours, limit);
    return { hits, via: "web", engines: describeReport(report), credits: 0 };
  }

  /**
   * Deep research search: the whole web, not only news. Firecrawl's web and news search when FIRECRAWL_API_KEY is set,
   * outside the sweep and daily caps like hyper_fetch; otherwise, or when Firecrawl fails, the web chain (Bing web,
   * then DuckDuckGo) plus the free news search. Best match first.
   */
  private async deepSearchBody(
    query: string,
    call: CallRef = {},
    options: { limit?: number; hours?: number } = {},
  ): Promise<SearchResult> {
    const limit = options.limit ?? 10;
    if (this.hyper && !this.health.cooling("firecrawl"))
      try {
        return await this.firecrawlSearch(this.hyper, query, call, limit, options.hours);
      } catch {
        // Logged; fall through to the free search.
      }
    const report = newReport();
    const [web, news] = await Promise.all([
      runChain(this.web, WEB_CHAIN, query, options.hours, limit, report),
      webSearch(this.web, query, options.hours, limit, report),
    ]);
    return {
      hits: mergeHits([web, news.hits], options.hours).slice(0, limit),
      via: "web",
      engines: describeReport(report),
      credits: 0,
    };
  }

  /**
   * Deep research read: one page in full with the links on it. Firecrawl when FIRECRAWL_API_KEY is set (outside the
   * caps), otherwise, or when Firecrawl fails, a direct fetch with Readability. Never cut to the cache's 40k.
   */
  private async deepScrapeBody(
    url: string,
    call: CallRef = {},
  ): Promise<{
    title?: string;
    markdown: string;
    links: PageLink[];
    via: "firecrawl" | "http";
    credits: number;
  }> {
    if (this.hyper && !this.health.cooling("firecrawl"))
      try {
        const page = await this.firecrawlScrape(
          this.hyper,
          url,
          call,
          this.deps.store.sources.cached(url),
        );
        return {
          title: page.doc.title,
          markdown: page.markdown,
          links: markdownLinks(page.markdown, url),
          via: "firecrawl",
          credits: page.credits,
        };
      } catch (error) {
        this.deps.log?.warn("firecrawl.deep_scrape_failed", { url, error: String(error), ...call });
      }
    const res = await this.deps.http.get(url, {
      headers: { accept: "text/html,application/xhtml+xml" },
    });
    const article = extractArticle(res.text, res.url, 200_000);
    return {
      title: article.title,
      markdown: article.text,
      links: htmlLinks(res.text, res.url),
      via: "http",
      credits: 0,
    };
  }

  /** Cache first; a fresh scraped body over 200 chars is never fetched again. */
  private async scrapeBody(
    url: string,
    call: CallRef = {},
  ): Promise<{ doc: CachedDoc; via: "cache" | "firecrawl" | "http"; credits: number }> {
    const cached = this.deps.store.sources.cached(url);
    if (
      cached &&
      (cached.contentMd?.length ?? 0) > 200 &&
      cached.fetchVia !== "feed" &&
      this.deps.store.sources.isFresh(cached)
    )
      return { doc: cached, via: "cache", credits: 0 };
    const release = this.reserve(call, SCRAPE_CREDITS);
    if (release) {
      try {
        const { doc, credits } = await this.firecrawlScrape(this.firecrawl!, url, call, cached);
        return { doc, via: "firecrawl", credits };
      } catch (error) {
        this.deps.log?.warn("firecrawl.scrape_failed", { url, error: String(error), ...call });
      } finally {
        release();
      }
    }
    const res = await this.deps.http.get(url, {
      headers: { accept: "text/html,application/xhtml+xml" },
    });
    const article = extractArticle(res.text, res.url);
    const doc = this.deps.store.sources.cache({
      url,
      title: article.title ?? cached?.title,
      excerpt: article.excerpt ?? cached?.excerpt,
      contentMd: article.text,
      imageUrl: article.imageUrl,
      publishedAt: article.publishedAt,
      author: article.byline,
      fetchVia: "http",
      ttlMinutes: 24 * 60,
    });
    return { doc, via: "http", credits: 0 };
  }

  /**
   * hyper_fetch: a fresh full-page read the reader asked for. Firecrawl when FIRECRAWL_API_KEY is set (outside the
   * sweep and daily caps); without a key, or when Firecrawl fails, a direct fetch with Readability. Full markdown.
   */
  private async hyperFetchBody(
    url: string,
    call: CallRef = {},
  ): Promise<{ doc: CachedDoc; markdown: string; via: "firecrawl" | "http"; credits: number }> {
    const cached = this.deps.store.sources.cached(url);
    if (this.hyper && !this.health.cooling("firecrawl"))
      try {
        const page = await this.firecrawlScrape(this.hyper, url, call, cached);
        this.deps.log?.info("firecrawl.hyper_fetch", { url, credits: page.credits, ...call });
        return { ...page, via: "firecrawl" };
      } catch (error) {
        this.deps.log?.warn("firecrawl.hyper_fetch_failed", { url, error: String(error), ...call });
      }
    const res = await this.deps.http.get(url, {
      headers: { accept: "text/html,application/xhtml+xml" },
    });
    const article = extractArticle(res.text, res.url, 200_000);
    const doc = this.deps.store.sources.cache({
      url,
      title: article.title ?? cached?.title,
      excerpt: article.excerpt ?? cached?.excerpt,
      contentMd: article.text.slice(0, 40_000),
      imageUrl: article.imageUrl,
      publishedAt: article.publishedAt,
      author: article.byline,
      fetchVia: "http",
      ttlMinutes: 24 * 60,
    });
    this.deps.log?.info("web.hyper_fetch", { url, chars: article.text.length, ...call });
    return { doc, markdown: article.text, via: "http", credits: 0 };
  }

  /** One Firecrawl search: logged with its credits. Throws on failure. */
  private async firecrawlSearch(
    client: FirecrawlClient,
    query: string,
    call: CallRef,
    limit: number,
    hours?: number,
  ): Promise<SearchResult> {
    const started = Date.now();
    try {
      const result = await client.search(query, { limit, tbs: firecrawlWindow(hours) });
      this.health.ok("firecrawl");
      this.deps.store.telemetry.firecrawl({
        endpoint: "search",
        query,
        status: "ok",
        results: result.hits.length,
        creditsUsed: result.credits,
        creditsSource: result.creditsSource,
        elapsedMs: Date.now() - started,
        ...call,
      });
      this.deps.log?.info("firecrawl.search", {
        query,
        results: result.hits.length,
        credits: result.credits,
        ...call,
      });
      return {
        hits: result.hits.map((h) => ({
          captureIds: h.captureIds,
          url: h.url,
          title: h.title,
          excerpt: h.description,
          publishedAt:
            h.date && Number.isFinite(Date.parse(h.date))
              ? new Date(h.date).toISOString()
              : undefined,
          imageUrl: h.imageUrl,
          sourceName: hostOf(h.url),
        })),
        via: "firecrawl",
        credits: result.credits,
      };
    } catch (error) {
      this.deps.store.telemetry.firecrawl({
        endpoint: "search",
        query,
        status: "error",
        error: String(error).slice(0, 500),
        elapsedMs: Date.now() - started,
        creditsUsed: 0,
        ...call,
      });
      this.deps.log?.warn("firecrawl.search_failed", { query, error: String(error), ...call });
      this.health.fail("firecrawl", error);
      throw error;
    }
  }

  /** One Firecrawl scrape: logged with its credits, cached for a day. Throws on failure. */
  private async firecrawlScrape(
    client: FirecrawlClient,
    url: string,
    call: CallRef,
    cached?: CachedDoc,
  ): Promise<{ doc: CachedDoc; markdown: string; credits: number }> {
    const started = Date.now();
    try {
      const page = await client.scrape(url);
      this.health.ok("firecrawl");
      this.deps.store.telemetry.firecrawl({
        endpoint: "scrape",
        url,
        status: "ok",
        results: 1,
        creditsUsed: page.credits,
        creditsSource: page.creditsSource,
        elapsedMs: Date.now() - started,
        ...call,
      });
      const doc = this.deps.store.sources.cache({
        url,
        title: page.title ?? cached?.title,
        excerpt: page.description ?? cached?.excerpt,
        contentMd: page.markdown.slice(0, 40_000),
        imageUrl: page.imageUrl,
        publishedAt: page.publishedAt,
        fetchVia: this.mode === "fixture" ? "fixture" : "firecrawl",
        ttlMinutes: 24 * 60,
      });
      return { doc, markdown: page.markdown, credits: page.credits };
    } catch (error) {
      this.deps.store.telemetry.firecrawl({
        endpoint: "scrape",
        url,
        status: "error",
        error: String(error).slice(0, 500),
        elapsedMs: Date.now() - started,
        creditsUsed: 0,
        ...call,
      });
      this.health.fail("firecrawl", error);
      throw error;
    }
  }

  async creditsLeft(): Promise<number | undefined> {
    if (!this.firecrawl) return undefined;
    try {
      return await this.firecrawl.creditsLeft();
    } catch (error) {
      this.deps.log?.warn("firecrawl.credits_failed", { error: String(error) });
      return undefined;
    }
  }
}

export const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
};
