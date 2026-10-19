import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { CAPABILITY_IDS } from "@dna/sdk";
import { bootServer, idle, settledSweep, type Booted } from "../../dna-server-api/tests/server.ts";
import { CLI_COMMANDS } from "../src/coverage.ts";

const BIN = resolve(import.meta.dirname, "../bin/dna.mjs");
const run = promisify(execFile);
let s: Booted;
let dir: string;

before(async () => {
  s = await bootServer();
  dir = mkdtempSync(join(tmpdir(), "dna-cli-"));
  writeFileSync(join(dir, "net.yaml"), `devices:\n  local: { kind: local, url: ${s.base} }\n`);
  const started = await s.cron.newsSweep({ requestId: "cli:1" });
  await settledSweep(s.client, started.data.sweep!.id);
  await idle(s.client);
});
after(async () => {
  await s.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

async function dna(...argv: string[]): Promise<{ code: number; json: any; stderr: string }> {
  const env = {
    ...process.env,
    NODE_NO_WARNINGS: "1",
    DNA_ENV_FILE: "none",
    DNA_NETWORK_FILE: join(dir, "net.yaml"),
    DNA_LOG_DIR: join(dir, "logs"),
    DNA_CLIENT_TOKEN: s.tokens.client,
    DNA_CRON_TOKEN: s.tokens.cron,
  };
  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, "--json", ...argv], {
      env,
      timeout: 60_000,
    });
    return { code: 0, json: JSON.parse(stdout), stderr };
  } catch (error) {
    const e = error as { code: number; stdout: string; stderr: string };
    return { code: e.code, json: e.stdout ? JSON.parse(e.stdout) : undefined, stderr: e.stderr };
  }
}

test("every capability maps to a dna command that exists", async () => {
  const help = await dna("help");
  for (const id of CAPABILITY_IDS)
    assert.ok(help.json[CLI_COMMANDS[id]], `dna ${CLI_COMMANDS[id]} for ${id}`);
});

test("read commands print parseable JSON", async () => {
  const [status, feed, taste, answer, sweeps, runs, usage, logs, keywords, sources, model] =
    await Promise.all([
      dna("status"),
      dna("feed"),
      dna("taste"),
      dna("answer"),
      dna("sweeps"),
      dna("runs"),
      dna("usage"),
      dna("logs", "--limit", "5"),
      dna("keywords"),
      dna("sources"),
      dna("model"),
    ]);
  assert.equal(status.json.info.device, "test");
  assert.equal(status.json.lastSweep.status, "completed");
  assert.equal(feed.json.items.length, 4, "news cards only");
  const timelines = await dna("timelines");
  assert.deepEqual(timelines.json, [], "unrelated fixture stories form no timeline");
  assert.ok(Array.isArray(taste.json.keywords));
  assert.ok(Array.isArray(answer.json));
  assert.equal(sweeps.json[0].status, "completed");
  assert.ok(runs.json.length >= 1);
  assert.ok(usage.json.length >= 1);
  assert.ok(logs.json.length <= 5);
  assert.ok(keywords.json.length > 5);
  assert.ok(sources.json.length > 5);
  assert.equal(model.json[0].id, "faux-haiku");

  const card = await dna("card", String(feed.json.items[0].id));
  assert.equal(card.json.card.id, feed.json.items[0].id);
  const sweep = await dna("sweep", String(sweeps.json[0].id));
  assert.ok(sweep.json.toolCalls.length > 5);
  const deskRun = runs.json.find((r: { agent: string }) => r.agent === "news-desk");
  const runDetail = await dna("run", String(deskRun.runEntryId));
  assert.equal(runDetail.json.children.length, 2);
  const tool = await dna("tool", String(sweep.json.toolCalls[0].id));
  assert.equal(typeof tool.json.durationMs, "number");
});

test("write commands work and print parseable JSON", async () => {
  const card = (await dna("feed", "--kind", "news")).json.items[0].id;
  assert.ok(Array.isArray((await dna("more", String(card))).json.changed));
  assert.ok(Array.isArray((await dna("less", String(card))).json.changed));
  assert.ok(Array.isArray((await dna("label", String(card), "signal", "facts")).json.changed));
  const bad = await dna("label", String(card), "vibes");
  assert.equal(bad.code, 2);
  assert.equal(bad.json.error.code, "usage");

  const send = await dna("send", "What", "did", "you", "find?", "--wait", "30");
  assert.equal(send.json.status, "done");
  assert.ok(send.json.answer.text.length > 0);
  assert.equal((await dna("thinking", "low")).json.thinkingLevel, "low");
  assert.deepEqual(
    [
      (await dna("compaction", "90k", "180k")).json.background,
      (await dna("compaction")).json.force,
    ],
    [90_000, 180_000],
  );
  assert.ok((await dna("compact")).json.taskId > 0);
  const kw = await dna("keywords", "add", "topic", "agent memory", "1.3");
  assert.equal(kw.json.term, "agent memory");
  assert.equal((await dna("keywords", "off", String(kw.json.id))).json.enabled, false);
  assert.deepEqual((await dna("keywords", "rm", String(kw.json.id))).json, { ok: true });
  const src = await dna("sources", "add", "rss", "Example", "https://example.com/feed.xml");
  assert.equal((await dna("sources", "off", String(src.json.id))).json.enabled, false);
  assert.deepEqual((await dna("sources", "rm", String(src.json.id))).json, { ok: true });
  assert.deepEqual((await dna("abort")).json, { ok: true });
});

test("watch streams frames, and net probe checks the scope matrix on the device", async () => {
  const watch = await dna("watch", "--seconds", "2");
  assert.equal(watch.json[0].type, "hello");
  assert.ok(watch.json.some((f: { type: string }) => f.type === "agent.snapshot"));
  const probe = await dna("net", "probe", "local");
  assert.equal(probe.code, 0, JSON.stringify(probe.json));
  assert.ok(probe.json.every((c: { ok: boolean }) => c.ok));
  const doctor = await dna("doctor");
  const byName = Object.fromEntries(
    doctor.json.map((c: { name: string; ok: boolean }) => [c.name, c.ok]),
  );
  assert.equal(byName["Node 24"], true);
  assert.equal(byName["the workflow route with the client token is 403"], true);
  assert.equal(byName["search mode"], true);
});

test("errors come back as JSON with the server's code", async () => {
  const missing = await dna("card", "9999");
  assert.equal(missing.code, 1);
  assert.equal(missing.json.error.code, "not_found");
});

test("--track selects the dedicated desk for terminal reads and writes", async () => {
  const tracks = await dna("tracks");
  assert.deepEqual(
    tracks.json.map((t: { id: string }) => t.id),
    ["ai", "cyber-security"],
  );
  const security = await dna("--track", "cyber-security", "status");
  assert.equal(security.json.info.track.id, "cyber-security");
  assert.equal(security.json.lastSweep, undefined);
  assert.equal((await dna("--track", "cyber-security", "schedule", "15")).json.everyMinutes, 15);
  assert.notEqual((await dna("schedule")).json.everyMinutes, 15);
  assert.equal((await dna("--track", "missing", "feed")).code, 1);
});
