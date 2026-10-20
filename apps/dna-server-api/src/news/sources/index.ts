// Fetch one source and cache what it returns. Every sweep checks every source: a hash of the listed entries tells
// whether anything changed, and an unchanged source returns nothing for the sweep to judge. A third failure in a row
// disables the source; a 429 (rate limited) or a 403 (blocked, as reddit and Cloudflare do to servers) is a skip for
// this sweep, not a failure, and neither is retried.
import { createHash } from "node:crypto";
import type { Source } from "@dna/sdk";
import type { Logger } from "@dna/sdk/node";
import type { CachedDoc } from "../../db/repos/sources.ts";
import type { Store } from "../../db/store.ts";
import type { Http } from "../http.ts";
import { NO_RETRY } from "../search/web.ts";
import { fetchGithubReleases } from "./github.ts";
import { fetchHnFront, fetchHnSearch } from "./hn.ts";
import { fetchFeed } from "./rss.ts";
import type { Fetcher } from "./types.ts";
import { fetchWebPage } from "./webpage.ts";

export const FETCHERS: Record<Source["kind"], Fetcher> = {
  rss: fetchFeed,
  atom: fetchFeed,
  hn_front: fetchHnFront,
  hn_search: fetchHnSearch,
  github_releases: fetchGithubReleases,
  web_page: fetchWebPage,
};

/** Feed entries live a day in the cache. */
export const ENTRY_TTL_MIN = 24 * 60;

/** What a source listed, as one hash: entry urls, titles and dates in order. */
export const entriesHash = (entries: { url: string; title: string; publishedAt?: string }[]) =>
  createHash("sha256")
    .update(entries.map((e) => `${e.url}\t${e.title}\t${e.publishedAt ?? ""}`).join("\n"))
    .digest("hex");

export interface SourceFetch {
  source: Source;
  ok: boolean;
  status: string;
  docs: CachedDoc[];
  disabled: boolean;
  error?: string;
}

export async function fetchSource(
  source: Source,
  deps: {
    http: Http;
    store: Store;
    log?: Logger;
    queries?: string[];
    since: Date;
    sweepId?: number;
  },
): Promise<SourceFetch> {
  const { value } = await deps.store.archive.capture(
    {
      kind: source.kind === "web_page" ? "listing" : source.kind.startsWith("hn_") ? "api" : "feed",
      trackId: deps.store.trackId,
      sourceId: source.id,
      sweepId: deps.sweepId,
      extractor: `source-${source.kind}/v1`,
      config: { since: deps.since.toISOString(), feedBodyMaxChars: 8000, excerptMaxChars: 600 },
    },
    deps.http,
    (http) => fetchSourceBody(source, { ...deps, http }),
  );
  return value;
}

async function fetchSourceBody(
  source: Source,
  deps: {
    http: Http;
    store: Store;
    log?: Logger;
    queries?: string[];
    since: Date;
    sweepId?: number;
  },
): Promise<SourceFetch> {
  const validators = deps.store.sources.validators(source.id);
  try {
    const http: Http = {
      ...deps.http,
      get: (url, options) => deps.http.get(url, { noRetryOn: NO_RETRY, ...options }),
    };
    const result = await FETCHERS[source.kind](source, {
      http,
      log: deps.log,
      validators,
      queries: deps.queries,
      since: deps.since,
    });
    const inputs = result.entries.map((e) => ({
      sourceId: source.id,
      url: e.url,
      title: e.title,
      author: e.author,
      publishedAt: e.publishedAt,
      excerpt: e.excerpt,
      captureIds: e.captureIds,
      contentMd: e.contentMd,
      imageUrl: e.imageUrl,
      discussionUrl: e.discussionUrl,
      points: e.points,
      comments: e.comments,
      fetchVia: "feed",
      ttlMinutes: ENTRY_TTL_MIN,
    }));
    const hash = entriesHash(result.entries);
    if (
      !result.notModified &&
      result.entries.length &&
      deps.store.sources.contentHash(source.id) === hash
    ) {
      // The admission hash omits body text; preserve corrections even when no new item is admitted.
      for (const input of inputs) deps.store.sources.preserveExtraction(input);
      deps.store.sources.fetched(source.id, { ok: true, status: "unchanged" });
      deps.log?.debug("source.unchanged", { sourceId: source.id, source: source.name });
      return { source, ok: true, status: "unchanged", docs: [], disabled: false };
    }
    if (result.entries.length) deps.store.sources.setContentHash(source.id, hash);
    const docs = inputs.map((input) => deps.store.sources.cache(input));
    deps.store.sources.fetched(source.id, {
      ok: true,
      status: result.status,
      etag: result.etag,
      lastModified: result.lastModified,
    });
    deps.log?.info("source.fetched", {
      sourceId: source.id,
      source: source.name,
      status: result.status,
      entries: docs.length,
    });
    return { source, ok: true, status: result.status, docs, disabled: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = (error as { status?: number }).status;
    if (status === 429 || status === 403) {
      const reason = status === 429 ? "429 rate limited" : "403 blocked";
      deps.log?.warn("source.skipped", { sourceId: source.id, source: source.name, reason });
      return { source, ok: false, status: reason, docs: [], disabled: false };
    }
    const { disabled } = deps.store.sources.fetched(source.id, {
      ok: false,
      status: "error",
      error: message.slice(0, 500),
    });
    deps.log?.[disabled ? "error" : "warn"](disabled ? "source.disabled" : "source.failed", {
      sourceId: source.id,
      source: source.name,
      error: message,
    });
    return { source, ok: false, status: "error", docs: [], disabled, error: message };
  }
}
