// Publish dates. Content is dated by when it was published, never by when the agent found it. An item without a feed
// date gets one from its page: meta tags, JSON-LD, <time>, then a date in the url, all free. Only when none says, one
// call to the quick model reads the start of the page and answers in JSON. What nobody can tell stays unknown.
import type { Logger } from "@dna/sdk/node";
import type { Item } from "../db/repos/news.ts";
import type { Store } from "../db/store.ts";
import { stripHtml, type Http } from "./http.ts";
import { dateInHtml, dateInUrl, extractArticle, plausible, type DateSource } from "./extract.ts";
import { ArchiveError } from "../archive/archive.ts";
import type { Quick } from "./quick.ts";

export type { DateSource };

export const DATE_PROMPT = `You read the start of a web page and say when it was published.
Answer with JSON only: {"published": "YYYY-MM-DD"}, or {"published": null} when the page does not state it.
Use the article's own publish date. Use an updated date only when it is the only date. Never use today's date and never guess.`;

/** The model's answer to an ISO date, or undefined for null, junk or an implausible date. */
export function parseDateAnswer(text: string, now = Date.now()): string | undefined {
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return undefined;
  try {
    const value = (JSON.parse(json) as { published?: unknown }).published;
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)
      ? plausible(value, now)
      : undefined;
  } catch {
    return undefined;
  }
}

export class Dates {
  constructor(private readonly deps: { http: Http; store: Store; log: Logger; quick: Quick }) {}

  /** Date one item from its page, store the answer (unknown included, so it is asked once) and return it. */
  async resolve(item: Item): Promise<{ at?: string; source: DateSource }> {
    const { value } = await this.deps.store.archive.capture(
      {
        kind: "article",
        trackId: this.deps.store.trackId,
        sweepId: item.sweepId,
        extractor: "publish-date/v1",
      },
      this.deps.http,
      (http) => this.find(item, http),
    );
    return this.save(item, value);
  }

  private save(item: Item, found: { at?: string; source: DateSource }) {
    this.deps.store.news.setPublished(item.id, found.at, found.source);
    this.deps.log.info("dates.resolved", {
      itemId: item.id,
      source: found.source,
      publishedAt: found.at,
    });
    return found;
  }

  private async find(item: Item, http: Http): Promise<{ at?: string; source: DateSource }> {
    const now = Date.now();
    let text = "";
    try {
      const res = await http.get(item.url, {
        headers: { accept: "text/html,application/xhtml+xml" },
      });
      const found = dateInHtml(res.text, res.url || item.url, now);
      if (found) return found;
      // Readability drops bylines and date lines, so the model also sees the page's raw text from the top.
      const article = extractArticle(res.text, res.url || item.url, 2000);
      text = [article.byline, stripHtml(res.text, 2000), article.text].filter(Boolean).join("\n\n");
    } catch (error) {
      if (error instanceof ArchiveError) throw error;
      this.deps.log.warn("dates.fetch_failed", { itemId: item.id, error: String(error) });
      const fromUrl = dateInUrl(item.url, now);
      if (fromUrl) return { at: fromUrl, source: "url" };
    }
    if (text.length < 80) return { source: "unknown" };
    try {
      const { text: answer } = await this.deps.quick.ask(
        "publish_date",
        DATE_PROMPT,
        `URL: ${item.url}\nTitle: ${item.title}\nToday: ${new Date(now).toISOString().slice(0, 10)}\n\nPage text:\n${text}`,
      );
      const at = parseDateAnswer(answer, now);
      return at ? { at, source: "model" } : { source: "unknown" };
    } catch (error) {
      this.deps.log.warn("dates.model_failed", { itemId: item.id, error: String(error) });
      return { source: "unknown" };
    }
  }
}
