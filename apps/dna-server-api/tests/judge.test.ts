import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Judge } from "../src/news/hfs.ts";
import { fixtureDecide } from "../src/news/fixtures.ts";
import { PROMPTS_DIR, tempStore } from "./helpers.ts";

test("the judge scores, ranks, records every call, and records failures", async () => {
  const { store, cleanup } = tempStore();
  try {
    const judge = new Judge({ decide: fixtureDecide(), store, dir: join(PROMPTS_DIR, "jev") });
    const { item: pi } = store.news.upsertItem({
      url: "https://simonwillison.net/pi",
      title: "pi-durable 1.1.0 adds task timings",
      excerpt: "The changelog adds durationMs. How to upgrade: bump the version.",
    });
    const { item: hype } = store.news.upsertItem({
      url: "https://x.dev/hype",
      title: "Insiders say an agent is 100x smarter",
      excerpt: "A game changer, revolutionary, AGI is here.",
    });
    const rel = await judge.relevance(pi, { sweepId: undefined });
    assert.ok(rel.relevance > 0.7);
    assert.equal(rel.matchedTopic, "pi-durable");
    const hfsPi = await judge.hfs(pi);
    assert.ok(["facts", "signal"].includes(hfsPi.primary));
    const hfsHype = await judge.hfs(hype);
    assert.equal(hfsHype.primary, "hype");
    assert.ok(judge.attention(hfsPi, 0.9) > judge.attention(hfsHype, 0.9));
    assert.equal(store.news.latestHfs(pi.id)!.primary, hfsPi.primary);
    const support = await judge.claimSupport(
      ["adds durationMs", "ships a GUI"],
      "The changelog adds durationMs.",
    );
    assert.equal(support.length, 2);
    assert.equal(
      await judge.sameStory(
        { title: "pi-durable 1.1.0 adds task timings" },
        { title: "pi-durable 1.1.0 adds task timings" },
      ),
      0.95,
    );
    const failing = new Judge({
      decide: async () => Promise.reject(new Error("jev down")),
      store,
      dir: join(PROMPTS_DIR, "jev"),
    });
    await assert.rejects(failing.worth(pi, { callId: "c9" }), /jev down/);
    const rows = store.db
      .prepare("SELECT command, error, call_id,archive_evidence_id FROM jev_calls ORDER BY id")
      .all() as any[];
    assert.deepEqual(
      rows.map((r) => r.command),
      ["relevance", "hfs", "hfs", "claim-support", "same-story", "worth-attention"],
    );
    assert.match(rows.at(-1).error, /jev down/);
    assert.equal(rows.at(-1).call_id, "c9");
    assert.ok(rows.every((r) => r.archive_evidence_id));
    const exact = JSON.parse(
      store.evidence.body("ai", "evidence", rows[1].archive_evidence_id)!.toString(),
    );
    assert.equal(exact.command.name, "hfs");
    assert.equal(exact.vars.excerpt, pi.excerpt);
    assert.equal(
      store.db
        .prepare("SELECT archive_evidence_id FROM classifications WHERE id=?")
        .get(hfsPi.classificationId)!.archive_evidence_id,
      rows[1].archive_evidence_id,
    );
  } finally {
    cleanup();
  }
});
