import { Type } from "@earendil-works/pi-ai";
import { defineAppTool, toolError, toolText } from "@dna/durable-agent";
import type { Deps } from "../../deps.ts";
import { JEV_COMMANDS } from "../../news/hfs.ts";
import { StoryMatcher } from "../../news/stories.ts";
import { pageRead } from "../../news/page.ts";
import { weightsOf } from "../../news/rank.ts";
import { FixableError, ref, requireItem } from "./shared.ts";

export function jevClassify(deps: Deps) {
  return defineAppTool({
    name: "jev_classify",
    returns:
      "Text: the item id, the jev command and its result, for hfs the ranked Hype, Facts and Signal scores with the primary category and labels.",
    description:
      "Run a jev classifier on one item. hfs: rank Hype, Facts and Signal (0 to 100, always ranked). relevance and worth-attention: the gate scores. claim-support: one yes or no per claim, give claims and optionally evidence text. same-story: compare with another item (other_item_id). importance: how much the reader would care, given their topic and source weights.",
    parameters: Type.Object({
      command: Type.Union(JEV_COMMANDS.map((c) => Type.Literal(c))),
      item_id: Type.Integer(),
      claims: Type.Optional(Type.Array(Type.String(), { maxItems: 8 })),
      evidence: Type.Optional(Type.String()),
      other_item_id: Type.Optional(Type.Integer()),
    }),
    enums: { command: JEV_COMMANDS },
    example: { command: "hfs", item_id: 12 },
    replay: "safe",
    execute: async (args, api, ctx) => {
      const done = await api.memo<string>("jev-result", ctx);
      if (done) return toolText(done);
      try {
        const item = requireItem(deps, args.item_id);
        const r = ref(api, item.sweepId);
        let text = "";
        switch (args.command) {
          case "hfs": {
            // Facts needs what the page says, not a one line feed excerpt.
            const page = await pageRead(deps, item);
            const evidence = page
              ? `${item.excerpt ?? item.title}\n\n${page.text}`.slice(0, 2400)
              : undefined;
            const hfs = await deps.judge.hfs(
              item,
              { ...r, sourceExtractionIds: page?.sourceExtractionIds },
              undefined,
              evidence,
            );
            text = `#${item.id} hfs: ${hfs.ranked.map((x) => `${x.category} ${x.score}`).join(", ")}. primary ${hfs.primary}, labels ${hfs.labels.join(" and ") || "none"}${hfs.suspectCombo ? ". suspect_combo: hype and signal without facts, ask the reader with ask_taste" : ""}.`;
            break;
          }
          case "relevance": {
            const rel = await deps.judge.relevance(item, r);
            text = `#${item.id} relevance ${Math.round(rel.relevance * 100)}${rel.matchedTopic ? `, topic ${rel.matchedTopic}` : ""}.`;
            break;
          }
          case "worth-attention": {
            const w = await deps.judge.worth(item, r);
            text = `#${item.id} worth ${Math.round(w.worth * 100)}, novelty ${Math.round(w.novelty * 100)}.`;
            break;
          }
          case "claim-support": {
            if (!args.claims?.length)
              throw new FixableError("claim-support needs claims.", [
                "Pass claims: up to 8 short factual claims from the item.",
              ]);
            const cached = item.cacheId ? deps.store.sources.cachedById(item.cacheId) : undefined;
            const evidence = args.evidence ?? cached?.contentMd ?? item.excerpt ?? item.title;
            const support = await deps.judge.claimSupport(args.claims, evidence, {
              ...r,
              itemId: item.id,
              sourceExtractionIds:
                args.evidence === undefined && cached?.archiveExtractionId
                  ? [cached.archiveExtractionId]
                  : [],
            });
            text = support
              .map(
                (s) =>
                  `${s.supported >= 0.7 ? "supported" : s.supported >= 0.4 ? "unclear" : "unsupported"} ${Math.round(s.supported * 100)}: ${s.claim}`,
              )
              .join("\n");
            break;
          }
          case "importance": {
            const weights = weightsOf(deps.store, item);
            const importance = await deps.judge.importance(item, weights, r);
            text = `#${item.id} importance ${Math.round(importance * 100)} (topic weight ${weights.topic}, source weight ${weights.source}).`;
            break;
          }
          case "same-story": {
            if (!args.other_item_id) throw new FixableError("same-story needs other_item_id.");
            const other = requireItem(deps, args.other_item_id);
            const matcher = new StoryMatcher(deps);
            const result = await matcher.compare(item, other, item.sweepId);
            text = `#${item.id} and #${other.id}: ${result.action}. ${JSON.stringify(result.verdict)}`;
            break;
          }
        }
        await api.memo("jev-result", text, ctx);
        return toolText(text);
      } catch (error) {
        if (error instanceof FixableError) return toolError(error.message, error.hints);
        return toolError(`jev ${args.command} failed: ${String(error).slice(0, 200)}`, [
          "Retry once, or continue without this score.",
        ]);
      }
    },
  });
}
