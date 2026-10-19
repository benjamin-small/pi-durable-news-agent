// dna-tui: the terminal client for one device. Plain text goes to the agent; slash commands do everything else.
//   dna-tui [--device <id>] [--url <url>] [--track ai|cyber-security]      the device comes from dna-network.yaml (DNA_TARGET, default local)
import { parseArgs } from "node:util";
import { DnaClient } from "@dna/sdk";
import { loadNetwork, loadRootEnv, targetUrl } from "@dna/sdk/node";
import { App } from "./app.ts";

if (process.env.DNA_ENV_FILE !== "none") loadRootEnv(process.env.DNA_ENV_FILE || undefined);
const { values } = parseArgs({
  options: {
    device: { type: "string" },
    track: { type: "string" },
    url: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
});
if (values.help) {
  console.log(
    "usage: dna-tui [--device <id>] [--url <url>] [--track ai|cyber-security]\n\nThe client token comes from DNA_CLIENT_TOKEN in the root .env.",
  );
  process.exit(0);
}
const device = values.device ?? process.env.DNA_TARGET ?? "local";
const url = values.url ?? process.env.DNA_API_URL ?? targetUrl(device, loadNetwork());
const token = process.env.DNA_CLIENT_TOKEN?.trim();
if (!token) {
  console.error("DNA_CLIENT_TOKEN is missing. Run: just api tokens");
  process.exit(1);
}
let client: DnaClient;
try {
  client = new DnaClient(url, token, values.track ?? process.env.DNA_TRACK);
  await client.info();
} catch (error) {
  console.error(`${device} at ${url} did not answer: ${(error as Error).message}`);
  process.exit(1);
}
new App(client, device).start();
