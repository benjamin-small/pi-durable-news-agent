// The TUI: header, a bottom-up scroll view in one of five modes (chat, feed, timeline, runs, detail), a status line,
// the editor with slash autocomplete, and a footer with the model, context bar and cost.
import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  matchesKey,
  ProcessTerminal,
  ScrollView,
  Text,
  TuiAltScreen,
  VStack,
  type Component,
  type TuiInputListenerResult,
} from "@earendil-works/pi-tui";
import {
  AgentModel,
  cleanText,
  DnaClient,
  DnaError,
  FeedModel,
  follow,
  k,
  newRequestId,
  searchQuery,
  sumUsage,
  usd,
  type ConnectionState,
  type Info,
  type Timeline,
  type WireAssistantMessage,
} from "@dna/sdk";
import * as print from "../../dna-cli/src/print.ts";
import { CardBlock } from "./cards.ts";
import {
  buildCommands,
  KEYWORD_KINDS,
  kTokens,
  parseLabels,
  THINKING,
  type Command,
} from "./commands.ts";
import { contextBar } from "./context-bar.ts";
import { Line, spinner, TextBlock, toolStats, TranscriptView } from "./render.ts";
import { c, editorTheme } from "./theme.ts";

export type Mode = "chat" | "feed" | "timeline" | "runs" | "detail";

const KEYS: [string, string][] = [
  ["enter", "send; steers the agent while it works"],
  ["alt+enter", "queue as a follow up"],
  ["esc", "stop the current run"],
  ["ctrl+o", "expand tool output and thinking"],
  ["ctrl+c", "clear input, or exit when empty"],
];

export class App {
  readonly tui = new TuiAltScreen(new ProcessTerminal(), false, undefined, {
    scrollToEndIndicator: () => c.muted(" ↓ new "),
  });
  readonly agent = new AgentModel();
  readonly feed = new FeedModel();
  info?: Info;
  private timelineView?: Timeline;
  mode: Mode = "chat";
  readonly commands: Command[];
  private detailTitle = "";
  private detail: Component[] = [];
  private header = new Line("");
  private body = new Container();
  private transcript = new TranscriptView();
  private status = new Text("", 1, 0);
  private editor = new Editor(this.tui, editorTheme, { paddingX: 1 });
  private footer = new Line("");
  private connection: ConnectionState = "connecting";
  private notice?: { text: string; error: boolean; at: number };
  private ticker?: ReturnType<typeof setInterval>;
  private clock?: ReturnType<typeof setInterval>;
  private stop = new AbortController();
  private toolTimer?: ReturnType<typeof setTimeout>;

  constructor(
    readonly client: DnaClient,
    readonly device: string,
  ) {
    this.commands = buildCommands({
      models: () => this.info?.models.map((m) => m.id) ?? [],
      cardIds: () => this.feed.state.news.map((x) => x.id),
      timelineIds: () =>
        [...new Set(this.feed.state.news.flatMap((x) => (x.timeline ? [x.timeline.id] : [])))].map(
          String,
        ),
      questionIds: () => this.feed.state.questions.map((q) => q.id),
    });
    this.tui.setLayoutRoot(
      new VStack([
        { component: this.header, basis: "auto" },
        {
          component: new ScrollView(this.body, { follow: "end", primary: true }),
          basis: 0,
          grow: 1,
          minSize: 3,
        },
        { component: this.status, basis: "auto", visible: () => this.statusLines().length > 0 },
        { component: this.editor, basis: "auto", shrink: 1, minSize: 1 },
        { component: this.footer, basis: "auto" },
      ]),
    );
    this.editor.setAutocompleteProvider(
      new CombinedAutocompleteProvider(this.commands, process.cwd(), null),
    );
    this.editor.onSubmit = (text) => void this.submit(text, this.busy() ? "steer" : "followUp");
    this.tui.addInputListener((data) => this.key(data));
    this.agent.subscribe(() => this.redraw());
    this.feed.subscribe(() => this.redraw());
    this.tui.setFocus(this.editor);
    this.tui.start();
    this.clock = setInterval(() => this.redraw(false), 1000);
    this.redraw();
  }

  // ------------------------------------------------------------------ stream

  start() {
    void follow(
      (signal) => this.client.stream(signal),
      (frame) => {
        if (frame.trackId && frame.trackId !== (this.client.trackId ?? "ai")) return;
        if (frame.type === "hello") void this.loadSnapshot();
        this.agent.apply(frame);
        this.feed.apply(frame);
        if (
          frame.type === "agent.snapshot" ||
          (frame.type === "agent.batch" &&
            frame.events.some((e) => e.type === "tool_execution_end" || e.type === "run_end"))
        )
          this.refreshTools();
      },
      (state, error) => {
        this.connection = state;
        if (error && state === "unauthorized") this.flash(error.message, true);
        this.redraw(false);
      },
      this.stop.signal,
    );
  }

  private async loadSnapshot() {
    await this.run(async () => {
      const [info, page, sweeps, questions, agent] = await Promise.all([
        this.client.info(),
        this.client.feed({ limit: 200 }),
        this.client.sweeps({ limit: 30 }),
        this.client.questions("open"),
        this.client.agent(),
      ]);
      this.info = info;
      this.feed.load({ cards: page.items, sweeps, questions, agent });
    });
  }

  private refreshTools() {
    clearTimeout(this.toolTimer);
    this.toolTimer = setTimeout(async () => {
      const rows = await this.client.toolCalls({ limit: 300 }).catch(() => undefined);
      if (!rows) return;
      toolStats.rows = new Map(rows.map((r) => [r.callId, r]));
      this.redraw();
    }, 300);
  }

  // ------------------------------------------------------------------ input

  busy() {
    return this.feed.state.agent?.busy ?? this.agent.state.running;
  }

  private key(data: string): TuiInputListenerResult {
    if (matchesKey(data, "ctrl+c")) {
      if (this.editor.getText()) return (this.editor.setText(""), { consume: true });
      this.exit();
      return { consume: true };
    }
    if (matchesKey(data, "escape") && !this.editor.isShowingAutocomplete()) {
      if (this.mode !== "chat") this.show("chat");
      else if (this.busy()) void this.abort();
      return { consume: true };
    }
    if (matchesKey(data, "alt+enter")) {
      const text = this.editor.getText();
      this.editor.setText("");
      void this.submit(text, "followUp");
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+o")) {
      this.transcript.expand = !this.transcript.expand;
      this.redraw();
      return { consume: true };
    }
    return undefined;
  }

  async submit(text: string, mode: "followUp" | "steer") {
    const content = text.trim();
    if (!content) return;
    this.editor.addToHistory(content);
    if (content.startsWith("/")) return this.command(content);
    this.show("chat");
    const requestId = newRequestId();
    for (let attempt = 1; ; attempt++) {
      try {
        await this.client.send({ content, requestId, mode });
        if (mode === "steer") this.flash("Steering: joins after the current tool round");
        return;
      } catch (e) {
        if (e instanceof DnaError && e.code === "offline" && attempt < 3) {
          await new Promise((r) => setTimeout(r, 1000 * attempt));
          continue;
        }
        if (!this.editor.getText()) this.editor.setText(text);
        this.flash((e as Error).message, true);
        return;
      }
    }
  }

  private async abort() {
    await this.run(async () => {
      await this.client.abort();
      this.flash("Stopped");
    });
  }

  /** Show a mode; detail mode shows the given lines under a title. */
  show(mode: Mode, title = "", lines: string[] = []) {
    this.mode = mode;
    if (mode === "detail" || mode === "runs") {
      this.detailTitle = title;
      this.detail = [new TextBlock(lines)];
    }
    this.redraw();
  }

  private async command(text: string) {
    const [, name = "", rest = ""] = text.match(/^\/(\S+)\s*([\s\S]*)$/) ?? [];
    const words = rest.trim() ? rest.trim().split(/\s+/) : [];
    const id = (i = 0) => {
      const n = Number(words[i]);
      if (!Number.isInteger(n)) throw new Error(`/${name} needs an id`);
      return n;
    };
    const cl = this.client;
    await this.run(async () => {
      switch (name) {
        case "chat":
          return this.show("chat");
        case "feed":
          return this.show("feed");
        case "tools":
          return this.show(
            "detail",
            "tools",
            (await cl.tools()).map(print.toolLines).join("\n\n").split("\n"),
          );
        case "timelines":
          return this.show(
            "detail",
            "timelines",
            (await cl.timelines())
              .map(print.timelineLine)
              .concat("", "Open one with /timeline <id>"),
          );
        case "schedule": {
          const s =
            words[0] === "cards"
              ? await cl.setCardsPerSweep(Number(words[1]))
              : words[0]
                ? await cl.setSchedule(words[0] === "off" ? null : Number(words[0]))
                : await cl.schedule();
          this.feed.apply({ type: "schedule", schedule: s });
          return this.flash(
            s.everyMinutes === null
              ? "Scheduled sweeps are off"
              : `Sweeps every ${s.everyMinutes} min, up to ${s.cardsPerSweep} cards (presets ${s.presets.join(", ")}, off)`,
          );
        }
        case "search": {
          const query = searchQuery(words);
          if (!query.q) throw new Error("/search needs words, keyword <term> or url <link>");
          const cards = await cl.search(query);
          return this.show(
            "detail",
            `search ${rest.trim()}`,
            cards.length ? cards.map(print.cardLine) : [`No news matches ${query.q}.`],
          );
        }
        case "timeline": {
          const t = await cl.timeline(id());
          this.timelineView = t;
          return this.show("timeline");
        }
        case "card":
          return this.show(
            "detail",
            `card ${id()}`,
            print.cardDetail(await cl.card(id())).split("\n"),
          );
        case "more":
        case "less": {
          const r = await cl.feedback(id(), { signal: name });
          return this.flash(
            `Show me ${name}${r.changed.length ? `: ${r.changed.map((x) => `${x.term} ${x.to.toFixed(2)}`).join(", ")}` : ""}${r.leads?.length ? `. ${print.leadsLine(r.leads)}` : ""}`,
          );
        }
        case "label": {
          const labels = parseLabels(words.slice(1));
          if (!labels) throw new Error("Labels are hype, facts and signal");
          await cl.feedback(id(), { labels });
          return this.flash(`Labeled ${id()}: ${labels.join(" ") || "none"}`);
        }
        case "taste": {
          const [taste, questions] = await Promise.all([cl.taste(), cl.questions("open")]);
          return this.show("detail", "taste", [
            c.bold("Keywords"),
            ...taste.keywords.map(print.keywordLine),
            "",
            c.bold("Your feedback"),
            ...(taste.recent.length
              ? taste.recent.map(
                  (r) =>
                    `card ${r.cardId}  ${r.signal ? `show me ${r.signal}` : ""} ${r.labels.join(" ")}  ${cleanText(r.title)}`,
                )
              : [c.muted("none yet")]),
            "",
            c.bold("Open questions"),
            ...(questions.length ? questions.map(print.questionLine) : [c.muted("none")]),
          ]);
        }
        case "answer": {
          const labels = parseLabels(words.slice(1));
          if (!labels) throw new Error("Labels are hype, facts and signal");
          const q = await cl.answer(id(), labels);
          this.feed.apply({ type: "taste.question", question: q });
          this.show("chat");
          return this.flash(`Answered ${q.id}: ${labels.join(" ") || "none"}`);
        }
        case "keywords": {
          const kind = words[0] as (typeof KEYWORD_KINDS)[number] | undefined;
          if (kind && !KEYWORD_KINDS.includes(kind))
            throw new Error(`Kinds are ${KEYWORD_KINDS.join(", ")}`);
          return this.show("detail", "keywords", (await cl.keywords(kind)).map(print.keywordLine));
        }
        case "keyword": {
          const [verb, a, b, w] = words;
          if (verb === "add") {
            if (!a || !b) throw new Error("/keyword add <kind> <term> [weight]");
            const kw = await cl.addKeyword({
              kind: a as never,
              term: b,
              weight: w ? Number(w) : undefined,
            });
            return this.flash(`Added ${kw.kind} ${kw.term}`);
          }
          if (verb === "rm")
            return void (await cl.removeKeyword(id(1)), this.flash(`Removed keyword ${a}`));
          if (verb === "weight")
            return void (await cl.updateKeyword(id(1), { weight: Number(b) }),
            this.flash(`Keyword ${a} weight ${b}`));
          if (verb === "on" || verb === "off")
            return void (await cl.updateKeyword(id(1), { enabled: verb === "on" }),
            this.flash(`Keyword ${a} ${verb}`));
          throw new Error("/keyword add|rm|weight|on|off");
        }
        case "archive": {
          const result =
            words[0] === "disable"
              ? await cl.archivePolicy({ enforcement: "disabled" })
              : words[0] === "enable" && words[1]
                ? await cl.archivePolicy({ enforcement: "enabled" }, words[1])
                : words[0] === "cleanup" && words[1]
                  ? await cl.archiveCleanup(words[1])
                  : await cl.archiveRetention();
          return this.show(
            "detail",
            "archive retention",
            JSON.stringify(result, null, 2).split("\n"),
          );
        }
        case "sources":
          return this.show("detail", "sources", (await cl.sources()).map(print.sourceLine));
        case "source": {
          const [verb, a, b, u] = words;
          if (verb === "add") {
            if (!a || !b) throw new Error("/source add <kind> <name> [url]");
            const s = await cl.addSource({ kind: a as never, name: b, url: u });
            return this.flash(`Added source ${s.name}`);
          }
          if (verb === "toggle") {
            const s = (await cl.sources()).find((x) => x.id === id(1));
            if (!s) throw new Error(`No source ${a}`);
            return void (await cl.updateSource(s.id, { enabled: !s.enabled }),
            this.flash(`${s.name} ${s.enabled ? "off" : "on"}`));
          }
          if (verb === "rm")
            return void (await cl.removeSource(id(1)), this.flash(`Removed source ${a}`));
          throw new Error("/source add|toggle|rm");
        }
        case "model": {
          if (words[0] === "quick") {
            const state = words[1]
              ? await cl.configure({ quickModel: words[1] })
              : await cl.agent();
            this.feed.apply({ type: "agent.state", state });
            return this.flash(
              `Quick tasks: ${state.quick.model}, thinking ${state.quick.thinkingLevel}`,
            );
          }
          if (!words[0]) {
            const current = this.feed.state.agent?.model;
            return this.show(
              "detail",
              "models",
              (this.info?.models ?? []).map(
                (m) =>
                  `${m.id === current ? c.accent("●") : " "} ${m.id.padEnd(40)} ${m.name}${m.id === "anthropic/claude-haiku-5.5" ? c.muted("  default") : ""}`,
              ),
            );
          }
          const state = await cl.configure({ model: words[0] });
          this.feed.apply({ type: "agent.state", state });
          return this.flash(`Model ${state.model} from the next turn`);
        }
        case "thinking": {
          if (words[0] === "quick") {
            if (!THINKING.includes(words[1] as never))
              throw new Error(`Levels are ${THINKING.join(", ")}`);
            const state = await cl.configure({ quickThinking: words[1] as never });
            this.feed.apply({ type: "agent.state", state });
            return this.flash(`Quick tasks thinking ${state.quick.thinkingLevel}`);
          }
          if (!THINKING.includes(words[0] as never))
            throw new Error(`Levels are ${THINKING.join(", ")}`);
          const state = await cl.configure({ thinkingLevel: words[0] as never });
          this.feed.apply({ type: "agent.state", state });
          return this.flash(`Thinking ${state.thinkingLevel}`);
        }
        case "compaction": {
          const body =
            words[0] === "on" || words[0] === "off"
              ? { enabled: words[0] === "on" }
              : { background: kTokens(words[0]), force: kTokens(words[1]) };
          if ("background" in body && (!body.background || !body.force))
            throw new Error("/compaction <bgK> <forceK>, for example /compaction 100 200");
          const next = await cl.setCompaction(body);
          if (this.feed.state.agent)
            this.feed.apply({
              type: "agent.state",
              state: { ...this.feed.state.agent, compaction: next },
            });
          return this.flash(
            `Compaction bg ${k(next.background)} force ${k(next.force)} ${next.enabled ? "on" : "off"}`,
          );
        }
        case "compact": {
          const r = await cl.compact(rest.trim() || undefined);
          return this.flash(`Compaction task ${r.taskId} started`);
        }
        case "context": {
          const a = this.feed.state.agent ?? (await cl.agent());
          return this.show("detail", "context", [
            contextBar(
              40,
              this.used(),
              a.contextWindow,
              a.compaction.background,
              a.compaction.force,
            ),
            "",
            `window ${k(a.contextWindow)}  automatic compaction ${a.compaction.enabled ? "on" : "off"}`,
            c.muted("Move the points with /compaction 100 200, compact now with /compact"),
          ]);
        }
        case "abort":
          return this.abort();
        case "runs":
          return this.show("runs", "runs", (await cl.runs({ limit: 40 })).map(print.runLine));
        case "run":
          return this.show(
            "detail",
            `run ${id()}`,
            print.runDetail(await cl.run(id())).split("\n"),
          );
        case "tool":
          return this.show(
            "detail",
            `tool ${id()}`,
            print.toolDetail(await cl.toolCall(id())).split("\n"),
          );
        case "sweeps":
          return this.show(
            "detail",
            "sweeps",
            (await cl.sweeps({ limit: 30 })).map(print.sweepLine),
          );
        case "sweep":
          return this.show(
            "detail",
            `sweep ${id()}`,
            print.sweepDetail((await cl.sweep(id())) as never).split("\n"),
          );
        case "usage":
          return this.show("detail", "usage", (await cl.usage(14)).map(print.usageLine));
        case "logs": {
          const lines = await cl.logs({
            app: words[0] ?? "api",
            level: (words[1] ?? "info") as never,
            limit: 200,
          });
          return this.show(
            "detail",
            `logs ${words[0] ?? "api"}`,
            lines.map(
              (l) =>
                `${c.faint(l.ts.slice(11, 19))} ${l.level.padEnd(5)} ${l.event} ${c.muted(JSON.stringify({ ...l, ts: undefined, level: undefined, event: undefined, app: undefined, device: undefined }))}`,
            ),
          );
        }
        case "status": {
          const [info, agent, sweeps] = await Promise.all([
            cl.info(),
            cl.agent(),
            cl.sweeps({ limit: 1 }),
          ]);
          return this.show("detail", "status", print.status(info, agent, sweeps[0]).split("\n"));
        }
        case "help":
          return this.show("detail", "help", [
            ...KEYS.map(([key, d]) => `${c.accent(key.padEnd(11))} ${d}`),
            "",
            ...this.commands.map(
              (x) =>
                `${c.accent(`/${x.name}`.padEnd(12))} ${x.description ?? ""}${x.argumentHint ? c.muted(`  ${x.argumentHint}`) : ""}`,
            ),
            "",
            c.muted("Plain text goes to the agent. Closing the TUI never stops it."),
          ]);
        case "quit":
          return this.exit();
        default:
          throw new Error(`Unknown command /${name}. Try /help`);
      }
    });
  }

  // ------------------------------------------------------------------ helpers

  flash(text: string, error = false) {
    this.notice = { text, error, at: Date.now() };
    this.redraw(false);
    setTimeout(() => this.redraw(false), 6100);
  }

  async run(fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (e) {
      this.flash((e as Error).message, true);
    }
  }

  exit() {
    this.stop.abort();
    clearInterval(this.ticker);
    clearInterval(this.clock);
    this.tui.stop();
    process.stdout.write(
      `\n${c.muted("The agent keeps running on")} ${this.device}${c.muted(". Reattach with")} just tui attach ${this.device}\n\n`,
    );
    process.exit(0);
  }

  /** The last reply's prompt plus output: what the next request starts from. */
  used(): number {
    const entries = this.agent.state.entries;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].kind !== "pi.assistant") continue;
      const u = (
        entries[i].model?.find((m) => m.role === "assistant") as WireAssistantMessage | undefined
      )?.usage;
      if (u) return u.totalTokens || u.input + u.output + u.cacheRead + u.cacheWrite;
    }
    return this.feed.state.agent?.contextTokens ?? 0;
  }

  private statusLines(): string[] {
    const lines: string[] = [];
    const s = this.agent.state;
    if (this.busy())
      lines.push(
        `${c.warn("●")} ${c.muted(s.retry ? `retrying: ${cleanText(s.retry.error)}` : s.compactions.length ? "compacting" : "working")} ${c.faint("esc to stop")}`,
      );
    for (const item of s.inbox)
      lines.push(c.muted(item.mode === "steer" ? "↪ steer queued" : "◷ follow up queued"));
    if (this.notice && Date.now() - this.notice.at < 6000)
      lines.push(this.notice.error ? c.err(this.notice.text) : c.ok(this.notice.text));
    return lines;
  }

  private nextSweep(): string {
    const at = this.feed.state.agent?.nextSweepAt ?? this.info?.nextSweepAt;
    if (!at) return "no sweep scheduled";
    const s = Math.max(0, Math.round((Date.parse(at) - Date.now()) / 1000));
    return `next sweep in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  private content(): Component[] {
    const f = this.feed.state;
    switch (this.mode) {
      case "chat": {
        this.transcript.update(this.agent.state.items);
        const questions = f.questions.map(
          (q) =>
            new TextBlock([
              "",
              `${c.accent("? The agent asks")} ${cleanText(q.question)}${q.cardId ? c.muted(`  card ${q.cardId}`) : ""}`,
              c.muted(
                `  answer with /answer ${q.id} signal facts hype, or /answer ${q.id} for none`,
              ),
            ]),
        );
        if (!this.agent.state.items.length)
          return [
            new TextBlock([
              c.muted(
                "This agent did not wait for me to work. It works for me, then waits, then keeps working.",
              ),
            ]),
          ];
        return [this.transcript, ...questions];
      }
      case "feed":
        return f.news.length
          ? [new TextBlock([c.bold("News"), ""]), ...f.news.map((x) => new CardBlock(x))]
          : [new TextBlock([c.muted("No news yet. The agent sweeps every 15 minutes.")])];
      case "timeline": {
        const t = this.timelineView;
        if (!t) return [new TextBlock([c.muted("Open a timeline with /timeline <id>.")])];
        const cards = this.feed.timeline(t.id).length ? this.feed.timeline(t.id) : t.cards;
        return [
          new TextBlock([
            c.bold(`Timeline: ${t.title}`),
            c.muted(`${cards.length} items, oldest first`),
            "",
          ]),
          ...cards.map((x) => new CardBlock(x)),
        ];
      }
      default:
        return [
          new TextBlock([c.bold(this.detailTitle), ""]),
          ...this.detail,
          new TextBlock(["", c.faint("esc returns to the chat")]),
        ];
    }
  }

  private redraw(items = true) {
    const s = this.agent.state;
    if (items) {
      this.body.clear();
      for (const part of this.content()) this.body.addChild(part);
    }
    const running = s.items.some(
      (i) =>
        (i.kind === "tool" && i.call.status === "running") ||
        (i.kind === "assistant" &&
          i.blocks.some((b) => b.type === "tool" && b.call.status === "running")),
    );
    if (running && !this.ticker)
      this.ticker = setInterval(() => {
        spinner.frame++;
        this.tui.requestRender();
      }, 150);
    else if (!running && this.ticker) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
    const conn =
      this.connection === "live"
        ? c.ok("● live")
        : this.connection === "connecting"
          ? c.warn("◌ connecting")
          : c.err(`○ ${this.connection}`);
    const state = this.busy() ? c.accent("◐ Working") : c.muted(`◷ Waiting, ${this.nextSweep()}`);
    this.header.text = ` ${c.bold(c.accent("Durable News Agent"))}  ${c.muted(`${this.info?.track?.name ?? "AI"} desk`)}   ${c.muted("device")} ${this.info?.deviceName ?? this.device}   ${conn}   ${state}   ${c.faint(`[${this.mode}]`)}`;
    this.status.setText(this.statusLines().join("\n"));
    const a = this.feed.state.agent;
    const usage = sumUsage(s.usage);
    const window = a?.contextWindow ?? 0;
    const pct = window ? Math.round((100 * this.used()) / window) : 0;
    this.footer.text = ` ${c.muted("model")} ${a?.model ?? ""}  ${c.muted("thinking")} ${a?.thinkingLevel ?? "low"}  ${c.muted("ctx")} ${pct}%  ${a ? contextBar(16, this.used(), window, a.compaction.background, a.compaction.force) : ""}  ${usd(usage.cost)}  ${c.faint("/help")}`;
    this.tui.requestRender();
  }
}
