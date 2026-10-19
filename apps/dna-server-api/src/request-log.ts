// One log line per request: request id, method, path, status, ms, principal. Never the token.
import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import type { Logger } from "@dna/sdk/node";

export function requestLog(log: Logger): RequestHandler {
  return (req, res, next) => {
    const id = req.get("x-request-id")?.slice(0, 64) || randomUUID();
    const start = performance.now();
    res.set("x-request-id", id);
    res.on("finish", () => {
      const line = {
        requestId: id,
        trackId: res.locals.trackId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Math.round(performance.now() - start),
        principal: res.locals.principal,
      };
      if (req.path === "/healthz") log.debug("http.request", line);
      else if (res.statusCode >= 500) log.error("http.request", line);
      else log.info("http.request", line);
    });
    next();
  };
}
