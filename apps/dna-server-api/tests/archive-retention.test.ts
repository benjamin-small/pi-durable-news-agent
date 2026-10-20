import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { openStore } from "../src/db/store.ts";
import type { Store } from "../src/db/store.ts";
import { CONFIG_DIR, tempStore, fauxApp } from "./helpers.ts";
import { createHttpApp } from "../src/app.ts";
import { DnaClient, DnaError } from "@dna/sdk";

const NOW = new Date("2026-10-20T00:00:00Z"),
  OLD = "2025-01-01T00:00:00.000Z";
const url = "https://retention.test/article";
const body = "Source text with facts, examples, and references. ".repeat(50);
async function capture(store: Store, track = "ai", target = url, text = body) {
  const http = {
    get: async () => ({
      url: target,
      status: 200,
      text,
      headers: new Headers({ etag: '"same"' }),
      raw: { body: Buffer.from(text), complete: true },
    }),
    postJson: async () => {
      throw Error("unused");
    },
  };
  await store.archive.capture({ kind: "article", trackId: track }, http, async (h) => {
    const response = await h.get(target);
    store.sources.cache({
      url: target,
      title: "Archive source",
      contentMd: text,
      excerpt: text.slice(0, 100),
      captureIds: [response.captureId!],
      fetchVia: "http",
      ttlMinutes: 60,
    });
  });
  return Number(
    store.db.prepare("SELECT version_id FROM archive_observations ORDER BY id DESC LIMIT 1").get()!
      .version_id,
  );
}
function age(store: Store) {
  store.db.prepare("UPDATE archive_versions SET first_seen_at=?").run(OLD);
  store.db.prepare("UPDATE archive_extractions SET created_at=?").run(OLD);
  store.db.prepare("UPDATE archive_evidence SET created_at=?").run(OLD);
  store.db.prepare("UPDATE archive_blobs SET created_at=?").run(OLD);
}
function enable(store: Store) {
  store.retention.setPolicy({ enforcement: "enabled" }, store.retention.preview().token);
}

test("dry run is non-destructive, disabled by default, and policy changes require another preview", async () => {
  const { store, cleanup } = tempStore();
  try {
    await capture(store);
    age(store);
    const before = store.db.prepare("SELECT * FROM archive_blobs").all();
    const report = store.retention.preview(NOW);
    assert.equal(report.policy.ordinaryDays, 90);
    assert.equal(report.policy.citedDays, 365);
    assert.equal(report.policy.enforcement, "disabled");
    assert.equal(report.candidateCount, 2);
    assert.ok(report.reclaimableBytes > 0);
    assert.deepEqual(store.db.prepare("SELECT * FROM archive_blobs").all(), before);
    assert.throws(
      () => store.retention.cleanup({ previewToken: report.token, now: NOW }),
      /disabled/,
    );
    assert.throws(() => store.retention.setPolicy({ enforcement: "enabled" }), /Preview/);
    assert.throws(
      () => store.retention.setPolicy({ ordinaryDays: 120, citedDays: 90 }),
      /at least/,
    );
    assert.throws(
      () => store.retention.setPolicy({ ordinaryDays: 1, enforcement: "enabled" }, report.token),
      /Save changed/,
    );
    store.retention.setPolicy({ ordinaryDays: 100, citedDays: 400 });
    assert.throws(
      () => store.retention.setPolicy({ enforcement: "enabled" }, report.token),
      /Preview/,
    );
    for (const b of before) assert.ok(existsSync(store.archive.blobPath(String(b.hash))));
  } finally {
    cleanup();
  }
});

test("unchanged observations do not reset source retention, and cleanup clears expired cache bodies while keeping metadata", async () => {
  const { store, cleanup } = tempStore();
  try {
    const version = await capture(store);
    age(store);
    const cache = store.sources.cached(url)!;
    const item = store.news.upsertItem({
      url,
      title: "Archive source",
      cacheId: cache.id,
      excerpt: body.slice(0, 100),
    }).item;
    await capture(store);
    assert.equal(store.db.prepare("SELECT count(*) n FROM archive_versions").get()!.n, 1);
    assert.equal(store.db.prepare("SELECT count(*) n FROM archive_observations").get()!.n, 2);
    enable(store);
    const result = store.retention.cleanup({
      previewToken: store.retention.preview(NOW).token,
      now: NOW,
    });
    assert.equal(result.deleted, 2);
    assert.ok(store.evidence.entry("ai", "version", version)!.expiredAt);
    assert.equal(store.evidence.body("ai", "version", version), undefined);
    assert.equal(store.sources.cached(url)!.contentMd, undefined);
    assert.equal(store.news.item(item.id)!.excerpt, undefined);
    assert.equal(store.db.prepare("SELECT count(*) n FROM archive_observations").get()!.n, 2);
    assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.throws(() => store.evidence.pin("ai", "version", version, true), /expired/);
    // A genuine refetch can restore bytes, with the original immutable first-seen time retained.
    await capture(store);
    assert.ok(store.evidence.body("ai", "version", version));
    assert.equal(
      store.db.prepare("SELECT first_seen_at FROM archive_versions WHERE id=?").get(version)!
        .first_seen_at,
      OLD,
    );
  } finally {
    cleanup();
  }
});

test("latest exact-version citation extends raw inputs and normalized evidence; unrelated versions still expire", async () => {
  const { store, cleanup } = tempStore();
  try {
    const version = await capture(store);
    const cache = store.sources.cached(url)!;
    const i = store.news.upsertItem({ url, title: "Archive source", cacheId: cache.id }).item;
    const evidence = store.evidence.record(
      "ai",
      "judgment:hfs",
      { excerpt: body.slice(0, 200) },
      { itemId: i.id, sourceExtractionIds: [cache.archiveExtractionId!] },
    );
    store.news.addCard({
      kind: "news",
      component: "brief",
      props: {},
      itemId: i.id,
      toolCallId: "first",
    });
    age(store);
    store.db.prepare("UPDATE archive_citations SET published_at='2025-01-02T00:00:00Z'").run();
    await capture(
      store,
      "ai",
      url,
      "A completely different correction with additional new facts. ".repeat(20),
    );
    age(store);
    const c = store.news.addCard({
      kind: "news",
      component: "brief",
      props: {},
      itemId: i.id,
      toolCallId: "latest",
    }).card;
    store.db
      .prepare("UPDATE archive_citations SET published_at='2026-09-01T00:00:00Z' WHERE card_id=?")
      .run(c.id);
    const report = store.retention.preview(NOW);
    const hash = store.evidence.entry("ai", "version", version)!.hash;
    assert.ok(!report.candidates.some((x) => x.hash === hash));
    assert.ok(report.citedBytes > 0);
    assert.ok(report.candidateCount >= 2);
    enable(store);
    store.retention.cleanup({ previewToken: store.retention.preview(NOW).token, now: NOW });
    assert.ok(store.evidence.body("ai", "evidence", evidence));
    assert.ok(store.evidence.body("ai", "version", version));
    assert.ok(
      store.retention
        .preview(new Date("2027-09-02T00:00:00Z"))
        .candidates.some((x) => x.hash === hash),
    );
  } finally {
    cleanup();
  }
});

test("pins protect shared dependency bytes across desks and storage pressure cannot override them", async () => {
  const { store, cleanup } = tempStore();
  try {
    const text = randomBytes(1200000).toString("hex");
    const v = await capture(store, "ai", url, text);
    await capture(store, "cyber-security", url, text);
    age(store);
    const extraction = Number(
      store.db.prepare("SELECT id FROM archive_extractions LIMIT 1").get()!.id,
    );
    store.evidence.pin("cyber-security", "extraction", extraction, true);
    store.evidence.pin("ai", "version", v, true);
    store.evidence.pin("ai", "version", v, false);
    const p = store.retention.preview(NOW);
    assert.equal(p.candidateCount, 0);
    assert.ok(p.pinnedBytes > 0);
    store.retention.setPolicy({ storageBudgetBytes: 1048576 });
    assert.equal(store.retention.preview(NOW).overBudget, true);
    enable(store);
    assert.equal(
      store.retention.cleanup({ previewToken: store.retention.preview(NOW).token, now: NOW })
        .marked,
      0,
    );
    store.evidence.pin("cyber-security", "extraction", extraction, false);
    assert.ok(store.retention.preview(NOW).candidateCount > 0);
  } finally {
    cleanup();
  }
});

test("active acquisitions, judgments and sweeps defer cleanup; stale previews cannot race a pin", async () => {
  const { store, cleanup } = tempStore();
  try {
    const v = await capture(store);
    age(store);
    enable(store);
    const preview = store.retention.preview(NOW);
    store.evidence.pin("ai", "version", v, true);
    assert.throws(
      () => store.retention.cleanup({ previewToken: preview.token, now: NOW }),
      /changed/,
    );
    store.evidence.pin("ai", "version", v, false);
    store.archive.activeAcquisitions++;
    assert.equal(store.retention.cleanup({ scheduled: true, now: NOW }).status, "deferred");
    store.archive.activeAcquisitions--;
    const sweep = store.sweeps.create({ requestId: "active", trigger: "test", status: "running" });
    assert.equal(store.retention.cleanup({ scheduled: true, now: NOW }).status, "deferred");
    store.sweeps.update(sweep.id, { status: "completed" });
    assert.equal(
      store.retention.cleanup({ scheduled: true, busy: true, now: NOW }).status,
      "deferred",
    );
    assert.equal(
      store.db.prepare("SELECT count(*) n FROM archive_blobs WHERE expired_at IS NOT NULL").get()!
        .n,
      0,
    );
  } finally {
    cleanup();
  }
});

test("physical deletion failures are audited and retry without deleting protected data or starving later batches", async () => {
  const { store, cleanup } = tempStore();
  try {
    await capture(store);
    age(store);
    enable(store);
    const candidate = store.retention.preview(NOW).candidates[0];
    const file = store.archive.blobPath(candidate.hash),
      backup = `${file}.test-backup`;
    renameSync(file, backup);
    mkdirSync(file);
    const first = store.retention.cleanup({ scheduled: true, now: NOW, limit: 1 });
    assert.equal(first.status, "partial");
    assert.equal(first.marked, 1);
    assert.ok(
      store.db.prepare("SELECT error FROM archive_cleanup_entries WHERE run_id=?").get(first.id)!
        .error,
    );
    rmSync(file, { recursive: true });
    renameSync(backup, file);
    const second = store.retention.cleanup({ scheduled: true, now: NOW, limit: 1 });
    assert.equal(second.deleted, 1);
    assert.equal(second.status, "completed");
    const third = store.retention.cleanup({ scheduled: true, now: NOW, limit: 1 });
    assert.equal(third.deleted, 1);
    assert.equal(store.retention.preview(NOW).pendingBytes, 0);
  } finally {
    cleanup();
  }
});

test("SIGKILL after committed expiry resumes file deletion on restart and keeps provenance intact", async () => {
  const { store, dir, cleanup } = tempStore();
  try {
    await capture(store);
    age(store);
    enable(store);
    store.close();
    const source = `import {openStore} from ${JSON.stringify(new URL("../src/db/store.ts", import.meta.url).href)};
      const s=openStore(${JSON.stringify(dir)},${JSON.stringify(CONFIG_DIR)});
      s.archive.blobPath=()=>{process.kill(process.pid,'SIGKILL');throw Error('killed');};
      s.retention.cleanup({scheduled:true,now:new Date(${JSON.stringify(NOW.toISOString())})});`;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", source],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const [code, signal] = await once(child, "exit");
    assert.equal(code, null);
    assert.equal(signal, "SIGKILL");
    const reopened = openStore(dir, CONFIG_DIR);
    try {
      assert.ok(
        reopened.db
          .prepare(
            "SELECT hash FROM archive_blobs WHERE expired_at IS NOT NULL AND purged_at IS NULL",
          )
          .get(),
      );
      assert.equal(reopened.retention.cleanup({ scheduled: true, now: NOW }).deleted, 2);
      assert.equal(reopened.db.prepare("SELECT count(*) n FROM archive_versions").get()!.n, 1);
      assert.deepEqual(reopened.db.prepare("PRAGMA foreign_key_check").all(), []);
      assert.equal(reopened.retention.preview(NOW).pendingBytes, 0);
    } finally {
      reopened.close();
    }
  } finally {
    cleanup();
  }
});

test("orphan grace period, managed filenames and saved-reader-cache cleanup preserve referenced files", async () => {
  const { store, dir, cleanup } = tempStore();
  try {
    const version = await capture(store);
    const known = store.archive.blobPath(store.evidence.entry("ai", "version", version)!.hash);
    const orphan = store.archive.blobPath("a".repeat(64));
    mkdirSync(dirname(orphan), { recursive: true });
    writeFileSync(orphan, "uncommitted blob");
    utimesSync(orphan, new Date(OLD), new Date(OLD));
    const recent = store.archive.blobPath("b".repeat(64));
    mkdirSync(dirname(recent), { recursive: true });
    writeFileSync(recent, "fresh uncommitted blob");
    const unrelated = join(dirname(orphan), "keep-me.txt");
    writeFileSync(unrelated, "unmanaged file");
    const scrapes = join(dir, "scrapes");
    mkdirSync(scrapes);
    const saved = join(scrapes, `${"a".repeat(16)}.md`);
    writeFileSync(saved, "saved body");
    utimesSync(saved, new Date(OLD), new Date(OLD));
    const fresh = join(scrapes, `${"b".repeat(16)}.md`);
    writeFileSync(fresh, "fresh saved body");
    const p = store.retention.preview();
    assert.equal(p.orphanCandidateCount, 1);
    assert.ok(p.orphanBytes > 0);
    enable(store);
    const result = store.retention.cleanup({ scheduled: true });
    assert.equal(result.deleted, 1);
    assert.equal(existsSync(orphan), false);
    assert.equal(existsSync(recent), true);
    assert.equal(existsSync(unrelated), true);
    assert.equal(existsSync(known), true);
    assert.equal(store.retention.clearScrapeCache(), 1);
    assert.equal(existsSync(saved), false);
    assert.equal(existsSync(fresh), true);
  } finally {
    cleanup();
  }
});

test("retention API is global across desks, client scoped, validates previews, and leaves deletion disabled on migration", async () => {
  const { app, cleanup } = await fauxApp({
    DNA_CLIENT_TOKEN: "retention-client",
    DNA_CRON_TOKEN: "retention-cron",
  });
  const server = createHttpApp(app).http.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const client = new DnaClient(base, app.config.clientToken, "ai");
  try {
    const p = await client.archiveRetention();
    assert.equal(p.policy.enforcement, "disabled");
    assert.deepEqual((await client.forTrack("cyber-security").archiveRetention()).policy, p.policy);
    await assert.rejects(
      new DnaClient(base, app.config.cronToken).archiveRetention(),
      (e: unknown) => e instanceof DnaError && e.status === 403,
    );
    await assert.rejects(client.archivePolicy({ enforcement: "enabled" }), /Preview/);
    await client.archivePolicy({ enforcement: "enabled" }, p.token);
    await assert.rejects(client.archiveCleanup(p.token), /changed/);
    const r = await client.archiveCleanup((await client.archiveRetention()).token);
    assert.equal(r.status, "completed");
    await client.archivePolicy({ enforcement: "disabled" });
    await assert.rejects(
      client.archiveCleanup((await client.archiveRetention()).token),
      /disabled/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await cleanup();
  }
});
