-- Keep existing records and IDs; the shared source_cache remains keyed by canonical URL.
CREATE TABLE tracks (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64 AND substr(id, 1, 1) GLOB '[a-z0-9]' AND id NOT GLOB '*[^a-z0-9-]*'),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  profile TEXT NOT NULL,
  conversation_id INTEGER UNIQUE,
  created_at TEXT NOT NULL
);
INSERT INTO tracks (id, name, description, profile, created_at)
VALUES ('ai', 'AI', 'AI news, research and tools for agentic engineers.', 'ai', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE sources_tracks (
  track_id TEXT NOT NULL DEFAULT 'ai' REFERENCES tracks (id),
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('rss', 'atom', 'hn_front', 'hn_search', 'github_releases', 'web_page')),
  name TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  query TEXT NOT NULL DEFAULT '',
  weight REAL NOT NULL DEFAULT 1.0,
  interval_min INTEGER NOT NULL DEFAULT 15,
  enabled INTEGER NOT NULL DEFAULT 1,
  fail_count INTEGER NOT NULL DEFAULT 0,
  last_status TEXT,
  last_error TEXT,
  last_fetched_at TEXT,
  etag TEXT,
  last_modified TEXT,
  origin TEXT NOT NULL DEFAULT 'config' CHECK (origin IN ('config', 'user', 'agent', 'upvote')),
  reason TEXT,
  content_hash TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (track_id, kind, url, query)
);
INSERT INTO sources_tracks (id, kind, name, url, query, weight, interval_min, enabled, fail_count, last_status, last_error, last_fetched_at, etag, last_modified, origin, reason, content_hash, created_at) SELECT id, kind, name, url, query, weight, interval_min, enabled, fail_count, last_status, last_error, last_fetched_at, etag, last_modified, origin, reason, content_hash, created_at FROM sources;
DROP TABLE sources;
ALTER TABLE sources_tracks RENAME TO sources;


CREATE TABLE sweeps_tracks (
  track_id TEXT NOT NULL DEFAULT 'ai' REFERENCES tracks (id),
  id INTEGER PRIMARY KEY,
  request_id TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('cron', 'manual', 'test')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'no_news', 'skipped', 'failed', 'stalled')),
  reason TEXT,
  submission_id INTEGER,
  run_entry_id INTEGER,
  task_id INTEGER,
  search_mode TEXT,
  gathered INTEGER NOT NULL DEFAULT 0,
  kept INTEGER NOT NULL DEFAULT 0,
  duplicates INTEGER NOT NULL DEFAULT 0,
  candidates INTEGER NOT NULL DEFAULT 0,
  presented INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  firecrawl_credits_used REAL NOT NULL DEFAULT 0,
  firecrawl_credits_left INTEGER,
  phases_json TEXT,
  audit_json TEXT,
  error TEXT,
  max_cards INTEGER,
  started_at TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (track_id, request_id)
);
INSERT INTO sweeps_tracks (id, request_id, trigger, status, reason, submission_id, run_entry_id, task_id, search_mode, gathered, kept, duplicates, candidates, presented, summary, firecrawl_credits_used, firecrawl_credits_left, phases_json, audit_json, error, max_cards, started_at, ended_at, created_at) SELECT id, request_id, trigger, status, reason, submission_id, run_entry_id, task_id, search_mode, gathered, kept, duplicates, candidates, presented, summary, firecrawl_credits_used, firecrawl_credits_left, phases_json, audit_json, error, max_cards, started_at, ended_at, created_at FROM sweeps;
DROP TABLE sweeps;
ALTER TABLE sweeps_tracks RENAME TO sweeps;


CREATE TABLE items_tracks (
  track_id TEXT NOT NULL DEFAULT 'ai' REFERENCES tracks (id),
  id INTEGER PRIMARY KEY,
  sweep_id INTEGER REFERENCES sweeps (id),
  cache_id INTEGER REFERENCES source_cache (id),
  source_id INTEGER REFERENCES sources (id) ON DELETE SET NULL,
  url TEXT NOT NULL,
  url_hash TEXT NOT NULL,
  title TEXT NOT NULL,
  source_name TEXT,
  published_at TEXT,
  excerpt TEXT,
  image_url TEXT,
  discussion_url TEXT,
  status TEXT NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate', 'rejected', 'duplicate', 'researching', 'classified', 'presented', 'failed')),
  relevance REAL,
  matched_topic TEXT,
  worth REAL,
  novelty REAL,
  attention INTEGER,
  duplicate_of INTEGER REFERENCES items (id),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  date_source TEXT, -- feed, meta, jsonld, time, url, model or unknown; NULL means never asked
  importance REAL,
  release_key TEXT,
  release_version TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (track_id, url_hash)
);
INSERT INTO items_tracks (id, sweep_id, cache_id, source_id, url, url_hash, title, source_name, published_at, excerpt, image_url, discussion_url, status, relevance, matched_topic, worth, novelty, attention, duplicate_of, attempts, last_error, date_source, importance, release_key, release_version, created_at, updated_at) SELECT id, sweep_id, cache_id, source_id, url, url_hash, title, source_name, published_at, excerpt, image_url, discussion_url, status, relevance, matched_topic, worth, novelty, attention, duplicate_of, attempts, last_error, date_source, importance, release_key, release_version, created_at, updated_at FROM items;
DROP TABLE items;
ALTER TABLE items_tracks RENAME TO items;

CREATE INDEX items_sweep_status ON items (sweep_id, status);
CREATE INDEX items_release_key ON items (release_key);

CREATE TABLE keywords_tracks (
  track_id TEXT NOT NULL DEFAULT 'ai' REFERENCES tracks (id),
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('topic', 'hype', 'facts', 'signal')),
  term TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  source TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('seed', 'user')),
  enabled INTEGER NOT NULL DEFAULT 1,
  last_searched_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (track_id, kind, term)
);
INSERT INTO keywords_tracks (id, kind, term, weight, source, enabled, last_searched_at, created_at, updated_at) SELECT id, kind, term, weight, source, enabled, last_searched_at, created_at, updated_at FROM keywords;
DROP TABLE keywords;
ALTER TABLE keywords_tracks RENAME TO keywords;


CREATE TABLE source_leads_tracks (
  track_id TEXT NOT NULL DEFAULT 'ai' REFERENCES tracks (id),
  id INTEGER PRIMARY KEY,
  site TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  card_id INTEGER REFERENCES cards (id) ON DELETE SET NULL,
  item_id INTEGER REFERENCES items (id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'saved', 'skipped')),
  note TEXT,
  source_id INTEGER REFERENCES sources (id) ON DELETE SET NULL,
  offered_sweep_id INTEGER REFERENCES sweeps (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE (track_id, site)
);
INSERT INTO source_leads_tracks (id, site, url, title, card_id, item_id, status, note, source_id, offered_sweep_id, created_at, resolved_at) SELECT id, site, url, title, card_id, item_id, status, note, source_id, offered_sweep_id, created_at, resolved_at FROM source_leads;
DROP TABLE source_leads;
ALTER TABLE source_leads_tracks RENAME TO source_leads;

CREATE INDEX source_leads_status ON source_leads (status, created_at);

CREATE TABLE release_heads_tracks (
  track_id TEXT NOT NULL DEFAULT 'ai' REFERENCES tracks (id),
  release_key TEXT NOT NULL,
  latest_item_id INTEGER NOT NULL REFERENCES items (id),
  visible_card_id INTEGER REFERENCES cards (id),
  PRIMARY KEY (track_id, release_key)
);
INSERT INTO release_heads_tracks (release_key, latest_item_id, visible_card_id) SELECT release_key, latest_item_id, visible_card_id FROM release_heads;
DROP TABLE release_heads;
ALTER TABLE release_heads_tracks RENAME TO release_heads;


ALTER TABLE stories ADD COLUMN track_id TEXT NOT NULL DEFAULT 'ai' REFERENCES tracks (id);
ALTER TABLE cards ADD COLUMN track_id TEXT NOT NULL DEFAULT 'ai' REFERENCES tracks (id);
ALTER TABLE taste_questions ADD COLUMN track_id TEXT NOT NULL DEFAULT 'ai' REFERENCES tracks (id);
ALTER TABLE images ADD COLUMN track_id TEXT NOT NULL DEFAULT 'ai' REFERENCES tracks (id);
ALTER TABLE classifications ADD COLUMN track_id TEXT NOT NULL DEFAULT 'ai' REFERENCES tracks (id);

CREATE TABLE track_settings (
  track_id TEXT NOT NULL REFERENCES tracks (id),
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (track_id, key)
);
INSERT INTO track_settings (track_id, key, value, updated_at)
SELECT 'ai', key, value, updated_at FROM settings;
CREATE INDEX sources_track ON sources (track_id);
CREATE INDEX items_track ON items (track_id);
CREATE INDEX sweeps_track ON sweeps (track_id);
CREATE INDEX stories_track ON stories (track_id);
CREATE INDEX cards_track ON cards (track_id);
CREATE INDEX keywords_track ON keywords (track_id);
CREATE INDEX source_leads_track ON source_leads (track_id);
CREATE INDEX taste_questions_track ON taste_questions (track_id);
CREATE INDEX images_track ON images (track_id);
CREATE INDEX classifications_track ON classifications (track_id);

-- Scope response replay by route and track without dropping outstanding AI retry keys.
CREATE TABLE requests_tracks (
  key TEXT NOT NULL,
  route TEXT NOT NULL,
  status INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (key, route)
);
INSERT INTO requests_tracks SELECT key, route || '?track=ai', status, body, created_at FROM requests;
DROP TABLE requests;
ALTER TABLE requests_tracks RENAME TO requests;
