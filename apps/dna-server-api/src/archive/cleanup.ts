import type { App } from "../runtime.ts";

/** Await the durable graph before entering a synchronous, non-yielding deletion batch. */
export async function cleanupArchive(
  app: App,
  options: { previewToken?: string; scheduled?: boolean } = {},
) {
  const graph = await app.harness.harness.taskGraph(app.harness.ctx);
  try {
    const busy = Object.values(graph.value.tasks).some((t) => !t.background);
    const result = app.store.retention.cleanup({ ...options, busy });
    if (result.status === "completed") app.store.retention.clearScrapeCache();
    app.log.info("archive.cleanup", { ...result });
    return result;
  } finally {
    graph.dispose();
  }
}
