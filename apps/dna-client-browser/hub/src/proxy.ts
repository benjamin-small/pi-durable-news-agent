// /api/* goes to the target device with the client token. The stream passes through unbuffered, images pass
// through as bytes, everything else as JSON.
import { Readable } from "node:stream";
import type { RequestHandler } from "express";
import type { Logger } from "@dna/sdk/node";

const err = (code: string, message: string) => ({ error: { code, message } });

export function proxy(
  target: { url: string; token: string; device: string },
  log: Logger,
): RequestHandler {
  return async (req, res) => {
    const path = req.originalUrl.replace(/^\/api/, "");
    const closed = new AbortController();
    res.on("close", () => closed.abort());
    const stream = path.startsWith("/v1/stream");
    const hasBody = !["GET", "HEAD", "DELETE"].includes(req.method);
    try {
      const upstream = await fetch(target.url + path, {
        method: req.method,
        headers: {
          authorization: `Bearer ${target.token}`,
          ...(hasBody ? { "content-type": "application/json" } : {}),
          ...(req.get("idempotency-key") ? { "idempotency-key": req.get("idempotency-key")! } : {}),
          ...(stream ? { accept: "text/event-stream" } : {}),
        },
        body: hasBody ? JSON.stringify(req.body ?? {}) : undefined,
        signal: stream
          ? closed.signal
          : AbortSignal.any([closed.signal, AbortSignal.timeout(330_000)]),
      });
      res.status(upstream.status);
      for (const h of [
        "content-type",
        "content-disposition",
        "x-content-type-options",
        "content-security-policy",
        "cache-control",
        "idempotent-replay",
        "x-request-id",
        "x-dna-track",
      ]) {
        const v = upstream.headers.get(h);
        if (v) res.set(h, v);
      }
      if (stream && upstream.ok && upstream.body) {
        res.set({
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        res.flushHeaders();
        res.socket?.setNoDelay(true);
        Readable.fromWeb(upstream.body as never)
          .on("error", () => res.end())
          .pipe(res);
        return;
      }
      res.send(Buffer.from(await upstream.arrayBuffer()));
    } catch (e) {
      if (closed.signal.aborted) return;
      log.warn("hub.upstream_failed", {
        path: req.path,
        device: target.device,
        error: (e as Error).message,
      });
      if (!res.headersSent)
        res
          .status(502)
          .json(err("offline", `${target.device} did not answer: ${(e as Error).message}`));
    }
  };
}
