ALTER TABLE archive_blobs ADD COLUMN purged_at TEXT;
ALTER TABLE archive_blobs ADD COLUMN purge_attempted_at TEXT;
ALTER TABLE archive_policy RENAME TO archive_policy_foundation;
CREATE TABLE archive_policy (
  id TEXT PRIMARY KEY,
  ordinary_days INTEGER NOT NULL CHECK(ordinary_days BETWEEN 1 AND 3650),
  cited_days INTEGER NOT NULL CHECK(cited_days BETWEEN ordinary_days AND 3650),
  pins_indefinite INTEGER NOT NULL CHECK(pins_indefinite=1),
  enforcement TEXT NOT NULL CHECK(enforcement IN ('disabled','enabled')),
  storage_budget_bytes INTEGER NOT NULL CHECK(storage_budget_bytes>0),
  revision INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO archive_policy SELECT id,ordinary_days,cited_days,pins_indefinite,'disabled',1073741824,1,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM archive_policy_foundation;
DROP TABLE archive_policy_foundation;
CREATE TABLE archive_cleanup_runs (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  summary_json TEXT,
  error TEXT
);
CREATE TABLE archive_cleanup_entries (
  run_id INTEGER NOT NULL REFERENCES archive_cleanup_runs(id),
  blob_hash TEXT NOT NULL REFERENCES archive_blobs(hash),
  bytes INTEGER NOT NULL,
  reason TEXT NOT NULL,
  deleted_at TEXT,
  cancelled_at TEXT,
  error TEXT,
  PRIMARY KEY(run_id,blob_hash)
);
CREATE INDEX archive_observations_version ON archive_observations(version_id);
CREATE INDEX archive_citations_evidence ON archive_citations(evidence_id,published_at);
CREATE TABLE archive_cleanup_files (
  run_id INTEGER NOT NULL REFERENCES archive_cleanup_runs(id),
  path TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  deleted_at TEXT,
  cancelled_at TEXT,
  error TEXT,
  PRIMARY KEY(run_id,path)
);
