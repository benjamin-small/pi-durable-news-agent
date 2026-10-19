import { DEFAULT_TRACK_ID } from "@dna/sdk";
import type { SQLInputValue } from "node:sqlite";
import type { Db } from "./db.ts";

export type OwnedTable =
  | "sources"
  | "items"
  | "sweeps"
  | "stories"
  | "cards"
  | "keywords"
  | "source_leads"
  | "taste_questions"
  | "images"
  | "classifications";

/** Bind a trusted track parameter; each query states its ownership predicate explicitly. */
export class TrackRepo {
  constructor(
    protected readonly db: Db,
    readonly trackId = DEFAULT_TRACK_ID,
  ) {}

  protected prepare(sql: string) {
    const statement = this.db.prepare(sql);
    const params = (args: any[]): [Record<string, SQLInputValue>, ...SQLInputValue[]] => {
      const named = args[0] && typeof args[0] === "object" && !(args[0] instanceof Uint8Array);
      return [
        { ...(named ? args[0] : {}), track: this.trackId },
        ...(named ? args.slice(1) : args),
      ];
    };
    return {
      all: (...args: any[]) => statement.all(...params(args)),
      get: (...args: any[]) => statement.get(...params(args)),
      run: (...args: any[]) => statement.run(...params(args)),
    };
  }

  protected requireOwned(table: OwnedTable, id: number | undefined): void {
    if (id === undefined) return;
    if (!this.prepare(`SELECT id FROM ${table} WHERE id = ? AND track_id = :track`).get(id))
      throw new Error(`No ${table} record ${id} in track ${this.trackId}`);
  }
}
