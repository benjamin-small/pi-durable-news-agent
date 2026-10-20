-- Source bodies are immutable. Freshness in source_cache is independent of archive retention.
CREATE TABLE archive_blobs (
  hash TEXT PRIMARY KEY CHECK(length(hash)=64),
  bytes INTEGER NOT NULL,
  stored_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE archive_documents (
  id INTEGER PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE archive_versions (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES archive_documents(id),
  blob_hash TEXT NOT NULL REFERENCES archive_blobs(hash),
  representation TEXT NOT NULL,
  completeness TEXT NOT NULL CHECK(completeness IN ('complete','partial','unknown')),
  first_seen_at TEXT NOT NULL,
  UNIQUE(document_id,blob_hash,representation,completeness)
);
CREATE TABLE archive_observations (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES archive_documents(id),
  version_id INTEGER REFERENCES archive_versions(id),
  track_id TEXT REFERENCES tracks(id),
  source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
  sweep_id INTEGER REFERENCES sweeps(id),
  conversation_id INTEGER,
  requested_url TEXT NOT NULL,
  final_url TEXT NOT NULL,
  status INTEGER NOT NULL,
  request_headers_json TEXT NOT NULL,
  headers_json TEXT NOT NULL,
  observed_at TEXT NOT NULL
);
CREATE INDEX archive_observations_document ON archive_observations(document_id,id);
CREATE INDEX archive_observations_track ON archive_observations(track_id,id);
CREATE TABLE archive_extractions (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL,
  blob_hash TEXT NOT NULL REFERENCES archive_blobs(hash),
  extractor TEXT NOT NULL,
  config_json TEXT NOT NULL,
  provenance TEXT NOT NULL CHECK(provenance IN ('captured','legacy-cache','unattributed')),
  created_at TEXT NOT NULL,
  UNIQUE(url,blob_hash,extractor,config_json,provenance)
);
CREATE TABLE archive_extraction_inputs (
  extraction_id INTEGER NOT NULL REFERENCES archive_extractions(id),
  observation_id INTEGER NOT NULL REFERENCES archive_observations(id),
  PRIMARY KEY(extraction_id,observation_id)
);
CREATE TABLE archive_cache_history (
  cache_id INTEGER NOT NULL REFERENCES source_cache(id),
  extraction_id INTEGER NOT NULL REFERENCES archive_extractions(id),
  PRIMARY KEY(cache_id,extraction_id)
);
ALTER TABLE source_cache ADD COLUMN archive_extraction_id INTEGER REFERENCES archive_extractions(id);
CREATE TABLE archive_policy (
  id TEXT PRIMARY KEY,
  ordinary_days INTEGER NOT NULL,
  cited_days INTEGER NOT NULL,
  pins_indefinite INTEGER NOT NULL,
  enforcement TEXT NOT NULL CHECK(enforcement='disabled')
);
INSERT INTO archive_policy VALUES ('source-bodies-v1',90,365,1,'disabled');
