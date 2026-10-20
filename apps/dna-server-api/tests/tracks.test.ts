import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openDb } from "../src/db/db.ts";
import { migrate, MIGRATIONS_DIR } from "../src/db/migrate.ts";
import { NewsRepo } from "../src/db/repos/news.ts";
import { SettingsRepo } from "../src/db/repos/settings.ts";
import { SourcesRepo } from "../src/db/repos/sources.ts";
import { SweepsRepo } from "../src/db/repos/sweeps.ts";
import { TasteRepo } from "../src/db/repos/taste.ts";
import { Schedule } from "../src/news/schedule.ts";
import { CONFIG_DIR, tempStore } from "./helpers.ts";
import { openStore } from "../src/db/store.ts";

function desks() {
  const fixture = tempStore();
  const { db } = fixture.store;
  db.prepare(
    "INSERT INTO tracks (id, name, description, profile, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run("test", "Test desk", "Inactive isolation fixture", "test", new Date().toISOString());
  const second = {
    news: new NewsRepo(db, "test"),
    sources: new SourcesRepo(db, "test"),
    sweeps: new SweepsRepo(db, "test"),
    taste: new TasteRepo(db, "test"),
    settings: new SettingsRepo(db, "test"),
  };
  return { ...fixture, second };
}

test("legacy migration preserves every row, ID, relationship, retry key and AI setting; reopen is idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "dna-track-upgrade-"));
  const legacyDir = join(dir, "legacy");
  mkdirSync(legacyDir);
  writeFileSync(
    join(legacyDir, "001_schema.sql"),
    readFileSync(join(MIGRATIONS_DIR, "001_schema.sql")),
  );
  const db = openDb(join(dir, "dna.sqlite"));
  try {
    migrate(db, legacyDir);
    const at = "2026-10-18T12:00:00.000Z";
    const insert = (table: string, values: Record<string, string | number | null>) => {
      db.prepare(
        `INSERT INTO ${table} (${Object.keys(values).join(",")}) VALUES (${Object.keys(values)
          .map(() => "?")
          .join(",")})`,
      ).run(...Object.values(values));
    };
    insert("settings", {
      key: "schedule",
      value: '{"everyMinutes":30,"cardsPerSweep":5}',
      updated_at: at,
    });
    insert("settings", { key: "compaction", value: '{"enabled":false}', updated_at: at });
    insert("sources", {
      id: 42,
      kind: "rss",
      name: "Custom",
      url: "https://example.com/feed",
      weight: 1.7,
      enabled: 0,
      created_at: at,
    });
    insert("source_cache", {
      id: 43,
      source_id: 42,
      url: "https://example.com/news",
      url_hash: "cache",
      content_md: "Saved body",
      fetched_at: at,
      expires_at: at,
    });
    insert("sweeps", {
      id: 44,
      request_id: "cron:old",
      trigger: "cron",
      status: "completed",
      created_at: at,
    });
    insert("items", {
      id: 45,
      sweep_id: 44,
      source_id: 42,
      cache_id: 43,
      url: "https://example.com/news",
      url_hash: "item",
      title: "Existing news",
      status: "presented",
      created_at: at,
      updated_at: at,
    });
    insert("classifications", {
      id: 46,
      item_id: 45,
      command: "hfs",
      version: 1,
      sweep_id: 44,
      created_at: at,
    });
    insert("findings", {
      id: 47,
      item_id: 45,
      conversation_id: 9,
      summary: "Research preserved",
      created_at: at,
    });
    insert("images", {
      id: 48,
      item_id: 45,
      origin: "source",
      status: "ready",
      url: "https://example.com/image",
      created_at: at,
    });
    insert("stories", { id: 49, title: "History", sweep_id: 44, image_id: 48, created_at: at });
    insert("story_items", { story_id: 49, item_id: 45 });
    insert("cards", {
      id: 50,
      kind: "news",
      component: "brief",
      item_id: 45,
      story_id: 49,
      image_id: 48,
      tool_call_id: "old-card",
      props_json: '{"title":"Existing news"}',
      conversation_id: 9,
      sweep_id: 44,
      created_at: at,
    });
    insert("feedback", { id: 51, card_id: 50, signal: "more", created_at: at });
    insert("keywords", {
      id: 52,
      kind: "topic",
      term: "custom topic",
      weight: 1.9,
      enabled: 0,
      created_at: at,
      updated_at: at,
    });
    insert("taste_questions", {
      id: 53,
      card_id: 50,
      item_id: 45,
      question: "Still open?",
      tool_call_id: "old-question",
      created_at: at,
    });
    insert("source_leads", {
      id: 54,
      site: "example.com",
      url: "https://example.com/news",
      card_id: 50,
      item_id: 45,
      source_id: 42,
      offered_sweep_id: 44,
      created_at: at,
    });
    insert("story_memberships", {
      item_id: 45,
      story_id: 49,
      role: "development",
      development_id: 45,
    });
    insert("story_decisions", {
      item_id: 45,
      other_item_id: 45,
      version: 1,
      evidence_hash: "old",
      state_json: "{}",
      answers_json: "{}",
      action: "different",
      sweep_id: 44,
      created_at: at,
    });
    insert("release_heads", {
      release_key: "old-package",
      latest_item_id: 45,
      visible_card_id: 50,
    });
    insert("agent_conversations", { conversation_id: 9, agent: "news-desk", created_at: at });
    insert("requests", {
      key: "old-retry",
      route: "POST /v1/agent/messages",
      status: 200,
      body: '{"status":"done"}',
      created_at: at,
    });
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name != 'schema_migrations'")
      .all()
      .map((r) => String(r.name));
    const before = new Map(
      tables.map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()]),
    );
    assert.deepEqual(migrate(db), [
      "002_tracks.sql",
      "003_cyber_security.sql",
      "004_archive.sql",
      "005_archive_evidence.sql",
      "006_archive_retention.sql",
    ]);
    for (const [table, rows] of before) {
      const after = db
        .prepare(`SELECT * FROM ${table}`)
        .all()
        .map((row) => {
          const {
            track_id,
            archive_extraction_id: _archive_extraction_id,
            archive_evidence_id: _archive_evidence_id,
            ...original
          } = row;
          if (track_id !== undefined) assert.equal(track_id, "ai", table);
          if (table === "requests")
            original.route = String(original.route).replace(/\?track=ai$/, "");
          return original;
        });
      // sqlite returns null-prototype rows; compare their plain object representations.
      assert.deepEqual(JSON.parse(JSON.stringify(after)), JSON.parse(JSON.stringify(rows)), table);
    }
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(db.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1);
    const settings = new SettingsRepo(db);
    assert.deepEqual(settings.get("schedule", {}), { everyMinutes: 30, cardsPerSweep: 5 });
    assert.deepEqual(settings.get("compaction", {}), { enabled: false });
    assert.deepEqual(migrate(db), []);
    db.close();
    const store = openStore(dir, CONFIG_DIR);
    assert.equal(store.news.card(50)!.feedback!.signal, "more");
    assert.equal(store.sources.get(42)!.enabled, false);
    assert.equal(new Schedule({ store, cronSchedule: "* * * * *" }).every(), 30);
    store.close();
  } finally {
    try {
      db.close();
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a rejected article in AI remains independent in another track, sharing the same cached content", () => {
  const { store, second, cleanup } = desks();
  try {
    const doc = store.sources.cache({
      url: "https://example.com/shared",
      contentMd: "One retrieved body",
      fetchVia: "http",
      ttlMinutes: 60,
    });
    const input = { url: doc.url, title: "Cross-topic research", cacheId: doc.id };
    const ai = store.news.upsertItem(input).item;
    store.news.updateItem(ai.id, { status: "rejected", relevance: 0.1 });
    const other = second.news.upsertItem(input).item;
    assert.notEqual(other.id, ai.id);
    assert.equal(other.cacheId, ai.cacheId);
    assert.equal(other.status, "candidate");
    second.news.updateItem(other.id, { relevance: 0.95 });
    assert.equal(store.news.item(other.id), undefined);
    assert.equal(second.news.item(ai.id), undefined);
    assert.equal(store.news.item(ai.id)!.relevance, 0.1);
    assert.equal(second.sources.cached(doc.url)!.contentMd, doc.contentMd);
    assert.equal(store.db.prepare("SELECT count(*) n FROM source_cache").get()!.n, 1);
  } finally {
    cleanup();
  }
});

test("sources, keywords, leads, schedules and request IDs are owned by their track", () => {
  const { store, second, cleanup } = desks();
  try {
    const input = {
      kind: "rss" as const,
      name: "Shared publisher",
      url: "https://example.com/feed",
    };
    const ai = store.sources.add(input);
    const other = second.sources.add(input);
    second.sources.update(other.id, { enabled: false, weight: 0.2 });
    assert.equal(store.sources.get(ai.id)!.weight, 1);
    assert.equal(store.sources.get(other.id), undefined);
    assert.equal(store.sources.update(other.id, { enabled: true }), undefined);
    assert.equal(store.sources.remove(other.id), false);
    assert.equal(second.sources.get(other.id)!.enabled, false);
    const keyword = store.taste.addKeyword("topic", "shared term", 1.8);
    const otherKeyword = second.taste.addKeyword("topic", "shared term", 0.3);
    store.taste.nudge(otherKeyword.id, 1);
    store.taste.markSearched([otherKeyword.id]);
    assert.equal(second.taste.keyword(otherKeyword.id)!.weight, 0.3);
    assert.equal(second.taste.keyword(otherKeyword.id)!.lastSearchedAt, undefined);
    assert.equal(store.taste.keyword(keyword.id)!.weight, 1.8);
    const lead = store.sources.addLead({ site: "example.com", url: "https://example.com" });
    const otherLead = second.sources.addLead({ site: "example.com", url: "https://example.com" });
    assert.notEqual(lead.id, otherLead.id);
    assert.equal(store.sources.lead(otherLead.id), undefined);
    const aiSweep = store.sweeps.create({
      requestId: "same-slot",
      trigger: "cron",
      status: "running",
    });
    const otherSweep = second.sweeps.create({
      requestId: "same-slot",
      trigger: "cron",
      status: "queued",
    });
    assert.notEqual(aiSweep.id, otherSweep.id);
    assert.deepEqual(
      store.sweeps.active().map((s) => s.id),
      [aiSweep.id],
    );
    store.sweeps.update(otherSweep.id, { status: "failed" });
    assert.equal(second.sweeps.get(otherSweep.id)!.status, "queued");
    const first = new Schedule({ store, cronSchedule: "* * * * *" });
    const next = new Schedule({
      store: { ...store, settings: second.settings, sweeps: second.sweeps },
      cronSchedule: "* * * * *",
    });
    first.set({ everyMinutes: 30, cardsPerSweep: 7 });
    next.set({ everyMinutes: null, cardsPerSweep: 3 });
    assert.equal(first.every(), 30);
    assert.equal(first.cards(), 7);
    assert.equal(next.every(), null);
    assert.equal(next.cards(), 3);
  } finally {
    cleanup();
  }
});

test("cards, research, feedback, stories and questions cannot link or mutate another track's records", () => {
  const { store, second, cleanup } = desks();
  try {
    const ai = store.news.upsertItem({ url: "https://example.com/story", title: "AI story" }).item;
    const other = second.news.upsertItem({ url: ai.url, title: "Other perspective" }).item;
    const card = (repo: NewsRepo, id: number, call: string) =>
      repo.addCard({
        kind: "news",
        component: "brief",
        props: { title: call },
        itemId: id,
        toolCallId: call,
      }).card;
    const a = card(store.news, ai.id, "ai-card");
    const b = card(second.news, other.id, "test-card");
    second.taste.addFeedback(b.id, { signal: "less" });
    assert.equal(store.taste.recentFeedback().length, 0);
    assert.equal(store.news.card(b.id), undefined);
    assert.deepEqual(
      store.news.cards().map((c) => c.id),
      [a.id],
    );
    assert.deepEqual(store.news.searchCards("search", "perspective"), []);
    assert.throws(() => store.taste.addFeedback(b.id, { signal: "more" }), /in track ai/);
    assert.throws(() => card(store.news, other.id, "bad-link"), /in track ai/);
    assert.throws(() => store.news.attachStory(ai, other, "coverage"), /in track ai/);
    assert.throws(
      () =>
        store.news.addFinding({
          itemId: other.id,
          summary: "Wrong desk",
          claims: [],
          evidence: [],
          claimSupport: [],
        }),
      /in track ai/,
    );
    const story = second.news.ensureStory(other);
    assert.equal(store.news.timelineSummary(story), undefined);
    assert.equal(store.news.storyHead(story), undefined);
    assert.deepEqual(store.news.storyMembers(story), []);
    assert.throws(() => store.news.extendTimeline(story, [ai.id]), /in track ai/);
    const q = second.taste.askQuestion({
      itemId: other.id,
      cardId: b.id,
      question: "Security?",
      toolCallId: "test-question",
    }).question;
    assert.equal(store.taste.question(q.id), undefined);
    assert.equal(store.taste.answer(q.id, ["signal"]), undefined);
    assert.equal(second.taste.question(q.id)!.status, "open");
    assert.throws(
      () =>
        store.taste.askQuestion({
          itemId: other.id,
          question: "Wrong desk?",
          toolCallId: "bad-question",
        }),
      /in track ai/,
    );
  } finally {
    cleanup();
  }
});

test("release heads remain local when the same package is covered by two tracks", () => {
  const { store, second, cleanup } = desks();
  try {
    const add = (repo: NewsRepo, version: string, date: string, call: string) => {
      const item = repo.upsertItem({
        url: `https://github.com/example/tool/releases/tag/${version}`,
        title: version,
        publishedAt: date,
      }).item;
      return repo.addCard({
        kind: "news",
        component: "brief",
        itemId: item.id,
        props: { title: version },
        toolCallId: call,
      }).card;
    };
    const old = add(store.news, "v1.0.0", "2026-10-17", "ai-release");
    const latest = add(second.news, "v2.0.0", "2026-10-18", "test-release");
    assert.deepEqual(
      store.news.cards().map((c) => c.id),
      [old.id],
    );
    assert.deepEqual(
      second.news.cards().map((c) => c.id),
      [latest.id],
    );
    assert.deepEqual(store.news.releaseCardIds(latest.itemId!), []);
    assert.equal(store.news.latestRelease(old.itemId!), old.itemId);
  } finally {
    cleanup();
  }
});

test("a failed rebuilding migration rolls back and restores foreign key enforcement", () => {
  const dir = mkdtempSync(join(tmpdir(), "dna-track-rollback-"));
  const db = openDb(join(dir, "dna.sqlite"));
  try {
    db.exec(
      "CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));",
    );
    writeFileSync(join(dir, "001_invalid.sql"), "INSERT INTO child VALUES (1, 999);");
    assert.throws(() => migrate(db, dir), /violates foreign keys/);
    assert.deepEqual(db.prepare("SELECT * FROM child").all(), []);
    assert.equal(db.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1);
    assert.throws(() => db.prepare("INSERT INTO child VALUES (2, 999)").run(), /FOREIGN KEY/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
