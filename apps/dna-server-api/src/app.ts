// The Express app: request log, auth, idempotency, then every route in ROUTES with its scope, then errors.
import express from "express";
import { ROUTES, type RouteId } from "@dna/sdk";
import { identify, requireScope } from "./auth.ts";
import { errorMiddleware, notFound } from "./errors.ts";
import { idempotent } from "./idempotency.ts";
import { requestLog } from "./request-log.ts";
import { agentRoutes } from "./routes/agent.ts";
import { executionRoutes } from "./routes/executions.ts";
import { feedRoutes } from "./routes/feed.ts";
import { infoRoutes } from "./routes/info.ts";
import { keywordRoutes } from "./routes/keywords.ts";
import { logRoutes } from "./routes/logs.ts";
import { sourceRoutes } from "./routes/sources.ts";
import { tasteRoutes } from "./routes/taste.ts";
import type { Handlers } from "./routes/types.ts";
import { scheduleRoutes } from "./routes/schedule.ts";
import { workflowRoutes } from "./routes/workflows.ts";
import type { App } from "./runtime.ts";
import { StreamHub } from "./sse.ts";
import { requireActiveTrack, trackRoutes } from "./routes/tracks.ts";

export function createHttpApp(app: App) {
  const hub = new StreamHub();
  const byTrack = new Map(
    [...app.desks].map(([id, desk]) => {
      const deps = { app: desk, hub };
      const handlers: Handlers = {
        ...trackRoutes(deps),
        ...infoRoutes(deps),
        ...workflowRoutes(deps),
        ...scheduleRoutes(deps),
        ...feedRoutes(deps),
        ...tasteRoutes(deps),
        ...keywordRoutes(deps),
        ...sourceRoutes(deps),
        ...agentRoutes(deps),
        ...executionRoutes(deps),
        ...logRoutes(deps),
      };
      return [id, handlers] as const;
    }),
  );
  const http = express();
  http.disable("x-powered-by");
  http.set("trust proxy", "loopback");
  http.use(requestLog(app.log));
  http.use(express.json({ limit: "256kb" }));
  http.use(identify({ client: app.config.clientToken, cron: app.config.cronToken }));
  const track = requireActiveTrack(app);
  const replay = idempotent(app.store.db, { skip: [ROUTES["workflow.newsSweep"].path] });
  for (const id of Object.keys(ROUTES) as RouteId[]) {
    const route = ROUTES[id];
    const method = route.method.toLowerCase() as "get" | "post" | "patch" | "delete";
    http[method](route.path, requireScope(route.scope, id, app.log), track, replay, (req, res) =>
      byTrack.get(res.locals.trackId ?? app.track.id)![id](req, res),
    );
  }
  http.use((req) => {
    throw notFound(`No route ${req.method} ${req.path}`);
  });
  http.use(errorMiddleware(app.log));
  return { http, hub };
}
