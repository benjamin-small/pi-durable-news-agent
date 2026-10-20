// Every capability maps to a TUI command (checked by apps/shared/packages/dna-sdk/tests/capabilities.test.ts).
// chat.send is plain text: anything that is not a slash command goes to the agent.
import type { CapabilityId } from "@dna/sdk";

export const TUI_COMMANDS: Record<CapabilityId, string> = {
  status: "/status",
  "feed.read": "/feed",
  "feed.search": "/search",
  schedule: "/schedule",
  "agent.tools": "/tools",
  "timelines.read": "/timelines",
  "card.read": "/card",
  "feedback.more": "/more",
  "feedback.less": "/less",
  "feedback.label": "/label",
  "taste.read": "/taste",
  "taste.answer": "/answer",
  "chat.send": "plain text",
  "chat.watch": "/chat",
  "chat.abort": "/abort",
  "agent.model": "/model",
  "agent.thinking": "/thinking",
  "agent.compaction": "/compaction",
  "agent.compact": "/compact",
  keywords: "/keywords",
  "archive.retention": "/archive",
  sources: "/sources",
  "sweeps.read": "/sweeps",
  "runs.read": "/runs",
  "tool.read": "/tool",
  usage: "/usage",
  logs: "/logs",
};
