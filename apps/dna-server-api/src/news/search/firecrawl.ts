// Firecrawl v2 over plain fetch: search, scrape, credit usage. Every call reports its credits.
import { HttpError } from "@dna/sdk";
import type { Http } from "../http.ts";

export const FIRECRAWL_API = "https://api.firecrawl.dev";

export interface FirecrawlHit {
  captureIds?: number[];
  url: string;
  title: string;
  description?: string;
  date?: string;
  imageUrl?: string;
  source: "web" | "news";
}

export interface FirecrawlSearch {
  hits: FirecrawlHit[];
  credits: number;
  creditsSource: "reported" | "estimated";
}

export interface FirecrawlScrape {
  markdown: string;
  title?: string;
  description?: string;
  imageUrl?: string;
  publishedAt?: string;
  credits: number;
  creditsSource: "reported" | "estimated";
}

export class FirecrawlClient {
  constructor(
    private readonly http: Http,
    private readonly apiKey: string,
    private readonly base = FIRECRAWL_API,
  ) {}

  private headers() {
    return { authorization: `Bearer ${this.apiKey}` };
  }

  private parse(res: { status: number; text: string }, what: string): any {
    let body: any;
    try {
      body = JSON.parse(res.text);
    } catch {
      throw new HttpError(res.status, `Firecrawl ${what}: invalid JSON`);
    }
    if (res.status >= 400 || body?.success === false)
      throw new HttpError(
        res.status,
        `Firecrawl ${what} HTTP ${res.status}: ${String(body?.error ?? "").slice(0, 200)}`,
      );
    return body;
  }

  async search(
    query: string,
    options: { limit?: number; tbs?: string } = {},
  ): Promise<FirecrawlSearch> {
    const res = await this.http.postJson(
      `${this.base}/v2/search`,
      {
        query,
        limit: options.limit ?? 10,
        sources: [{ type: "web" }, { type: "news" }],
        ...(options.tbs ? { tbs: options.tbs } : {}),
        ignoreInvalidURLs: true,
      },
      this.headers(),
    );
    const body = this.parse(res, "search");
    const data = body.data ?? {};
    const hits: FirecrawlHit[] = [
      ...(data.news ?? []).map((n: any) => ({
        url: n.url,
        title: n.title,
        description: n.snippet ?? n.description,
        date: n.date,
        imageUrl: n.imageUrl,
        source: "news" as const,
      })),
      ...(data.web ?? []).map((w: any) => ({
        url: w.url,
        title: w.title,
        description: w.description ?? w.snippet,
        source: "web" as const,
      })),
    ].filter((h) => h.url && h.title);
    const reported = typeof body.creditsUsed === "number";
    return {
      hits: hits.map((hit) => ({
        ...hit,
        captureIds: res.captureId ? [res.captureId] : undefined,
      })),
      credits: reported ? body.creditsUsed : Math.max(1, Math.ceil(hits.length / 10)) * 2,
      creditsSource: reported ? "reported" : "estimated",
    };
  }

  async scrape(url: string): Promise<FirecrawlScrape> {
    const res = await this.http.postJson(
      `${this.base}/v2/scrape`,
      { url, formats: ["markdown"], onlyMainContent: true, timeout: 45_000 },
      this.headers(),
      { timeoutMs: 60_000 },
    );
    const body = this.parse(res, "scrape");
    const meta = body.data?.metadata ?? {};
    const reported = typeof meta.creditsUsed === "number" || typeof body.creditsUsed === "number";
    const published = meta.publishedTime ?? meta["article:published_time"];
    return {
      markdown: String(body.data?.markdown ?? ""),
      title: meta.title ?? meta.ogTitle,
      description: meta.description ?? meta.ogDescription,
      imageUrl: meta.ogImage ?? meta["og:image"],
      publishedAt:
        published && Number.isFinite(Date.parse(published))
          ? new Date(published).toISOString()
          : undefined,
      credits: reported ? (meta.creditsUsed ?? body.creditsUsed) : 1,
      creditsSource: reported ? "reported" : "estimated",
    };
  }

  async creditsLeft(): Promise<number | undefined> {
    const res = await this.http.get(`${this.base}/v2/team/credit-usage`, {
      headers: this.headers(),
    });
    const body = this.parse(res, "credit-usage");
    const left = body.data?.remainingCredits ?? body.data?.remaining_credits;
    return typeof left === "number" ? left : undefined;
  }
}
