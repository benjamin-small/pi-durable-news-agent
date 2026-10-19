import { Type } from "@earendil-works/pi-ai";
import { defineAppTool, toolError, toolText } from "@dna/durable-agent";
import type { Deps } from "../../deps.ts";

export function askTaste(deps: Deps) {
  return defineAppTool({
    name: "ask_taste",
    returns:
      "Text: the question id it asked about the item, or the question already open for it. The question shows as a card in the reader's feed.",
    description:
      "Ask the reader to label one item as Hype, Facts and or Signal. Shows a question card in the chat with three chips. Does not wait for the answer; the answer arrives later as a message.",
    parameters: Type.Object({
      item_id: Type.Integer(),
      question: Type.String({ minLength: 8, maxLength: 200 }),
    }),
    replay: "safe",
    execute: async (args, api) => {
      const item = deps.store.news.item(args.item_id);
      if (!item) return toolError(`No item #${args.item_id}.`);
      const card = deps.store.news.cardForItem(item.id);
      const { question, created } = deps.store.taste.askQuestion({
        itemId: item.id,
        cardId: card?.id,
        question: args.question,
        toolCallId: String(api.taskId),
        conversationId: api.conversationId as number,
      });
      if (created) deps.bus.publish({ type: "taste.question", question });
      return toolText(
        created
          ? `Asked question ${question.id} about #${item.id}.`
          : `Question ${question.id} about #${item.id} is already open.`,
      );
    },
  });
}
