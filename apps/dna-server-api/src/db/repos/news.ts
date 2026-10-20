// Items, jev classifications, researcher findings, stories, images and the cards the feed renders.
import type {
  Card,
  CardComponent,
  CardImage,
  HfsCategory,
  HfsScores,
  TabBy,
  TimelineRef,
  TimelineSummary,
} from "@dna/sdk";
import type { EvidenceArchive } from "../../archive/evidence.ts";
import type { Db } from "../db.ts";
import { TrackRepo } from "../track-repo.ts";
import { bind, nowIso, num, parse, str, tx } from "../db.ts";
import { canonicalUrl, urlHash } from "./sources.ts";
import { comparePublished, packageRelease } from "../../news/releases.ts";

export type ItemStatus =
  | "candidate"
  | "rejected"
  | "duplicate"
  | "researching"
  | "classified"
  | "presented"
  | "failed";

export interface Item {
  id: number;
  trackId: string;
  sweepId?: number;
  cacheId?: number;
  sourceId?: number;
  url: string;
  urlHash: string;
  title: string;
  sourceName?: string;
  publishedAt?: string;
  /** Where the publish date came from; undefined when it was never looked up. */
  dateSource?: string;
  excerpt?: string;
  imageUrl?: string;
  discussionUrl?: string;
  status: ItemStatus;
  relevance?: number;
  matchedTopic?: string;
  worth?: number;
  novelty?: number;
  attention?: number;
  duplicateOf?: number;
  attempts: number;
  lastError?: string;
  /** jev's importance for the reader (0 to 1), set when a sweep ranks its candidates. */
  importance?: number;
  createdAt: string;
}

export interface ItemInput {
  sweepId?: number;
  cacheId?: number;
  sourceId?: number;
  url: string;
  title: string;
  sourceName?: string;
  publishedAt?: string;
  excerpt?: string;
  imageUrl?: string;
  discussionUrl?: string;
}

export interface Classification extends HfsScores {
  id: number;
  itemId?: number;
  command: string;
  version: number;
  model?: string;
  sweepId?: number;
  createdAt: string;
}

export interface Finding {
  id: number;
  itemId: number;
  conversationId?: number;
  summary: string;
  claims: string[];
  evidence: string[];
  actionability?: string;
  claimSupport: { claim: string; supported: number }[];
  createdAt: string;
}

export interface StoryMembership {
  storyId: number;
  role: "development" | "coverage" | "evidence";
  developmentId: number;
}

const toItem = (r: any): Item => ({
  id: r.id,
  trackId: r.track_id,
  sweepId: num(r.sweep_id),
  cacheId: num(r.cache_id),
  sourceId: num(r.source_id),
  url: r.url,
  urlHash: r.url_hash,
  title: r.title,
  sourceName: str(r.source_name),
  publishedAt: str(r.published_at),
  dateSource: str(r.date_source),
  excerpt: str(r.excerpt),
  imageUrl: str(r.image_url),
  discussionUrl: str(r.discussion_url),
  status: r.status,
  relevance: num(r.relevance),
  matchedTopic: str(r.matched_topic),
  worth: num(r.worth),
  novelty: num(r.novelty),
  attention: num(r.attention),
  duplicateOf: num(r.duplicate_of),
  attempts: r.attempts,
  lastError: str(r.last_error),
  importance: num(r.importance),
  createdAt: r.created_at,
});

const toClassification = (r: any): Classification => ({
  id: r.id,
  itemId: num(r.item_id),
  command: r.command,
  version: r.version,
  model: str(r.model),
  hype: r.hype,
  facts: r.facts,
  signal: r.signal,
  primary: r.primary_category,
  labels: parse(r.labels_json, []),
  ranked: parse(r.ranked_json, []),
  suspectCombo: r.suspect_combo === 1,
  sweepId: num(r.sweep_id),
  createdAt: r.created_at,
});

const toImage = (r: any): CardImage | undefined =>
  r ? { id: r.id, origin: r.origin, status: r.status, url: r.url ?? undefined } : undefined;

// Apply before pagination, including search. Historical cards remain addressable by id.
const STORY_VISIBLE = `NOT EXISTS (SELECT 1 FROM story_memberships sm WHERE sm.item_id = c.item_id AND c.id != coalesce((
  SELECT hc.id FROM cards hc JOIN story_memberships hm ON hm.item_id = hc.item_id JOIN items hi ON hi.id = hc.item_id
  WHERE hm.story_id = sm.story_id AND hm.role = 'development' AND hc.kind = 'news'
  ORDER BY coalesce(hi.published_at, hi.created_at) DESC, hc.id DESC LIMIT 1), -1))`;
const RELEASE_VISIBLE = `NOT EXISTS (SELECT 1 FROM items ri JOIN release_heads rh ON rh.release_key=ri.release_key AND rh.track_id=ri.track_id
  WHERE ri.id=c.item_id AND rh.visible_card_id != c.id)`;

export class NewsRepo extends TrackRepo {
  constructor(
    db: Db,
    trackId = "ai",
    private readonly evidence?: EvidenceArchive,
  ) {
    super(db, trackId);
  }
  // Items

  /** Insert a new item, or return the existing one for the same canonical URL. */
  upsertItem(input: ItemInput): { item: Item; created: boolean } {
    this.requireOwned("sources", input.sourceId);
    this.requireOwned("sweeps", input.sweepId);
    const hash = urlHash(input.url);
    const existing = this.prepare(
      "SELECT * FROM items WHERE track_id = :track AND url_hash = ?",
    ).get(hash);
    if (existing) return { item: toItem(existing), created: false };
    const now = nowIso();
    const r = this.prepare(
      `INSERT INTO items (track_id, sweep_id, cache_id, source_id, url, url_hash, title, source_name, published_at, date_source, excerpt, image_url, discussion_url, created_at, updated_at)
         VALUES (:track, :sweep_id, :cache_id, :source_id, :url, :url_hash, :title, :source_name, :published_at, :date_source, :excerpt, :image_url, :discussion_url, :now, :now)`,
    ).run(
      bind({
        sweep_id: input.sweepId,
        cache_id: input.cacheId,
        source_id: input.sourceId,
        url: canonicalUrl(input.url),
        url_hash: hash,
        title: input.title.trim().slice(0, 500),
        source_name: input.sourceName,
        published_at: input.publishedAt,
        date_source: input.publishedAt ? "feed" : undefined,
        excerpt: input.excerpt?.slice(0, 4000),
        image_url: input.imageUrl,
        discussion_url: input.discussionUrl,
        now,
      }),
    );
    const item = this.item(Number(r.lastInsertRowid))!;
    this.indexRelease(item);
    return { item, created: true };
  }

  private indexRelease(item: Pick<Item, "id" | "url">): void {
    const release = packageRelease(item.url);
    if (release)
      this.prepare(
        "UPDATE items SET release_key=?, release_version=? WHERE track_id = :track AND id=?",
      ).run(release.key, release.version, item.id);
  }

  /** Populate existing releases on boot, then choose by publication date across stable, preview and nightly. */
  refreshReleases(backfill = false): void {
    const run = () => {
      if (backfill)
        for (const row of this.prepare(
          "SELECT id,url FROM items WHERE track_id = :track AND release_key IS NULL",
        ).all() as any[])
          this.indexRelease(row);
      const groups = new Map<string, { id: number; publishedAt?: string; cardId?: number }[]>();
      for (const row of this.prepare(`SELECT i.id, i.release_key, i.published_at,
        (SELECT max(c.id) FROM cards c WHERE c.item_id=i.id AND c.kind='news') card_id
        FROM items i WHERE i.track_id = :track AND i.release_key IS NOT NULL`).all() as any[]) {
        const group = groups.get(row.release_key) ?? [];
        group.push({ id: row.id, publishedAt: str(row.published_at), cardId: num(row.card_id) });
        groups.set(row.release_key, group);
      }
      const save = this
        .prepare(`INSERT INTO release_heads (track_id, release_key, latest_item_id, visible_card_id) VALUES (:track, ?, ?, ?)
        ON CONFLICT(track_id, release_key) DO UPDATE SET latest_item_id=excluded.latest_item_id, visible_card_id=excluded.visible_card_id`);
      for (const [key, items] of groups) {
        items.sort((a, b) => comparePublished(b, a));
        save.run(key, items[0].id, items.find((i) => i.cardId)?.cardId ?? null);
      }
    };
    if (this.db.isTransaction) run();
    else tx(this.db, run);
  }

  latestRelease(itemId: number): number | undefined {
    const row = this.prepare(
      `SELECT rh.latest_item_id FROM items i JOIN release_heads rh ON rh.release_key=i.release_key AND rh.track_id=i.track_id WHERE i.track_id = :track AND i.id=?`,
    ).get(itemId) as any;
    return row?.latest_item_id;
  }

  releaseCardIds(itemId: number): number[] {
    return (
      this.prepare(`SELECT c.id FROM cards c JOIN items i ON i.id=c.item_id
      WHERE c.track_id = :track AND i.release_key=(SELECT release_key FROM items WHERE track_id = :track AND id=?) AND c.kind='news'`).all(
        itemId,
      ) as any[]
    ).map((r) => r.id);
  }

  private releaseHidden(itemId: number, cardId: number): boolean {
    const row = this.prepare(
      `SELECT rh.visible_card_id FROM items i JOIN release_heads rh ON rh.release_key=i.release_key AND rh.track_id=i.track_id WHERE i.track_id = :track AND i.id=?`,
    ).get(itemId) as any;
    return row ? row.visible_card_id !== cardId : false;
  }

  /** Cheap admission rule before Jev. Repair a latest release suppressed by the old semantic duplicate rule. */
  filterReleases(sweepId: number): void {
    this.requireOwned("sweeps", sweepId);
    this.refreshReleases();
    const latest =
      this.prepare(`SELECT i.* FROM release_heads r JOIN items i ON i.id=r.latest_item_id
      WHERE i.track_id = :track AND (i.status='duplicate' OR i.last_error LIKE 'Superseded by release item #%')
      AND NOT EXISTS (SELECT 1 FROM cards c WHERE c.item_id=i.id AND c.kind='news')
      AND i.published_at>=?`).all(new Date(Date.now() - 14 * 86_400_000).toISOString()) as any[];
    for (const row of latest) {
      this.prepare("DELETE FROM story_memberships WHERE item_id=?").run(row.id);
      this.prepare("DELETE FROM story_items WHERE item_id=?").run(row.id);
      this.updateItem(row.id, {
        status: "candidate",
        sweepId,
        duplicateOf: undefined,
        relevance: undefined,
        worth: undefined,
        lastError: undefined,
      });
    }
    this.prepare(`UPDATE items SET status='rejected', last_error='Superseded by release item #' || (
      SELECT r.latest_item_id FROM release_heads r WHERE track_id = :track AND r.release_key=items.release_key), updated_at=?
      WHERE track_id = :track AND sweep_id=? AND status='candidate' AND release_key IS NOT NULL AND id != (
      SELECT r.latest_item_id FROM release_heads r WHERE r.release_key=items.release_key AND r.track_id=items.track_id)`).run(
      nowIso(),
      sweepId,
    );
  }

  item(id: number): Item | undefined {
    const r = this.prepare("SELECT * FROM items WHERE track_id = :track AND id = ?").get(id);
    return r ? toItem(r) : undefined;
  }

  items(ids: number[]): Item[] {
    if (!ids.length) return [];
    return (
      this.prepare(
        `SELECT * FROM items WHERE track_id = :track AND id IN (${ids.map(() => "?").join(",")})`,
      ).all(...ids) as any[]
    ).map(toItem);
  }

  updateItem(
    id: number,
    patch: Partial<
      Pick<
        Item,
        | "status"
        | "relevance"
        | "matchedTopic"
        | "worth"
        | "novelty"
        | "attention"
        | "duplicateOf"
        | "lastError"
        | "sweepId"
        | "excerpt"
        | "imageUrl"
        | "importance"
      >
    >,
  ): void {
    this.requireOwned("sweeps", patch.sweepId);
    this.requireOwned("items", patch.duplicateOf);
    const map: Record<string, string> = {
      status: "status",
      relevance: "relevance",
      matchedTopic: "matched_topic",
      worth: "worth",
      novelty: "novelty",
      attention: "attention",
      duplicateOf: "duplicate_of",
      lastError: "last_error",
      sweepId: "sweep_id",
      excerpt: "excerpt",
      imageUrl: "image_url",
      importance: "importance",
    };
    const keys = Object.keys(patch).filter((k) => k in map);
    if (!keys.length) return;
    const sets = keys.map((k) => `${map[k]} = :${k}`).join(", ");
    this.prepare(
      `UPDATE items SET ${sets}, updated_at = :now WHERE track_id = :track AND id = :id`,
    ).run(bind({ ...patch, id, now: nowIso() }));
  }

  failItem(id: number, error: string): void {
    this.prepare(
      "UPDATE items SET attempts = attempts + 1, last_error = ?, status = CASE WHEN attempts + 1 >= 3 THEN 'failed' ELSE status END, updated_at = ? WHERE track_id = :track AND id = ?",
    ).run(error.slice(0, 500), nowIso(), id);
  }

  itemsForSweep(sweepId: number, statuses?: ItemStatus[]): Item[] {
    const filter = statuses?.length ? ` AND status IN (${statuses.map(() => "?").join(",")})` : "";
    return (
      this.prepare(
        `SELECT * FROM items WHERE track_id = :track AND sweep_id = ?${filter} ORDER BY COALESCE(attention, 0) DESC, id`,
      ).all(sweepId, ...(statuses ?? [])) as any[]
    ).map(toItem);
  }

  /** Items gathered earlier whose judgment failed and may be retried. */
  retryable(limit = 10): Item[] {
    return (
      this.prepare(
        "SELECT * FROM items WHERE track_id = :track AND status = 'candidate' AND attempts > 0 AND attempts < 3 ORDER BY updated_at LIMIT ?",
      ).all(limit) as any[]
    ).map(toItem);
  }

  /** Items presented in the last `hours`, for dedupe. */
  recentPresented(hours = 48): Item[] {
    const since = new Date(Date.now() - hours * 3_600_000).toISOString();
    return (
      this.prepare(
        "SELECT * FROM items WHERE track_id = :track AND status = 'presented' AND updated_at >= ? ORDER BY updated_at DESC LIMIT 200",
      ).all(since) as any[]
    ).map(toItem);
  }

  /** Wider retrieval history, including attached coverage of stories with a published development. */
  storyHistory(days = 14): Item[] {
    return (
      this.prepare(`SELECT i.* FROM items i
      LEFT JOIN story_memberships m ON m.item_id = i.id
      WHERE i.track_id = :track AND i.created_at >= ? AND (i.status = 'presented' OR EXISTS (
        SELECT 1 FROM story_memberships p JOIN cards c ON c.item_id = p.item_id
        WHERE p.story_id = m.story_id AND c.kind = 'news')) ORDER BY i.id DESC`).all(
        new Date(Date.now() - days * 86_400_000).toISOString(),
      ) as any[]
    ).map(toItem);
  }

  reviewMatches(itemId: number): Item[] {
    return (
      this.prepare(`SELECT DISTINCT i.* FROM story_decisions d JOIN items i ON i.id=d.other_item_id
      WHERE i.track_id = :track AND d.item_id=? AND d.action='uncertain' AND json_extract(d.answers_json, '$.same') >= 0.5
      ORDER BY i.id DESC LIMIT 12`).all(itemId) as any[]
    ).map(toItem);
  }

  membership(itemId: number): StoryMembership | undefined {
    const r = this.prepare(
      "SELECT * FROM story_memberships WHERE item_id = ? AND item_id IN (SELECT id FROM items WHERE track_id = :track)",
    ).get(itemId) as any;
    return r && { storyId: r.story_id, role: r.role, developmentId: r.development_id };
  }

  ensureStory(item: Item): number {
    this.requireOwned("items", item.id);
    const prior = this.membership(item.id);
    if (prior) return prior.storyId;
    return tx(this.db, () => {
      const id = this.addTimeline({
        title: item.title.slice(0, 80),
        itemIds: [item.id],
        sweepId: item.sweepId,
        toolCallId: `story:${item.id}`,
      }).id;
      this.prepare("INSERT INTO story_memberships VALUES (?, ?, 'development', ?)").run(
        item.id,
        id,
        item.id,
      );
      return id;
    });
  }

  storyMembers(storyId: number): Item[] {
    return (
      this.prepare(
        "SELECT i.* FROM items i JOIN story_memberships m ON m.item_id = i.id WHERE i.track_id = :track AND m.story_id = ? ORDER BY i.id",
      ).all(storyId) as any[]
    ).map(toItem);
  }

  /** Atomic and replayable: membership, timeline and suppression change together. */
  attachStory(item: Item, other: Item, role: StoryMembership["role"]): number {
    this.requireOwned("items", item.id);
    this.requireOwned("items", other.id);
    const storyId = this.ensureStory(other);
    const developmentId =
      role === "development" ? item.id : (this.membership(other.id)?.developmentId ?? other.id);
    tx(this.db, () => {
      const previous = this.membership(item.id);
      if (previous && previous.storyId !== storyId) {
        // Only a singleton may be reassigned (used when reconciling already presented items).
        if (this.storyMembers(previous.storyId).length > 1)
          throw new Error(`Item ${item.id} already belongs to a populated story`);
        this.prepare("DELETE FROM story_items WHERE story_id = ? AND item_id = ?").run(
          previous.storyId,
          item.id,
        );
      }
      this.prepare(`INSERT INTO story_memberships VALUES (?, ?, ?, ?)
        ON CONFLICT(item_id) DO UPDATE SET story_id=excluded.story_id, role=excluded.role, development_id=excluded.development_id`).run(
        item.id,
        storyId,
        role,
        developmentId,
      );
      if (role === "development") this.extendTimeline(storyId, [item.id]);
      else {
        this.prepare("DELETE FROM story_items WHERE story_id = ? AND item_id = ?").run(
          storyId,
          item.id,
        );
        this.updateItem(item.id, { status: "duplicate", duplicateOf: developmentId });
        this.prepare("UPDATE stories SET updated_at = ? WHERE track_id = :track AND id = ?").run(
          nowIso(),
          storyId,
        );
        const head = this.storyHead(storyId);
        if (head && (!previous || previous.storyId !== storyId || previous.role !== role))
          this.evidence?.publish(this.trackId, head, item.id, undefined, nowIso());
      }
    });
    return storyId;
  }

  /** A manual link: every story the items belong to joins the target story, and items without one join as developments. */
  mergeStories(targetId: number, itemIds: number[], title?: string): void {
    this.requireOwned("stories", targetId);
    for (const id of itemIds) this.requireOwned("items", id);
    tx(this.db, () => {
      for (const itemId of itemIds) {
        const from = this.membership(itemId)?.storyId;
        if (from === targetId) continue;
        if (from === undefined) {
          this.prepare("INSERT INTO story_memberships VALUES (?, ?, 'development', ?)").run(
            itemId,
            targetId,
            itemId,
          );
          this.extendTimeline(targetId, [itemId]);
          continue;
        }
        this.prepare("UPDATE story_memberships SET story_id = ? WHERE story_id = ?").run(
          targetId,
          from,
        );
        this.prepare(
          "INSERT OR IGNORE INTO story_items (story_id, item_id) SELECT ?, item_id FROM story_items WHERE story_id = ?",
        ).run(targetId, from);
        this.prepare("DELETE FROM story_items WHERE story_id = ?").run(from);
      }
      if (title)
        this.prepare("UPDATE stories SET title = ? WHERE track_id = :track AND id = ?").run(
          title,
          targetId,
        );
      this.prepare("UPDATE stories SET updated_at = ? WHERE track_id = :track AND id = ?").run(
        nowIso(),
        targetId,
      );
    });
  }

  storyCardIds(storyId: number): number[] {
    return (
      this.prepare(`SELECT c.id FROM cards c JOIN story_memberships m ON m.item_id = c.item_id
      WHERE c.track_id = :track AND m.story_id = ? AND c.kind = 'news' ORDER BY c.id`).all(
        storyId,
      ) as any[]
    ).map((r) => r.id);
  }

  storySources(storyId: number): NonNullable<Card["sources"]> {
    return (
      this.prepare(`SELECT i.*, m.role FROM items i JOIN story_memberships m ON m.item_id = i.id
      WHERE i.track_id = :track AND m.story_id = ? ORDER BY i.id`).all(storyId) as any[]
    ).map((r) => ({
      itemId: r.id,
      title: r.title,
      url: r.url,
      sourceName: str(r.source_name),
      publishedAt: str(r.published_at),
      role: r.role,
      excerpt: str(r.excerpt),
    }));
  }

  /** The newest published development is the story's feed card. Other cards remain in its timeline. */
  storyHead(storyId: number): number | undefined {
    const r =
      this.prepare(`SELECT c.id FROM cards c JOIN story_memberships m ON m.item_id = c.item_id
      JOIN items i ON i.id = c.item_id WHERE i.track_id = :track AND m.story_id = ? AND m.role = 'development' AND c.kind = 'news'
      ORDER BY coalesce(i.published_at, i.created_at) DESC, c.id DESC LIMIT 1`).get(storyId) as any;
    return r?.id;
  }

  // Classifications

  addClassification(input: {
    itemId?: number;
    command: string;
    version: number;
    model?: string;
    hfs: HfsScores;
    answers?: unknown;
    sweepId?: number;
    toolCallId?: string;
    archiveEvidenceId?: number;
  }): Classification {
    this.requireOwned("items", input.itemId);
    this.requireOwned("sweeps", input.sweepId);
    const r = this.prepare(
      `INSERT INTO classifications (track_id, item_id, command, version, model, hype, facts, signal, primary_category, labels_json, ranked_json, suspect_combo, answers_json, sweep_id, tool_call_id, created_at,archive_evidence_id)
         VALUES (:track, :item_id, :command, :version, :model, :hype, :facts, :signal, :primary_category, :labels, :ranked, :suspect, :answers, :sweep_id, :tool_call_id, :now,:archive_evidence)`,
    ).run(
      bind({
        item_id: input.itemId,
        archive_evidence: input.archiveEvidenceId,
        command: input.command,
        version: input.version,
        model: input.model,
        hype: input.hfs.hype,
        facts: input.hfs.facts,
        signal: input.hfs.signal,
        primary_category: input.hfs.primary,
        labels: input.hfs.labels,
        ranked: input.hfs.ranked,
        suspect: input.hfs.suspectCombo,
        answers: input.answers,
        sweep_id: input.sweepId,
        tool_call_id: input.toolCallId,
        now: nowIso(),
      }),
    );
    return toClassification(
      this.prepare("SELECT * FROM classifications WHERE track_id = :track AND id = ?").get(
        Number(r.lastInsertRowid),
      ),
    );
  }

  latestHfs(itemId: number): Classification | undefined {
    const r = this.prepare(
      "SELECT * FROM classifications WHERE track_id = :track AND item_id = ? AND command = 'hfs' ORDER BY id DESC LIMIT 1",
    ).get(itemId);
    return r ? toClassification(r) : undefined;
  }

  // Findings

  addFinding(input: {
    itemId: number;
    conversationId?: number;
    summary: string;
    claims: string[];
    evidence: string[];
    actionability?: string;
    claimSupport: { claim: string; supported: number }[];
  }): Finding {
    this.requireOwned("items", input.itemId);
    this.prepare(
      `INSERT INTO findings (item_id, conversation_id, summary, claims_json, evidence_json, actionability, claim_support_json, created_at)
         VALUES (:item_id, :conversation_id, :summary, :claims, :evidence, :actionability, :support, :now)
         ON CONFLICT (item_id, conversation_id) DO UPDATE SET summary = excluded.summary, claims_json = excluded.claims_json,
           evidence_json = excluded.evidence_json, actionability = excluded.actionability, claim_support_json = excluded.claim_support_json`,
    ).run(
      bind({
        item_id: input.itemId,
        conversation_id: input.conversationId,
        summary: input.summary,
        claims: input.claims,
        evidence: input.evidence,
        actionability: input.actionability,
        support: input.claimSupport,
        now: nowIso(),
      }),
    );
    const finding = this.findings(input.itemId).at(-1)!;
    const evidenceId = this.evidence?.record(this.trackId, `finding:${finding.id}`, input, input);
    if (evidenceId)
      this.db
        .prepare("UPDATE findings SET archive_evidence_id=? WHERE id=?")
        .run(evidenceId, finding.id);
    return finding;
  }

  findings(itemId: number): Finding[] {
    return (
      this.prepare(
        "SELECT * FROM findings WHERE item_id = ? AND item_id IN (SELECT id FROM items WHERE track_id = :track) ORDER BY id",
      ).all(itemId) as any[]
    ).map((r) => ({
      id: r.id,
      itemId: r.item_id,
      conversationId: num(r.conversation_id),
      summary: r.summary,
      claims: parse(r.claims_json, []),
      evidence: parse(r.evidence_json, []),
      actionability: str(r.actionability),
      claimSupport: parse(r.claim_support_json, []),
      createdAt: r.created_at,
    }));
  }

  // Images

  addImage(input: {
    origin: "source" | "generated";
    status: "ready" | "pending" | "failed";
    url?: string;
    filePath?: string;
    prompt?: string;
    model?: string;
    costUsd?: number;
    itemId?: number;
    error?: string;
  }): number {
    this.requireOwned("items", input.itemId);
    const r = this.prepare(
      "INSERT INTO images (track_id, origin, status, url, file_path, prompt, model, cost_usd, item_id, error, created_at) VALUES (:track, :origin, :status, :url, :file_path, :prompt, :model, :cost, :item_id, :error, :now)",
    ).run(
      bind({
        origin: input.origin,
        status: input.status,
        url: input.url,
        file_path: input.filePath,
        prompt: input.prompt,
        model: input.model,
        cost: input.costUsd,
        item_id: input.itemId,
        error: input.error,
        now: nowIso(),
      }),
    );
    return Number(r.lastInsertRowid);
  }

  updateImage(
    id: number,
    patch: {
      status: "ready" | "failed";
      filePath?: string;
      url?: string;
      costUsd?: number;
      model?: string;
      error?: string;
    },
  ): void {
    this.prepare(
      "UPDATE images SET status = :status, file_path = COALESCE(:file_path, file_path), url = COALESCE(:url, url), cost_usd = COALESCE(:cost, cost_usd), model = COALESCE(:model, model), error = :error WHERE track_id = :track AND id = :id",
    ).run(
      bind({
        id,
        status: patch.status,
        file_path: patch.filePath,
        url: patch.url,
        cost: patch.costUsd,
        model: patch.model,
        error: patch.error,
      }),
    );
  }

  image(id: number):
    | {
        id: number;
        origin: string;
        status: string;
        url?: string;
        filePath?: string;
        costUsd?: number;
      }
    | undefined {
    const r = this.prepare("SELECT * FROM images WHERE track_id = :track AND id = ?").get(
      id,
    ) as any;
    return r
      ? {
          id: r.id,
          origin: r.origin,
          status: r.status,
          url: str(r.url),
          filePath: str(r.file_path),
          costUsd: num(r.cost_usd),
        }
      : undefined;
  }

  // Stories

  addStory(input: {
    title: string;
    dek?: string;
    body?: string;
    hfs?: HfsScores;
    imageId?: number;
    sweepId?: number;
    itemIds: number[];
  }): number {
    for (const id of input.itemIds) this.requireOwned("items", id);
    this.requireOwned("images", input.imageId);
    this.requireOwned("sweeps", input.sweepId);
    const r = this.prepare(
      "INSERT INTO stories (track_id, title, dek, body_md, primary_category, hype, facts, signal, image_id, sweep_id, created_at) VALUES (:track, :title, :dek, :body, :primary, :hype, :facts, :signal, :image_id, :sweep_id, :now)",
    ).run(
      bind({
        title: input.title,
        dek: input.dek,
        body: input.body,
        primary: input.hfs?.primary,
        hype: input.hfs?.hype,
        facts: input.hfs?.facts,
        signal: input.hfs?.signal,
        image_id: input.imageId,
        sweep_id: input.sweepId,
        now: nowIso(),
      }),
    );
    const id = Number(r.lastInsertRowid);
    const link = this.prepare(
      "INSERT OR IGNORE INTO story_items (story_id, item_id) VALUES (?, ?)",
    );
    for (const itemId of input.itemIds) link.run(id, itemId);
    return id;
  }

  // Timelines: a story groups news cards about one evolving story, ordered by when each item was published.

  /** A new timeline, or the one this tool call already made (a replay). */
  addTimeline(input: { title: string; itemIds: number[]; sweepId?: number; toolCallId: string }): {
    id: number;
    created: boolean;
  } {
    for (const id of input.itemIds) this.requireOwned("items", id);
    this.requireOwned("sweeps", input.sweepId);
    const prior = this.prepare(
      "SELECT id FROM stories WHERE track_id = :track AND tool_call_id = ?",
    ).get(input.toolCallId) as { id: number } | undefined;
    if (prior) return { id: prior.id, created: false };
    const now = nowIso();
    const id = Number(
      this.prepare(
        "INSERT INTO stories (track_id, title, sweep_id, tool_call_id, created_at, updated_at) VALUES (:track, ?, ?, ?, ?, ?)",
      ).run(input.title, input.sweepId ?? null, input.toolCallId, now, now).lastInsertRowid,
    );
    this.extendTimeline(id, input.itemIds);
    return { id, created: true };
  }

  extendTimeline(id: number, itemIds: number[]): void {
    this.requireOwned("stories", id);
    for (const itemId of itemIds) this.requireOwned("items", itemId);
    const link = this.prepare(
      "INSERT OR IGNORE INTO story_items (story_id, item_id) VALUES (?, ?)",
    );
    for (const itemId of itemIds) link.run(id, itemId);
    this.prepare("UPDATE stories SET updated_at = ? WHERE track_id = :track AND id = ?").run(
      nowIso(),
      id,
    );
  }

  /** Item ids of a timeline, oldest published first. */
  timelineItems(id: number): number[] {
    return (
      this.prepare(
        `SELECT si.item_id FROM story_items si JOIN items i ON i.id = si.item_id
           WHERE i.track_id = :track AND si.story_id = ? AND (NOT EXISTS (SELECT 1 FROM story_memberships m WHERE m.story_id = si.story_id)
           OR EXISTS (SELECT 1 FROM cards c WHERE c.item_id = i.id AND c.kind = 'news')) ORDER BY coalesce(i.published_at, i.created_at), i.id`,
      ).all(id) as { item_id: number }[]
    ).map((r) => r.item_id);
  }

  timelineSummary(id: number): TimelineSummary | undefined {
    const r = this.prepare(
      `SELECT s.id, s.title, coalesce(s.updated_at, s.created_at) AS updated_at, count(si.item_id) AS n
         FROM stories s LEFT JOIN story_items si ON si.story_id = s.id WHERE s.track_id = :track AND s.id = ? GROUP BY s.id`,
    ).get(id) as any;
    return r
      ? {
          id: r.id,
          title: r.title,
          trackId: this.trackId,
          count: this.timelineItems(r.id).length,
          updatedAt: r.updated_at,
        }
      : undefined;
  }

  /** Most recently grown first. */
  timelines(limit = 20): TimelineSummary[] {
    return (
      this.prepare(
        `SELECT id FROM stories WHERE track_id = :track AND (SELECT count(*) FROM story_items si
            WHERE si.story_id = stories.id AND (NOT EXISTS (SELECT 1 FROM story_memberships m WHERE m.story_id=stories.id)
            OR EXISTS (SELECT 1 FROM cards c WHERE c.item_id=si.item_id AND c.kind='news'))) >= 2
            ORDER BY coalesce(updated_at, created_at) DESC, id DESC LIMIT ?`,
      ).all(limit) as { id: number }[]
    )
      .map((r) => this.timelineSummary(r.id)!)
      .filter((t) => t.count >= 2);
  }

  /** The news cards of a timeline, in timeline order. */
  timelineCards(id: number): Card[] {
    const order = this.timelineItems(id);
    const byItem = new Map(
      (
        this.prepare(
          `SELECT c.id, c.item_id FROM cards c JOIN story_items si ON si.item_id = c.item_id
             WHERE c.track_id = :track AND si.story_id = ? AND c.kind = 'news' ORDER BY c.id`,
        ).all(id) as { id: number; item_id: number }[]
      ).map((r) => [r.item_id, r.id]),
    );
    return order.flatMap((itemId) => {
      const cardId = byItem.get(itemId);
      return cardId ? [this.card(cardId)!] : [];
    });
  }

  /** The newest timeline an item belongs to, with the item's place in it. */
  timelineOf(itemId: number): TimelineRef | undefined {
    const r = this.prepare(
      "SELECT s.id, s.title FROM story_items si JOIN stories s ON s.id = si.story_id WHERE s.track_id = :track AND si.item_id = ? ORDER BY s.id DESC LIMIT 1",
    ).get(itemId) as { id: number; title: string } | undefined;
    if (!r) return undefined;
    const items = this.timelineItems(r.id);
    return items.length >= 2
      ? { id: r.id, title: r.title, index: items.indexOf(itemId) + 1, count: items.length }
      : undefined;
  }

  storyItems(storyId: number): number[] {
    return (
      this.prepare(
        "SELECT item_id FROM story_items WHERE story_id = ? AND story_id IN (SELECT id FROM stories WHERE track_id = :track) ORDER BY item_id",
      ).all(storyId) as any[]
    ).map((r) => r.item_id);
  }

  // Cards

  cardCount(sweepId: number): number {
    return (
      this.prepare("SELECT count(*) n FROM cards WHERE track_id = :track AND sweep_id = ?").get(
        sweepId,
      ) as {
        n: number;
      }
    ).n;
  }

  /** Record an item's publish date and where it came from (unknown keeps the date empty). */
  setPublished(id: number, at: string | undefined, source: string): void {
    this.prepare(
      "UPDATE items SET published_at = COALESCE(:at, published_at), date_source = :source, updated_at = :now WHERE track_id = :track AND id = :id",
    ).run(bind({ id, at, source, now: nowIso() }));
  }

  cardIdsForItem(itemId: number): number[] {
    return (
      this.prepare(
        "SELECT id FROM cards WHERE track_id = :track AND item_id = ? AND kind = 'news'",
      ).all(itemId) as any[]
    ).map((r) => r.id);
  }

  /** News cards whose item's newest hfs classification is older than `version` (or missing), oldest first. */
  cardsToRescore(version: number, limit = 500): Card[] {
    return (
      this.prepare(
        `SELECT c.id FROM cards c
           WHERE c.track_id = :track AND c.kind = 'news' AND c.item_id IS NOT NULL
             AND COALESCE((SELECT max(version) FROM classifications k WHERE k.item_id = c.item_id AND k.command = 'hfs'), 0) < ?
           ORDER BY c.id LIMIT ?`,
      ).all(version, limit) as any[]
    ).map((r) => this.card(r.id)!);
  }

  /** Put new Hype, Facts and Signal scores on a card. */
  setCardHfs(cardId: number, hfs: HfsScores, attention: number): void {
    this.prepare(
      "UPDATE cards SET hype = :hype, facts = :facts, signal = :signal, primary_category = :primary, labels_json = :labels, attention = :attention WHERE track_id = :track AND id = :id",
    ).run(
      bind({
        id: cardId,
        hype: hfs.hype,
        facts: hfs.facts,
        signal: hfs.signal,
        primary: hfs.primary,
        labels: hfs.labels,
        attention,
      }),
    );
  }

  /** The newest news card for an item. */
  cardForItem(itemId: number): Card | undefined {
    const r = this.prepare(
      "SELECT id FROM cards WHERE track_id = :track AND item_id = ? AND kind = 'news' ORDER BY id DESC LIMIT 1",
    ).get(itemId) as any;
    return r ? this.card(r.id) : undefined;
  }

  cardByToolCall(toolCallId: string): Card | undefined {
    const r = this.prepare("SELECT id FROM cards WHERE track_id = :track AND tool_call_id = ?").get(
      toolCallId,
    ) as any;
    return r ? this.card(r.id) : undefined;
  }

  addCard(input: {
    kind: "news" | "story";
    component: CardComponent;
    props: Record<string, unknown>;
    itemId?: number;
    storyId?: number;
    imageId?: number;
    hfs?: HfsScores;
    attention?: number;
    toolCallId: string;
    conversationId?: number;
    sweepId?: number;
  }): { card: Card; created: boolean } {
    this.requireOwned("items", input.itemId);
    this.requireOwned("stories", input.storyId);
    this.requireOwned("images", input.imageId);
    this.requireOwned("sweeps", input.sweepId);
    const write = () => {
      const existing = this.cardByToolCall(input.toolCallId);
      if (existing) return { card: existing, created: false };
      const r = this.prepare(
        `INSERT INTO cards (track_id, kind, component, item_id, story_id, image_id, props_json, hype, facts, signal, primary_category, labels_json, attention, tool_call_id, conversation_id, sweep_id, created_at)
         VALUES (:track, :kind, :component, :item_id, :story_id, :image_id, :props, :hype, :facts, :signal, :primary, :labels, :attention, :tool_call_id, :conversation_id, :sweep_id, :now)`,
      ).run(
        bind({
          kind: input.kind,
          component: input.component,
          item_id: input.itemId,
          story_id: input.storyId,
          image_id: input.imageId,
          props: input.props,
          hype: input.hfs?.hype,
          facts: input.hfs?.facts,
          signal: input.hfs?.signal,
          primary: input.hfs?.primary,
          labels: input.hfs?.labels,
          attention: input.attention,
          tool_call_id: input.toolCallId,
          conversation_id: input.conversationId,
          sweep_id: input.sweepId,
          now: nowIso(),
        }),
      );
      const cardId = Number(r.lastInsertRowid);
      this.evidence?.publish(this.trackId, cardId, input.itemId, input.conversationId);
      const storyId =
        input.storyId ?? (input.itemId ? this.membership(input.itemId)?.storyId : undefined);
      if (storyId)
        for (const member of this.storyMembers(storyId))
          if (member.id !== input.itemId) this.evidence?.publish(this.trackId, cardId, member.id);
      if (input.itemId) this.updateItem(input.itemId, { status: "presented" });
      if (input.itemId && packageRelease(this.item(input.itemId)!.url)) this.refreshReleases();
      return { card: this.card(Number(r.lastInsertRowid))!, created: true };
    };
    return this.db.isTransaction ? write() : tx(this.db, write);
  }

  setCardImage(cardId: number, imageId: number): void {
    this.requireOwned("cards", cardId);
    this.requireOwned("images", imageId);
    this.prepare("UPDATE cards SET image_id = ? WHERE track_id = :track AND id = ?").run(
      imageId,
      cardId,
    );
  }

  cardsWithImage(imageId: number): Card[] {
    return (
      this.prepare("SELECT id FROM cards WHERE track_id = :track AND image_id = ?").all(
        imageId,
      ) as any[]
    ).map((r) => this.card(r.id)!);
  }

  card(id: number): Card | undefined {
    const r = this.prepare(
      `SELECT c.*, i.url AS item_url, i.title AS item_title, i.source_name, i.published_at, i.discussion_url,
                i.matched_topic,
                s.title AS story_title,
                im.id AS im_id, im.origin AS im_origin, im.status AS im_status, im.url AS im_url
         FROM cards c
         LEFT JOIN items i ON i.id = c.item_id
         LEFT JOIN stories s ON s.id = c.story_id
         LEFT JOIN images im ON im.id = c.image_id
         WHERE c.track_id = :track AND c.id = ?`,
    ).get(id) as any;
    if (!r) return undefined;
    const props = parse<Record<string, unknown>>(r.props_json, {});
    const feedback = this.prepare(
      "SELECT signal, labels_json FROM feedback WHERE card_id = ? ORDER BY id DESC",
    ).all(id) as any[];
    const lastSignal = feedback.find((f) => f.signal)?.signal;
    const lastLabels = feedback.find((f) => f.labels_json)?.labels_json;
    const hfs: HfsScores | undefined =
      r.hype === null || r.hype === undefined
        ? undefined
        : {
            hype: r.hype,
            facts: r.facts,
            signal: r.signal,
            primary: r.primary_category,
            labels: parse(r.labels_json, []),
            ranked: (["signal", "facts", "hype"] as HfsCategory[])
              .map((category) => ({ category, score: r[category] as number, confidence: 0 }))
              .sort((a, b) => b.score - a.score),
            suspectCombo: false,
          };
    const membership = r.item_id ? this.membership(r.item_id) : undefined;
    return {
      id: r.id,
      trackId: r.track_id,
      kind: r.kind,
      component: r.component,
      props,
      itemId: num(r.item_id),
      storyId: membership?.storyId ?? num(r.story_id),
      hiddenFromFeed:
        (membership ? this.storyHead(membership.storyId) !== r.id : false) ||
        (r.item_id ? this.releaseHidden(r.item_id, r.id) : false),
      sources: membership ? this.storySources(membership.storyId) : undefined,
      itemIds: r.story_id ? this.storyItems(r.story_id) : undefined,
      title: String(
        props.title ??
          props.name ??
          props.claim ??
          props.quote ??
          r.item_title ??
          r.story_title ??
          "",
      ),
      url: str(r.item_url),
      sourceName: str(r.source_name),
      discussionUrl: str(r.discussion_url),
      publishedAt: str(r.published_at),
      topic: str(r.matched_topic),
      timeline: r.item_id ? this.timelineOf(r.item_id) : undefined,
      hfs,
      attention: num(r.attention),
      image: toImage(
        r.im_id
          ? { id: r.im_id, origin: r.im_origin, status: r.im_status, url: r.im_url }
          : undefined,
      ),
      feedback: { signal: lastSignal ?? undefined, labels: parse(lastLabels, []) },
      sweepId: num(r.sweep_id),
      toolCallId: r.tool_call_id,
      createdAt: r.created_at,
    };
  }

  /**
   * News cards that match, newest published first: by search every word appears in the card or its item; by keyword
   * the item's topic is the keyword or the text mentions it; by url the link contains it (an article or a site).
   */
  searchCards(by: TabBy, value: string, limit = 50): Card[] {
    const text = `lower(c.props_json || ' ' || COALESCE(i.title, '') || ' ' || COALESCE(i.excerpt, '') || ' ' ||
      COALESCE(i.source_name, '') || ' ' || COALESCE(i.matched_topic, '') || ' ' || coalesce((
      SELECT group_concat(mi.title || ' ' || coalesce(mi.excerpt, '') || ' ' || mi.url, ' ')
      FROM story_memberships cm JOIN story_memberships mm ON mm.story_id = cm.story_id
      JOIN items mi ON mi.id = mm.item_id WHERE cm.item_id = i.id), ''))`;
    const where = ["c.track_id = :track", "c.kind = 'news'", STORY_VISIBLE, RELEASE_VISIBLE];
    const params: Record<string, unknown> = { limit: Math.min(limit, 1000) };
    const term = value.trim().toLowerCase();
    if (by === "url") {
      where.push(`(instr(lower(i.url), :v) > 0 OR EXISTS (SELECT 1 FROM story_memberships cm
        JOIN story_memberships mm ON mm.story_id = cm.story_id JOIN items mi ON mi.id = mm.item_id
        WHERE cm.item_id = i.id AND instr(lower(mi.url), :v) > 0))`);
      params.v = urlKey(term);
    } else if (by === "keyword") {
      where.push(`(lower(i.matched_topic) = :v OR instr(${text}, :v) > 0)`);
      params.v = term;
    } else
      term
        .split(/\s+/)
        .filter(Boolean)
        .forEach((word, n) => {
          where.push(`instr(${text}, :w${n}) > 0`);
          params[`w${n}`] = word;
        });
    const sql = `SELECT c.id FROM cards c LEFT JOIN items i ON i.id = c.item_id WHERE ${where.join(" AND ")}
      ORDER BY COALESCE(i.published_at, c.created_at) DESC, c.id DESC LIMIT :limit`;
    return (this.prepare(sql).all(bind(params)) as any[]).map((r) => this.card(r.id)!);
  }

  /** News cards, oldest to newest. `before` pages backwards from a card id. Old story cards are not news. */
  cards(options: { before?: number; limit?: number } = {}): Card[] {
    const limit = Math.min(options.limit ?? 50, 200);
    const where: string[] = [
      "c.track_id = :track",
      "c.kind = 'news'",
      STORY_VISIBLE,
      RELEASE_VISIBLE,
    ];
    const params: Record<string, unknown> = { limit };
    if (options.before) {
      where.push("c.id < :before");
      params.before = options.before;
    }
    const sql = `SELECT c.id FROM cards c WHERE ${where.join(" AND ")} ORDER BY c.id DESC LIMIT :limit`;
    return (this.prepare(sql).all(bind(params)) as any[]).map((r) => this.card(r.id)!).reverse();
  }
}

/** A url to match on: no scheme, no www, no trailing slash, so a site or an article link both match. */
export const urlKey = (url: string) =>
  url
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
