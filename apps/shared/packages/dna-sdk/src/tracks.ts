/** Stable desk identity, independent of source format or topic keywords. */
export const DEFAULT_TRACK_ID = "ai";

export interface Track {
  id: string;
  name: string;
  description: string;
  /** Built-in editorial profile: ai or cyber-security. */
  profile: string;
  conversationId?: number;
}
