// Keywords per section, feedback on cards, and the taste questions the agent asks.
import type { HfsCategory, Keyword, TasteQuestion } from "@dna/sdk";
import { TrackRepo } from "../track-repo.ts";
import { bind, bool, nowIso, num, parse, str } from "../db.ts";

export type KeywordKind = Keyword["kind"];

const toKeyword = (r: any): Keyword => ({
  id: r.id,
  trackId: r.track_id,
  kind: r.kind,
  term: r.term,
  weight: r.weight,
  source: r.source,
  enabled: bool(r.enabled),
  lastSearchedAt: str(r.last_searched_at),
});

const toQuestion = (r: any): TasteQuestion => ({
  id: r.id,
  trackId: r.track_id,
  cardId: num(r.card_id),
  itemId: num(r.item_id),
  question: r.question,
  status: r.status,
  answerLabels: parse(r.answer_labels_json, []),
  createdAt: r.created_at,
  answeredAt: str(r.answered_at),
});

export class TasteRepo extends TrackRepo {
  seed(groups: Record<KeywordKind, string[]>): number {
    const insert = this.prepare(
      "INSERT OR IGNORE INTO keywords (track_id, kind, term, source, created_at, updated_at) VALUES (:track, ?, ?, 'seed', ?, ?)",
    );
    let added = 0;
    const now = nowIso();
    for (const [kind, terms] of Object.entries(groups))
      for (const term of terms) added += Number(insert.run(kind, term, now, now).changes);
    return added;
  }

  keywords(kind?: KeywordKind, enabledOnly = false): Keyword[] {
    const where = [
      "track_id = :track",
      kind ? "kind = :kind" : "",
      enabledOnly ? "enabled = 1" : "",
    ]
      .filter(Boolean)
      .join(" AND ");
    return (
      this.prepare(
        `SELECT * FROM keywords ${where ? `WHERE ${where}` : ""} ORDER BY kind, weight DESC, term`,
      ).all(bind({ ...(kind ? { kind } : {}) })) as any[]
    ).map(toKeyword);
  }

  keyword(id: number): Keyword | undefined {
    const r = this.prepare("SELECT * FROM keywords WHERE track_id = :track AND id = ?").get(id);
    return r ? toKeyword(r) : undefined;
  }

  findKeyword(kind: KeywordKind, term: string): Keyword | undefined {
    const r = this.prepare(
      "SELECT * FROM keywords WHERE track_id = :track AND kind = ? AND lower(term) = lower(?)",
    ).get(kind, term);
    return r ? toKeyword(r) : undefined;
  }

  addKeyword(kind: KeywordKind, term: string, weight = 1): Keyword {
    const now = nowIso();
    this.prepare(
      "INSERT INTO keywords (track_id, kind, term, weight, source, created_at, updated_at) VALUES (:track, ?, ?, ?, 'user', ?, ?) ON CONFLICT (track_id, kind, term) DO UPDATE SET enabled = 1, updated_at = excluded.updated_at",
    ).run(kind, term.trim(), weight, now, now);
    return this.findKeyword(kind, term.trim())!;
  }

  updateKeyword(
    id: number,
    patch: { weight?: number; enabled?: boolean; term?: string },
  ): Keyword | undefined {
    const k = this.keyword(id);
    if (!k) return undefined;
    this.prepare(
      "UPDATE keywords SET weight = :weight, enabled = :enabled, term = :term, updated_at = :now WHERE track_id = :track AND id = :id",
    ).run(
      bind({
        id,
        weight: clamp(patch.weight ?? k.weight),
        enabled: patch.enabled ?? k.enabled,
        term: patch.term?.trim() || k.term,
        now: nowIso(),
      }),
    );
    return this.keyword(id);
  }

  removeKeyword(id: number): boolean {
    return (
      Number(
        this.prepare("DELETE FROM keywords WHERE track_id = :track AND id = ?").run(id).changes,
      ) > 0
    );
  }

  /** Add delta to a weight, clamped to 0.1..2.0. */
  nudge(id: number, delta: number): Keyword | undefined {
    const k = this.keyword(id);
    if (!k) return undefined;
    return this.updateKeyword(id, { weight: Math.round((k.weight + delta) * 100) / 100 });
  }

  markSearched(ids: number[]): void {
    const now = nowIso();
    const stmt = this.prepare(
      "UPDATE keywords SET last_searched_at = ? WHERE track_id = :track AND id = ?",
    );
    for (const id of ids) stmt.run(now, id);
  }

  addFeedback(
    cardId: number,
    input: { signal?: "more" | "less"; labels?: HfsCategory[]; note?: string },
  ): void {
    this.requireOwned("cards", cardId);
    this.prepare(
      "INSERT INTO feedback (card_id, signal, labels_json, note, created_at) VALUES (:card_id, :signal, :labels, :note, :now)",
    ).run(
      bind({
        card_id: cardId,
        signal: input.signal,
        labels: input.labels,
        note: input.note,
        now: nowIso(),
      }),
    );
  }

  /** Recent feedback joined to card titles, newest first. */
  recentFeedback(limit = 20): {
    cardId: number;
    title: string;
    signal?: "more" | "less";
    labels: HfsCategory[];
    at: string;
  }[] {
    return (
      this.prepare(
        `SELECT f.card_id, f.signal, f.labels_json, f.created_at, COALESCE(json_extract(c.props_json, '$.title'), i.title, '') AS title
           FROM feedback f JOIN cards c ON c.id = f.card_id LEFT JOIN items i ON i.id = c.item_id
           WHERE c.track_id = :track ORDER BY f.id DESC LIMIT ?`,
      ).all(limit) as any[]
    ).map((r) => ({
      cardId: r.card_id,
      title: r.title,
      signal: r.signal ?? undefined,
      labels: parse(r.labels_json, []),
      at: r.created_at,
    }));
  }

  // Taste questions

  askQuestion(input: {
    cardId?: number;
    itemId?: number;
    question: string;
    toolCallId: string;
    conversationId?: number;
  }): { question: TasteQuestion; created: boolean } {
    this.requireOwned("cards", input.cardId);
    this.requireOwned("items", input.itemId);
    const existing = this.prepare(
      "SELECT * FROM taste_questions WHERE track_id = :track AND tool_call_id = ?",
    ).get(input.toolCallId);
    if (existing) return { question: toQuestion(existing), created: false };
    const open = input.itemId
      ? this.prepare(
          "SELECT * FROM taste_questions WHERE track_id = :track AND item_id = ? AND status = 'open'",
        ).get(input.itemId)
      : undefined;
    if (open) return { question: toQuestion(open), created: false };
    const r = this.prepare(
      "INSERT INTO taste_questions (track_id, card_id, item_id, question, tool_call_id, conversation_id, created_at) VALUES (:track, :card_id, :item_id, :question, :tool_call_id, :conversation_id, :now)",
    ).run(
      bind({
        card_id: input.cardId,
        item_id: input.itemId,
        question: input.question,
        tool_call_id: input.toolCallId,
        conversation_id: input.conversationId,
        now: nowIso(),
      }),
    );
    return { question: this.question(Number(r.lastInsertRowid))!, created: true };
  }

  question(id: number): TasteQuestion | undefined {
    const r = this.prepare("SELECT * FROM taste_questions WHERE track_id = :track AND id = ?").get(
      id,
    );
    return r ? toQuestion(r) : undefined;
  }

  questions(status?: TasteQuestion["status"]): TasteQuestion[] {
    const sql = status
      ? "SELECT * FROM taste_questions WHERE track_id = :track AND status = ? ORDER BY id"
      : "SELECT * FROM taste_questions WHERE track_id = :track ORDER BY id";
    return (status ? this.prepare(sql).all(status) : this.prepare(sql).all()).map(toQuestion);
  }

  answer(id: number, labels: HfsCategory[]): TasteQuestion | undefined {
    this.prepare(
      "UPDATE taste_questions SET status = 'answered', answer_labels_json = ?, answered_at = ? WHERE track_id = :track AND id = ? AND status = 'open'",
    ).run(JSON.stringify(labels), nowIso(), id);
    return this.question(id);
  }
}

export const clamp = (weight: number) => Math.min(2, Math.max(0.1, weight));
