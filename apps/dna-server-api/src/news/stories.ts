import { createHash } from "node:crypto";
import type { Deps } from "../deps.ts";
import type { Item } from "../db/repos/news.ts";
import { yes } from "@dna/jev";
import { pageRead } from "./page.ts";
import {
  shortlist,
  storyAction,
  STORY_THRESHOLDS,
  type StoryAction,
  type StoryVerdict,
} from "./story-policy.ts";

type StoryDeps = Pick<Deps, "store" | "judge" | "http" | "log" | "bus">;

/** One matcher per sweep. Page reads are shared, verdicts persist across process restarts. */
export class StoryMatcher {
  private pages = new Map<number, ReturnType<typeof pageRead>>();
  constructor(private readonly deps: StoryDeps) {}

  private async evidence(item: Item) {
    if (!this.pages.has(item.id)) this.pages.set(item.id, pageRead(this.deps, item, 6000));
    const page = await this.pages.get(item.id);
    const text = page?.text;
    return {
      title: item.title,
      source_url: item.url,
      source: item.sourceName ?? "unknown",
      published_at: item.publishedAt ?? "unknown",
      excerpt: item.excerpt ?? "",
      article_text: text ?? "",
      article_available: !!text,
      findings: this.deps.store.news
        .findings(item.id)
        .slice(-2)
        .map((f) => ({
          summary: f.summary,
          claims: f.claimSupport,
          evidence_urls: f.evidence,
        })),
    };
  }

  async compare(
    candidate: Item,
    other: Item,
    sweepId?: number,
  ): Promise<{ action: StoryAction; verdict: StoryVerdict }> {
    const { store, judge } = this.deps;
    const membership = store.news.membership(other.id);
    const members = membership
      ? store.news.storyMembers(membership.storyId).filter((i) => i.id !== candidate.id)
      : [other];
    const relevant = shortlist(candidate, members, 10);
    const selected = [
      ...new Map([other, ...relevant, ...members.slice(-10)].map((i) => [i.id, i])).values(),
    ].slice(0, 20);
    const developments = [];
    // Bounded page fetching, with one shared promise per article.
    for (const member of selected)
      developments.push({
        role: store.news.membership(member.id)?.role ?? "development",
        ...(await this.evidence(member)),
      });
    const state = {
      candidate: await this.evidence(candidate),
      existing: {
        title: other.title,
        developments,
        history_truncated: selected.length < members.length,
      },
    };
    const hash = createHash("sha256").update(JSON.stringify(state)).digest("hex");
    const version = judge.commands["same-story"].version;
    const prior = store.db
      .prepare(`SELECT answers_json FROM story_decisions
      WHERE item_id=? AND other_item_id=? AND version=? AND evidence_hash=?`)
      .get(candidate.id, other.id, version, hash) as any;
    const verdict: StoryVerdict = prior
      ? JSON.parse(prior.answers_json)
      : await (async () => {
          const sourceExtractionIds = (
            await Promise.all([candidate, ...selected].map((i) => this.pages.get(i.id)))
          ).flatMap((p) => p?.sourceExtractionIds ?? []);
          const result = await judge.run("same-story", state, {
            itemId: candidate.id,
            sweepId,
            sourceExtractionIds,
          });
          return Object.fromEntries(
            ["same", "development", "covered", "addition", "sufficient"].map((k) => [
              k,
              yes(result.answers[k], k),
            ]),
          ) as unknown as StoryVerdict;
        })();
    const thresholds = Object.fromEntries(
      Object.entries(STORY_THRESHOLDS).map(([key, fallback]) => [
        key,
        judge.policy("same-story", key, fallback),
      ]),
    ) as typeof STORY_THRESHOLDS;
    const action = storyAction(verdict, thresholds);
    if (!prior)
      store.db
        .prepare(`INSERT INTO story_decisions
      (item_id, other_item_id, version, evidence_hash, state_json, answers_json, action, sweep_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          candidate.id,
          other.id,
          version,
          hash,
          JSON.stringify(state),
          JSON.stringify(verdict),
          action,
          sweepId ?? null,
          new Date().toISOString(),
        );
    return { action, verdict };
  }

  publish(storyId: number) {
    for (const id of this.deps.store.news.storyCardIds(storyId)) {
      const card = this.deps.store.news.card(id)!;
      this.deps.bus.publish({ type: "feed.card_updated", card });
    }
  }

  /** Each candidate is resolved before the next one, so same-sweep coverage sees the full story accumulated so far. */
  async classify(
    item: Item,
    history: Item[],
    sweepId?: number,
    reconsider = false,
  ): Promise<StoryAction | "new"> {
    const { store, judge, log } = this.deps;
    const existing = store.news.membership(item.id);
    if (existing && (!reconsider || store.news.storyMembers(existing.storyId).length > 1))
      return "new";
    const options = shortlist(item, history, judge.policy("same-story", "shortlist", 12));
    const seen = new Set<string>();
    const matches: { other: Item; action: StoryAction; verdict: StoryVerdict }[] = [];
    let failed = false;
    // Compare a candidate with at most one representative per story, in bounded batches.
    const candidates = options.filter((other) => {
      const key = String(store.news.membership(other.id)?.storyId ?? `item:${other.id}`);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    for (let n = 0; n < candidates.length; n += 4) {
      await Promise.all(
        candidates.slice(n, n + 4).map(async (other) => {
          try {
            matches.push({ other, ...(await this.compare(item, other, sweepId)) });
          } catch (error) {
            failed = true;
            log.warn("sweep.same_story_failed", {
              itemId: item.id,
              otherId: other.id,
              error: String(error),
            });
          }
        }),
      );
    }
    const confident = matches.filter((m) =>
      ["duplicate", "evidence", "development"].includes(m.action),
    );
    // Multiple plausible stories need research, never an arbitrary first-match merge.
    if (confident.length === 1) {
      const match = confident[0];
      const role =
        match.action === "duplicate" ? "coverage" : (match.action as "evidence" | "development");
      const id = store.news.attachStory(item, match.other, role);
      this.publish(id);
      log.info("story.linked", {
        itemId: item.id,
        otherId: match.other.id,
        storyId: id,
        action: match.action,
        verdict: match.verdict,
        sweepId,
      });
      return match.action;
    }
    store.news.ensureStory(item);
    const uncertain =
      failed || matches.some((m) => m.action === "uncertain") || confident.length > 1;
    if (uncertain)
      store.news.updateItem(item.id, {
        lastError: "Story relationship uncertain: research before suppressing or linking",
      });
    return uncertain ? "uncertain" : "new";
  }
}
