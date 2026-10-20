// Sources and their content cache.
import { createHash } from "node:crypto";
import type { Source, SourceKind, SourceLead, SourceOrigin } from "@dna/sdk";
import { TrackRepo } from "../track-repo.ts";
import { bind, bool, nowIso, num, str, type Db } from "../db.ts";
import type { Archive } from "../../archive/archive.ts";

export const urlHash = (url: string) =>
  createHash("sha256").update(canonicalUrl(url)).digest("hex").slice(0, 32);

/** Drop tracking params and fragments so the same article dedupes across sources. */
export function canonicalUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    u.hash = "";
    for (const key of [...u.searchParams.keys()])
      if (/^(utm_|ref$|ref_src$|fbclid$|gclid$|mc_)/i.test(key)) u.searchParams.delete(key);
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "") || "/";
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ""}${path}${u.search}`;
  } catch {
    return url.trim();
  }
}

export interface SourceSeed {
  kind: SourceKind;
  name: string;
  url?: string;
  query?: string;
  weight?: number;
  interval_min?: number;
}

export interface CachedDoc {
  id: number;
  sourceId?: number;
  url: string;
  urlHash: string;
  title?: string;
  author?: string;
  publishedAt?: string;
  excerpt?: string;
  contentMd?: string;
  imageUrl?: string;
  discussionUrl?: string;
  points?: number;
  comments?: number;
  fetchVia: string;
  fetchedAt: string;
  expiresAt: string;
  archiveExtractionId?: number;
}

export type CachedInput = Omit<CachedDoc, "id" | "urlHash" | "fetchedAt" | "expiresAt"> & {
  ttlMinutes: number;
  captureIds?: number[];
};

const toSource = (r: any): Source => ({
  id: r.id,
  trackId: r.track_id,
  kind: r.kind,
  name: r.name,
  url: r.url,
  query: r.query,
  weight: r.weight,
  intervalMin: r.interval_min,
  enabled: bool(r.enabled),
  failCount: r.fail_count,
  lastStatus: str(r.last_status),
  lastError: str(r.last_error),
  lastFetchedAt: str(r.last_fetched_at),
  origin: r.origin ?? "config",
  reason: str(r.reason),
});

const toLead = (r: any): SourceLead => ({
  id: r.id,
  trackId: r.track_id,
  site: r.site,
  url: r.url,
  title: str(r.title),
  cardId: num(r.card_id),
  status: r.status,
  note: str(r.note),
  sourceId: num(r.source_id),
});

const toCached = (r: any): CachedDoc => ({
  id: r.id,
  sourceId: num(r.source_id),
  url: r.url,
  urlHash: r.url_hash,
  title: str(r.title),
  author: str(r.author),
  publishedAt: str(r.published_at),
  excerpt: str(r.excerpt),
  contentMd: str(r.content_md),
  imageUrl: str(r.image_url),
  discussionUrl: str(r.discussion_url),
  points: num(r.points),
  comments: num(r.comments),
  fetchVia: r.fetch_via,
  fetchedAt: r.fetched_at,
  expiresAt: r.expires_at,
  archiveExtractionId: num(r.archive_extraction_id),
});

export class SourcesRepo extends TrackRepo {
  constructor(
    db: Db,
    trackId = "ai",
    private readonly archive?: Archive,
  ) {
    super(db, trackId);
  }
  seed(seeds: SourceSeed[]): number {
    const insert = this.prepare(
      "INSERT OR IGNORE INTO sources (track_id, kind, name, url, query, weight, interval_min, origin, created_at) VALUES (:track, :kind, :name, :url, :query, :weight, :interval_min, 'config', :created_at)",
    );
    let added = 0;
    for (const s of seeds) {
      const r = insert.run(
        bind({
          kind: s.kind,
          name: s.name,
          url: s.url ?? "",
          query: s.query ?? "",
          weight: s.weight ?? 1,
          interval_min: s.interval_min ?? 15,
          created_at: nowIso(),
        }),
      );
      added += Number(r.changes);
    }
    return added;
  }

  list(): Source[] {
    return (
      this.prepare("SELECT * FROM sources WHERE track_id = :track ORDER BY id").all() as any[]
    ).map(toSource);
  }

  get(id: number): Source | undefined {
    const r = this.prepare("SELECT * FROM sources WHERE track_id = :track AND id = ?").get(id);
    return r ? toSource(r) : undefined;
  }

  /** Enabled sources whose interval has passed. */
  due(now = new Date()): Source[] {
    return this.list().filter(
      (s) =>
        s.enabled &&
        (!s.lastFetchedAt ||
          now.getTime() - Date.parse(s.lastFetchedAt) >= s.intervalMin * 60_000 - 30_000),
    );
  }

  add(input: {
    kind: SourceKind;
    name: string;
    url?: string;
    query?: string;
    weight?: number;
    intervalMin?: number;
    origin?: SourceOrigin;
    reason?: string;
  }): Source {
    const r = this.prepare(
      "INSERT INTO sources (track_id, kind, name, url, query, weight, interval_min, origin, reason, created_at) VALUES (:track, :kind, :name, :url, :query, :weight, :interval_min, :origin, :reason, :created_at)",
    ).run(
      bind({
        kind: input.kind,
        name: input.name,
        url: input.url ?? "",
        query: input.query ?? "",
        weight: input.weight ?? 1,
        interval_min: input.intervalMin ?? 15,
        origin: input.origin ?? "user",
        reason: input.reason,
        created_at: nowIso(),
      }),
    );
    return this.get(Number(r.lastInsertRowid))!;
  }

  byUrl(kind: SourceKind, url: string): Source | undefined {
    const r = this.prepare(
      "SELECT * FROM sources WHERE track_id = :track AND kind = ? AND url = ? AND query = ''",
    ).get(kind, url);
    return r ? toSource(r) : undefined;
  }

  /** Sources the agent saved (on its own or from an upvote): capped so the sweep stays small. */
  savedCount(): number {
    return (
      this.prepare(
        "SELECT COUNT(*) AS n FROM sources WHERE track_id = :track AND origin IN ('agent', 'upvote')",
      ).get() as { n: number }
    ).n;
  }

  // Leads: sites a reader upvoted, offered to the next sweep.

  /** Record a lead for a site. A skipped site the reader upvotes again opens again; a saved one stays saved. */
  addLead(input: {
    site: string;
    url: string;
    title?: string;
    cardId?: number;
    itemId?: number;
  }): SourceLead {
    this.requireOwned("cards", input.cardId);
    this.requireOwned("items", input.itemId);
    this.prepare(
      `INSERT INTO source_leads (track_id, site, url, title, card_id, item_id, created_at)
         VALUES (:track, :site, :url, :title, :card_id, :item_id, :now)
         ON CONFLICT (track_id, site) DO UPDATE SET
           url = CASE WHEN status = 'saved' THEN url ELSE excluded.url END,
           title = CASE WHEN status = 'saved' THEN title ELSE excluded.title END,
           card_id = CASE WHEN status = 'saved' THEN card_id ELSE excluded.card_id END,
           item_id = CASE WHEN status = 'saved' THEN item_id ELSE excluded.item_id END,
           note = CASE WHEN status = 'saved' THEN note ELSE NULL END,
           resolved_at = CASE WHEN status = 'saved' THEN resolved_at ELSE NULL END,
           status = CASE WHEN status = 'saved' THEN 'saved' ELSE 'open' END`,
    ).run(
      bind({
        site: input.site,
        url: input.url,
        title: input.title,
        card_id: input.cardId,
        item_id: input.itemId,
        now: nowIso(),
      }),
    );
    return toLead(
      this.prepare("SELECT * FROM source_leads WHERE track_id = :track AND site = ?").get(
        input.site,
      ),
    );
  }

  lead(id: number): SourceLead | undefined {
    const r = this.prepare("SELECT * FROM source_leads WHERE track_id = :track AND id = ?").get(id);
    return r ? toLead(r) : undefined;
  }

  openLeads(limit = 5): SourceLead[] {
    return (
      this.prepare(
        "SELECT * FROM source_leads WHERE track_id = :track AND status = 'open' ORDER BY id LIMIT ?",
      ).all(limit) as any[]
    ).map(toLead);
  }

  /** Mark the leads a sweep's prompt lists, so the audit can check each was saved or skipped. */
  offerLeads(ids: number[], sweepId: number): void {
    this.requireOwned("sweeps", sweepId);
    const stmt = this.prepare(
      "UPDATE source_leads SET offered_sweep_id = ? WHERE track_id = :track AND id = ?",
    );
    for (const id of ids) stmt.run(sweepId, id);
  }

  openLeadsOffered(sweepId: number): SourceLead[] {
    return (
      this.prepare(
        "SELECT * FROM source_leads WHERE track_id = :track AND offered_sweep_id = ? AND status = 'open'",
      ).all(sweepId) as any[]
    ).map(toLead);
  }

  offeredCount(sweepId: number): number {
    return (
      this.prepare(
        "SELECT COUNT(*) AS n FROM source_leads WHERE track_id = :track AND offered_sweep_id = ?",
      ).get(sweepId) as { n: number }
    ).n;
  }

  resolveLead(
    id: number,
    status: "saved" | "skipped",
    note?: string,
    sourceId?: number,
  ): SourceLead | undefined {
    this.requireOwned("sources", sourceId);
    this.prepare(
      "UPDATE source_leads SET status = :status, note = :note, source_id = :source_id, resolved_at = :now WHERE track_id = :track AND id = :id",
    ).run(bind({ id, status, note, source_id: sourceId, now: nowIso() }));
    return this.lead(id);
  }

  update(
    id: number,
    patch: { name?: string; enabled?: boolean; weight?: number; intervalMin?: number },
  ): Source | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    this.prepare(
      "UPDATE sources SET name = :name, enabled = :enabled, weight = :weight, interval_min = :interval_min, fail_count = CASE WHEN :enabled = 1 AND enabled = 0 THEN 0 ELSE fail_count END WHERE track_id = :track AND id = :id",
    ).run(
      bind({
        id,
        name: patch.name ?? current.name,
        enabled: patch.enabled ?? current.enabled,
        weight: patch.weight ?? current.weight,
        interval_min: patch.intervalMin ?? current.intervalMin,
      }),
    );
    return this.get(id);
  }

  remove(id: number): boolean {
    if (!this.get(id)) return false;
    this.prepare("UPDATE items SET source_id = NULL WHERE track_id = :track AND source_id = ?").run(
      id,
    );
    return (
      Number(
        this.prepare("DELETE FROM sources WHERE track_id = :track AND id = ?").run(id).changes,
      ) > 0
    );
  }

  fetched(
    id: number,
    result: { ok: boolean; status: string; error?: string; etag?: string; lastModified?: string },
    maxFailures = 3,
  ): { disabled: boolean } {
    this.requireOwned("sources", id);
    const now = nowIso();
    if (result.ok) {
      this.prepare(
        "UPDATE sources SET fail_count = 0, last_status = :status, last_error = NULL, last_fetched_at = :now, etag = COALESCE(:etag, etag), last_modified = COALESCE(:lm, last_modified) WHERE track_id = :track AND id = :id",
      ).run(bind({ id, status: result.status, now, etag: result.etag, lm: result.lastModified }));
      return { disabled: false };
    }
    this.prepare(
      "UPDATE sources SET fail_count = fail_count + 1, last_status = :status, last_error = :error, last_fetched_at = :now WHERE track_id = :track AND id = :id",
    ).run(bind({ id, status: result.status, error: result.error, now }));
    const row = this.prepare(
      "SELECT fail_count FROM sources WHERE track_id = :track AND id = ?",
    ).get(id) as {
      fail_count: number;
    };
    if (row.fail_count >= maxFailures) {
      this.prepare("UPDATE sources SET enabled = 0 WHERE track_id = :track AND id = ?").run(id);
      return { disabled: true };
    }
    return { disabled: false };
  }

  /** The hash of what a source listed last time it changed. */
  contentHash(id: number): string | undefined {
    const r = this.prepare(
      "SELECT content_hash FROM sources WHERE track_id = :track AND id = ?",
    ).get(id) as any;
    return str(r?.content_hash);
  }

  setContentHash(id: number, hash: string): void {
    this.prepare("UPDATE sources SET content_hash = ? WHERE track_id = :track AND id = ?").run(
      hash,
      id,
    );
  }

  validators(id: number): { etag?: string; lastModified?: string } {
    const r = this.prepare(
      "SELECT etag, last_modified FROM sources WHERE track_id = :track AND id = ?",
    ).get(id) as any;
    return { etag: str(r?.etag), lastModified: str(r?.last_modified) };
  }

  cached(url: string): CachedDoc | undefined {
    const r = this.prepare("SELECT * FROM source_cache WHERE url_hash = ?").get(urlHash(url));
    return r ? toCached(r) : undefined;
  }

  cachedById(id: number): CachedDoc | undefined {
    const r = this.prepare("SELECT * FROM source_cache WHERE id = ?").get(id);
    return r ? toCached(r) : undefined;
  }

  isFresh(doc: CachedDoc | undefined, now = new Date()): doc is CachedDoc {
    return !!doc && Date.parse(doc.expiresAt) > now.getTime();
  }

  /** Upsert by URL hash. Keeps richer content: a feed entry never overwrites a scraped article body. */
  cache(input: CachedInput, now = new Date()): CachedDoc {
    const extraction = this.preserveExtraction(input);
    const hash = urlHash(input.url);
    const fetchedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + input.ttlMinutes * 60_000).toISOString();
    this.prepare(
      `INSERT INTO source_cache (source_id, url, url_hash, title, author, published_at, excerpt, content_md, image_url, discussion_url, points, comments, fetch_via, fetched_at, expires_at, bytes, archive_extraction_id)
         VALUES (:source_id, :url, :url_hash, :title, :author, :published_at, :excerpt, :content_md, :image_url, :discussion_url, :points, :comments, :fetch_via, :fetched_at, :expires_at, :bytes, :extraction)
         ON CONFLICT (url_hash) DO UPDATE SET
           source_id = COALESCE(source_cache.source_id, excluded.source_id),
           title = COALESCE(excluded.title, source_cache.title),
           author = COALESCE(excluded.author, source_cache.author),
           published_at = COALESCE(source_cache.published_at, excluded.published_at),
           excerpt = COALESCE(excluded.excerpt, source_cache.excerpt),
           content_md = CASE WHEN length(COALESCE(excluded.content_md, '')) >= length(COALESCE(source_cache.content_md, '')) THEN excluded.content_md ELSE source_cache.content_md END,
           image_url = COALESCE(source_cache.image_url, excluded.image_url),
           discussion_url = COALESCE(excluded.discussion_url, source_cache.discussion_url),
           points = COALESCE(excluded.points, source_cache.points),
           comments = COALESCE(excluded.comments, source_cache.comments),
           fetch_via = CASE WHEN length(COALESCE(excluded.content_md, '')) >= length(COALESCE(source_cache.content_md, '')) THEN excluded.fetch_via ELSE source_cache.fetch_via END,
           fetched_at = excluded.fetched_at,
           expires_at = excluded.expires_at,
           archive_extraction_id = CASE WHEN length(COALESCE(excluded.content_md, '')) >= length(COALESCE(source_cache.content_md, '')) THEN excluded.archive_extraction_id ELSE source_cache.archive_extraction_id END`,
    ).run(
      bind({
        source_id: input.sourceId,
        url: input.url,
        url_hash: hash,
        title: input.title,
        author: input.author,
        published_at: input.publishedAt,
        excerpt: input.excerpt,
        content_md: input.contentMd,
        image_url: input.imageUrl,
        discussion_url: input.discussionUrl,
        points: input.points,
        comments: input.comments,
        fetch_via: input.fetchVia,
        fetched_at: fetchedAt,
        expires_at: expiresAt,
        bytes: input.contentMd?.length,
        extraction,
      }),
    );
    const cached = this.cached(input.url)!;
    if (extraction)
      this.db
        .prepare("INSERT OR IGNORE INTO archive_cache_history VALUES (?,?)")
        .run(cached.id, extraction);
    return cached;
  }

  /** Archive adapter output even when the admission hash says there is no new article. */
  preserveExtraction(input: CachedInput): number | undefined {
    const id = this.archive?.extraction({ ...input });
    const cached = this.cached(input.url);
    if (id && cached)
      this.db
        .prepare("INSERT OR IGNORE INTO archive_cache_history VALUES (?,?)")
        .run(cached.id, id);
    return id;
  }

  /** Full-text-ish search over cached docs (fallback search). */
  searchCache(terms: string[], sinceIso: string, limit = 20): CachedDoc[] {
    if (!terms.length) return [];
    const where = terms
      .map((_, i) => `(lower(title) LIKE :t${i} OR lower(excerpt) LIKE :t${i})`)
      .join(" OR ");
    const params: Record<string, unknown> = { since: sinceIso, limit };
    terms.forEach((t, i) => (params[`t${i}`] = `%${t.toLowerCase()}%`));
    return (
      this.prepare(
        `SELECT * FROM source_cache WHERE fetched_at >= :since AND (${where}) ORDER BY fetched_at DESC LIMIT :limit`,
      ).all(bind(params)) as any[]
    ).map(toCached);
  }
}
