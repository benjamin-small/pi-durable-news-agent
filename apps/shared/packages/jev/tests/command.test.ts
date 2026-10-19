import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
  commandVariables,
  JevClient,
  listCommands,
  loadCommand,
  renderCommand,
  runCommand,
  TemplateError,
} from "../src/index.ts";

const DIR = join(import.meta.dirname, "../../../../dna-server-api/prompt_engineering/jev");

const SAMPLE = {
  audience: "an engineer who builds with AI agents",
  coverage: "AI news and agentic engineering",
  title: "pi-durable 1.1.0 adds task timings",
  source: "github.com",
  excerpt: "Task records now carry startedAt and endedAt; tool results carry durationMs.",
  published_at: "2026-10-07",
  findings: "",
  topic_keywords: [{ term: "pi-durable", weight: 1.5 }],
  topic_choices: { pi_durable: "pi-durable", none: "None of the topics" },
  section_keywords: { hype: ["10x"], facts: ["changelog"], signal: ["breaking change"] },
  taste_examples: [],
  candidate: { title: "a", excerpt: "b" },
  existing: { title: "c", developments: [{ excerpt: "d" }] },
  candidate_title: "a",
  candidate_excerpt: "b",
  existing_title: "c",
  existing_excerpt: "d",
  source_weight: 1.2,
  topic: "pi-durable",
  topic_weight: 1.5,
  evidence: "The changelog lists startedAt and endedAt.",
  claims: ["Task records carry startedAt", "It ships a GUI"],
};

test("all six commands load, render and validate", () => {
  assert.deepEqual(listCommands(DIR), [
    "claim-support",
    "hfs",
    "importance",
    "relevance",
    "same-story",
    "worth-attention",
  ]);
  for (const name of listCommands(DIR)) {
    const cmd = loadCommand(name, DIR);
    const rendered = renderCommand(cmd, SAMPLE);
    assert.ok(Object.keys(rendered.questions).length > 0, name);
  }
});

test("a whole-value variable keeps its structure; partial strings interpolate", () => {
  const rendered = renderCommand(loadCommand("relevance", DIR), SAMPLE);
  assert.deepEqual((rendered.questions.matched_topic as any).criteria, SAMPLE.topic_choices);
  assert.deepEqual((rendered.state as any).topic_keywords, SAMPLE.topic_keywords);
  assert.equal((rendered.state as any).title, SAMPLE.title);
});

test("missing variables throw with every name", () => {
  const cmd = loadCommand("hfs", DIR);
  assert.throws(
    () => renderCommand(cmd, { title: "x" }),
    (error: unknown) => {
      assert.ok(error instanceof TemplateError);
      assert.deepEqual(error.missing, [
        "excerpt",
        "findings",
        "section_keywords",
        "source",
        "taste_examples",
      ]);
      return true;
    },
  );
  assert.deepEqual(commandVariables(cmd), [
    "excerpt",
    "findings",
    "section_keywords",
    "source",
    "taste_examples",
    "title",
  ]);
});

test("each repeats questions per claim with suffixed ids", () => {
  const rendered = renderCommand(loadCommand("claim-support", DIR), SAMPLE);
  assert.deepEqual(Object.keys(rendered.questions), ["supported_0", "supported_1"]);
  assert.match(String((rendered.questions.supported_1 as any).instructions), /It ships a GUI/);
});

test("runCommand renders and decides through the seam", async () => {
  const client = new JevClient({ provider: "mock" });
  const { result } = await runCommand(loadCommand("hfs", DIR), SAMPLE, (s, q, o) =>
    client.systemOne(s, q, o),
  );
  assert.deepEqual(Object.keys(result.answers).sort(), ["facts", "hype", "signal"]);
});

test("worth-attention uses the selected desk's audience and coverage", () => {
  const rendered = renderCommand(loadCommand("worth-attention", DIR), {
    ...SAMPLE,
    audience: "a cyber security reader",
    coverage: "industry security news and research",
  });
  assert.equal((rendered.state as any).audience, "a cyber security reader");
  assert.equal((rendered.state as any).coverage, "industry security news and research");
  assert.doesNotMatch(JSON.stringify(rendered.questions), /agentic engineer|builds with AI/);
});
