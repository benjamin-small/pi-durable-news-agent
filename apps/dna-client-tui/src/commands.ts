// Slash commands with argument completions. Each declares the capability it covers; plain text goes to the agent.
import type { AutocompleteItem, SlashCommand } from "@earendil-works/pi-tui";
import { HFS_CATEGORIES, type CapabilityId, type HfsCategory } from "@dna/sdk";

export const KEYWORD_KINDS = ["topic", "signal", "facts", "hype"] as const;
export const THINKING = ["off", "minimal", "low", "medium", "high"] as const;
export const LOG_APPS = ["api", "cron", "cli"] as const;

export interface CompletionState {
  models(): string[];
  cardIds(): number[];
  timelineIds(): string[];
  questionIds(): number[];
}

export interface Command extends SlashCommand {
  cap?: CapabilityId;
}

const items = (
  values: readonly (string | number)[],
  prefix: string,
  base = "",
): AutocompleteItem[] =>
  values
    .map(String)
    .filter((v) => v.startsWith(prefix))
    .map((v) => ({ value: `${base}${v}`, label: v }));

/** Complete the last word of the argument, keeping the words before it. */
function lastWord(
  arg: string,
  values: (index: number, words: string[]) => readonly (string | number)[],
): AutocompleteItem[] {
  const words = arg.split(/\s+/);
  const last = words.pop() ?? "";
  const base = words.length ? `${words.join(" ")} ` : "";
  return items(values(words.length, words), last, base);
}

export function buildCommands(state: CompletionState): Command[] {
  const cards = (arg: string) => lastWord(arg, (i) => (i === 0 ? state.cardIds() : []));
  return [
    {
      name: "archive",
      cap: "archive.retention",
      description:
        "shared source archive policy and dry run; enable <token>, disable, cleanup <token>",
      argumentHint: "[preview|enable <token>|disable|cleanup <token>]",
    },
    { name: "chat", cap: "chat.watch", description: "the agent and its tool calls, live" },
    { name: "feed", cap: "feed.read", description: "news worth your attention, oldest first" },
    {
      name: "tools",
      cap: "agent.tools",
      description: "every tool the agents have, with params and returns",
    },
    {
      name: "timelines",
      cap: "timelines.read",
      description: "timelines: related news linked by the agent",
    },
    {
      name: "schedule",
      cap: "schedule",
      description: "how often sweeps run (1 to 60 minutes or off), or cards <n> per sweep",
      argumentHint: "[minutes|off|cards <n>]",
      getArgumentCompletions: (arg: string) =>
        items(["1", "5", "10", "15", "30", "60", "off"], arg),
    },
    {
      name: "search",
      cap: "feed.search",
      description: "news matching words, keyword <term> or url <link>",
      argumentHint: "[keyword|url] <words>",
    },
    {
      name: "timeline",
      description: "one timeline's news, oldest first",
      argumentHint: "<id>",
      getArgumentCompletions: (arg: string) =>
        lastWord(arg, (i) => (i === 0 ? state.timelineIds() : [])),
    },
    {
      name: "card",
      cap: "card.read",
      description: "one card with findings and its tool call",
      argumentHint: "<id>",
      getArgumentCompletions: cards,
    },
    {
      name: "more",
      cap: "feedback.more",
      description: "show me more like this card",
      argumentHint: "<id>",
      getArgumentCompletions: cards,
    },
    {
      name: "less",
      cap: "feedback.less",
      description: "show me less like this card",
      argumentHint: "<id>",
      getArgumentCompletions: cards,
    },
    {
      name: "label",
      cap: "feedback.label",
      description: "label a card hype, facts or signal",
      argumentHint: "<id> <hype|facts|signal>",
      getArgumentCompletions: (arg) =>
        lastWord(arg, (i, words) =>
          i === 0 ? state.cardIds() : HFS_CATEGORIES.filter((c) => !words.includes(c)),
        ),
    },
    { name: "taste", cap: "taste.read", description: "keywords, your feedback and open questions" },
    {
      name: "answer",
      cap: "taste.answer",
      description: "answer a taste question (no labels means none)",
      argumentHint: "<question id> [labels]",
      getArgumentCompletions: (arg) =>
        lastWord(arg, (i, words) =>
          i === 0 ? state.questionIds() : HFS_CATEGORIES.filter((c) => !words.includes(c)),
        ),
    },
    {
      name: "keywords",
      cap: "keywords",
      description: "keywords per section with weights",
      argumentHint: "[kind]",
      getArgumentCompletions: (arg) => items(KEYWORD_KINDS, arg),
    },
    {
      name: "keyword",
      description: "add, rm, weight, on or off",
      argumentHint: "add <kind> <term> [weight] | rm <id> | weight <id> <w> | on <id> | off <id>",
      getArgumentCompletions: (arg) =>
        lastWord(arg, (i, words) =>
          i === 0
            ? ["add", "rm", "weight", "on", "off"]
            : i === 1 && words[0] === "add"
              ? KEYWORD_KINDS
              : [],
        ),
    },
    { name: "sources", cap: "sources", description: "sources with last status" },
    {
      name: "source",
      description: "add, toggle or rm a source",
      argumentHint: "add <kind> <name> [url] | toggle <id> | rm <id>",
      getArgumentCompletions: (arg) =>
        lastWord(arg, (i) => (i === 0 ? ["add", "toggle", "rm"] : [])),
    },
    {
      name: "model",
      cap: "agent.model",
      description: "list models, or pick one; quick <id> picks the one-shot model",
      argumentHint: "[quick] [id]",
      getArgumentCompletions: (arg) => items(state.models(), arg),
    },
    {
      name: "thinking",
      cap: "agent.thinking",
      description: "set the thinking level; quick <level> for the one-shot model",
      argumentHint: "[quick] <level>",
      getArgumentCompletions: (arg) => items(THINKING, arg),
    },
    {
      name: "compaction",
      cap: "agent.compaction",
      description: "move the compaction points in k tokens",
      argumentHint: "<bgK> <forceK> | on | off",
    },
    {
      name: "compact",
      cap: "agent.compact",
      description: "compact the context now",
      argumentHint: "[instructions]",
    },
    { name: "context", description: "context used and the compaction points" },
    { name: "abort", cap: "chat.abort", description: "stop the current run" },
    { name: "runs", cap: "runs.read", description: "agent runs" },
    { name: "run", description: "one run with tool calls and subagents", argumentHint: "<id>" },
    {
      name: "tool",
      cap: "tool.read",
      description: "one tool call: timings, tokens, cost",
      argumentHint: "<id>",
    },
    { name: "sweeps", cap: "sweeps.read", description: "recent sweeps" },
    { name: "sweep", description: "one sweep: phases, audit, tool calls", argumentHint: "<id>" },
    { name: "usage", cap: "usage", description: "cost, tokens, jev calls and credits per day" },
    {
      name: "logs",
      cap: "logs",
      description: "tail the device logs",
      argumentHint: "[app] [level]",
      getArgumentCompletions: (arg) =>
        lastWord(arg, (i) =>
          i === 0 ? LOG_APPS : i === 1 ? ["debug", "info", "warn", "error"] : [],
        ),
    },
    { name: "status", cap: "status", description: "device, model, agent state and sweeps" },
    { name: "help", description: "keys and commands" },
    { name: "quit", description: "exit; the agent keeps running" },
  ];
}

export function parseLabels(words: string[]): HfsCategory[] | undefined {
  return words.every((w) => HFS_CATEGORIES.includes(w as HfsCategory))
    ? (words as HfsCategory[])
    : undefined;
}

/** "100" or "100k" is 100000 tokens; "100000" stays. */
export function kTokens(value: string | undefined): number | undefined {
  const m = value?.match(/^(\d+(?:\.\d+)?)(k|m)?$/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (m[2]?.toLowerCase() === "m") return Math.round(n * 1_000_000);
  return Math.round(m[2] || n < 10_000 ? n * 1000 : n);
}
