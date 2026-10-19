// POST /v1/workflows/news-sweep (cron token only) and the sweep reads.
import { startNewsSweep } from "../news/sweep.ts";
import { int, notFound, optInt } from "../errors.ts";
import { MAX_CARDS } from "../news/schedule.ts";
import { bodyOf, bool, num, oneOf, str, type Handlers, type RouteDeps } from "./types.ts";

export function workflowRoutes({
  app,
}: RouteDeps): Handlers<"workflow.newsSweep" | "sweeps.list" | "sweeps.get"> {
  const withCost = <T extends { id: number }>(s: T) => ({
    ...s,
    cost: app.store.telemetry.sweepCost(s.id),
  });
  return {
    "workflow.newsSweep": async (req, res) => {
      const body = bodyOf(req);
      const requestId = str(body, "requestId", { max: 128 });
      const trigger =
        oneOf(body.trigger, "trigger", ["cron", "manual", "test"] as const, true) ?? "cron";
      const scheduled = bool(body, "scheduled") ?? false;
      const cards = num(body, "cards", { min: 1, max: MAX_CARDS, integer: true });
      const targets = scheduled && req.query.track === undefined ? [...app.desks.values()] : [app];
      const trackResults = await Promise.all(
        targets.map(async (desk) => {
          const result = await startNewsSweep(desk, desk.main, desk.ctx, {
            trigger,
            requestId,
            scheduled,
            cards,
          });
          return {
            ...result,
            trackId: desk.track.id,
            sweep: result.sweep && {
              ...result.sweep,
              cost: desk.store.telemetry.sweepCost(result.sweep.id),
            },
          };
        }),
      );
      const selected = trackResults.find((r) => r.status === "accepted") ?? trackResults[0];
      const result = { ...selected, ...(targets.length > 1 ? { trackResults } : {}) };
      if (targets.length > 1) res.set("X-DNA-Track", "all");
      if (result.status === "not_due") return res.status(200).json(result);
      if (result.status === "replay") res.set("Idempotent-Replay", "true");
      res.status(result.status === "accepted" ? 202 : 200).json(result);
    },
    "sweeps.list": (req, res) =>
      res.json(
        app.store.sweeps
          .list(int(req.query.limit, "limit", 50), optInt(req.query.before, "before"))
          .map(withCost),
      ),
    "sweeps.get": (req, res) => {
      const sweep = app.store.sweeps.get(int(req.params.id, "id"));
      if (!sweep) throw notFound(`No sweep ${req.params.id}`);
      res.json({ ...withCost(sweep), toolCalls: app.store.telemetry.toolCallsForSweep(sweep.id) });
    },
  };
}
