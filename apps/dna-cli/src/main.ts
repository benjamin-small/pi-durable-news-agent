// dna: every capability of the Durable News Agent from a terminal or a script, plus device operations.
//   dna [--device <id>] [--json] <command> [args]
// Run `dna help` for the command list.
import { parseArgs } from "node:util";
import { join } from "node:path";
import {
  AgentModel,
  DnaClient,
  DnaError,
  follow,
  HFS_CATEGORIES,
  searchQuery,
  type Frame,
  type HfsCategory,
} from "@dna/sdk";
import {
  createLogger,
  ensureTokens,
  loadNetwork,
  loadRootEnv,
  repoRoot,
  targetUrl,
} from "@dna/sdk/node";
import { doctor } from "./doctor.ts";
import { net } from "./net/index.ts";
import * as print from "./print.ts";

if (process.env.DNA_ENV_FILE !== "none") loadRootEnv(process.env.DNA_ENV_FILE || undefined);

const { values: flags, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    device: { type: "string" },
    track: { type: "string" },
    url: { type: "string" },
    json: { type: "boolean", default: false },
    kind: { type: "string" },
    limit: { type: "string" },
    days: { type: "string" },
    level: { type: "string" },
    sweep: { type: "string" },
    conversation: { type: "string" },
    steer: { type: "boolean", default: false },
    wait: { type: "string" },
    seconds: { type: "string" },
    on: { type: "boolean", default: false },
    off: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: true,
  strict: true,
});

const log = createLogger("cli");
const [command = "help", ...args] = flags.help ? ["help"] : positionals;
const tokens = {
  client: process.env.DNA_CLIENT_TOKEN?.trim(),
  cron: process.env.DNA_CRON_TOKEN?.trim(),
};
const deviceId = flags.device ?? process.env.DNA_TARGET ?? "local";
const baseUrl = () => flags.url ?? process.env.DNA_API_URL ?? targetUrl(deviceId, loadNetwork());
let clientCache: DnaClient | undefined;
const client = () =>
  (clientCache ??= new DnaClient(baseUrl(), tokens.client, flags.track ?? process.env.DNA_TRACK));
const num = (value: string | undefined, name: string): number => {
  const n = Number(value);
  if (value === undefined || !Number.isInteger(n) || n < 0)
    throw new Usage(`${name} must be a whole number`);
  return n;
};
const optNum = (value: string | undefined, name: string) =>
  value === undefined ? undefined : num(value, name);
const labels = (list: string[]): HfsCategory[] => {
  for (const l of list)
    if (!HFS_CATEGORIES.includes(l as HfsCategory))
      throw new Usage(`Labels are: ${HFS_CATEGORIES.join(", ")}`);
  return list as HfsCategory[];
};

class Usage extends Error {}

interface Command {
  usage: string;
  summary: string;
  run(): Promise<{ data: unknown; text?: string }>;
}

const COMMANDS: Record<string, Command> = {
  tracks: {
    usage: "tracks",
    summary: "Available news desks",
    async run() {
      const tracks = await client().tracks();
      return { data: tracks, text: tracks.map((t) => `${t.id}  ${t.name}`).join("\n") };
    },
  },
  status: {
    usage: "status",
    summary: "Device, model, agent state, last and next sweep",
    async run() {
      const [info, agent, sweeps] = await Promise.all([
        client().info(),
        client().agent(),
        client().sweeps({ limit: 1 }),
      ]);
      return {
        data: { info, agent, lastSweep: sweeps[0] },
        text: print.status(info, agent, sweeps[0]),
      };
    },
  },
  feed: {
    usage: "feed [--limit N]",
    summary: "News cards, oldest first",
    async run() {
      const page = await client().feed({ limit: optNum(flags.limit, "limit") });
      return {
        data: page,
        text: page.items.length
          ? page.items.map(print.cardLine).join("\n")
          : "No cards yet. The next sweep fills the feed.",
      };
    },
  },
  search: {
    usage: "search [keyword|url] <words> [--limit N]",
    summary: "News cards matching words, a keyword or a url, newest published first",
    async run() {
      const query = searchQuery(args);
      if (!query.q) throw new Error("search needs words, keyword <term> or url <link>");
      const cards = await client().search({ ...query, limit: optNum(flags.limit, "limit") });
      return {
        data: cards,
        text: cards.length ? cards.map(print.cardLine).join("\n") : `No news matches ${query.q}.`,
      };
    },
  },
  schedule: {
    usage: "schedule [1|5|10|15|30|60|off] | schedule cards <1-30>",
    summary: "How often scheduled sweeps run, or change it",
    async run() {
      const s =
        args[0] === "cards"
          ? await client().setCardsPerSweep(num(args[1], "cards"))
          : args[0]
            ? await client().setSchedule(args[0] === "off" ? null : num(args[0], "minutes"))
            : await client().schedule();
      return {
        data: s,
        text: `${s.everyMinutes === null ? "Scheduled sweeps are off" : `Every ${s.everyMinutes} minutes, next ${s.nextSweepAt}`}, up to ${s.cardsPerSweep} cards a sweep. Presets: ${s.presets.join(", ")}, off.`,
      };
    },
  },
  tools: {
    usage: "tools",
    summary: "Every tool the agents have: params (* required) and what each returns",
    async run() {
      const tools = await client().tools();
      return { data: tools, text: tools.map(print.toolLines).join("\n\n") };
    },
  },
  timelines: {
    usage: "timelines [--limit N]",
    summary: "Timelines: related news, most recently grown first",
    async run() {
      const list = await client().timelines({ limit: optNum(flags.limit, "limit") });
      return {
        data: list,
        text: list.length
          ? list.map(print.timelineLine).join("\n")
          : "No timelines yet. The agent links related news into one.",
      };
    },
  },
  timeline: {
    usage: "timeline <id>",
    summary: "One timeline's news cards, oldest published first",
    async run() {
      const t = await client().timeline(num(args[0], "timeline id"));
      return { data: t, text: [print.timelineLine(t), ...t.cards.map(print.cardLine)].join("\n") };
    },
  },
  card: {
    usage: "card <id>",
    summary: "One card with its item, findings and tool call",
    async run() {
      const d = await client().card(num(args[0], "card id"));
      return { data: d, text: print.cardDetail(d) };
    },
  },
  more: {
    usage: "more <card id>",
    summary: "Show me more like this",
    async run() {
      const r = await client().feedback(num(args[0], "card id"), { signal: "more" });
      return {
        data: r,
        text: [
          r.changed.length
            ? r.changed
                .map((c) => `${c.kind} ${c.term} ${c.from.toFixed(2)} to ${c.to.toFixed(2)}`)
                .join("\n")
            : "Noted. No keyword matched this card.",
          print.leadsLine(r.leads),
        ]
          .filter(Boolean)
          .join("\n"),
      };
    },
  },
  less: {
    usage: "less <card id>",
    summary: "Show me less like this",
    async run() {
      const r = await client().feedback(num(args[0], "card id"), { signal: "less" });
      return {
        data: r,
        text: r.changed.length
          ? r.changed
              .map((c) => `${c.kind} ${c.term} ${c.from.toFixed(2)} to ${c.to.toFixed(2)}`)
              .join("\n")
          : "Noted. No keyword matched this card.",
      };
    },
  },
  label: {
    usage: "label <card id> <hype|facts|signal>...",
    summary: "Label a card hype, facts or signal",
    async run() {
      const r = await client().feedback(num(args[0], "card id"), { labels: labels(args.slice(1)) });
      return {
        data: r,
        text: `Labeled. ${r.changed.length} keyword weight${r.changed.length === 1 ? "" : "s"} moved.`,
      };
    },
  },
  taste: {
    usage: "taste",
    summary: "Keywords, recent feedback and open questions",
    async run() {
      const [taste, questions] = await Promise.all([client().taste(), client().questions("open")]);
      const text = [
        ...taste.keywords.map(print.keywordLine),
        "",
        ...taste.recent.map(
          (r) => `card ${r.cardId} ${r.signal ?? ""} ${r.labels.join(" ")}  ${r.title}`,
        ),
        ...(questions.length ? ["", ...questions.map(print.questionLine)] : []),
      ].join("\n");
      return { data: { ...taste, questions }, text };
    },
  },
  answer: {
    usage: "answer [<question id> <hype|facts|signal>...]",
    summary: "List open taste questions, or answer one (no labels means none)",
    async run() {
      if (!args[0]) {
        const qs = await client().questions("open");
        return {
          data: qs,
          text: qs.length ? qs.map(print.questionLine).join("\n") : "No open questions.",
        };
      }
      const q = await client().answer(num(args[0], "question id"), labels(args.slice(1)));
      return { data: q, text: `Answered #${q.id}: ${q.answerLabels.join(", ") || "none"}` };
    },
  },
  send: {
    usage: "send <text> [--steer] [--wait seconds]",
    summary: "Send the agent a message (followUp), or steer the current run",
    async run() {
      const content = args.join(" ").trim();
      if (!content) throw new Usage("send needs a message");
      const r = await client().send({
        content,
        mode: flags.steer ? "steer" : "followUp",
        waitMs: (optNum(flags.wait, "wait") ?? 120) * 1000,
      });
      return {
        data: r,
        text:
          r.status === "done"
            ? r.answer.text
            : r.status === "unanswered"
              ? `No answer: ${r.reason ?? "unanswered"}`
              : `Queued as submission ${r.submissionId}`,
      };
    },
  },
  watch: {
    usage: "watch [--seconds N] [--conversation id]",
    summary: "Stream the agent, its tool calls, cards and sweeps",
    async run() {
      const stop = new AbortController();
      const seconds = optNum(flags.seconds, "seconds");
      if (seconds) setTimeout(() => stop.abort(), seconds * 1000);
      process.once("SIGINT", () => stop.abort());
      const conversation = optNum(flags.conversation, "conversation");
      const model = new AgentModel(conversation);
      const seen = new Set<string>();
      const frames: Frame[] = [];
      const emit = (key: string, line: string) => {
        if (seen.has(key)) return;
        seen.add(key);
        if (flags.json) return;
        console.log(line);
      };
      await follow(
        (signal) =>
          client().stream(signal, { conversations: conversation ? [conversation] : undefined }),
        (frame) => {
          if (flags.json) frames.push(frame);
          model.apply(frame);
          if (frame.type === "feed.card")
            emit(`card:${frame.card.id}`, `card  ${print.cardLine(frame.card)}`);
          if (frame.type === "sweep")
            emit(
              `sweep:${frame.sweep.id}:${frame.sweep.status}`,
              `sweep ${print.sweepLine(frame.sweep)}`,
            );
          if (frame.type === "taste.question")
            emit(
              `q:${frame.question.id}:${frame.question.status}`,
              `taste ${print.questionLine(frame.question)}`,
            );
          for (const item of model.state.items) {
            if (item.kind === "user")
              emit(
                `u:${item.id}`,
                `you   ${
                  item.text
                    .split("\n")
                    .find((l) => l.trim() && !l.startsWith("#"))
                    ?.slice(0, 160) ?? ""
                }`,
              );
            if (item.kind !== "assistant" || item.streaming) continue;
            for (const block of item.blocks) {
              if (
                block.type === "tool" &&
                block.call.status !== "pending" &&
                block.call.status !== "running"
              )
                emit(
                  `t:${block.call.callId}`,
                  `tool  ${block.call.name} ${block.call.status}  ${(block.call.result ?? "")
                    .replace(/<\/?harness>/g, "")
                    .trim()
                    .split("\n")[0]
                    .slice(0, 120)}`,
                );
              if (block.type === "text")
                emit(`a:${item.id}`, `agent ${block.text.replace(/\s+/g, " ").slice(0, 400)}`);
            }
          }
        },
        (state, error) => {
          if (!flags.json) console.error(`[${state}]${error ? ` ${error.message}` : ""}`);
        },
        stop.signal,
      );
      return { data: frames, text: "" };
    },
  },
  abort: {
    usage: "abort",
    summary: "Stop the current run",
    async run() {
      return { data: await client().abort(), text: "Stopped." };
    },
  },
  model: {
    usage: "model [id] | model quick [id]",
    summary: "List models, or pick one; quick is the model for one-shot jobs such as publish dates",
    async run() {
      if (args[0] === "quick") {
        const state = args[1]
          ? await client().configure({ quickModel: args[1] })
          : await client().agent();
        return {
          data: state.quick,
          text: `Quick tasks: ${state.quick.model}, thinking ${state.quick.thinkingLevel}`,
        };
      }
      if (!args[0]) {
        const [info, agent] = await Promise.all([client().info(), client().agent()]);
        return {
          data: info.models,
          text: info.models
            .map(
              (m) =>
                `${m.id === agent.model ? "*" : " "} ${m.id.padEnd(44)} ${m.name}  ${(m.contextWindow / 1000).toFixed(0)}k`,
            )
            .join("\n"),
        };
      }
      const state = await client().configure({ model: args[0] });
      return { data: state, text: `Model ${state.model}, window ${state.contextWindow}` };
    },
  },
  thinking: {
    usage: "thinking [quick] <off|minimal|low|medium|high>",
    summary: "Pick the thinking level, or the quick model's",
    async run() {
      if (args[0] === "quick") {
        const state = await client().configure({ quickThinking: args[1] as never });
        return {
          data: state.quick,
          text: `Quick tasks: ${state.quick.model}, thinking ${state.quick.thinkingLevel}`,
        };
      }
      const state = await client().configure({ thinkingLevel: args[0] as never });
      return { data: state, text: `Thinking ${state.thinkingLevel}` };
    },
  },
  compaction: {
    usage: "compaction [background force] [--on|--off]",
    summary: "Show or move the compaction points (tokens, or 100k style)",
    async run() {
      const tokensOf = (v: string, name: string) => {
        const m = v.match(/^(\d+(?:\.\d+)?)(k|m)?$/i);
        if (!m) throw new Usage(`${name} must be tokens like 100000 or 100k`);
        return Math.round(
          Number(m[1]) *
            (m[2]?.toLowerCase() === "k" ? 1000 : m[2]?.toLowerCase() === "m" ? 1_000_000 : 1),
        );
      };
      const body = {
        ...(args[0] ? { background: tokensOf(args[0], "background") } : {}),
        ...(args[1] ? { force: tokensOf(args[1], "force") } : {}),
        ...(flags.on ? { enabled: true } : flags.off ? { enabled: false } : {}),
      };
      const c = Object.keys(body).length
        ? await client().setCompaction(body)
        : await client().compaction();
      return {
        data: c,
        text: `background ${c.background}  force ${c.force}  window ${c.window}  ${c.enabled ? "on" : "off"}`,
      };
    },
  },
  compact: {
    usage: "compact [instructions]",
    summary: "Compact the context now",
    async run() {
      const r = await client().compact(args.join(" ").trim() || undefined);
      return { data: r, text: `Compaction task ${r.taskId} started` };
    },
  },
  keywords: {
    usage:
      "keywords [list [kind] | add <kind> <term> [weight] | weight <id> <w> | on <id> | off <id> | rm <id>]",
    summary: "List, add, weight, toggle and remove keywords",
    async run() {
      const [verb = "list", a, b, c] = args;
      if (verb === "list") {
        const ks = await client().keywords(a);
        return { data: ks, text: ks.map(print.keywordLine).join("\n") };
      }
      if (verb === "add") {
        if (!a || !b) throw new Usage("keywords add <topic|hype|facts|signal> <term> [weight]");
        const kw = await client().addKeyword({
          kind: a as never,
          term: b,
          weight: c ? Number(c) : undefined,
        });
        return { data: kw, text: print.keywordLine(kw) };
      }
      if (verb === "weight") {
        const kw = await client().updateKeyword(num(a, "keyword id"), { weight: Number(b) });
        return { data: kw, text: print.keywordLine(kw) };
      }
      if (verb === "on" || verb === "off") {
        const kw = await client().updateKeyword(num(a, "keyword id"), { enabled: verb === "on" });
        return { data: kw, text: print.keywordLine(kw) };
      }
      if (verb === "rm")
        return {
          data: await client().removeKeyword(num(a, "keyword id")),
          text: `Removed keyword ${a}`,
        };
      throw new Usage(COMMANDS.keywords.usage);
    },
  },
  sources: {
    usage: "sources [list | add <kind> <name> [url] | on <id> | off <id> | rm <id>]",
    summary: "List, add, toggle and remove sources",
    async run() {
      const [verb = "list", a, b, c] = args;
      if (verb === "list") {
        const ss = await client().sources();
        return { data: ss, text: ss.map(print.sourceLine).join("\n") };
      }
      if (verb === "add") {
        if (!a || !b)
          throw new Usage(
            "sources add <rss|atom|hn_front|hn_search|github_releases|web_page> <name> [url]",
          );
        const s = await client().addSource({ kind: a as never, name: b, url: c });
        return { data: s, text: print.sourceLine(s) };
      }
      if (verb === "on" || verb === "off") {
        const s = await client().updateSource(num(a, "source id"), { enabled: verb === "on" });
        return { data: s, text: print.sourceLine(s) };
      }
      if (verb === "rm")
        return {
          data: await client().removeSource(num(a, "source id")),
          text: `Removed source ${a}`,
        };
      throw new Usage(COMMANDS.sources.usage);
    },
  },
  sweeps: {
    usage: "sweeps [--limit N]",
    summary: "Recent sweeps with counts and cost",
    async run() {
      const ss = await client().sweeps({ limit: optNum(flags.limit, "limit") ?? 20 });
      return { data: ss, text: ss.length ? ss.map(print.sweepLine).join("\n") : "No sweeps yet." };
    },
  },
  sweep: {
    usage: "sweep <id>",
    summary: "One sweep: phases, audit and tool calls",
    async run() {
      const s = await client().sweep(num(args[0], "sweep id"));
      return { data: s, text: print.sweepDetail(s as never) };
    },
  },
  runs: {
    usage: "runs [--sweep id] [--conversation id] [--limit N]",
    summary: "Agent runs",
    async run() {
      const rs = await client().runs({
        sweepId: optNum(flags.sweep, "sweep"),
        conversationId: optNum(flags.conversation, "conversation"),
        limit: optNum(flags.limit, "limit"),
      });
      return { data: rs, text: rs.map(print.runLine).join("\n") };
    },
  },
  run: {
    usage: "run <id>",
    summary: "One run with its tool calls and subagents",
    async run() {
      const r = await client().run(num(args[0], "run id"));
      return { data: r, text: print.runDetail(r) };
    },
  },
  tool: {
    usage: "tool <id>",
    summary: "One tool call: timings, tokens, cost, context and paid calls",
    async run() {
      const t = await client().toolCall(num(args[0], "tool call id"));
      return { data: t, text: print.toolDetail(t) };
    },
  },
  usage: {
    usage: "usage [--days N]",
    summary: "Cost, tokens, jev calls and Firecrawl credits per day",
    async run() {
      const us = await client().usage(optNum(flags.days, "days") ?? 14);
      return { data: us, text: us.length ? us.map(print.usageLine).join("\n") : "No usage yet." };
    },
  },
  logs: {
    usage: "logs [app] [--level L] [--sweep id] [--conversation id] [--limit N]",
    summary: "Tail the device logs (api, cron, cli)",
    async run() {
      const lines = await client().logs({
        app: args[0],
        level: flags.level as never,
        sweepId: optNum(flags.sweep, "sweep"),
        conversationId: optNum(flags.conversation, "conversation"),
        limit: optNum(flags.limit, "limit"),
      });
      return {
        data: lines,
        text: lines
          .map(
            ({ ts, level, event, app: _a, device: _d, ...rest }) =>
              `${ts} ${String(level).padEnd(5)} ${event} ${JSON.stringify(rest)}`,
          )
          .join("\n"),
      };
    },
  },
  token: {
    usage: "token init|rotate",
    summary: "Write the client and cron tokens into .env (names only are printed)",
    async run() {
      const verb = args[0] ?? "init";
      if (verb !== "init" && verb !== "rotate") throw new Usage(COMMANDS.token.usage);
      const file = join(repoRoot(), ".env");
      const written = ensureTokens(file, { rotate: verb === "rotate" });
      return {
        data: { file, written },
        text: written.length
          ? `Wrote ${written.join(" and ")} to ${file}${verb === "rotate" ? ". Restart every device and redeploy env." : ""}`
          : "Both tokens already set",
      };
    },
  },
  doctor: {
    usage: "doctor",
    summary: "Check Node, keys, the API, scopes, cron, search mode and credits",
    async run() {
      const checks = await doctor(client(), tokens);
      if (checks.some((c) => !c.ok)) process.exitCode = 1;
      return {
        data: checks,
        text: checks.map((c) => `${c.ok ? "pass" : "FAIL"}  ${c.name}: ${c.detail}`).join("\n"),
      };
    },
  },
  net: {
    usage: "net <status|probe|up|down|restart|cron|logs> [device] [args]",
    summary: "Operate devices from dna-network.yaml",
    async run() {
      const [verb = "status", ...rest] = args;
      const data = await net(verb, rest, tokens);
      const rows = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
      const failed = rows.some((x) => x.ok === false || x.online === false);
      const text =
        typeof data === "string"
          ? data
          : verb === "up" && rows.length
            ? `${failed ? "FAIL" : "pass"}  up ${rest[0]}: ${rows.filter((x) => x.ok).length} of ${rows.length} steps passed`
            : Array.isArray(data)
              ? rows
                  .map((x) =>
                    "step" in x
                      ? `${x.ok ? "pass" : "FAIL"}  ${x.step}: ${x.detail}`
                      : "name" in x
                        ? `${x.ok ? "pass" : "FAIL"}  ${x.name} (${x.detail})`
                        : print.deviceLine(x as unknown as print.DeviceStatus),
                  )
                  .join("\n")
              : JSON.stringify(data, null, 2);
      if (failed) process.exitCode = 1;
      return { data, text };
    },
  },
  help: {
    usage: "help",
    summary: "This list",
    async run() {
      const width = Math.max(...Object.values(COMMANDS).map((c) => c.usage.length));
      return {
        data: Object.fromEntries(Object.entries(COMMANDS).map(([k, c]) => [k, c.summary])),
        text: `dna [--device id] [--track ai|cyber-security] [--json] <command>\n\n${Object.values(
          COMMANDS,
        )
          .map((c) => `  ${c.usage.padEnd(Math.min(width, 50))}  ${c.summary}`)
          .join("\n")}`,
      };
    },
  },
};

export const COMMAND_NAMES = Object.keys(COMMANDS);

try {
  const cmd = COMMANDS[command];
  if (!cmd) throw new Usage(`Unknown command ${command}. Run: dna help`);
  log.info("cli.command", { command, device: deviceId });
  const { data, text } = await cmd.run();
  if (flags.json) console.log(JSON.stringify(data, null, 2));
  else if (text) console.log(text);
} catch (error) {
  const message =
    error instanceof DnaError ? `${error.code}: ${error.message}` : (error as Error).message;
  log.warn("cli.failed", { command, error: message });
  if (flags.json)
    console.log(
      JSON.stringify({
        error: {
          code: error instanceof DnaError ? error.code : error instanceof Usage ? "usage" : "error",
          message,
        },
      }),
    );
  else console.error(message);
  process.exitCode = error instanceof Usage ? 2 : 1;
}
