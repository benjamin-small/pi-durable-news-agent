// present_news and present_timeline: the agent's generative UI. present_news renders one item as a card (enum
// components, props checked against jev scores, one card per tool task so a replay returns the same card, images
// resolved or generated in the background). present_timeline links presented cards about one story in date order.
import { Type } from "@earendil-works/pi-ai";
import type { Task, ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { defineAppTool, onceInCommit, toolError, toolText } from "@dna/durable-agent";
import { NEWS_COMPONENTS, type Card, type HfsScores } from "@dna/sdk";
import type { Deps } from "../../deps.ts";
import type { Item } from "../../db/repos/news.ts";
import { StoryMatcher } from "../../news/stories.ts";
import { checkComponent } from "../../news/components.ts";
import type { ImageInput } from "../../news/image-task.ts";

const PROPS_HELP =
  "props holds the component's fields as short phrases: title, summary, dek, action, why, claim, verdict, evidence (array of urls), reality_check, name, version, changes (array), takes (array), quote, speaker, body, events (array of { date, text }), left, right.";

const scoreLine = (card: Card) =>
  card.hfs
    ? `${card.hfs.ranked.map((r) => `${r.category} ${r.score}`).join(", ")}`
    : "not classified";

function hfsOf(deps: Deps, item: Item): HfsScores | undefined {
  const c = deps.store.news.latestHfs(item.id);
  return c
    ? {
        hype: c.hype,
        facts: c.facts,
        signal: c.signal,
        primary: c.primary,
        labels: c.labels,
        ranked: c.ranked,
        suspectCombo: c.suspectCombo,
      }
    : undefined;
}

async function imageFor(
  deps: Deps,
  item: Item | undefined,
  title: string,
  summary: string,
): Promise<number> {
  const existing = item ? await deps.images.resolve(item) : undefined;
  if (existing) return existing;
  return deps.images.pending(item?.id, deps.images.prompt({ title, summary }));
}

async function startImage(
  api: ToolExecutionApi,
  ctx: Context,
  imageTask: Task<ImageInput, any, any, object>,
  card: Card,
  deps: Deps,
) {
  if (!card.image || card.image.status !== "pending") return;
  const prompt = deps.store.db
    .prepare("SELECT prompt FROM images WHERE id = ?")
    .get(card.image.id) as { prompt: string } | undefined;
  await onceInCommit<number>(
    api,
    ctx,
    async (tx) =>
      (await tx.createTask(
        imageTask,
        { imageId: card.image!.id, prompt: prompt?.prompt ?? card.title },
        {
          ownership: { kind: "conversation" },
          conversationId: api.conversationId,
          background: true,
        },
      )) as number,
  );
}

export function presentNews(deps: Deps, imageTask: Task<ImageInput, any, any, object>) {
  return defineAppTool({
    name: "present_news",
    returns:
      "Text: the card id, its component and the ranked H/F/S scores. A replay returns the same card.",
    description: `Render one item as a news card in the reader's feed. component is one of: ${NEWS_COMPONENTS.join(", ")}. ${PROPS_HELP} Run jev_classify hfs first. The card shows jev's ranked Hype, Facts and Signal scores.`,
    parameters: Type.Object({
      item_id: Type.Integer(),
      component: Type.Union(NEWS_COMPONENTS.map((c) => Type.Literal(c))),
      props: Type.Record(Type.String(), Type.Unknown()),
    }),
    enums: { component: NEWS_COMPONENTS },
    example: {
      item_id: 12,
      component: "brief",
      props: {
        title: "Codex CLI adds durable sessions",
        summary: "Runs now survive restarts and resume from a checkpoint.",
      },
    },
    replay: "safe",
    execute: async (args, api, ctx) => {
      const prior = deps.store.news.cardByToolCall(String(api.taskId));
      if (prior) {
        await startImage(api, ctx, imageTask, prior, deps);
        return toolText(`Presented card ${prior.id} (${prior.component}, ${scoreLine(prior)}).`, {
          cardId: prior.id,
        });
      }
      const item = deps.store.news.item(args.item_id);
      if (!item)
        return toolError(`present_news failed: no item #${args.item_id}.`, [
          "Use an item id from run_news_sweep or search_web.",
        ]);
      const membership = deps.store.news.membership(item.id);
      deps.store.news.refreshReleases();
      const latestRelease = deps.store.news.latestRelease(item.id);
      if (latestRelease && latestRelease !== item.id)
        return toolText(
          `Skipped release #${item.id}: #${latestRelease} was published more recently. Only the latest release per package is presented.`,
        );
      if (membership && membership.role !== "development")
        return toolText(
          `Item #${item.id} is attached as ${membership.role} to story ${membership.storyId}; no additional card is needed.`,
        );
      const existing = deps.store.news.cardForItem(item.id);
      if (existing)
        return toolText(
          `Presented card ${existing.id} (${existing.component}, ${scoreLine(existing)}).`,
          { cardId: existing.id },
        );
      if (
        item.lastError?.startsWith("Story relationship uncertain") &&
        !deps.store.news.findings(item.id).length
      )
        return toolError(
          "present_news needs research for this item's uncertain story relationship.",
          [
            "Call research_items for this item. It will recheck the possible matches after findings arrive. If evidence remains inconclusive, keep the item separate.",
          ],
        );
      const hfs = hfsOf(deps, item);
      const attention = hfs ? deps.judge.attention(hfs, item.relevance ?? 0.5) : item.attention;
      const problem = checkComponent({
        component: args.component,
        props: args.props,
        hfs,
        attention,
        hasDiscussion: !!item.discussionUrl,
      });
      if (problem) return toolError(`present_news failed: ${problem}`);
      // The feed orders news by publish date: an item without one gets it from its page first.
      if (!item.publishedAt && !item.dateSource) await deps.dates.resolve(item);
      const title = String(args.props.title ?? args.props.name ?? args.props.claim ?? item.title);
      const summary = String(
        args.props.summary ?? args.props.dek ?? args.props.why ?? item.excerpt ?? "",
      );
      const imageId = await imageFor(deps, item, title, summary);
      const { card } = deps.store.news.addCard({
        kind: "news",
        component: args.component,
        props: args.props,
        itemId: item.id,
        imageId,
        hfs,
        attention,
        toolCallId: String(api.taskId),
        conversationId: api.conversationId as number,
        sweepId: item.sweepId,
      });
      await startImage(api, ctx, imageTask, card, deps);
      const sweep = item.sweepId ? deps.store.sweeps.get(item.sweepId) : undefined;
      // A count, not an increment: a replayed call after a restart must not count its card twice.
      if (sweep)
        deps.store.sweeps.update(sweep.id, { presented: deps.store.news.cardCount(sweep.id) });
      if (membership) new StoryMatcher(deps).publish(membership.storyId);
      for (const id of deps.store.news.releaseCardIds(item.id))
        if (id !== card.id)
          deps.bus.publish({ type: "feed.card_updated", card: deps.store.news.card(id)! });
      deps.bus.publish({ type: "feed.card", card });
      deps.log.info("card.presented", {
        cardId: card.id,
        component: card.component,
        itemId: item.id,
        sweepId: item.sweepId,
        conversationId: api.conversationId,
      });
      return toolText(`Presented card ${card.id} (${card.component}, ${scoreLine(card)}).`, {
        cardId: card.id,
      });
    },
  });
}

export function presentTimeline(deps: Deps) {
  return defineAppTool({
    name: "present_timeline",
    returns:
      "Text: the timeline id and title, then each item with its place in date order (#12 1/3, #15 2/3).",
    description:
      "Link presented news cards about one evolving story into a timeline the reader can open, ordered by publish date. Present every item with present_news first. A new timeline needs a short title and 2 or more items. To add items to an existing timeline from TIMELINES, give its timeline_id.",
    parameters: Type.Object({
      item_ids: Type.Array(Type.Integer(), { minItems: 1, maxItems: 8 }),
      title: Type.Optional(Type.String({ maxLength: 80 })),
      timeline_id: Type.Optional(Type.Integer()),
    }),
    example: { item_ids: [12, 15], title: "Codex goes always on" },
    replay: "safe",
    execute: async (args, api) => {
      const { news } = deps.store;
      const missing = args.item_ids.filter((id) => !news.item(id));
      if (missing.length)
        return toolError(
          `present_timeline failed: no items ${missing.map((m) => `#${m}`).join(", ")}.`,
        );
      const presented = new Set(args.item_ids.filter((id) => news.cardForItem(id)));
      const unpresented = args.item_ids.filter((id) => !presented.has(id));
      if (unpresented.length)
        return toolError(
          `present_timeline failed: ${unpresented.map((i) => `#${i}`).join(", ")} ${unpresented.length > 1 ? "have" : "has"} no news card yet.`,
          ["Call present_news for each item first, then link them."],
        );
      const story = args.item_ids.map((i) => news.membership(i)?.storyId).find(Boolean);
      let id: number;
      if (story !== undefined && !args.timeline_id) {
        // Items the story classifier already placed: their stories join one timeline.
        if (new Set(args.item_ids).size < 2)
          return toolError("present_timeline failed: linking needs 2 or more items.");
        id = story;
        news.mergeStories(id, args.item_ids, args.title?.trim());
      } else if (args.timeline_id) {
        if (!news.timelineSummary(args.timeline_id))
          return toolError(`present_timeline failed: no timeline ${args.timeline_id}.`, [
            "Use a timeline id from TIMELINES, or leave timeline_id out to start one.",
          ]);
        id = args.timeline_id;
        news.mergeStories(id, args.item_ids);
      } else {
        const title = args.title?.trim();
        if (!title)
          return toolError("present_timeline failed: a new timeline needs a title.", [
            "Give a short title of 3 to 8 words, or a timeline_id from TIMELINES.",
          ]);
        if (new Set(args.item_ids).size < 2)
          return toolError("present_timeline failed: a new timeline needs 2 or more items.", [
            "Give a timeline_id from TIMELINES to add one item to an existing timeline.",
          ]);
        const sweepId = news.item(args.item_ids[0])?.sweepId;
        id = news.addTimeline({
          title,
          itemIds: args.item_ids,
          sweepId,
          toolCallId: String(api.taskId),
        }).id;
      }
      const cards = news.timelineCards(id);
      for (const card of cards) deps.bus.publish({ type: "feed.card_updated", card });
      const t = news.timelineSummary(id)!;
      deps.log.info("timeline.linked", { timelineId: id, items: t.count, added: args.item_ids });
      return toolText(
        `Timeline ${id} "${t.title}": ${cards.map((c) => `#${c.itemId} ${c.timeline?.index}/${c.timeline?.count}`).join(", ")}.`,
        { timelineId: id },
      );
    },
  });
}
