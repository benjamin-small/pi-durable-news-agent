import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { UsageDoc } from "@earendil-works/pi-durable";
import { openDb } from "../src/db/db.ts";
import { bootServer, settledSweep } from "./server.ts";
import { fauxApp, until } from "./helpers.ts";

test("both desk queues resume after SIGKILL with stable identities and no repeated completed judgments", async () => {
  const server = await bootServer({ DNA_FIXTURE_JEV_DELAY_MS: "120", DNA_GATE_CHUNK: "1" });
  const db = openDb(join(server.dir, "dna.sqlite"));
  try {
    const tracks = await server.client.tracks();
    const [a, b] = await Promise.all([
      server.cron.forTrack("ai").newsSweep({ requestId: "crash:ai", trigger: "test" }),
      server.cron
        .forTrack("cyber-security")
        .newsSweep({ requestId: "crash:security", trigger: "test" }),
    ]);
    await until(
      () => {
        const active = db.prepare("SELECT count(*) n FROM sweeps WHERE status='running'").get()!.n;
        const judged = db
          .prepare(
            "SELECT track_id, count(*) n FROM items WHERE relevance IS NOT NULL AND worth IS NOT NULL GROUP BY track_id",
          )
          .all();
        return active === 2 && judged.length === 2 && judged.every((r) => Number(r.n) >= 1);
      },
      20_000,
      "both desk gates to commit judgments",
    );
    await server.stop("SIGKILL");
    const judged = db
      .prepare("SELECT id FROM items WHERE relevance IS NOT NULL AND worth IS NOT NULL")
      .all()
      .map((r) => Number(r.id));
    const before = new Map(
      db
        .prepare(
          "SELECT item_id, count(*) n FROM jev_calls WHERE command='relevance' GROUP BY item_id",
        )
        .all()
        .map((r) => [r.item_id, r.n]),
    );
    await server.start();
    const [ai, security] = await Promise.all([
      settledSweep(server.client.forTrack("ai"), a.data.sweep!.id, 60_000),
      settledSweep(server.client.forTrack("cyber-security"), b.data.sweep!.id, 60_000),
    ]);
    assert.equal(ai.status, "completed");
    assert.equal(security.status, "completed");
    assert.deepEqual(ai.audit?.missing, []);
    assert.deepEqual(security.audit?.missing, []);
    assert.deepEqual(await server.client.tracks(), tracks);
    const after = new Map(
      db
        .prepare(
          "SELECT item_id, count(*) n FROM jev_calls WHERE command='relevance' GROUP BY item_id",
        )
        .all()
        .map((r) => [r.item_id, r.n]),
    );
    for (const id of judged)
      assert.equal(after.get(id), before.get(id), `completed judgment for ${id} is reused`);
    const duplicate = db
      .prepare(
        "SELECT track_id,item_id,count(*) n FROM cards WHERE kind='news' GROUP BY track_id,item_id HAVING n>1",
      )
      .all();
    assert.deepEqual(duplicate, []);
    assert.equal((await server.client.forTrack("cyber-security").feed()).items.length, 3);
  } finally {
    db.close();
    await server.cleanup();
  }
});

test("the security conversation receipt recovers a lost application binding without creating another agent", async () => {
  const server = await bootServer();
  try {
    const before = await server.client.tracks();
    await server.stop();
    const db = openDb(join(server.dir, "dna.sqlite"));
    db.prepare("UPDATE tracks SET conversation_id=NULL WHERE id='cyber-security'").run();
    db.close();
    await server.start();
    assert.deepEqual(await server.client.tracks(), before);
  } finally {
    await server.cleanup();
  }
});

test("search reservations and daily provider credits are shared while usage attribution stays scoped", async () => {
  const { app, cleanup } = await fauxApp({ FIRECRAWL_API_KEY: "fc-fixture" });
  try {
    const security = app.desks.get("cyber-security")!;
    assert.equal(app.search, security.search);
    assert.equal(app.http, security.http);
    const a = app.store.sweeps.create({
      requestId: "budget:ai",
      trigger: "test",
      status: "running",
    });
    const b = security.store.sweeps.create({
      requestId: "budget:security",
      trigger: "test",
      status: "running",
    });
    app.store.globalTelemetry.firecrawl({
      endpoint: "search",
      status: "ok",
      sweepId: a.id,
      creditsUsed: 4,
    });
    app.store.globalTelemetry.firecrawl({
      endpoint: "search",
      status: "ok",
      sweepId: b.id,
      creditsUsed: 8,
    });
    assert.equal(app.store.telemetry.creditsToday(), 4);
    assert.equal(security.store.telemetry.creditsToday(), 8);
    assert.equal(app.search.budget().dailyUsed, 12);
    assert.equal(security.search.budget().dailyUsed, 12);
    assert.deepEqual(app.store.telemetry.creditsForSweep(b.id), 0);
    assert.deepEqual(security.store.telemetry.creditsForSweep(a.id), 0);
  } finally {
    await cleanup();
  }
});

test("model usage ledgers, including compaction charges, are attributed to their own desk", async () => {
  const { app, cleanup } = await fauxApp();
  try {
    const security = app.desks.get("cyber-security")!;
    const record = (tokens: number, cost: number) => ({
      input: tokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: tokens,
      cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
    });
    await app.harness.harness.commit(async (tx) => {
      (await tx.doc(UsageDoc, app.main.id)).models["faux/ai"] = record(5, 0.5);
      (await tx.doc(UsageDoc, security.main.id)).models["faux/security"] = record(20, 1.5);
    }, app.ctx);
    assert.equal(app.modelUsage().tokens, 5);
    assert.equal(app.modelUsage().cost, 0.5);
    assert.equal(security.modelUsage().tokens, 20);
    assert.equal(security.modelUsage().cost, 1.5);
  } finally {
    await cleanup();
  }
});
