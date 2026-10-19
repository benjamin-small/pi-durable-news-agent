import { profileFor } from "./profiles.ts";
// The Judge: every jev command the app runs, with each call priced, logged and stored in jev_calls.
import { join } from "node:path";
import type { HfsScores } from "@dna/sdk";
import type { Logger } from "@dna/sdk/node";
import {
  attentionScore,
  DEFAULT_ATTENTION,
  type AttentionWeights,
  type Decide,
  type JevCommand,
  JevLedger,
  listCommands,
  loadCommand,
  rankHfs,
  runCommand,
  type ScoreAnswer,
  type SystemOneResult,
  type Vars,
  normalized,
  yes,
} from "@dna/jev";
import type { Finding, Item } from "../db/repos/news.ts";
import type { Store } from "../db/store.ts";
import type { CallRef } from "./search/index.ts";
import { sectionKeywords, tasteExamples, topicChoices } from "./taste.ts";

export const JEV_COMMANDS = [
  "relevance",
  "worth-attention",
  "hfs",
  "same-story",
  "claim-support",
  "importance",
] as const;
export type JevCommandName = (typeof JEV_COMMANDS)[number];

export interface JudgeRef extends CallRef {
  itemId?: number;
}

const excerptOf = (item: Item, store: Store, max = 1500) => {
  const cached = item.cacheId ? store.sources.cachedById(item.cacheId) : undefined;
  const body =
    cached?.contentMd && cached.contentMd.length > (item.excerpt?.length ?? 0)
      ? cached.contentMd
      : (item.excerpt ?? "");
  return body.slice(0, max);
};

export class Judge {
  readonly commands: Record<string, JevCommand>;
  readonly ledger: JevLedger;

  constructor(private readonly deps: { decide: Decide; store: Store; log?: Logger; dir: string }) {
    this.commands = Object.fromEntries(
      listCommands(deps.dir).map((name) => [name, loadCommand(name, deps.dir)]),
    );
    for (const name of JEV_COMMANDS)
      if (!this.commands[name])
        throw new Error(`Missing jev command ${join(deps.dir, name, "command.json")}`);
    this.ledger = new JevLedger();
  }

  policy<T>(name: JevCommandName, key: string, fallback: T): T {
    return (this.commands[name].policy[key] as T) ?? fallback;
  }

  get attentionWeights(): AttentionWeights {
    return this.policy("hfs", "attention", DEFAULT_ATTENTION);
  }

  /** Run one command by name, recording the call whether it succeeds or fails. */
  async run(name: JevCommandName, vars: Vars, ref: JudgeRef = {}): Promise<SystemOneResult> {
    const cmd = this.commands[name];
    const profile = profileFor(this.deps.store.trackId);
    vars = { ...vars, audience: profile.audience, coverage: profile.coverage };
    try {
      const { result, rendered } = await runCommand(cmd, vars, this.deps.decide);
      const record = this.ledger.record(result, { command: cmd.name, version: cmd.version });
      this.deps.store.telemetry.jev({
        command: cmd.name,
        version: cmd.version,
        provider: record.provider,
        model: record.model,
        questions: Object.keys(rendered.questions).length,
        answers: result.answers,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        costUsd: record.cost.amount,
        costSource: record.cost.source,
        elapsedMs: record.elapsedMs,
        attempts: record.attempts,
        itemId: ref.itemId,
        sweepId: ref.sweepId,
        conversationId: ref.conversationId,
        callId: ref.callId,
      });
      this.deps.log?.debug("jev.call", {
        command: name,
        itemId: ref.itemId,
        ms: record.elapsedMs,
        cost: record.cost.amount,
        sweepId: ref.sweepId,
      });
      return result;
    } catch (error) {
      this.ledger.fail(error, { command: cmd.name, version: cmd.version });
      this.deps.store.telemetry.jev({
        command: cmd.name,
        version: cmd.version,
        questions: 0,
        error: String(error).slice(0, 500),
        itemId: ref.itemId,
        sweepId: ref.sweepId,
        conversationId: ref.conversationId,
        callId: ref.callId,
      });
      this.deps.log?.warn("jev.failed", {
        command: name,
        itemId: ref.itemId,
        error: String(error),
      });
      throw error;
    }
  }

  async relevance(
    item: Item,
    ref: JudgeRef = {},
  ): Promise<{ relevance: number; matchedTopic?: string }> {
    const topics = this.deps.store.taste.keywords("topic", true);
    const choices = topicChoices(topics);
    const result = await this.run(
      "relevance",
      {
        title: item.title,
        source: item.sourceName ?? "",
        excerpt: excerptOf(item, this.deps.store, 1200),
        topic_keywords: topics.map((k) => ({ term: k.term, weight: k.weight })),
        topic_choices: choices,
        taste_examples: tasteExamples(this.deps.store),
      },
      { ...ref, itemId: item.id },
    );
    const relevance = normalized(result.answers.relevance as ScoreAnswer);
    const choice = (result.answers.matched_topic as { choice?: string } | undefined)?.choice;
    return { relevance, matchedTopic: choice && choice !== "none" ? choices[choice] : undefined };
  }

  /** How important a gated item is to the reader, 0 to 1, given the topic and source weights. */
  async importance(
    item: Item,
    weights: { topic: number; source: number },
    ref: JudgeRef = {},
  ): Promise<number> {
    const topics = this.deps.store.taste.keywords("topic", true);
    const result = await this.run(
      "importance",
      {
        title: item.title,
        source: item.sourceName ?? "",
        source_weight: weights.source,
        published_at: item.publishedAt ?? "unknown",
        excerpt: excerptOf(item, this.deps.store, 1200),
        topic: item.matchedTopic ?? "none",
        topic_weight: weights.topic,
        topic_keywords: topics.map((k) => ({ term: k.term, weight: k.weight })),
        taste_examples: tasteExamples(this.deps.store),
      },
      { ...ref, itemId: item.id },
    );
    return normalized(result.answers.importance as ScoreAnswer);
  }

  async worth(item: Item, ref: JudgeRef = {}): Promise<{ worth: number; novelty: number }> {
    const result = await this.run(
      "worth-attention",
      {
        title: item.title,
        source: item.sourceName ?? "",
        published_at: item.publishedAt ?? "unknown",
        excerpt: excerptOf(item, this.deps.store, 1200),
        taste_examples: tasteExamples(this.deps.store),
      },
      { ...ref, itemId: item.id },
    );
    return {
      worth: yes(result.answers.worth, "worth"),
      novelty: normalized(result.answers.novelty as ScoreAnswer),
    };
  }

  /** `text` is the item's page text when the caller fetched it; without it jev reads the cached body or excerpt. */
  async hfs(
    item: Item,
    ref: JudgeRef = {},
    findings: Finding[] = this.deps.store.news.findings(item.id),
    text?: string,
  ): Promise<HfsScores & { classificationId: number }> {
    const cmd = this.commands.hfs;
    const result = await this.run(
      "hfs",
      {
        title: item.title,
        source: item.sourceName ?? "",
        excerpt: text ?? excerptOf(item, this.deps.store, 2400),
        findings: findings
          .map((f) => ({
            summary: f.summary,
            actionability: f.actionability,
            claims: f.claimSupport,
          }))
          .slice(-3),
        section_keywords: sectionKeywords(this.deps.store),
        taste_examples: tasteExamples(this.deps.store),
      },
      { ...ref, itemId: item.id },
    );
    const ranked = rankHfs(result.answers, cmd.policy as never);
    const hfs: HfsScores = {
      hype: ranked.scores.hype,
      facts: ranked.scores.facts,
      signal: ranked.scores.signal,
      primary: ranked.primary,
      labels: ranked.labels,
      ranked: ranked.ranked,
      suspectCombo: ranked.suspectCombo,
    };
    const row = this.deps.store.news.addClassification({
      itemId: item.id,
      command: cmd.name,
      version: cmd.version,
      model: result.meta.resolvedModel,
      hfs,
      answers: result.answers,
      sweepId: ref.sweepId,
      toolCallId: ref.callId,
    });
    this.deps.store.news.updateItem(item.id, {
      status: ["presented", "duplicate"].includes(item.status) ? item.status : "classified",
      attention: this.attention(hfs, item.relevance ?? 0.5),
    });
    if (hfs.suspectCombo)
      this.deps.log?.warn("hfs.suspect_combo", {
        itemId: item.id,
        ...ranked.scores,
        sweepId: ref.sweepId,
      });
    return { ...hfs, classificationId: row.id };
  }

  async sameStory(
    a: Pick<Item, "title" | "excerpt">,
    b: Pick<Item, "title" | "excerpt">,
    ref: JudgeRef = {},
  ): Promise<number> {
    const result = await this.run(
      "same-story",
      {
        candidate: { title: a.title, excerpt: a.excerpt ?? "" },
        existing: { title: b.title, developments: [{ title: b.title, excerpt: b.excerpt ?? "" }] },
      },
      ref,
    );
    return yes(result.answers.same, "same");
  }

  async claimSupport(
    claims: string[],
    evidence: string,
    ref: JudgeRef = {},
  ): Promise<{ claim: string; supported: number }[]> {
    if (!claims.length) return [];
    const result = await this.run(
      "claim-support",
      { claims: claims.slice(0, 8), evidence: evidence.slice(0, 6000) },
      ref,
    );
    return claims.slice(0, 8).map((claim, i) => ({
      claim,
      supported: yes(result.answers[`supported_${i}`], `supported_${i}`),
    }));
  }

  attention(hfs: Pick<HfsScores, "hype" | "facts" | "signal">, relevance: number): number {
    return attentionScore(
      { hype: hfs.hype, facts: hfs.facts, signal: hfs.signal },
      relevance,
      this.attentionWeights,
    );
  }

  /** Attention before an hfs classification exists: relevance, worth and novelty only. */
  preAttention(relevance: number, worth: number, novelty: number): number {
    return Math.round((relevance * 0.5 + worth * 0.35 + novelty * 0.15) * 100);
  }
}
