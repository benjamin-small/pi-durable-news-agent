import { DEFAULT_TRACK_ID } from "@dna/sdk";

/** Only AI is enabled in the foundation release; a second desk adds track selection. */
export const ACTIVE_TRACK_ID = DEFAULT_TRACK_ID;

export const trackStorageKey = (name: string, trackId = ACTIVE_TRACK_ID) =>
  `dna.track.${trackId}.${name}`;

/** Move existing AI browser state once, without overwriting an already scoped value. */
export function migrateTrackStorage(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  legacyKey: string,
  name: string,
  trackId = ACTIVE_TRACK_ID,
): void {
  if (trackId !== DEFAULT_TRACK_ID) return;
  try {
    const value = storage.getItem(legacyKey);
    if (value === null) return;
    if (storage.getItem(trackStorageKey(name, trackId)) === null)
      storage.setItem(trackStorageKey(name, trackId), value);
    storage.removeItem(legacyKey);
  } catch {
    // Storage can be unavailable; the desk still works with in-memory defaults.
  }
}
