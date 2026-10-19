import { DEFAULT_TRACK_ID } from "@dna/sdk";

/** A page has one immutable desk context. Switching reloads it, disposing old streams, dialogs and requests. */
const requested = new URL(location.href).searchParams.get("track");
export const ACTIVE_TRACK_ID =
  requested === null
    ? DEFAULT_TRACK_ID
    : /^[a-z0-9][a-z0-9-]{0,63}$/.test(requested)
      ? requested
      : "invalid-track";

export function selectTrack(id: string) {
  if (id === ACTIVE_TRACK_ID) return;
  const url = new URL(location.href);
  url.searchParams.set("track", id);
  url.hash = "/";
  location.assign(url.href);
}

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
