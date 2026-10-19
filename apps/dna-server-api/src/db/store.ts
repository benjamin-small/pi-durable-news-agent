// Open dna.sqlite (WAL), migrate, seed defaults on first run, and expose one repo per table group.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lockFile } from "@dna/durable-agent";
import { type Db, openDb } from "./db.ts";
import { migrate } from "./migrate.ts";
import { NewsRepo } from "./repos/news.ts";
import { SettingsRepo } from "./repos/settings.ts";
import { SourcesRepo, type SourceSeed } from "./repos/sources.ts";
import { SweepsRepo } from "./repos/sweeps.ts";
import { TasteRepo, type KeywordKind } from "./repos/taste.ts";
import { TelemetryRepo } from "./repos/telemetry.ts";
import { TracksRepo } from "./repos/tracks.ts";
import { DEFAULT_TRACK_ID } from "@dna/sdk";

export interface Store {
  db: Db;
  readonly trackId: string;
  tracks: TracksRepo;
  settings: SettingsRepo;
  sources: SourcesRepo;
  news: NewsRepo;
  taste: TasteRepo;
  sweeps: SweepsRepo;
  telemetry: TelemetryRepo;
  globalTelemetry: TelemetryRepo;
  close(): void;
}

export function openStore(dataDir: string, configDir: string): Store {
  const path = join(dataDir, "dna.sqlite");
  const unlock = lockFile(`${path}.lock`);
  const db = openDb(path);
  migrate(db);
  const store: Store = {
    db,
    trackId: DEFAULT_TRACK_ID,
    tracks: new TracksRepo(db),
    settings: new SettingsRepo(db, DEFAULT_TRACK_ID),
    sources: new SourcesRepo(db, DEFAULT_TRACK_ID),
    news: new NewsRepo(db, DEFAULT_TRACK_ID),
    taste: new TasteRepo(db, DEFAULT_TRACK_ID),
    sweeps: new SweepsRepo(db, DEFAULT_TRACK_ID),
    telemetry: new TelemetryRepo(db, undefined, DEFAULT_TRACK_ID),
    globalTelemetry: new TelemetryRepo(db),
    close() {
      try {
        db.close();
      } finally {
        unlock();
      }
    },
  };
  seedStore(store, configDir);
  return store;
}

export function scopeStore(owner: Store, trackId: string, configDir: string): Store {
  if (!owner.tracks.get(trackId)) throw new Error(`Unknown track ${trackId}`);
  const db = owner.db;
  const store: Store = {
    ...owner,
    trackId,
    settings: new SettingsRepo(db, trackId),
    sources: new SourcesRepo(db, trackId),
    news: new NewsRepo(db, trackId),
    taste: new TasteRepo(db, trackId),
    sweeps: new SweepsRepo(db, trackId),
    telemetry: new TelemetryRepo(db, undefined, trackId),
    close() {
      throw new Error("Only the owning store may close the shared database");
    },
  };
  seedStore(store, configDir);
  return store;
}

function seedStore(store: Store, configDir: string): void {
  store.news.refreshReleases(true);
  const sources = (
    JSON.parse(readFileSync(join(configDir, "sources.json"), "utf8")) as { sources: SourceSeed[] }
  ).sources;
  const key = (s: { kind: string; url?: string; query?: string }) =>
    `${s.kind}|${s.url ?? ""}|${s.query ?? ""}`;
  if (!store.settings.get("seeded", false)) {
    const keywords = JSON.parse(readFileSync(join(configDir, "keywords.json"), "utf8")) as Record<
      KeywordKind,
      string[]
    >;
    store.sources.seed(sources);
    store.taste.seed(keywords);
    store.settings.set("seeded", true);
    store.settings.set("seededSources", sources.map(key));
  } else {
    // A source added to config/sources.json later reaches existing devices once; one the reader removed stays removed.
    const seeded = new Set(
      store.settings.get<string[]>("seededSources", store.sources.list().map(key)),
    );
    const added = sources.filter((s) => !seeded.has(key(s)));
    if (added.length) store.sources.seed(added);
    store.settings.set("seededSources", [...seeded, ...added.map(key)]);
  }
}
