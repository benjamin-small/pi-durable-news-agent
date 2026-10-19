import { trackName } from "./profiles.ts";
// dna.image: generate one card image in the background, then push the updated cards. A background task, so the
// agent's run never waits on it and an abort of the run does not cancel it.
import { defineTask } from "@earendil-works/pi-durable";
import type { Deps } from "../deps.ts";

export interface ImageInput {
  imageId: number;
  prompt: string;
}

export function createImageTask(deps: Deps) {
  return defineTask<ImageInput, { phase: "generate" }, { ok: boolean }>({
    name: trackName(deps, "dna.image"),
    version: 1,
    initial: () => ({ phase: "generate" }),
    phases: {
      generate: async (task, runtime, ctx) => {
        let ok = deps.store.news.image(task.input.imageId)?.status === "ready";
        if (!ok) {
          try {
            ok = (await deps.images.generate(task.input.imageId, task.input.prompt)).ok;
          } catch (error) {
            deps.store.news.updateImage(task.input.imageId, {
              status: "failed",
              error: String(error).slice(0, 500),
            });
            deps.log.warn("image.task_failed", {
              imageId: task.input.imageId,
              error: String(error),
            });
          }
        }
        for (const card of deps.store.news.cardsWithImage(task.input.imageId))
          deps.bus.publish({ type: "feed.card_updated", card });
        await runtime.commit(
          () => ({ status: "terminal", outcome: { status: "completed", result: { ok } } }),
          ctx,
        );
      },
    },
    abort: async (_task, runtime, ctx) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
    },
  });
}
