/** Stable desk identity, independent of source format or topic keywords. */
export const DEFAULT_TRACK_ID = "ai";

export interface Track {
  id: string;
  name: string;
  description: string;
  /** Editorial profile; only the existing AI profile is runnable in this release. */
  profile: string;
  conversationId?: number;
}
