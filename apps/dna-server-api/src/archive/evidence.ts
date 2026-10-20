import type { ArchiveEntry, ArchiveHistory, ArchiveKind } from "@dna/sdk";
import { tx, type Db } from "../db/db.ts";
import type { Archive } from "./archive.ts";

/** Immutable inputs and publication links. URL mentions alone never establish source provenance. */
export class EvidenceArchive {
  constructor(
    readonly db: Db,
    readonly archive: Archive,
  ) {}

  private transaction<T>(run: () => T): T {
    return this.db.isTransaction ? run() : tx(this.db, run);
  }

  record(
    track: string,
    kind: string,
    input: unknown,
    ref: { itemId?: number; conversationId?: number; url?: string } = {},
  ): number {
    const text = JSON.stringify(input);
    return this.transaction(() => {
      if (
        ref.itemId &&
        !this.db.prepare("SELECT id FROM items WHERE id=? AND track_id=?").get(ref.itemId, track)
      )
        throw new Error("Evidence item belongs to another desk");
      const hash = this.archive.saveBody(Buffer.from(text));
      const id = Number(
        this.db
          .prepare(
            "INSERT INTO archive_evidence(track_id,item_id,conversation_id,kind,blob_hash,created_at,url) VALUES (?,?,?,?,?,?,?)",
          )
          .run(
            track,
            ref.itemId ?? null,
            ref.conversationId ?? null,
            kind,
            hash,
            new Date().toISOString(),
            ref.url ?? null,
          ).lastInsertRowid,
      );
      // Only link an extraction when a source passage in this exact input occurs in its immutable body.
      // Searching by URL/cache history is ownership discovery, never an attribution by itself.
      const item = ref.itemId
        ? this.db.prepare("SELECT url FROM items WHERE id=?").get(ref.itemId)
        : undefined;
      const url = ref.url ?? item?.url;
      if (url) {
        const passages: string[] = [];
        const visit = (v: unknown, key = "") => {
          if (
            typeof v === "string" &&
            ["excerpt", "evidence", "text", "contentMd"].includes(key) &&
            v.length >= 40
          )
            passages.push(...v.split(/\n{2,}/).filter((p) => p.length >= 40));
          else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) visit(x, k);
        };
        visit(input);
        const candidates = this.db
          .prepare("SELECT id,blob_hash FROM archive_extractions WHERE url=? ORDER BY id DESC")
          .all(url);
        for (const passage of passages) {
          for (const row of candidates) {
            const blob = this.db
              .prepare("SELECT expired_at FROM archive_blobs WHERE hash=?")
              .get(row.blob_hash);
            if (blob?.expired_at) continue;
            const doc = JSON.parse(this.archive.readBlob(String(row.blob_hash)).toString());
            if (
              [doc.contentMd, doc.excerpt].some(
                (body) => typeof body === "string" && body.includes(passage),
              )
            ) {
              this.db
                .prepare("INSERT OR IGNORE INTO archive_evidence_sources VALUES (?,?)")
                .run(id, row.id);
              break;
            }
          }
        }
      }
      return id;
    });
  }

  /** Freeze only evidence available at publication. Later reads never rewrite an old card's citations. */
  publish(
    track: string,
    cardId: number,
    itemId?: number,
    conversationId?: number,
    at?: string,
  ): void {
    const card = this.db
      .prepare("SELECT created_at FROM cards WHERE id=? AND track_id=?")
      .get(cardId, track);
    if (!card) throw new Error("No card in this desk");
    const published = at ?? String(card.created_at);
    this.db
      .prepare(`INSERT OR IGNORE INTO archive_citations(card_id,evidence_id,published_at)
      SELECT ?,id,? FROM archive_evidence WHERE track_id=? AND (item_id=? OR (kind LIKE 'read:%' AND conversation_id=? AND EXISTS (SELECT 1 FROM findings f,json_each(f.evidence_json) u WHERE f.item_id=? AND u.value=archive_evidence.url))) AND created_at<=?`)
      .run(
        cardId,
        published,
        track,
        itemId ?? null,
        conversationId ?? null,
        itemId ?? null,
        published,
      );
  }

  private table(kind: ArchiveKind) {
    return {
      version: "archive_versions",
      extraction: "archive_extractions",
      evidence: "archive_evidence",
    }[kind];
  }

  visible(track: string, kind: ArchiveKind, id: number): boolean {
    if (kind === "evidence")
      return !!this.db
        .prepare("SELECT id FROM archive_evidence WHERE id=? AND track_id=?")
        .get(id, track);
    if (kind === "extraction")
      return !!this.db
        .prepare(`SELECT e.id FROM archive_extractions e WHERE e.id=? AND (
      EXISTS (SELECT 1 FROM archive_extraction_inputs x JOIN archive_observations o ON o.id=x.observation_id WHERE x.extraction_id=e.id AND o.track_id=?) OR
      EXISTS (SELECT 1 FROM archive_cache_history h JOIN items i ON i.cache_id=h.cache_id WHERE h.extraction_id=e.id AND i.track_id=?) OR
      EXISTS (SELECT 1 FROM archive_evidence_sources s JOIN archive_evidence a ON a.id=s.evidence_id WHERE s.extraction_id=e.id AND a.track_id=?))`)
        .get(id, track, track, track);
    return !!this.db
      .prepare(`SELECT id FROM archive_versions v WHERE v.id=? AND (EXISTS (SELECT 1 FROM archive_observations o WHERE o.version_id=v.id AND o.track_id=?) OR EXISTS (
      SELECT 1 FROM archive_observations o JOIN archive_extraction_inputs x ON x.observation_id=o.id JOIN archive_evidence_sources s ON s.extraction_id=x.extraction_id JOIN archive_evidence a ON a.id=s.evidence_id WHERE o.version_id=v.id AND a.track_id=?) OR EXISTS (SELECT 1 FROM archive_observations o JOIN archive_extraction_inputs x ON x.observation_id=o.id JOIN archive_cache_history h ON h.extraction_id=x.extraction_id JOIN items i ON i.cache_id=h.cache_id WHERE o.version_id=v.id AND i.track_id=?))`)
      .get(id, track, track, track);
  }

  entry(track: string, kind: ArchiveKind, id: number): ArchiveEntry | undefined {
    if (!this.visible(track, kind, id)) return;
    const row = this.db
      .prepare(
        `SELECT t.*,b.bytes,b.expired_at FROM ${this.table(kind)} t JOIN archive_blobs b ON b.hash=t.blob_hash WHERE t.id=?`,
      )
      .get(id)!;
    const pins = this.db
      .prepare("SELECT track_id FROM archive_pins WHERE kind=? AND target_id=?")
      .all(kind, id);
    const observation =
      kind === "version"
        ? this.db
            .prepare(
              "SELECT count(*) n,max(observed_at) at FROM archive_observations WHERE version_id=? AND track_id=?",
            )
            .get(id, track)
        : undefined;
    const document =
      kind === "version"
        ? this.db.prepare("SELECT url FROM archive_documents WHERE id=?").get(row.document_id)
        : undefined;
    return {
      url: String(row.url ?? document?.url ?? "") || undefined,
      observations: observation ? Number(observation.n) : undefined,
      lastSeenAt: observation?.at as string | undefined,
      id,
      kind,
      hash: String(row.blob_hash),
      bytes: Number(row.bytes),
      at: String(row.first_seen_at ?? row.created_at),
      label: String(row.kind ?? row.extractor ?? row.representation),
      completeness: row.completeness as ArchiveEntry["completeness"],
      provenance: row.provenance as string | undefined,
      expiredAt: row.expired_at as string | undefined,
      pinned: pins.some((p) => p.track_id === track),
      protectedByOtherDesk: pins.some((p) => p.track_id !== track),
      sources:
        kind === "evidence"
          ? this.db
              .prepare("SELECT extraction_id id FROM archive_evidence_sources WHERE evidence_id=?")
              .all(id)
              .map((x) => Number(x.id))
          : [],
    };
  }

  history(track: string, cardId: number): ArchiveHistory {
    const card = this.db
      .prepare("SELECT item_id FROM cards WHERE id=? AND track_id=?")
      .get(cardId, track);
    if (!card) throw new Error("No card in this desk");
    const evidence = this.db
      .prepare(
        "SELECT evidence_id id,published_at FROM archive_citations WHERE card_id=? ORDER BY evidence_id",
      )
      .all(cardId)
      .map((r) => ({
        ...this.entry(track, "evidence", Number(r.id))!,
        citedAt: String(r.published_at),
      }));
    const extractions = this.db
      .prepare(`SELECT DISTINCT e.id FROM archive_extractions e WHERE EXISTS (
      SELECT 1 FROM archive_cache_history h JOIN items i ON i.cache_id=h.cache_id WHERE h.extraction_id=e.id AND i.id=? AND i.track_id=?) OR EXISTS (
      SELECT 1 FROM archive_evidence_sources s JOIN archive_citations c ON c.evidence_id=s.evidence_id WHERE s.extraction_id=e.id AND c.card_id=?) ORDER BY e.id DESC`)
      .all(card.item_id, track, cardId)
      .map((r) => this.entry(track, "extraction", Number(r.id)))
      .filter((x): x is ArchiveEntry => !!x);
    const versions: ArchiveEntry[] = [];
    for (const e of extractions)
      for (const row of this.db
        .prepare(
          `SELECT DISTINCT o.version_id id FROM archive_extraction_inputs x JOIN archive_observations o ON o.id=x.observation_id WHERE x.extraction_id=? AND o.version_id IS NOT NULL`,
        )
        .all(e.id)) {
        if (versions.some((v) => v.id === row.id)) continue;
        const v = this.entry(track, "version", Number(row.id));
        if (v) versions.push(v);
      }
    return { evidence, extractions, versions };
  }

  body(track: string, kind: ArchiveKind, id: number): Buffer | undefined {
    const entry = this.entry(track, kind, id);
    if (!entry || entry.expiredAt) return;
    return this.archive.readBlob(entry.hash);
  }

  pin(track: string, kind: ArchiveKind, id: number, pinned: boolean): void {
    this.transaction(() => {
      const entry = this.entry(track, kind, id);
      if (!entry || (pinned && entry.expiredAt))
        throw new Error("Original unavailable; an expired body cannot be pinned");
      if (pinned)
        this.db
          .prepare("INSERT OR IGNORE INTO archive_pins VALUES (?,?,?,?)")
          .run(track, kind, id, new Date().toISOString());
      else
        this.db
          .prepare("DELETE FROM archive_pins WHERE track_id=? AND kind=? AND target_id=?")
          .run(track, kind, id);
    });
  }
}
