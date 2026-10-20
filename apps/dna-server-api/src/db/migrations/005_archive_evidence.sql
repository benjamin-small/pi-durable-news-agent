ALTER TABLE archive_blobs ADD COLUMN expired_at TEXT;
CREATE TABLE archive_evidence (
  id INTEGER PRIMARY KEY,
  track_id TEXT NOT NULL REFERENCES tracks(id),
  item_id INTEGER REFERENCES items(id),
  conversation_id INTEGER,
  kind TEXT NOT NULL,
  url TEXT,
  blob_hash TEXT NOT NULL REFERENCES archive_blobs(hash),
  created_at TEXT NOT NULL
);
CREATE INDEX archive_evidence_item ON archive_evidence(track_id,item_id,id);
CREATE TABLE archive_evidence_sources (
  evidence_id INTEGER NOT NULL REFERENCES archive_evidence(id),
  extraction_id INTEGER NOT NULL REFERENCES archive_extractions(id),
  PRIMARY KEY(evidence_id,extraction_id)
);
CREATE TABLE archive_citations (
  card_id INTEGER NOT NULL REFERENCES cards(id),
  evidence_id INTEGER NOT NULL REFERENCES archive_evidence(id),
  published_at TEXT NOT NULL,
  PRIMARY KEY(card_id,evidence_id)
);
CREATE TABLE archive_pins (
  track_id TEXT NOT NULL REFERENCES tracks(id),
  kind TEXT NOT NULL CHECK(kind IN ('version','extraction','evidence')),
  target_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(track_id,kind,target_id)
);

ALTER TABLE jev_calls ADD COLUMN archive_evidence_id INTEGER REFERENCES archive_evidence(id);
ALTER TABLE classifications ADD COLUMN archive_evidence_id INTEGER REFERENCES archive_evidence(id);
ALTER TABLE findings ADD COLUMN archive_evidence_id INTEGER REFERENCES archive_evidence(id);
