// One row per sweep: the cron slot id, status, counts, phase timings, cost and the audit.
import type { Sweep, SweepAudit, SweepPhase, SweepStatus } from "@dna/sdk";
import { TrackRepo } from "../track-repo.ts";
import { bind, nowIso, num, parse, str } from "../db.ts";

const toSweep = (r: any): Sweep => ({
  id: r.id,
  trackId: r.track_id,
  requestId: r.request_id,
  trigger: r.trigger,
  status: r.status,
  reason: str(r.reason),
  submissionId: num(r.submission_id),
  runEntryId: num(r.run_entry_id),
  taskId: num(r.task_id),
  searchMode: str(r.search_mode),
  gathered: r.gathered,
  kept: r.kept,
  duplicates: r.duplicates,
  candidates: r.candidates,
  presented: r.presented,
  maxCards: num(r.max_cards),
  summary: str(r.summary),
  firecrawlCreditsUsed: r.firecrawl_credits_used,
  firecrawlCreditsLeft: num(r.firecrawl_credits_left),
  phases: parse<SweepPhase[]>(r.phases_json, []),
  audit: parse<SweepAudit | undefined>(r.audit_json, undefined),
  error: str(r.error),
  startedAt: str(r.started_at),
  endedAt: str(r.ended_at),
  createdAt: r.created_at,
});

export type SweepPatch = Partial<{
  status: SweepStatus;
  reason: string;
  submissionId: number;
  runEntryId: number;
  taskId: number;
  searchMode: string;
  gathered: number;
  kept: number;
  duplicates: number;
  candidates: number;
  presented: number;
  maxCards: number;
  summary: string;
  firecrawlCreditsUsed: number;
  firecrawlCreditsLeft: number;
  phases: SweepPhase[];
  audit: SweepAudit;
  error: string;
  startedAt: string;
  endedAt: string;
}>;

const COLUMNS: Record<keyof SweepPatch, string> = {
  status: "status",
  reason: "reason",
  submissionId: "submission_id",
  runEntryId: "run_entry_id",
  taskId: "task_id",
  searchMode: "search_mode",
  gathered: "gathered",
  kept: "kept",
  duplicates: "duplicates",
  candidates: "candidates",
  presented: "presented",
  maxCards: "max_cards",
  summary: "summary",
  firecrawlCreditsUsed: "firecrawl_credits_used",
  firecrawlCreditsLeft: "firecrawl_credits_left",
  phases: "phases_json",
  audit: "audit_json",
  error: "error",
  startedAt: "started_at",
  endedAt: "ended_at",
};

export class SweepsRepo extends TrackRepo {
  byRequest(requestId: string): Sweep | undefined {
    const r = this.prepare("SELECT * FROM sweeps WHERE track_id = :track AND request_id = ?").get(
      requestId,
    );
    return r ? toSweep(r) : undefined;
  }

  get(id: number): Sweep | undefined {
    const r = this.prepare("SELECT * FROM sweeps WHERE track_id = :track AND id = ?").get(id);
    return r ? toSweep(r) : undefined;
  }

  create(input: {
    requestId: string;
    trigger: Sweep["trigger"];
    status: SweepStatus;
    reason?: string;
    searchMode?: string;
  }): Sweep {
    const r = this.prepare(
      "INSERT INTO sweeps (track_id, request_id, trigger, status, reason, search_mode, created_at) VALUES (:track, :request_id, :trigger, :status, :reason, :search_mode, :now)",
    ).run(
      bind({
        request_id: input.requestId,
        trigger: input.trigger,
        status: input.status,
        reason: input.reason,
        search_mode: input.searchMode,
        now: nowIso(),
      }),
    );
    return this.get(Number(r.lastInsertRowid))!;
  }

  update(id: number, patch: SweepPatch): Sweep {
    const keys = (Object.keys(patch) as (keyof SweepPatch)[]).filter((k) => patch[k] !== undefined);
    if (keys.length) {
      const sets = keys.map((k) => `${COLUMNS[k]} = :${k}`).join(", ");
      this.prepare(`UPDATE sweeps SET ${sets} WHERE track_id = :track AND id = :id`).run(
        bind({ ...patch, id }),
      );
    }
    return this.get(id)!;
  }

  /** When the newest cron sweep that actually started was created (skipped ones do not count). */
  lastCronAt(): string | undefined {
    const r = this.prepare(
      "SELECT created_at FROM sweeps WHERE track_id = :track AND trigger = 'cron' AND status != 'skipped' ORDER BY id DESC LIMIT 1",
    ).get() as { created_at: string } | undefined;
    return r?.created_at;
  }

  /** Open (queued or running) sweeps, newest first. */
  active(): Sweep[] {
    return (
      this.prepare(
        "SELECT * FROM sweeps WHERE track_id = :track AND status IN ('queued', 'running') ORDER BY id DESC",
      ).all() as any[]
    ).map(toSweep);
  }

  list(limit = 50, before?: number): Sweep[] {
    const rows = before
      ? this.prepare(
          "SELECT * FROM sweeps WHERE track_id = :track AND id < ? ORDER BY id DESC LIMIT ?",
        ).all(before, limit)
      : this.prepare("SELECT * FROM sweeps WHERE track_id = :track ORDER BY id DESC LIMIT ?").all(
          limit,
        );
    return (rows as any[]).map(toSweep);
  }

  last(): Sweep | undefined {
    const r = this.prepare(
      "SELECT * FROM sweeps WHERE track_id = :track AND status NOT IN ('skipped') ORDER BY id DESC LIMIT 1",
    ).get();
    return r ? toSweep(r) : undefined;
  }

  /** Start of the most recent completed sweep, for "since". */
  lastFinishedAt(): string | undefined {
    const r = this.prepare(
      "SELECT started_at FROM sweeps WHERE track_id = :track AND status IN ('completed', 'no_news') AND started_at IS NOT NULL ORDER BY id DESC LIMIT 1",
    ).get() as any;
    return str(r?.started_at);
  }

  phase(id: number, phase: string, status: SweepPhase["status"], note?: string): Sweep {
    const sweep = this.get(id)!;
    const phases = [...sweep.phases];
    const now = Date.now();
    const open = phases.findLastIndex((p) => p.phase === phase && p.status === "running");
    if (status === "running" && open < 0) phases.push({ phase, status, startedAt: now, note });
    else if (open >= 0)
      phases[open] = {
        ...phases[open],
        status,
        endedAt: status === "running" ? undefined : now,
        note: note ?? phases[open].note,
      };
    else phases.push({ phase, status, startedAt: now, endedAt: now, note });
    return this.update(id, { phases });
  }

  touch(id: number, at = nowIso()): void {
    this.prepare(
      "UPDATE sweeps SET started_at = COALESCE(started_at, ?) WHERE track_id = :track AND id = ?",
    ).run(at, id);
  }
}
