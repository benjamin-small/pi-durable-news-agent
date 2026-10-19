import type { RequestHandler } from "express";
import { invalid, notFound, ApiFault } from "../errors.ts";
import type { App } from "../runtime.ts";
import type { Handlers, RouteDeps } from "./types.ts";

/** Resolve once, before idempotency or handlers; a typo must never target the AI desk. */
export function requireActiveTrack(app: App): RequestHandler {
  return (req, res, next) => {
    if (req.path === "/healthz") return next();
    if (req.body?.track !== undefined || req.body?.trackId !== undefined)
      throw invalid("Select the desk using ?track=id, not a body field");
    const id = req.query.track ?? app.track.id;
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id))
      throw invalid("track must be a lowercase track id");
    if (!app.store.tracks.get(id)) throw notFound(`Unknown track ${id}`);
    if (!app.desks.has(id)) throw new ApiFault("unavailable", `Track ${id} has no running desk`);
    res.set("X-DNA-Track", id);
    res.locals.trackId = id;
    next();
  };
}

export function trackRoutes({ app }: RouteDeps): Handlers<"tracks.list"> {
  return {
    "tracks.list": (_req, res) => res.json([...app.desks.values()].map((desk) => desk.track)),
  };
}
