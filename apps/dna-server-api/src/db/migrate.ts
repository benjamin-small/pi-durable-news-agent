// Applies migrations/NNN_name.sql in order, one transaction each, recorded in schema_migrations.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Db, nowIso, tx } from "./db.ts";

export const MIGRATIONS_DIR = join(import.meta.dirname, "migrations");

export function migrate(db: Db, dir = MIGRATIONS_DIR): string[] {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const applied = new Set(
    (db.prepare("SELECT name FROM schema_migrations").all() as { name: string }[]).map(
      (r) => r.name,
    ),
  );
  const pending = readdirSync(dir)
    .filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f) && !applied.has(f))
    .sort();
  for (const name of pending) {
    const sql = readFileSync(join(dir, name), "utf8");
    // SQLite table rebuilds require foreign keys off before BEGIN; validate before committing.
    db.exec("PRAGMA foreign_keys=OFF");
    try {
      tx(db, () => {
        db.exec(sql);
        const violations = db.prepare("PRAGMA foreign_key_check").all();
        if (violations.length)
          throw new Error(`Migration ${name} violates foreign keys: ${JSON.stringify(violations)}`);
        db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(
          name,
          nowIso(),
        );
      });
    } finally {
      db.exec("PRAGMA foreign_keys=ON");
    }
  }
  return pending;
}
