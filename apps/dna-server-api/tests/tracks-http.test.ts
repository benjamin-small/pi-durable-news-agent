import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { DnaClient, DnaError } from "@dna/sdk";
import { openDb } from "../src/db/db.ts";
import { bootServer, type Booted } from "./server.ts";

let server: Booted;
before(async () => {
  server = await bootServer();
});
after(() => server.cleanup());

test("legacy and explicit AI clients reach the same desk; its conversation, transcript and settings survive restart", async () => {
  const client = server.client.forTrack("ai");
  const track = (await client.tracks())[0];
  assert.equal(track.id, "ai");
  assert.equal(track.name, "AI");
  assert.ok(track.conversationId);
  assert.deepEqual((await client.info()).track, (await server.client.info()).track);
  assert.equal((await client.raw("info")).headers.get("x-dna-track"), "ai");
  await client.setSchedule(30);
  await client.configure({ thinkingLevel: "minimal" });
  await client.send({
    content: "Remember this AI desk conversation",
    requestId: "track:chat",
    waitMs: 10_000,
  });
  const transcript = await client.transcript();
  assert.equal(transcript.conversationId, track.conversationId);
  assert.ok(transcript.items!.length);
  await server.stop();
  await server.start();
  assert.deepEqual((await client.tracks())[0], track);
  assert.deepEqual((await client.transcript()).items, transcript.items);
  assert.equal((await client.schedule()).everyMinutes, 30);
  assert.equal((await server.client.schedule()).everyMinutes, 30);
  assert.equal((await client.agent()).thinkingLevel, "minimal");
});

test("unknown, malformed and inactive tracks fail before replay, settings changes or workflow submission", async () => {
  const db = openDb(join(server.dir, "dna.sqlite"));
  db.prepare(
    "INSERT INTO tracks (id, name, description, profile, created_at) VALUES ('inactive', 'Inactive', 'Test only', 'test', ?)",
  ).run(new Date().toISOString());
  const count = Number(db.prepare("SELECT count(*) n FROM sweeps").get()!.n);
  db.close();
  const status = (expected: number) => (e: unknown) =>
    e instanceof DnaError && e.status === expected;
  await server.client.send({ content: "AI retry", requestId: "same-key", waitMs: 10_000 });
  await assert.rejects(
    server.client
      .forTrack("cyber-security")
      .send({ content: "wrong track", requestId: "same-key" }),
    status(404),
  );
  await assert.rejects(server.client.forTrack("inactive").setSchedule(5), status(503));
  await assert.rejects(
    server.cron.forTrack("inactive").newsSweep({ requestId: "inactive:tick", scheduled: true }),
    status(503),
  );
  await assert.rejects(
    server.cron.forTrack("missing").newsSweep({ requestId: "missing:tick" }),
    status(404),
  );
  await assert.rejects(server.client.call("info", { query: { track: "AI" } }), status(400));
  await assert.rejects(
    server.client.call("schedule.set", { body: { everyMinutes: 5, trackId: "inactive" } }),
    status(400),
  );
  await assert.rejects(
    server.client.forTrack("ai").call("info", { query: { track: "inactive" } }),
    /track-bound client/,
  );
  const response = await fetch(`${server.base}/v1/info?track=ai&track=inactive`, {
    headers: { authorization: `Bearer ${server.tokens.client}` },
  });
  assert.equal(response.status, 400);
  assert.equal((await server.client.tracks()).length, 1);
  assert.equal((await server.client.schedule()).everyMinutes, 30);
  const check = openDb(join(server.dir, "dna.sqlite"));
  assert.equal(check.prepare("SELECT count(*) n FROM sweeps").get()!.n, count);
  check.close();
});

test("track-scoped response replay still requires the correct token", async () => {
  const body = { content: "Cached answer", requestId: "auth:track", waitMs: 10_000 };
  await server.client.forTrack("ai").send(body);
  const response = await server.client
    .forTrack("ai")
    .raw("agent.messages", { body, idempotencyKey: body.requestId });
  assert.equal(response.headers.get("idempotent-replay"), "true");
  await assert.rejects(
    new DnaClient(server.base).forTrack("ai").send(body),
    (e: unknown) => e instanceof DnaError && e.status === 401,
  );
  await assert.rejects(
    server.cron.forTrack("ai").send(body),
    (e: unknown) => e instanceof DnaError && e.status === 403,
  );
});

test("the SDK stream carries the selected AI track on snapshots and state", async () => {
  const stop = new AbortController();
  const types = new Set<string>();
  try {
    for await (const frame of server.client.forTrack("ai").stream(stop.signal)) {
      assert.equal(frame.trackId, "ai");
      types.add(frame.type);
      if (frame.type === "agent.state") break;
    }
  } finally {
    stop.abort();
  }
  assert.ok(types.has("hello"));
  assert.ok(types.has("agent.snapshot"));
  assert.ok(types.has("agent.state"));
});
