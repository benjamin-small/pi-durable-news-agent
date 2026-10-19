INSERT INTO tracks (id, name, description, profile, created_at)
VALUES ('cyber-security', 'Cyber Security', 'Broad industry security news, defensive research and significant developments.', 'cyber-security', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

ALTER TABLE agent_conversations ADD COLUMN track_id TEXT NOT NULL DEFAULT 'ai' REFERENCES tracks (id);
CREATE INDEX agent_conversations_track ON agent_conversations (track_id);
ALTER TABLE agent_runs ADD COLUMN track_id TEXT NOT NULL DEFAULT 'ai' REFERENCES tracks (id);
CREATE INDEX agent_runs_track ON agent_runs (track_id);
ALTER TABLE generations ADD COLUMN track_id TEXT NOT NULL DEFAULT 'ai' REFERENCES tracks (id);
CREATE INDEX generations_track ON generations (track_id);
ALTER TABLE tool_calls ADD COLUMN track_id TEXT NOT NULL DEFAULT 'ai' REFERENCES tracks (id);
CREATE INDEX tool_calls_track ON tool_calls (track_id);
ALTER TABLE tasks ADD COLUMN track_id TEXT NOT NULL DEFAULT 'ai' REFERENCES tracks (id);
CREATE INDEX tasks_track ON tasks (track_id);
ALTER TABLE jev_calls ADD COLUMN track_id TEXT NOT NULL DEFAULT 'ai' REFERENCES tracks (id);
CREATE INDEX jev_calls_track ON jev_calls (track_id);
ALTER TABLE firecrawl_calls ADD COLUMN track_id TEXT NOT NULL DEFAULT 'ai' REFERENCES tracks (id);
CREATE INDEX firecrawl_calls_track ON firecrawl_calls (track_id);
ALTER TABLE events ADD COLUMN track_id TEXT NOT NULL DEFAULT 'ai' REFERENCES tracks (id);
CREATE INDEX events_track ON events (track_id);
