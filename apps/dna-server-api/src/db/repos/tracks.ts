import { DEFAULT_TRACK_ID, type Track } from "@dna/sdk";
import { type Db, num } from "../db.ts";

const toTrack = (r: any): Track => ({
  id: r.id,
  name: r.name,
  description: r.description,
  profile: r.profile,
  conversationId: num(r.conversation_id),
});

export class TracksRepo {
  constructor(private readonly db: Db) {}

  get(id = DEFAULT_TRACK_ID): Track | undefined {
    const row = this.db.prepare("SELECT * FROM tracks WHERE id = ?").get(id);
    return row ? toTrack(row) : undefined;
  }

  list(): Track[] {
    return this.db.prepare("SELECT * FROM tracks ORDER BY id").all().map(toTrack);
  }

  /** Attach the existing durable root, never replace its transcript or configuration. */
  bindConversation(id: string, conversationId: number): Track {
    const track = this.get(id);
    if (!track) throw new Error(`Unknown track ${id}`);
    if (track.conversationId !== undefined && track.conversationId !== conversationId)
      throw new Error(`Track ${id} is already bound to conversation ${track.conversationId}`);
    this.db.prepare("UPDATE tracks SET conversation_id = ? WHERE id = ?").run(conversationId, id);
    return this.get(id)!;
  }
}
