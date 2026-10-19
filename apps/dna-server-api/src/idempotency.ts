// Idempotency-Key on every POST: a repeated key on the same route replays the stored response for 24 h.
import type { RequestHandler } from "express";
import type { Db } from "./db/db.ts";
import { invalid } from "./errors.ts";

const TTL_MS = 24 * 3_600_000;

export function idempotent(db: Db, options: { skip?: string[] } = {}): RequestHandler {
  let lastPurge = 0;
  return (req, res, next) => {
    if (req.method !== "POST" || options.skip?.includes(req.path)) return next();
    const key = req.get("idempotency-key");
    if (!key) return next();
    if (key.length > 128) throw invalid("Idempotency-Key must be 128 characters or fewer");
    const route = `${req.method} ${req.baseUrl}${req.path}?track=${res.locals.trackId}`;
    if (Date.now() - lastPurge > 3_600_000) {
      lastPurge = Date.now();
      db.prepare("DELETE FROM requests WHERE created_at < ?").run(
        new Date(Date.now() - TTL_MS).toISOString(),
      );
    }
    const stored = db
      .prepare("SELECT status, body FROM requests WHERE key = ? AND route = ? AND created_at >= ?")
      .get(key, route, new Date(Date.now() - TTL_MS).toISOString()) as
      | { status: number; body: string }
      | undefined;
    if (stored)
      return void res
        .status(stored.status)
        .set("Idempotent-Replay", "true")
        .json(JSON.parse(stored.body));
    const json = res.json.bind(res);
    res.json = (body: unknown) => {
      if (res.statusCode < 400 && res.get("Idempotent-Replay") !== "true")
        db.prepare(
          "INSERT OR REPLACE INTO requests (key, route, status, body, created_at) VALUES (?, ?, ?, ?, ?)",
        ).run(key, route, res.statusCode, JSON.stringify(body ?? null), new Date().toISOString());
      return json(body);
    };
    next();
  };
}
