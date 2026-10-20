// Helpers every tool uses: the call reference for telemetry, sweep lookup, item lookup with a fixable error.
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { CallRef } from "../../news/search/index.ts";
import type { Deps } from "../../deps.ts";
import type { Item } from "../../db/repos/news.ts";

/** Telemetry links jev and Firecrawl calls to the tool call by its pi-durable task id (unique in the session). */
export const ref = (api: ToolExecutionApi, sweepId?: number, trackId?: string): CallRef => ({
  ...(trackId ? { trackId } : {}),
  conversationId: api.conversationId as number,
  callId: String(api.taskId),
  sweepId,
});

export function activeSweepId(deps: Deps, given?: number): number | undefined {
  if (given !== undefined) {
    if (!deps.store.sweeps.get(given)) throw new FixableError(`No sweep #${given} in this track.`);
    return given;
  }
  return deps.store.sweeps.active()[0]?.id;
}

export class FixableError extends Error {
  constructor(
    message: string,
    readonly hints: string[] = [],
  ) {
    super(message);
  }
}

export function requireItem(deps: Deps, id: number): Item {
  const item = deps.store.news.item(id);
  if (!item)
    throw new FixableError(`No item #${id}.`, [
      "Use an item id returned by run_news_sweep, list_candidates or search_web.",
    ]);
  return item;
}

export function itemLine(item: Item): string {
  const parts = [`#${item.id}`, item.title];
  if (item.sourceName) parts.push(`(${item.sourceName})`);
  if (item.attention !== undefined) parts.push(`attention ${item.attention}`);
  return parts.join(" ");
}

export const clip = (text: string | undefined, max: number) =>
  !text ? "" : text.length > max ? `${text.slice(0, max)} [${text.length - max} more chars]` : text;
