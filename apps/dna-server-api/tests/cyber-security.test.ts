import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { DnaError, type Frame } from "@dna/sdk";
import { openDb } from "../src/db/db.ts";
import { bootServer, idle, settledSweep, type Booted } from "./server.ts";
import { until } from "./helpers.ts";

let server: Booted;
before(async () => {
  server = await bootServer({ DNA_FIXTURE_JEV_DELAY_MS: "20" });
});
after(() => server.cleanup());
const security = () => server.client.forTrack("cyber-security");
const cronSecurity = () => server.cron.forTrack("cyber-security");
const missing = (e: unknown) => e instanceof DnaError && e.status === 404;

test("Cyber Security has its own durable identity, broad sources, preferences, model and schedule", async () => {
  const tracks = await server.client.tracks();
  assert.deepEqual(
    tracks.map((t) => t.id),
    ["ai", "cyber-security"],
  );
  assert.notEqual(tracks[0].conversationId, tracks[1].conversationId);
  const state = await security().agent();
  assert.equal(state.conversationId, tracks[1].conversationId);
  assert.equal(state.schedule.everyMinutes, 30);
  assert.equal(state.schedule.cardsPerSweep, 5);
  const sources = await security().sources();
  assert.equal(sources.length, 6);
  assert.ok(sources.every((s) => s.trackId === "cyber-security"));
  assert.ok(sources.some((s) => s.name === "Cisco Talos Intelligence"));
  assert.ok((await security().keywords("topic")).some((k) => k.term === "cryptography research"));
  assert.ok(!(await server.client.keywords()).some((k) => k.term === "cryptography research"));
  await security().configure({ thinkingLevel: "high", deepResearchCount: 2 });
  assert.equal((await security().agent()).thinkingLevel, "high");
  assert.equal((await server.client.agent()).thinkingLevel, "low");
  assert.equal((await server.client.agent()).deepResearch.count, 1);
  const firstKeyword = (await server.client.keywords())[0];
  await assert.rejects(security().updateKeyword(firstKeyword.id, { weight: 0.2 }), missing);
  assert.equal(
    (await server.client.keywords()).find((k) => k.id === firstKeyword.id)!.weight,
    firstKeyword.weight,
  );
});

test("both queues run concurrently and produce separate feeds, research and telemetry", async () => {
  await server.client.addSource({
    kind: "rss",
    name: "Cross-topic research",
    url: "https://security.example.dev/feed.xml",
  });
  const [a, b] = await Promise.all([
    server.cron.forTrack("ai").newsSweep({ requestId: "two-desks:one", trigger: "test" }),
    cronSecurity().newsSweep({ requestId: "two-desks:one", trigger: "test" }),
  ]);
  assert.equal(a.data.status, "accepted");
  assert.equal(b.data.status, "accepted");
  assert.notEqual(a.data.sweep!.id, b.data.sweep!.id);
  const [aiDone, securityDone] = await Promise.all([
    settledSweep(server.client, a.data.sweep!.id),
    settledSweep(security(), b.data.sweep!.id),
  ]);
  assert.equal(aiDone.status, "completed");
  assert.equal(securityDone.status, "completed");
  assert.deepEqual(securityDone.audit?.missing, []);
  assert.ok(securityDone.cost!.jevCalls > 0);
  await Promise.all([idle(server.client), idle(security())]);
  const [aiFeed, securityFeed] = await Promise.all([server.client.feed(), security().feed()]);
  assert.ok(aiFeed.items.length > 0);
  assert.equal(securityFeed.items.length, 3);
  assert.ok(
    securityFeed.items.every(
      (c) => c.trackId === "cyber-security" && c.url?.startsWith("https://security.example.dev/"),
    ),
  );
  assert.ok(
    securityFeed.items.some((c) => /cryptography/i.test(c.title)),
    "broad research survives beyond vulnerability alerts",
  );
  assert.ok(!aiFeed.items.some((c) => /cryptography/i.test(c.title)));
  const db = openDb(join(server.dir, "dna.sqlite"));
  const shared = db
    .prepare("SELECT id, track_id, cache_id, relevance FROM items WHERE url = ? ORDER BY track_id")
    .all("https://security.example.dev/agent-boundary");
  assert.equal(shared.length, 2);
  assert.notEqual(shared[0].id, shared[1].id);
  assert.equal(shared[0].cache_id, shared[1].cache_id);
  assert.ok(shared.every((i) => Number(i.relevance) > 0));
  const differing = db
    .prepare("SELECT track_id, status FROM items WHERE url = ? ORDER BY track_id")
    .all("https://security.example.dev/cryptography");
  assert.equal(differing[0].status, "rejected");
  assert.equal(differing[1].status, "presented");
  db.close();
  const card = securityFeed.items[0];
  await assert.rejects(server.client.card(card.id), missing);
  await assert.rejects(server.client.feedback(card.id, { signal: "less" }), missing);
  await assert.rejects(server.client.sweep(b.data.sweep!.id), missing);
  const detail = await security().card(card.id);
  assert.ok(detail.findings.length);
  const runs = await security().runs({ sweepId: b.data.sweep!.id });
  assert.ok(runs.length > 1, "the desk and its dedicated researchers are tracked");
  assert.ok(
    !(await server.client.runs()).some((r) => runs.some((s) => r.runEntryId === s.runEntryId)),
  );
  for (const run of runs) {
    await assert.rejects(server.client.run(run.runEntryId), missing);
    await assert.rejects(server.client.transcript({ conversationId: run.conversationId }), missing);
  }
  const calls = await security().toolCalls({ sweepId: b.data.sweep!.id });
  assert.ok(calls.length);
  await assert.rejects(server.client.toolCall(calls[0].id), missing);
  assert.deepEqual(await server.client.toolCalls({ conversationId: runs[0].conversationId }), []);
  assert.deepEqual(await server.client.toolCalls({ sweepId: b.data.sweep!.id }), []);
  assert.deepEqual(await server.client.runs({ sweepId: b.data.sweep!.id }), []);
});

test("chat, feedback, stream subscriptions and source changes stay within their desk", async () => {
  const sec = security();
  await Promise.all([
    server.client.send({
      content: "AI-only conversation marker",
      requestId: "same-chat-id",
      waitMs: 10_000,
    }),
    sec.send({
      content: "Security-only conversation marker",
      requestId: "same-chat-id",
      waitMs: 10_000,
    }),
  ]);
  const aiText = JSON.stringify((await server.client.transcript()).items);
  const secText = JSON.stringify((await sec.transcript()).items);
  assert.match(aiText, /AI-only conversation marker/);
  assert.doesNotMatch(aiText, /Security-only conversation marker/);
  assert.match(secText, /Security-only conversation marker/);
  assert.doesNotMatch(secText, /AI-only conversation marker/);
  const secId = (await sec.agent()).conversationId;
  const response = await fetch(`${server.base}/v1/stream?track=ai&conversations=${secId}`, {
    headers: { authorization: `Bearer ${server.tokens.client}` },
  });
  assert.equal(response.status, 404);
  assert.match(response.headers.get("content-type")!, /json/);
  const aiTaste = await server.client.taste();
  const card = (await sec.feed()).items[0];
  await sec.feedback(card.id, { signal: "more", labels: ["facts"] });
  assert.deepEqual(await server.client.taste(), aiTaste);
  const source = (await sec.sources())[0];
  await assert.rejects(server.client.updateSource(source.id, { enabled: false }), missing);
  assert.equal((await sec.sources())[0].enabled, true);
  const stop = new AbortController();
  try {
    for await (const frame of sec.stream(stop.signal)) {
      assert.equal(frame.trackId, "cyber-security");
      if (frame.type === "hello") assert.equal(frame.mainConversationId, secId);
      if (frame.type === "agent.state") break;
    }
  } finally {
    stop.abort();
  }
});

test("the Security agent rejects another desk's sweep before searching or creating researchers", async () => {
  const sec = security();
  const sweep = (await server.client.sweeps())[0];
  const item = (await sec.feed()).items[0].itemId!;
  const db = openDb(join(server.dir, "dna.sqlite"));
  try {
    const before = Number(db.prepare("SELECT count(*) n FROM firecrawl_calls").get()!.n);
    const children = Number(
      db
        .prepare("SELECT count(*) n FROM agent_conversations WHERE track_id='cyber-security'")
        .get()!.n,
    );
    for (const [tool, args] of [
      ["search_web", { query: "security", sweep_id: sweep.id }],
      ["research_items", { sweep_id: sweep.id, batches: [{ item_ids: [item] }] }],
    ] as const) {
      const result = await sec.send({
        content: `FAUX_CALL ${tool} ${JSON.stringify(args)}`,
        waitMs: 10_000,
      });
      assert.equal(result.status, "done");
      const calls = await sec.toolCalls({ limit: 300 });
      const last = calls.filter((c) => c.toolName === tool).at(-1)!;
      assert.equal(last.isError, true);
      assert.match(last.resultText!, /No sweep/);
    }
    assert.equal(db.prepare("SELECT count(*) n FROM firecrawl_calls").get()!.n, before);
    assert.equal(
      db
        .prepare("SELECT count(*) n FROM agent_conversations WHERE track_id='cyber-security'")
        .get()!.n,
      children,
    );
  } finally {
    db.close();
  }
});

test("live feedback frames are delivered only to the selected desk's stream", async () => {
  const ai: Frame[] = [],
    sec: Frame[] = [];
  const stop = new AbortController();
  const read = async (client: typeof server.client, out: Frame[]) => {
    for await (const frame of client.stream(stop.signal)) out.push(frame);
  };
  const readers = [read(server.client, ai), read(security(), sec)];
  try {
    await until(
      () => ai.some((f) => f.type === "agent.state") && sec.some((f) => f.type === "agent.state"),
    );
    const card = (await security().feed()).items[0];
    await security().feedback(card.id, { signal: "more" });
    await until(() => sec.some((f) => f.type === "feed.card_updated" && f.card.id === card.id));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(ai.every((f) => f.trackId === "ai"));
    assert.ok(sec.every((f) => f.trackId === "cyber-security"));
    assert.ok(!ai.some((f) => f.type === "feed.card_updated" && f.card.id === card.id));
    await security().setCompaction({ enabled: false });
    await until(
      () =>
        ai.some((f) => f.type === "agent.state" && !f.state.compaction.enabled) &&
        sec.some((f) => f.type === "agent.state" && !f.state.compaction.enabled),
    );
    await server.client.setCompaction({ enabled: true });
  } finally {
    stop.abort();
    await Promise.allSettled(readers);
  }
});

test("an existing cron tick visits both desks, while pausing one leaves the other operational", async () => {
  await server.client.setSchedule(null);
  await security().setSchedule(30);
  const result = await server.cron.newsSweep({ requestId: "both:tick", scheduled: true });
  assert.equal(result.headers.get("x-dna-track"), "all");
  assert.equal(result.data.trackResults!.length, 2);
  assert.equal(result.data.trackResults!.find((r) => r.trackId === "ai")!.status, "not_due");
  const sec = result.data.trackResults!.find((r) => r.trackId === "cyber-security")!;
  assert.equal(sec.status, "accepted");
  const replay = await server.cron.newsSweep({ requestId: "both:tick", scheduled: true });
  assert.equal(
    replay.data.trackResults!.find((r) => r.trackId === "cyber-security")!.sweep!.id,
    sec.sweep!.id,
  );
  await settledSweep(security(), sec.sweep!.id);
  assert.equal((await server.client.schedule()).everyMinutes, null);
  const identities = await server.client.tracks();
  const feeds = await Promise.all([server.client.feed(), security().feed()]);
  await server.stop();
  await server.start();
  assert.deepEqual(await server.client.tracks(), identities);
  assert.deepEqual(await Promise.all([server.client.feed(), security().feed()]), feeds);
  assert.equal((await security().agent()).thinkingLevel, "high");
  assert.equal((await security().schedule()).everyMinutes, 30);
  assert.equal((await server.client.schedule()).everyMinutes, null);
  const db = openDb(join(server.dir, "dna.sqlite"));
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  const paid = db.prepare("SELECT track_id, count(*) n FROM jev_calls GROUP BY track_id").all();
  assert.equal(paid.length, 2);
  db.close();
});
