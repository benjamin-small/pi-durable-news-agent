import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { createHttpApp } from "../src/app.ts";
import { DnaClient } from "@dna/sdk";
import { fauxApp, tempStore } from "./helpers.ts";
import { scopeStore } from "../src/db/store.ts";

const url = "https://evidence.test/article";
const old = "Original source passage. ".repeat(30),
  updated = "A later correction. ".repeat(30);
function item(store: ReturnType<typeof tempStore>["store"], text = old) {
  const cache = store.sources.cache({
    url,
    title: "Evidence history",
    contentMd: text,
    excerpt: text.slice(0, 100),
    fetchVia: "http",
    ttlMinutes: 60,
  });
  return store.news.upsertItem({ url, title: "Evidence history", cacheId: cache.id, excerpt: text })
    .item;
}
function card(store: ReturnType<typeof tempStore>["store"], id: number) {
  return store.news.addCard({
    kind: "news",
    component: "brief",
    props: { title: "Evidence history" },
    itemId: id,
    toolCallId: `card-${id}`,
  }).card;
}

test("publication freezes exact input and extraction; later shorter corrections and caller text do not rewrite provenance", () => {
  const { store, cleanup } = tempStore();
  try {
    const i = item(store);
    const id = store.evidence.record(
      "ai",
      "judgment:hfs",
      { excerpt: old.slice(0, 240), claims: ["test"] },
      { itemId: i.id },
    );
    const c = card(store, i.id);
    const before = store.evidence.history("ai", c.id);
    assert.equal(before.evidence[0].id, id);
    assert.equal(before.evidence[0].sources.length, 1);
    const exact = store.evidence.body("ai", "evidence", id)!;
    item(store, updated);
    const supplied = store.evidence.record(
      "ai",
      "judgment:claim-support",
      { evidence: "Caller supplied text with no corresponding captured body. ".repeat(5) },
      { itemId: i.id },
    );
    assert.equal(store.evidence.entry("ai", "evidence", supplied)!.sources.length, 0);
    assert.deepEqual(store.evidence.history("ai", c.id).evidence, before.evidence);
    assert.deepEqual(store.evidence.body("ai", "evidence", id), exact);
    assert.equal(store.evidence.history("ai", c.id).extractions.length, 2);
    assert.equal(
      store.news.addCard({
        kind: "news",
        component: "brief",
        props: {},
        itemId: i.id,
        toolCallId: `card-${i.id}`,
      }).created,
      false,
    );
    assert.equal(store.evidence.history("ai", c.id).evidence.length, 1);
  } finally {
    cleanup();
  }
});

test("desk ownership, independent pins and expired tombstones", () => {
  const { store, cleanup } = tempStore();
  try {
    const i = item(store),
      c = card(store, i.id);
    const e = store.evidence.history("ai", c.id).extractions[0];
    assert.equal(store.evidence.entry("cyber-security", "extraction", e.id), undefined);
    assert.throws(() => store.evidence.pin("cyber-security", "extraction", e.id, true));
    assert.throws(() =>
      store.evidence.record("cyber-security", "judgment:hfs", { excerpt: old }, { itemId: i.id }),
    );
    const cyber = scopeStore(
      store,
      "cyber-security",
      join(import.meta.dirname, "../config/cyber-security"),
    );
    item(cyber);
    store.evidence.pin("ai", "extraction", e.id, true);
    store.evidence.pin("cyber-security", "extraction", e.id, true);
    store.evidence.pin("ai", "extraction", e.id, false);
    assert.equal(store.evidence.entry("ai", "extraction", e.id)!.protectedByOtherDesk, true);
    assert.equal(store.evidence.entry("cyber-security", "extraction", e.id)!.pinned, true);
    store.db
      .prepare("UPDATE archive_blobs SET expired_at=? WHERE hash=?")
      .run(new Date().toISOString(), e.hash);
    assert.equal(store.evidence.body("ai", "extraction", e.id), undefined);
    assert.throws(() => store.evidence.pin("ai", "extraction", e.id, true));
    assert.ok(store.evidence.entry("ai", "extraction", e.id)!.expiredAt);
  } finally {
    cleanup();
  }
});

test("archive API requires scopes and desk ownership; HTML downloads force attachment and text previews stay inert", async () => {
  const { app, cleanup } = await fauxApp({
    DNA_CLIENT_TOKEN: "evidence-test-client",
    DNA_CRON_TOKEN: "evidence-test-cron",
  });
  const server = createHttpApp(app).http.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const body = "<html><script>alert('unsafe')</script><body>test</body></html>";
    const http = {
      get: async () => ({
        status: 200,
        url,
        text: body,
        headers: new Headers({ "content-type": "text/html" }),
        raw: { body: Buffer.from(body), complete: true },
      }),
      postJson: async () => {
        throw Error("unused");
      },
    };
    await app.store.archive.capture({ kind: "article", trackId: "ai" }, http, async (h) => {
      const r = await h.get(url);
      app.store.sources.cache({
        url,
        contentMd: old,
        title: "Evidence history",
        captureIds: [r.captureId!],
        fetchVia: "http",
        ttlMinutes: 60,
      });
    });
    const i = app.store.news.upsertItem({
      url,
      title: "Evidence history",
      cacheId: app.store.sources.cached(url)!.id,
    }).item;
    const c = card(app.store, i.id);
    const client = new DnaClient(base, app.config.clientToken, "ai");
    const history = await client.archiveHistory(c.id),
      v = history.versions[0];
    assert.ok(v);
    assert.equal((await client.archivePreview("version", v.id)).text, body);
    const download = await fetch(client.archiveDownloadUrl("version", v.id), {
      headers: { authorization: `Bearer ${app.config.clientToken}` },
    });
    assert.match(download.headers.get("content-disposition")!, /^attachment;/);
    assert.equal(download.headers.get("x-content-type-options"), "nosniff");
    assert.match(download.headers.get("content-security-policy")!, /sandbox/);
    assert.equal(await download.text(), body);
    assert.equal((await client.archivePin("version", v.id, true)).entry.pinned, true);
    await assert.rejects(
      new DnaClient(base, app.config.cronToken, "ai").archivePin("version", v.id, false),
      /scope|allowed|permission|forbidden|grant/i,
    );
    await assert.rejects(
      new DnaClient(base, app.config.clientToken, "cyber-security").archivePreview("version", v.id),
      /No archived/,
    );
    assert.equal((await fetch(client.archiveDownloadUrl("version", v.id))).status, 401);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup();
  }
});
