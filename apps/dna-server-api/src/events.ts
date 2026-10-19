// In-process bus: tools and the sweep publish frames; the SSE route forwards them to every client.
import { EventEmitter } from "node:events";
import { DEFAULT_TRACK_ID, type Frame } from "@dna/sdk";

export class Bus {
  private readonly emitter = new EventEmitter();
  constructor(readonly trackId = DEFAULT_TRACK_ID) {
    this.emitter.setMaxListeners(200);
  }
  publish(frame: Frame): void {
    this.emitter.emit("frame", { ...frame, trackId: this.trackId });
  }
  subscribe(listener: (frame: Frame) => void): () => void {
    this.emitter.on("frame", listener);
    return () => this.emitter.off("frame", listener);
  }
}
