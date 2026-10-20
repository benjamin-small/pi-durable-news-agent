import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  statSync,
  lstatSync,
  unlinkSync,
  openSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
  ArchivePolicy,
  ArchiveRetentionReport,
  ArchiveCleanupResult,
  ArchiveKind,
} from "@dna/sdk";
import { tx, type Db } from "../db/db.ts";
import type { Archive } from "./archive.ts";

const DAY = 86400000;
function syncRemoval(file: string) {
  const dir = dirname(file);
  if (existsSync(dir)) {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}
interface BlobState {
  hash: string;
  bytes: number;
  rawBytes: number;
  expiredAt?: string;
  deadline: number;
  pinned: boolean;
  cited: boolean;
}

/** Global policy: a shared blob is reclaimed only when every reference in both desks allows it. */
export class ArchiveRetention {
  constructor(
    readonly db: Db,
    readonly archive: Archive,
  ) {}

  policy(): ArchivePolicy {
    const p = this.db.prepare("SELECT * FROM archive_policy WHERE id='source-bodies-v1'").get()!;
    return {
      ordinaryDays: Number(p.ordinary_days),
      citedDays: Number(p.cited_days),
      pinsIndefinite: true,
      enforcement: p.enforcement as ArchivePolicy["enforcement"],
      storageBudgetBytes: Number(p.storage_budget_bytes),
      revision: Number(p.revision),
    };
  }

  setPolicy(
    patch: Partial<
      Pick<ArchivePolicy, "ordinaryDays" | "citedDays" | "enforcement" | "storageBudgetBytes">
    >,
    previewToken?: string,
  ): ArchivePolicy {
    return tx(this.db, () => {
      const old = this.policy(),
        p = { ...old, ...patch };
      if (
        !Number.isInteger(p.ordinaryDays) ||
        p.ordinaryDays < 1 ||
        p.ordinaryDays > 3650 ||
        !Number.isInteger(p.citedDays) ||
        p.citedDays < p.ordinaryDays ||
        p.citedDays > 3650
      )
        throw new Error(
          "Retention days must be whole days from 1 to 3650, with cited retention at least ordinary retention",
        );
      if (!Number.isSafeInteger(p.storageBudgetBytes) || p.storageBudgetBytes < 1048576)
        throw new Error("Storage warning budget must be at least 1 MiB");
      if (!["disabled", "enabled"].includes(p.enforcement))
        throw new Error("Invalid retention enforcement");
      if (p.enforcement === "enabled") {
        if (
          p.ordinaryDays !== old.ordinaryDays ||
          p.citedDays !== old.citedDays ||
          p.storageBudgetBytes !== old.storageBudgetBytes
        )
          throw new Error(
            "Save changed policy with cleanup disabled, then preview it before enabling",
          );
        if (!previewToken || this.preview().token !== previewToken)
          throw new Error("Preview the current archive before enabling cleanup");
      }
      this.db
        .prepare(
          "UPDATE archive_policy SET ordinary_days=?,cited_days=?,enforcement=?,storage_budget_bytes=?,revision=revision+1,updated_at=? WHERE id='source-bodies-v1'",
        )
        .run(
          p.ordinaryDays,
          p.citedDays,
          p.enforcement,
          p.storageBudgetBytes,
          new Date().toISOString(),
        );
      return this.policy();
    });
  }

  private orphanFiles(now: Date) {
    const root = join(this.archive.directory, "blobs"),
      files: { path: string; bytes: number; mtime: number; eligible: boolean }[] = [];
    if (!existsSync(root)) return files;
    const known = new Set(
      this.db
        .prepare("SELECT hash FROM archive_blobs")
        .all()
        .map((r) => String(r.hash)),
    );
    for (const dir of readdirSync(root, { withFileTypes: true }))
      if (dir.isDirectory() && /^[0-9a-f]{2}$/.test(dir.name)) {
        for (const entry of readdirSync(join(root, dir.name), { withFileTypes: true })) {
          const match = /^([0-9a-f]{64})\.gz(?:\.[0-9a-f-]{36}\.tmp)?$/.exec(entry.name);
          if (
            !entry.isFile() ||
            !match ||
            match[1].slice(0, 2) !== dir.name ||
            (entry.name.endsWith(".gz") && known.has(match[1]))
          )
            continue;
          const path = `blobs/${dir.name}/${entry.name}`,
            stat = statSync(join(this.archive.directory, path));
          files.push({
            path,
            bytes: stat.size,
            mtime: stat.mtimeMs,
            eligible: now.getTime() - stat.mtimeMs > DAY,
          });
        }
      }
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  private states(now: Date) {
    const policy = this.policy(),
      states = new Map<string, BlobState>(),
      targets = new Map<string, string[]>();
    for (const b of this.db.prepare("SELECT * FROM archive_blobs").all())
      states.set(String(b.hash), {
        hash: String(b.hash),
        bytes: Number(b.stored_bytes),
        rawBytes: Number(b.bytes),
        expiredAt: b.expired_at as string | undefined,
        deadline: 0,
        pinned: false,
        cited: false,
      });
    const index = (kind: ArchiveKind, id: number, hash: string, at: string) => {
      targets.set(`${kind}:${id}`, [hash]);
      const b = states.get(hash)!;
      b.deadline = Math.max(b.deadline, Date.parse(at) + policy.ordinaryDays * DAY);
    };
    for (const r of this.db.prepare("SELECT * FROM archive_versions").all())
      index("version", Number(r.id), String(r.blob_hash), String(r.first_seen_at));
    for (const r of this.db.prepare("SELECT * FROM archive_extractions").all())
      index("extraction", Number(r.id), String(r.blob_hash), String(r.created_at));
    for (const r of this.db
      .prepare(
        `SELECT x.extraction_id,o.version_id FROM archive_extraction_inputs x JOIN archive_observations o ON o.id=x.observation_id WHERE o.version_id IS NOT NULL`,
      )
      .all()) {
      const key = `extraction:${r.extraction_id}`;
      targets.get(key)!.push(...targets.get(`version:${r.version_id}`)!);
    }
    for (const r of this.db.prepare("SELECT * FROM archive_evidence").all())
      index("evidence", Number(r.id), String(r.blob_hash), String(r.created_at));
    for (const r of this.db.prepare("SELECT * FROM archive_evidence_sources").all())
      targets
        .get(`evidence:${r.evidence_id}`)!
        .push(...targets.get(`extraction:${r.extraction_id}`)!);
    for (const r of this.db
      .prepare(
        "SELECT evidence_id,max(published_at) at FROM archive_citations GROUP BY evidence_id",
      )
      .all())
      for (const hash of targets.get(`evidence:${r.evidence_id}`) ?? []) {
        const b = states.get(hash)!;
        b.cited = true;
        b.deadline = Math.max(b.deadline, Date.parse(String(r.at)) + policy.citedDays * DAY);
      }
    for (const r of this.db.prepare("SELECT * FROM archive_pins").all())
      for (const hash of targets.get(`${r.kind}:${r.target_id}`) ?? [])
        states.get(hash)!.pinned = true;
    // An orphan row from a failed logical operation still receives the ordinary grace period.
    for (const b of this.db.prepare("SELECT hash,created_at FROM archive_blobs").all())
      if (!states.get(String(b.hash))!.deadline)
        states.get(String(b.hash))!.deadline =
          Date.parse(String(b.created_at)) + policy.ordinaryDays * DAY;
    const active =
      this.archive.activeAcquisitions > 0 ||
      !!this.db.prepare("SELECT id FROM sweeps WHERE status IN ('queued','running') LIMIT 1").get();
    const eligible = [...states.values()]
      .filter((b) => !b.expiredAt && !b.pinned && b.deadline <= now.getTime())
      .sort((a, b) => a.deadline - b.deadline || a.hash.localeCompare(b.hash));
    return { policy, states, eligible, active };
  }

  preview(now = new Date()): ArchiveRetentionReport {
    const { policy, states, eligible, active } = this.states(now),
      retained = [...states.values()].filter((b) => !b.expiredAt);
    const sum = (values: BlobState[]) => values.reduce((n, b) => n + b.bytes, 0);
    const pendingBytes = sum(
      [...states.values()].filter(
        (b) => !!b.expiredAt && existsSync(this.archive.blobPath(b.hash)),
      ),
    );
    const orphans = this.orphanFiles(now),
      orphanBytes = orphans.reduce((n, f) => n + f.bytes, 0);
    const storedBytes = sum(retained) + pendingBytes + orphanBytes,
      reclaimableBytes = sum(eligible);
    const token = createHash("sha256")
      .update(
        JSON.stringify([
          policy,
          active,
          [...states.values()].map((b) => [
            b.hash,
            b.expiredAt ?? null,
            b.deadline,
            b.pinned,
            b.cited,
          ]),
          eligible.map((b) => b.hash),
          orphans,
        ]),
      )
      .digest("hex");
    return {
      policy,
      generatedAt: now.toISOString(),
      token,
      active,
      storedBytes,
      reclaimableBytes,
      pinnedBytes: sum(retained.filter((b) => b.pinned)),
      citedBytes: sum(retained.filter((b) => b.cited)),
      pendingBytes,
      orphanBytes,
      orphanCandidateCount: orphans.filter((f) => f.eligible).length,
      orphans: orphans
        .filter((f) => f.eligible)
        .slice(0, 100)
        .map((f) => ({ path: f.path, storedBytes: f.bytes })),
      overBudget: storedBytes > policy.storageBudgetBytes,
      candidateCount: eligible.length,
      candidates: eligible.slice(0, 100).map((b) => ({
        hash: b.hash,
        storedBytes: b.bytes,
        expiresAt: new Date(b.deadline).toISOString(),
        reason: b.cited ? "Cited retention elapsed" : "Ordinary retention elapsed",
      })),
      recentRuns: this.db
        .prepare(
          "SELECT id,started_at,finished_at,status,summary_json,error FROM archive_cleanup_runs ORDER BY id DESC LIMIT 10",
        )
        .all()
        .map((r) => ({
          id: Number(r.id),
          startedAt: String(r.started_at),
          finishedAt: r.finished_at as string | undefined,
          status: String(r.status),
          summary: r.summary_json ? JSON.parse(String(r.summary_json)) : undefined,
          error: r.error as string | undefined,
        })),
    };
  }

  /** The decision and tombstone commit before unlink. A crash resumes pending deletions on the next pass. */
  cleanup(
    options: {
      previewToken?: string;
      scheduled?: boolean;
      busy?: boolean;
      now?: Date;
      limit?: number;
    } = {},
  ): ArchiveCleanupResult {
    const now = options.now ?? new Date(),
      limit = Math.max(1, Math.min(100, options.limit ?? 100));
    const result = tx(this.db, () => {
      const report = this.preview(now);
      if (report.policy.enforcement !== "enabled") throw new Error("Cleanup is disabled");
      if (!options.scheduled && options.previewToken !== report.token)
        throw new Error("Archive changed; preview cleanup again");
      const active = report.active || options.busy;
      const id = Number(
        this.db
          .prepare("INSERT INTO archive_cleanup_runs(started_at,status,policy_json) VALUES (?,?,?)")
          .run(now.toISOString(), active ? "deferred" : "marked", JSON.stringify(report.policy))
          .lastInsertRowid,
      );
      if (active) {
        this.db
          .prepare("UPDATE archive_cleanup_runs SET finished_at=?,summary_json=? WHERE id=?")
          .run(
            now.toISOString(),
            JSON.stringify({ reason: "Active processing; nothing deleted" }),
            id,
          );
        return { id, status: "deferred" as const, marked: 0, deleted: 0, bytes: 0 };
      }
      const candidates = report.candidates.slice(0, limit);
      for (const b of candidates) {
        this.db
          .prepare("UPDATE archive_blobs SET expired_at=? WHERE hash=? AND expired_at IS NULL")
          .run(now.toISOString(), b.hash);
        this.db
          .prepare(
            "INSERT INTO archive_cleanup_entries(run_id,blob_hash,bytes,reason) VALUES (?,?,?,?)",
          )
          .run(id, b.hash, b.storedBytes, b.reason);
      }
      this.db
        .prepare(`UPDATE sources SET etag=NULL,last_modified=NULL,content_hash=NULL WHERE id IN (
        SELECT o.source_id FROM archive_observations o JOIN archive_versions v ON v.id=o.version_id JOIN archive_cleanup_entries c ON c.blob_hash=v.blob_hash WHERE c.run_id=? AND o.source_id IS NOT NULL
        UNION SELECT o.source_id FROM archive_observations o JOIN archive_extraction_inputs x ON x.observation_id=o.id JOIN archive_extractions e ON e.id=x.extraction_id JOIN archive_cleanup_entries c ON c.blob_hash=e.blob_hash WHERE c.run_id=? AND o.source_id IS NOT NULL)`)
        .run(id, id);
      for (const file of report.orphans.slice(0, limit - candidates.length))
        this.db
          .prepare("INSERT INTO archive_cleanup_files(run_id,path,bytes) VALUES (?,?,?)")
          .run(id, file.path, file.storedBytes);
      // Remove ordinary cached bodies only when their exact archived representation has expired.
      this.db
        .prepare(
          `UPDATE source_cache SET content_md=NULL,excerpt=NULL WHERE archive_extraction_id IN (SELECT e.id FROM archive_extractions e JOIN archive_blobs b ON b.hash=e.blob_hash WHERE b.expired_at IS NOT NULL)`,
        )
        .run();
      this.db
        .prepare(
          `UPDATE items SET excerpt=NULL WHERE cache_id IN (SELECT c.id FROM source_cache c JOIN archive_extractions e ON e.id=c.archive_extraction_id JOIN archive_blobs b ON b.hash=e.blob_hash WHERE b.expired_at IS NOT NULL)`,
        )
        .run();
      return {
        id,
        status: "marked" as "marked" | "deferred" | "completed" | "partial",
        marked: candidates.length,
        deleted: 0,
        bytes: 0,
      };
    });
    if (result.status === "deferred") return result;
    const errors: string[] = [];
    let processed = 0;
    // Retry older tombstones first; completed rows cannot starve later batches.
    for (const b of this.db
      .prepare(
        "SELECT hash,stored_bytes FROM archive_blobs WHERE expired_at IS NOT NULL AND purged_at IS NULL ORDER BY coalesce(purge_attempted_at,''),expired_at,hash LIMIT ?",
      )
      .all(limit)) {
      processed++;
      this.db
        .prepare("UPDATE archive_blobs SET purge_attempted_at=? WHERE hash=?")
        .run(new Date().toISOString(), b.hash);
      try {
        const file = this.archive.blobPath(String(b.hash));
        if (existsSync(file)) {
          unlinkSync(file);
          result.deleted++;
          result.bytes += Number(b.stored_bytes);
        }
        syncRemoval(file);
        this.db
          .prepare("UPDATE archive_blobs SET purged_at=? WHERE hash=? AND expired_at IS NOT NULL")
          .run(now.toISOString(), b.hash);
        this.db
          .prepare(
            "UPDATE archive_cleanup_entries SET deleted_at=?,error=NULL WHERE blob_hash=? AND deleted_at IS NULL",
          )
          .run(now.toISOString(), b.hash);
      } catch (error) {
        errors.push(`Could not delete ${b.hash}`);
        this.db
          .prepare(
            "UPDATE archive_cleanup_entries SET error=? WHERE blob_hash=? AND deleted_at IS NULL",
          )
          .run(String(error).slice(0, 400), b.hash);
      }
    }
    const orphanCandidates = new Set(
      this.orphanFiles(now)
        .filter((f) => f.eligible)
        .map((f) => f.path),
    );
    for (const row of this.db
      .prepare(
        "SELECT path,max(bytes) bytes FROM archive_cleanup_files WHERE deleted_at IS NULL AND cancelled_at IS NULL GROUP BY path ORDER BY min(run_id) LIMIT ?",
      )
      .all(Math.max(0, limit - processed))) {
      const path = String(row.path),
        file = join(this.archive.directory, path);
      try {
        if (existsSync(file)) {
          if (!orphanCandidates.has(path) || !lstatSync(file).isFile()) {
            this.db
              .prepare(
                "UPDATE archive_cleanup_files SET cancelled_at=?,error=? WHERE path=? AND deleted_at IS NULL AND cancelled_at IS NULL",
              )
              .run(
                now.toISOString(),
                "Cancelled: file is referenced, recent, or no longer a regular orphan",
                path,
              );
            continue;
          }
          unlinkSync(file);
          result.deleted++;
          result.bytes += Number(row.bytes);
        }
        syncRemoval(file);
        this.db
          .prepare(
            "UPDATE archive_cleanup_files SET deleted_at=?,error=NULL WHERE path=? AND deleted_at IS NULL",
          )
          .run(now.toISOString(), path);
      } catch (error) {
        errors.push(`Could not delete orphan ${path}`);
        this.db
          .prepare("UPDATE archive_cleanup_files SET error=? WHERE path=? AND deleted_at IS NULL")
          .run(String(error).slice(0, 400), path);
      }
    }
    this.db
      .prepare(
        `UPDATE archive_cleanup_runs SET status='completed',finished_at=?,summary_json=? WHERE status='marked' AND id<>? AND NOT EXISTS (SELECT 1 FROM archive_cleanup_entries e WHERE e.run_id=archive_cleanup_runs.id AND e.deleted_at IS NULL AND e.cancelled_at IS NULL) AND NOT EXISTS (SELECT 1 FROM archive_cleanup_files f WHERE f.run_id=archive_cleanup_runs.id AND f.deleted_at IS NULL AND f.cancelled_at IS NULL)`,
      )
      .run(now.toISOString(), JSON.stringify({ recovered: true }), result.id);
    result.status = errors.length ? "partial" : "completed";
    this.db
      .prepare(
        "UPDATE archive_cleanup_runs SET status=?,finished_at=?,summary_json=?,error=? WHERE id=?",
      )
      .run(
        result.status,
        new Date().toISOString(),
        JSON.stringify(result),
        errors.length ? errors.join("; ") : null,
        result.id,
      );
    return result;
  }

  /** Saved reader chunks are a separate 24-hour compatibility cache; never an archive recovery source. */
  clearScrapeCache(now = new Date()): number {
    const dir = join(dirname(this.archive.directory), "scrapes");
    let removed = 0;
    if (!existsSync(dir)) return 0;
    for (const name of readdirSync(dir))
      if (/^[0-9a-f]{16}\.md$/.test(name)) {
        const file = join(dir, name);
        if (now.getTime() - statSync(file).mtimeMs > DAY) {
          unlinkSync(file);
          if (existsSync(`${file}.archive.json`)) unlinkSync(`${file}.archive.json`);
          removed++;
        }
      }
    return removed;
  }
}
