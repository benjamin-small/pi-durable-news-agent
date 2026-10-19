// GET /v1/logs: the tails of logs/<app>.jsonl (every app unless narrowed), merged newest last, filtered by level,
// sweep, conversation and call. 500 lines max.
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LogLine } from "@dna/sdk";
import { int, invalid, optInt } from "../errors.ts";
import { oneOf, type Handlers, type RouteDeps } from "./types.ts";

const LEVELS = ["debug", "info", "warn", "error"] as const;
const RANK: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };
const TAIL_BYTES = 8 * 1024 * 1024;

export function tail(file: string, bytes = TAIL_BYTES): string[] {
  if (!existsSync(file)) return [];
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return lines.filter(Boolean);
  } finally {
    closeSync(fd);
  }
}

/** Comma separated names, each like api or cron; undefined when the query leaves it out. */
function names(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === "") return undefined;
  const list = String(value)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  for (const n of list)
    if (!/^[a-z][a-z-]{0,20}$/.test(n))
      throw invalid(`${field} must list names like api, cron, cli or hub`);
  return list;
}

export function logRoutes({ app }: RouteDeps): Handlers<"logs"> {
  const dir = dirname(app.log.file);
  return {
    logs: (req, res) => {
      // Every app and level unless the query narrows it: apps=api,cron and levels=warn,error (app and level still work).
      const apps =
        names(req.query.apps, "apps") ??
        (req.query.app
          ? names(req.query.app, "app")!
          : existsSync(dir)
            ? readdirSync(dir)
                .filter((f) => f.endsWith(".jsonl"))
                .map((f) => f.slice(0, -".jsonl".length))
            : []);
      const levels = names(req.query.levels, "levels");
      if (levels?.some((l) => !(LEVELS as readonly string[]).includes(l)))
        throw invalid(`levels must list: ${LEVELS.join(", ")}`);
      const level = oneOf(req.query.level, "level", LEVELS, true) ?? "debug";
      const sweepId = optInt(req.query.sweepId, "sweepId");
      const conversationId = optInt(req.query.conversationId, "conversationId");
      const callId = req.query.callId ? String(req.query.callId) : undefined;
      const limit = Math.min(int(req.query.limit, "limit", 200), 500);
      const out: LogLine[] = [];
      for (const name of apps) {
        const lines = tail(join(dir, `${name}.jsonl`));
        let taken = 0;
        for (let i = lines.length - 1; i >= 0 && taken < limit; i--) {
          let line: LogLine;
          try {
            line = JSON.parse(lines[i]);
          } catch {
            continue;
          }
          line.app ??= name;
          if (line.trackId && line.trackId !== app.track.id) continue;
          if (
            !line.trackId &&
            typeof line.conversationId === "number" &&
            !app.store.telemetry.ownsConversation(line.conversationId)
          )
            continue;
          if (
            !line.trackId &&
            typeof line.sweepId === "number" &&
            !app.store.sweeps.get(line.sweepId)
          )
            continue;
          if (levels ? !levels.includes(line.level) : (RANK[line.level] ?? 0) < RANK[level])
            continue;
          if (sweepId !== undefined && line.sweepId !== sweepId) continue;
          if (conversationId !== undefined && line.conversationId !== conversationId) continue;
          if (callId !== undefined && line.callId !== callId && line.taskId !== Number(callId))
            continue;
          out.push(line);
          taken++;
        }
      }
      out.sort((a, b) => a.ts.localeCompare(b.ts));
      res.json(out.slice(-limit));
    },
  };
}
