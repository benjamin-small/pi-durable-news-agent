import { Type } from "@earendil-works/pi-ai";
import { defineAppTool, toolError, toolText } from "@dna/durable-agent";
import type { Deps } from "../../deps.ts";
import { ref } from "./shared.ts";

const ACTIONABILITY = ["high", "medium", "low", "none"] as const;

export function reportFindings(deps: Deps) {
  return defineAppTool({
    name: "report_findings",
    returns: "Text: that the findings were saved, with how many claims jev found supported.",
    description:
      "Save your findings for one item: a one sentence summary, up to four claims, evidence urls, and actionability. Claims are checked against the item text with jev claim-support unless you already did.",
    parameters: Type.Object({
      item_id: Type.Integer(),
      summary: Type.String({ minLength: 10, maxLength: 600 }),
      claims: Type.Array(Type.String(), { maxItems: 4 }),
      evidence_urls: Type.Array(Type.String(), { maxItems: 6 }),
      actionability: Type.Union(ACTIONABILITY.map((a) => Type.Literal(a))),
    }),
    enums: { actionability: ACTIONABILITY },
    example: {
      item_id: 12,
      summary: "v2.4 adds durable sessions; available now.",
      claims: ["Version 2.4 is available"],
      evidence_urls: ["https://example.com/release"],
      actionability: "medium",
    },
    replay: "safe",
    execute: async (args, api) => {
      const item = deps.store.news.item(args.item_id);
      if (!item)
        return toolError(`No item #${args.item_id}.`, ["Report only the item ids you were given."]);
      const cached = item.cacheId ? deps.store.sources.cachedById(item.cacheId) : undefined;
      const evidence = cached?.contentMd ?? item.excerpt ?? item.title;
      let support: { claim: string; supported: number }[] = [];
      if (args.claims.length) {
        try {
          support = await deps.judge.claimSupport(args.claims, evidence, {
            ...ref(api, item.sweepId),
            itemId: item.id,
            sourceExtractionIds: cached?.archiveExtractionId ? [cached.archiveExtractionId] : [],
          });
        } catch (error) {
          deps.log.warn("findings.claim_support_failed", { itemId: item.id, error: String(error) });
        }
      }
      deps.store.news.addFinding({
        itemId: item.id,
        conversationId: api.conversationId as number,
        summary: args.summary,
        claims: args.claims,
        evidence: args.evidence_urls,
        actionability: args.actionability,
        claimSupport: support,
      });
      const supported = support.filter((s) => s.supported >= 0.7).length;
      return toolText(
        `Saved findings for #${item.id}${support.length ? `: ${supported} of ${support.length} claims supported` : ""}.`,
      );
    },
  });
}
