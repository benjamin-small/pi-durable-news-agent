import { nowIso, parse } from "../db.ts";
import { TrackRepo } from "../track-repo.ts";

export class SettingsRepo extends TrackRepo {
  get<T>(key: string, fallback: T): T {
    const row = this.prepare(
      "SELECT value FROM track_settings WHERE key = ? AND track_id = :track",
    ).get(key) as { value: string } | undefined;
    return row ? parse<T>(row.value, fallback) : fallback;
  }

  set(key: string, value: unknown): void {
    this.prepare(
      "INSERT INTO track_settings (track_id, key, value, updated_at) VALUES (:track, ?, ?, ?) ON CONFLICT (track_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    ).run(key, JSON.stringify(value), nowIso());
  }
}
