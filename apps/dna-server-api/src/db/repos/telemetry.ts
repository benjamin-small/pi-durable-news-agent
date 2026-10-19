// Telemetry: the commit projector's TelemetryStore, hook events, jev and Firecrawl calls, and the executions queries.
import type {
  AgentEventRow,
  FirecrawlCallRow,
  GenerationRow,
  JevCallRow,
  RunDetail,
  RunSummary,
  ToolCallDetail,
  ToolCallRow,
  UsageDay,
} from "@dna/sdk";
import type {
  AgentHookEvent,
  ConversationTelemetry,
  GenerationTelemetry,
  OtherEntryTelemetry,
  SubmissionTelemetry,
  TaskTelemetry,
  TelemetryStore,
  ToolResultTelemetry,
  UserInputTelemetry,
} from "@dna/durable-agent";
import { bind, bool, type Db, nowIso, num, parse, str } from "../db.ts";

const RESULT_CAP = 20_000;
const sweepOfRequest = (requestId?: string) =>
  requestId?.startsWith("sweep:") ? Number(requestId.slice(6)) || undefined : undefined;

const toGeneration = (r: any): GenerationRow => ({
  entryId: r.entry_id,
  conversationId: r.conversation_id,
  runEntryId: num(r.run_entry_id),
  provider: str(r.provider),
  model: str(r.model),
  stopReason: str(r.stop_reason),
  error: str(r.error),
  inputTokens: r.input_tokens,
  outputTokens: r.output_tokens,
  cacheReadTokens: r.cache_read_tokens,
  cacheWriteTokens: r.cache_write_tokens,
  totalTokens: r.total_tokens,
  costUsd: r.cost_usd,
  contextTokens: r.context_tokens,
  durationMs: num(r.duration_ms),
  thinkingChars: r.thinking_chars,
  text: str(r.text),
  toolCalls: r.tool_calls,
  startedAt: r.started_at,
  endedAt: num(r.ended_at),
});

const toToolCall = (r: any): ToolCallRow => ({
  id: r.id,
  callId: r.call_id,
  generationEntryId: r.generation_entry_id,
  conversationId: r.conversation_id,
  runEntryId: num(r.run_entry_id),
  sweepId: num(r.sweep_id),
  taskId: num(r.task_id),
  toolName: r.tool_name,
  args: parse(r.args_json, undefined),
  status: r.status,
  isError: bool(r.is_error),
  resultText: str(r.result_text),
  details: parse(r.details_json, undefined),
  durationMs: num(r.duration_ms),
  startedAt: num(r.started_at),
  endedAt: num(r.ended_at),
  toolCostUsd: r.tool_cost_usd,
  contextTokens: num(r.context_tokens),
});

const toJev = (r: any): JevCallRow => ({
  id: r.id,
  command: str(r.command),
  version: num(r.version),
  model: str(r.model),
  questions: r.questions,
  answers: parse(r.answers_json, undefined),
  inputTokens: num(r.input_tokens),
  costUsd: num(r.cost_usd),
  costSource: str(r.cost_source),
  elapsedMs: num(r.elapsed_ms),
  attempts: num(r.attempts),
  error: str(r.error),
  itemId: num(r.item_id),
  sweepId: num(r.sweep_id),
  callId: str(r.call_id),
  createdAt: r.created_at,
});

const toFirecrawl = (r: any): FirecrawlCallRow => ({
  id: r.id,
  endpoint: r.endpoint,
  query: str(r.query),
  url: str(r.url),
  status: r.status,
  results: num(r.results),
  creditsUsed: num(r.credits_used),
  creditsSource: str(r.credits_source),
  elapsedMs: num(r.elapsed_ms),
  error: str(r.error),
  sweepId: num(r.sweep_id),
  callId: str(r.call_id),
  createdAt: r.created_at,
});

const toEvent = (r: any): AgentEventRow => ({
  id: r.id,
  ts: r.ts,
  level: r.level,
  event: r.event,
  conversationId: num(r.conversation_id),
  taskId: num(r.task_id),
  callId: str(r.call_id),
  sweepId: num(r.sweep_id),
  data: parse(r.data_json, undefined),
});

export interface JevCallInput {
  command?: string;
  version?: number;
  provider?: string;
  model?: string;
  questions: number;
  answers?: unknown;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number | null;
  costSource?: string;
  elapsedMs?: number;
  attempts?: number;
  error?: string;
  itemId?: number;
  sweepId?: number;
  conversationId?: number;
  callId?: string;
}

export interface FirecrawlCallInput {
  endpoint: string;
  query?: string;
  url?: string;
  status: string;
  results?: number;
  creditsUsed?: number;
  creditsSource?: string;
  elapsedMs?: number;
  error?: string;
  sweepId?: number;
  conversationId?: number;
  callId?: string;
}

export class TelemetryRepo implements TelemetryStore {
  constructor(
    private readonly db: Db,
    private readonly agentOf: (rec: ConversationTelemetry) => string = (rec) =>
      rec.ownerTaskId ? "news-researcher" : "news-desk",
    readonly trackId?: string,
  ) {}

  private prepare(sql: string) {
    const statement = this.db.prepare(sql);
    const params = (args: any[]) => {
      const named = args[0] && typeof args[0] === "object" && !(args[0] instanceof Uint8Array);
      return [
        { ...(named ? args[0] : {}), track: this.trackId ?? null },
        ...(named ? args.slice(1) : args),
      ] as [Record<string, any>, ...any[]];
    };
    return {
      all: (...args: any[]) => statement.all(...params(args)),
      get: (...args: any[]) => statement.get(...params(args)),
      run: (...args: any[]) => statement.run(...params(args)),
    };
  }

  private trackOf(conversationId?: number, parentId?: number, sweepId?: number): string {
    if (this.trackId) return this.trackId;
    const root =
      conversationId &&
      this.db.prepare("SELECT id FROM tracks WHERE conversation_id = ?").get(conversationId);
    if (root) return String(root.id);
    const conversation =
      this.db
        .prepare("SELECT track_id FROM agent_conversations WHERE conversation_id = ?")
        .get(conversationId ?? parentId ?? -1) ??
      this.db
        .prepare("SELECT track_id FROM agent_conversations WHERE conversation_id = ?")
        .get(parentId ?? -1);
    if (conversation) return String(conversation.track_id);
    const sweep =
      sweepId && this.db.prepare("SELECT track_id FROM sweeps WHERE id = ?").get(sweepId);
    return sweep ? String(sweep.track_id) : "ai";
  }

  ownsConversation(id: number): boolean {
    if (!this.trackId) return true;
    return !!this.db
      .prepare(
        "SELECT 1 FROM tracks WHERE conversation_id = ? AND id = ? UNION ALL SELECT 1 FROM agent_conversations WHERE conversation_id = ? AND track_id = ?",
      )
      .get(id, this.trackId, id, this.trackId);
  }

  // TelemetryStore

  conversation(rec: ConversationTelemetry): void {
    const owner = rec.ownerTaskId
      ? (this.prepare(
          "SELECT sweep_id FROM tool_calls WHERE (:track IS NULL OR track_id = :track) AND task_id = ?",
        ).get(rec.ownerTaskId) as any)
      : undefined;
    this.prepare(
      "INSERT OR IGNORE INTO agent_conversations (track_id, conversation_id, agent, owner_conversation_id, owner_task_id, parent_conversation_id, sweep_id, created_at) VALUES (:write_track, :id, :agent, :oc, :ot, :pc, :sweep, :now)",
    ).run(
      bind({
        write_track: this.trackOf(
          rec.conversationId,
          rec.ownerConversationId ?? rec.parentConversationId,
        ),
        id: rec.conversationId,
        agent: this.agentOf(rec),
        oc: rec.ownerConversationId,
        ot: rec.ownerTaskId,
        pc: rec.parentConversationId,
        sweep: owner?.sweep_id,
        now: nowIso(),
      }),
    );
  }

  userInput(rec: UserInputTelemetry): void {
    const conv = this.prepare(
      "SELECT sweep_id FROM agent_conversations WHERE (:track IS NULL OR track_id = :track) AND conversation_id = ?",
    ).get(rec.conversationId) as any;
    this.prepare(
      "INSERT OR IGNORE INTO agent_runs (track_id, run_entry_id, conversation_id, sweep_id, text, started_at) VALUES (:write_track, :id, :conv, :sweep, :text, :at)",
    ).run(
      bind({
        write_track: this.trackOf(rec.conversationId, undefined),
        id: rec.entryId,
        conv: rec.conversationId,
        sweep: conv?.sweep_id,
        text: rec.text.slice(0, 4000),
        at: rec.timestamp,
      }),
    );
  }

  private currentRun(
    conversationId: number,
  ): { run_entry_id: number; sweep_id: number | null } | undefined {
    return this.prepare(
      "SELECT run_entry_id, sweep_id FROM agent_runs WHERE (:track IS NULL OR track_id = :track) AND conversation_id = ? ORDER BY run_entry_id DESC LIMIT 1",
    ).get(conversationId) as any;
  }

  generation(rec: GenerationTelemetry): void {
    const run = this.currentRun(rec.conversationId);
    const endedAt = rec.durationMs !== undefined ? rec.timestamp + rec.durationMs : undefined;
    this.prepare(
      `INSERT OR REPLACE INTO generations (track_id, entry_id, conversation_id, run_entry_id, task_id, sweep_id, provider, model, stop_reason, error, input_tokens, output_tokens,
           cache_read_tokens, cache_write_tokens, total_tokens, cost_usd, context_tokens, duration_ms, thinking_chars, text, tool_calls, started_at, ended_at)
         VALUES (:write_track, :entry_id, :conversation_id, :run, :task_id, :sweep, :provider, :model, :stop, :error, :input, :output, :cr, :cw, :total, :cost, :ctx, :dur, :thinking, :text, :calls, :started, :ended)`,
    ).run(
      bind({
        write_track: this.trackOf(rec.conversationId, undefined),
        entry_id: rec.entryId,
        conversation_id: rec.conversationId,
        run: run?.run_entry_id,
        task_id: rec.taskId,
        sweep: run?.sweep_id,
        provider: rec.provider,
        model: rec.model,
        stop: rec.stopReason,
        error: rec.errorMessage,
        input: rec.usage.input,
        output: rec.usage.output,
        cr: rec.usage.cacheRead,
        cw: rec.usage.cacheWrite,
        total: rec.usage.totalTokens,
        cost: rec.usage.cost,
        ctx: rec.contextTokens,
        dur: rec.durationMs,
        thinking: rec.thinkingChars,
        text: rec.text.slice(0, RESULT_CAP),
        calls: rec.toolCalls.length,
        started: rec.timestamp,
        ended: endedAt,
      }),
    );
    const insert = this.prepare(
      "INSERT OR IGNORE INTO tool_calls (track_id, generation_entry_id, call_id, conversation_id, run_entry_id, sweep_id, tool_name, args_json) VALUES (:write_track, :gen, :call, :conv, :run, :sweep, :name, :args)",
    );
    for (const c of rec.toolCalls) {
      insert.run(
        bind({
          write_track: this.trackOf(rec.conversationId, undefined),
          gen: rec.entryId,
          call: c.id,
          conv: rec.conversationId,
          run: run?.run_entry_id,
          sweep: run?.sweep_id,
          name: c.name,
          args: c.arguments ?? {},
        }),
      );
    }
    if (run) {
      const status =
        rec.stopReason === "error" ? "error" : rec.toolCalls.length ? "running" : "done";
      this.prepare(
        "UPDATE agent_runs SET ended_at = :ended, status = CASE WHEN status = 'done' THEN status ELSE :status END, answer_entry_id = CASE WHEN :done = 1 THEN :entry ELSE answer_entry_id END WHERE (:track IS NULL OR track_id = :track) AND run_entry_id = :run",
      ).run(
        bind({
          write_track: this.trackOf(rec.conversationId, undefined),
          ended: endedAt ?? rec.timestamp,
          status,
          done: status === "done",
          entry: rec.entryId,
          run: run.run_entry_id,
        }),
      );
    }
  }

  task(rec: TaskTelemetry): void {
    this.prepare(
      `INSERT INTO tasks (track_id, task_id, conversation_id, kind, owner_task_id, background, status, outcome, error, started_at, ended_at)
         VALUES (:write_track, :id, :conv, :kind, :owner, :bg, :status, :outcome, :error, :started, :ended)
         ON CONFLICT (task_id) DO UPDATE SET status = excluded.status, outcome = excluded.outcome, error = excluded.error,
           started_at = COALESCE(excluded.started_at, tasks.started_at), ended_at = COALESCE(excluded.ended_at, tasks.ended_at)`,
    ).run(
      bind({
        write_track: this.trackOf(rec.conversationId, undefined),
        id: rec.taskId,
        conv: rec.conversationId,
        kind: rec.kind,
        owner: rec.ownerTaskId,
        bg: rec.background,
        status: rec.status,
        outcome: rec.outcome,
        error: rec.error,
        started: rec.startedAt,
        ended: rec.endedAt,
      }),
    );
    // A deep dive's subagents are owned by its dna.deep-research task, projected after them in the same commit.
    if (rec.kind.startsWith("dna.deep-research"))
      this.prepare(
        "UPDATE agent_conversations SET agent = 'deep-research' WHERE (:track IS NULL OR track_id = :track) AND owner_task_id = ?",
      ).run(rec.taskId);
    if (rec.kind === "pi.tool") {
      const input = rec.input as { assistant?: number; callId?: string };
      if (input?.assistant === undefined || !input.callId) return;
      const status =
        rec.status === "terminal"
          ? rec.outcome === "completed"
            ? "done"
            : (rec.outcome ?? "done")
          : rec.status;
      this.prepare(
        `UPDATE tool_calls SET task_id = :task, started_at = COALESCE(:started, started_at), ended_at = COALESCE(:ended, ended_at),
             status = CASE WHEN status IN ('done', 'error') THEN status ELSE :status END
           WHERE (:track IS NULL OR track_id = :track) AND generation_entry_id = :gen AND call_id = :call`,
      ).run(
        bind({
          write_track: this.trackOf(rec.conversationId, undefined),
          task: rec.taskId,
          started: rec.startedAt,
          ended: rec.endedAt,
          status,
          gen: input.assistant,
          call: input.callId,
        }),
      );
    }
  }

  toolResult(rec: ToolResultTelemetry): void {
    const params = bind({
      is_error: rec.isError,
      text: rec.text.slice(0, RESULT_CAP),
      details: rec.details,
      entry: rec.entryId,
      dur: rec.durationMs,
      status: rec.isError ? "error" : "done",
      cost: rec.usage?.cost ?? 0,
      task: rec.taskId,
      conv: rec.conversationId,
      call: rec.callId,
    });
    const set =
      "is_error = :is_error, result_text = :text, details_json = :details, result_entry_id = :entry, duration_ms = :dur, status = :status, tool_cost_usd = tool_cost_usd + :cost";
    const byTask =
      rec.taskId !== undefined
        ? this.prepare(
            `UPDATE tool_calls SET ${set} WHERE (:track IS NULL OR track_id = :track) AND task_id = :task`,
          ).run(params)
        : undefined;
    if (!byTask || Number(byTask.changes) === 0) {
      this.prepare(
        `UPDATE tool_calls SET ${set} WHERE (:track IS NULL OR track_id = :track) AND id = (SELECT id FROM tool_calls WHERE (:track IS NULL OR track_id = :track) AND conversation_id = :conv AND call_id = :call ORDER BY id DESC LIMIT 1)`,
      ).run(params);
    }
  }

  submission(rec: SubmissionTelemetry): void {
    if (rec.type !== "input" || rec.entryId === undefined) return;
    const sweep = sweepOfRequest(rec.requestId);
    this.prepare(
      "UPDATE agent_runs SET request_id = COALESCE(:req, request_id), submission_id = :sub, sweep_id = COALESCE(:sweep, sweep_id), status = CASE WHEN :status = 'unanswered' THEN 'unanswered' ELSE status END WHERE (:track IS NULL OR track_id = :track) AND run_entry_id = :entry",
    ).run(
      bind({
        req: rec.requestId,
        sub: rec.submissionId,
        sweep,
        status: rec.status,
        entry: rec.entryId,
      }),
    );
    if (sweep) {
      this.prepare(
        "UPDATE generations SET sweep_id = ? WHERE (:track IS NULL OR track_id = :track) AND run_entry_id = ? AND sweep_id IS NULL",
      ).run(sweep, rec.entryId);
      this.prepare(
        "UPDATE tool_calls SET sweep_id = ? WHERE (:track IS NULL OR track_id = :track) AND run_entry_id = ? AND sweep_id IS NULL",
      ).run(sweep, rec.entryId);
      this.prepare(
        "UPDATE sweeps SET submission_id = ?, run_entry_id = ? WHERE (:track IS NULL OR track_id = :track) AND id = ?",
      ).run(rec.submissionId, rec.entryId, sweep);
    }
  }

  entry(rec: OtherEntryTelemetry): void {
    if (rec.kind === "pi.compaction") {
      this.event({
        event: "compaction.done",
        level: "info",
        conversationId: rec.conversationId,
        taskId: rec.taskId ?? 0,
        data: { entryId: rec.entryId },
      });
    }
  }

  // Events

  event(e: AgentHookEvent): void {
    const run = e.conversationId ? this.currentRun(e.conversationId) : undefined;
    this.prepare(
      "INSERT INTO events (track_id, ts, level, event, conversation_id, task_id, call_id, sweep_id, data_json) VALUES (:write_track, :ts, :level, :event, :conv, :task, :call, :sweep, :data)",
    ).run(
      bind({
        write_track: this.trackOf(
          e.conversationId,
          undefined,
          typeof e.data.sweepId === "number" ? e.data.sweepId : undefined,
        ),
        ts: nowIso(),
        level: e.level,
        event: e.event,
        conv: e.conversationId,
        task: e.taskId,
        call: typeof e.data.callId === "string" ? e.data.callId : undefined,
        sweep: e.data.sweepId ?? run?.sweep_id,
        data: e.data,
      }),
    );
  }

  events(filter: {
    sweepId?: number;
    conversationId?: number;
    callId?: string;
    since?: number;
    until?: number;
    limit?: number;
  }): AgentEventRow[] {
    const where: string[] = ["(:track IS NULL OR track_id = :track)"];
    if (filter.sweepId) where.push("sweep_id = :sweep");
    if (filter.conversationId) where.push("conversation_id = :conv");
    if (filter.callId) where.push("call_id = :call");
    if (filter.since) where.push("ts >= :since");
    if (filter.until) where.push("ts <= :until");
    return (
      this.prepare(
        `SELECT * FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT :limit`,
      ).all(
        bind({
          sweep: filter.sweepId,
          conv: filter.conversationId,
          call: filter.callId,
          since: filter.since ? new Date(filter.since).toISOString() : undefined,
          until: filter.until ? new Date(filter.until).toISOString() : undefined,
          limit: filter.limit ?? 200,
        }),
      ) as any[]
    )
      .map(toEvent)
      .reverse();
  }

  // Jev and Firecrawl

  jev(input: JevCallInput): number {
    const r = this.prepare(
      `INSERT INTO jev_calls (track_id, command, version, provider, model, questions, answers_json, input_tokens, output_tokens, cost_usd, cost_source, elapsed_ms, attempts, error, item_id, sweep_id, conversation_id, call_id, created_at)
         VALUES (:write_track, :command, :version, :provider, :model, :questions, :answers, :input, :output, :cost, :source, :elapsed, :attempts, :error, :item, :sweep, :conv, :call, :now)`,
    ).run(
      bind({
        write_track: this.trackOf(input.conversationId, undefined, input.sweepId),
        command: input.command,
        version: input.version,
        provider: input.provider,
        model: input.model,
        questions: input.questions,
        answers: input.answers,
        input: input.inputTokens,
        output: input.outputTokens,
        cost: input.costUsd,
        source: input.costSource,
        elapsed: input.elapsedMs,
        attempts: input.attempts,
        error: input.error,
        item: input.itemId,
        sweep: input.sweepId,
        conv: input.conversationId,
        call: input.callId,
        now: nowIso(),
      }),
    );
    return Number(r.lastInsertRowid);
  }

  firecrawl(input: FirecrawlCallInput): number {
    const r = this.prepare(
      `INSERT INTO firecrawl_calls (track_id, endpoint, query, url, status, results, credits_used, credits_source, elapsed_ms, error, sweep_id, conversation_id, call_id, created_at)
         VALUES (:write_track, :endpoint, :query, :url, :status, :results, :credits, :source, :elapsed, :error, :sweep, :conv, :call, :now)`,
    ).run(
      bind({
        write_track: this.trackOf(input.conversationId, undefined, input.sweepId),
        endpoint: input.endpoint,
        query: input.query,
        url: input.url,
        status: input.status,
        results: input.results,
        credits: input.creditsUsed,
        source: input.creditsSource,
        elapsed: input.elapsedMs,
        error: input.error,
        sweep: input.sweepId,
        conv: input.conversationId,
        call: input.callId,
        now: nowIso(),
      }),
    );
    return Number(r.lastInsertRowid);
  }

  /** Credits used since local midnight (UTC day) and in one sweep. */
  /** Context size the conversation's latest generation sent. */
  contextTokens(conversationId: number): number {
    const r = this.prepare(
      "SELECT context_tokens FROM generations WHERE (:track IS NULL OR track_id = :track) AND conversation_id = ? ORDER BY entry_id DESC LIMIT 1",
    ).get(conversationId) as { context_tokens?: number } | undefined;
    return r?.context_tokens ?? 0;
  }

  /** When any agent last generated (epoch ms). */
  lastActivityAt(): number | undefined {
    const r = this.prepare(
      "SELECT max(coalesce(ended_at, started_at)) at FROM generations WHERE (:track IS NULL OR track_id = :track)",
    ).get() as { at?: number | null } | undefined;
    return r?.at ?? undefined;
  }

  creditsToday(now = new Date()): number {
    const day = now.toISOString().slice(0, 10);
    return Number(
      (
        this.prepare(
          "SELECT COALESCE(SUM(credits_used), 0) n FROM firecrawl_calls WHERE (:track IS NULL OR track_id = :track) AND created_at >= ?",
        ).get(`${day}T00:00:00.000Z`) as any
      ).n,
    );
  }

  /**
   * The run a submission started: running, done or unanswered, or undefined while it waits in the inbox. Match the
   * submission, not the sweep: a sweep's subagent runs carry its sweep id and finish while the sweep still works.
   * ended_at alone is not enough either: the projector stamps it after every generation.
   */
  submissionRun(submissionId: number): { status: string } | undefined {
    return this.prepare(
      "SELECT status FROM agent_runs WHERE (:track IS NULL OR track_id = :track) AND submission_id = ? ORDER BY run_entry_id DESC LIMIT 1",
    ).get(submissionId) as { status: string } | undefined;
  }

  /** A conversation's newest run, with when it ended. */
  lastRun(conversationId: number): { status: string; endedAt?: number } | undefined {
    const r = this.prepare(
      "SELECT status, ended_at FROM agent_runs WHERE (:track IS NULL OR track_id = :track) AND conversation_id = ? ORDER BY run_entry_id DESC LIMIT 1",
    ).get(conversationId) as { status: string; ended_at: number | null } | undefined;
    return r && { status: r.status, endedAt: r.ended_at ?? undefined };
  }

  creditsForSweep(sweepId: number): number {
    return Number(
      (
        this.prepare(
          "SELECT COALESCE(SUM(credits_used), 0) n FROM firecrawl_calls WHERE (:track IS NULL OR track_id = :track) AND sweep_id = ?",
        ).get(sweepId) as any
      ).n,
    );
  }

  // Executions

  private runSummary(r: any): RunSummary {
    const agg = this.prepare(
      "SELECT COUNT(*) gens, COALESCE(SUM(input_tokens + cache_read_tokens + cache_write_tokens), 0) tin, COALESCE(SUM(output_tokens), 0) tout, COALESCE(SUM(cost_usd), 0) cost FROM generations WHERE (:track IS NULL OR track_id = :track) AND run_entry_id = ?",
    ).get(r.run_entry_id) as any;
    const tools = (
      this.prepare(
        "SELECT COUNT(*) n FROM tool_calls WHERE (:track IS NULL OR track_id = :track) AND run_entry_id = ?",
      ).get(r.run_entry_id) as any
    ).n;
    return {
      runEntryId: r.run_entry_id,
      conversationId: r.conversation_id,
      agent: r.agent ?? "news-desk",
      requestId: str(r.request_id),
      sweepId: num(r.sweep_id),
      text: str(r.text)?.slice(0, 400),
      status: r.status,
      startedAt: r.started_at,
      endedAt: num(r.ended_at),
      generations: agg.gens,
      toolCalls: tools,
      tokensIn: agg.tin,
      tokensOut: agg.tout,
      costUsd: agg.cost,
    };
  }

  runs(
    filter: {
      sweepId?: number;
      conversationId?: number;
      before?: number;
      limit?: number;
      topLevel?: boolean;
    } = {},
  ): RunSummary[] {
    const where: string[] = ["(:track IS NULL OR r.track_id = :track)"];
    if (filter.sweepId) where.push("r.sweep_id = :sweep");
    if (filter.conversationId) where.push("r.conversation_id = :conv");
    if (filter.before) where.push("r.run_entry_id < :before");
    if (filter.topLevel) where.push("c.owner_task_id IS NULL");
    return (
      this.prepare(
        `SELECT r.*, c.agent FROM agent_runs r LEFT JOIN agent_conversations c ON c.conversation_id = r.conversation_id ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY r.run_entry_id DESC LIMIT :limit`,
      ).all(
        bind({
          sweep: filter.sweepId,
          conv: filter.conversationId,
          before: filter.before,
          limit: filter.limit ?? 50,
        }),
      ) as any[]
    ).map((r) => this.runSummary(r));
  }

  private toolCallsWhere(where: string, params: Record<string, unknown>): ToolCallRow[] {
    const rows = (
      this.prepare(
        `SELECT t.*, g.context_tokens FROM tool_calls t LEFT JOIN generations g ON g.entry_id = t.generation_entry_id WHERE (:track IS NULL OR t.track_id = :track) AND (${where}) ORDER BY t.id`,
      ).all(bind(params)) as any[]
    ).map(toToolCall);
    for (const row of rows) {
      if (row.taskId === undefined) continue;
      row.children = (
        this.prepare(
          "SELECT conversation_id FROM agent_conversations WHERE (:track IS NULL OR track_id = :track) AND owner_task_id = ? ORDER BY conversation_id",
        ).all(row.taskId) as any[]
      ).map((c) => c.conversation_id);
      // deep_dive_research's subagents belong to its background task; the call names them in its details.
      const named = (row.details as { children?: unknown } | undefined)?.children;
      if (!row.children.length && Array.isArray(named))
        row.children = named.filter((id): id is number => typeof id === "number");
      const paid = this.prepare(
        "SELECT (SELECT COALESCE(SUM(cost_usd), 0) FROM jev_calls WHERE (:track IS NULL OR track_id = :track) AND call_id = :call) + (SELECT COALESCE(SUM(im.cost_usd), 0) FROM images im JOIN cards c ON c.image_id = im.id WHERE c.tool_call_id = :call AND im.origin = 'generated') usd",
      ).get({ call: String(row.taskId) }) as { usd: number };
      row.paidUsd = paid.usd;
    }
    return rows;
  }

  run(runEntryId: number, depth = 0): RunDetail | undefined {
    const r = this.prepare(
      "SELECT r.*, c.agent FROM agent_runs r LEFT JOIN agent_conversations c ON c.conversation_id = r.conversation_id WHERE (:track IS NULL OR r.track_id = :track) AND r.run_entry_id = ?",
    ).get(runEntryId) as any;
    if (!r) return undefined;
    const summary = this.runSummary(r);
    const generationRows = (
      this.prepare(
        "SELECT * FROM generations WHERE (:track IS NULL OR track_id = :track) AND run_entry_id = ? ORDER BY entry_id",
      ).all(runEntryId) as any[]
    ).map(toGeneration);
    const toolCallRows = this.toolCallsWhere("t.run_entry_id = :run", { run: runEntryId });
    // Paid calls (jev, Firecrawl) record the pi-durable task id of the tool call that made them.
    const callIds = toolCallRows.flatMap((t) => (t.taskId ? [String(t.taskId)] : []));
    const childConversations = toolCallRows.flatMap((t) => t.children ?? []);
    const children =
      depth < 2
        ? childConversations.flatMap((conv) =>
            (
              this.prepare(
                "SELECT run_entry_id FROM agent_runs WHERE (:track IS NULL OR track_id = :track) AND conversation_id = ? ORDER BY run_entry_id",
              ).all(conv) as any[]
            )
              .map((c) => this.run(c.run_entry_id, depth + 1)!)
              .filter(Boolean),
          )
        : [];
    const inCalls = (table: string, map: (r: any) => any) =>
      callIds.length
        ? (
            this.prepare(
              `SELECT * FROM ${table} WHERE (:track IS NULL OR track_id = :track) AND call_id IN (${callIds.map(() => "?").join(",")}) ORDER BY id`,
            ).all(...callIds) as any[]
          ).map(map)
        : [];
    return {
      ...summary,
      generationRows,
      toolCallRows,
      children,
      jevCalls: inCalls("jev_calls", toJev),
      firecrawlCalls: inCalls("firecrawl_calls", toFirecrawl),
      events: this.events({
        conversationId: summary.conversationId,
        since: summary.startedAt - 1000,
        until: (summary.endedAt ?? Date.now()) + 5000,
        limit: 500,
      }),
    };
  }

  toolCall(id: number): ToolCallDetail | undefined {
    const [row] = this.toolCallsWhere("t.id = :id", { id });
    if (!row) return undefined;
    const g = this.prepare(
      "SELECT * FROM generations WHERE (:track IS NULL OR track_id = :track) AND entry_id = ?",
    ).get(row.generationEntryId);
    const childRuns = (row.children ?? []).flatMap((conv) =>
      this.runs({ conversationId: conv, limit: 20 }),
    );
    const paid = row.taskId ? String(row.taskId) : row.callId;
    return {
      ...row,
      generation: g ? toGeneration(g) : undefined,
      jevCalls: (
        this.prepare(
          "SELECT * FROM jev_calls WHERE (:track IS NULL OR track_id = :track) AND call_id = ? ORDER BY id",
        ).all(paid) as any[]
      ).map(toJev),
      firecrawlCalls: (
        this.prepare(
          "SELECT * FROM firecrawl_calls WHERE (:track IS NULL OR track_id = :track) AND call_id = ? ORDER BY id",
        ).all(paid) as any[]
      ).map(toFirecrawl),
      childRuns,
      events: this.events({ callId: row.callId, limit: 100 }),
    };
  }

  /** The tool call a pi-durable tool task ran (cards.tool_call_id holds the task id). */
  toolCallByTask(taskId: number): ToolCallDetail | undefined {
    const r = this.prepare(
      "SELECT id FROM tool_calls WHERE (:track IS NULL OR track_id = :track) AND task_id = ?",
    ).get(taskId) as { id: number } | undefined;
    return r ? this.toolCall(r.id) : undefined;
  }

  /** The newest `limit` tool calls of a conversation, oldest first. */
  toolCallsForConversation(conversationId: number, limit = 200): ToolCallRow[] {
    const ids = (
      this.prepare(
        "SELECT id FROM tool_calls WHERE (:track IS NULL OR track_id = :track) AND conversation_id = ? ORDER BY id DESC LIMIT ?",
      ).all(conversationId, limit) as { id: number }[]
    ).map((r) => r.id);
    if (!ids.length) return [];
    return this.toolCallsWhere(`t.id IN (${ids.join(",")})`, {});
  }

  toolCallsForSweep(sweepId: number): ToolCallRow[] {
    return this.toolCallsWhere("t.sweep_id = :sweep", { sweep: sweepId });
  }

  sweepCost(sweepId: number): {
    modelUsd: number;
    jevUsd: number;
    imageUsd: number;
    jevCalls: number;
    tokensIn: number;
    tokensOut: number;
  } {
    const childConvs =
      "SELECT conversation_id FROM agent_conversations WHERE (:track IS NULL OR track_id = :track) AND sweep_id = :sweep";
    const g = this.prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) cost, COALESCE(SUM(input_tokens + cache_read_tokens + cache_write_tokens), 0) tin, COALESCE(SUM(output_tokens), 0) tout FROM generations WHERE (:track IS NULL OR track_id = :track) AND (sweep_id = :sweep OR conversation_id IN (${childConvs}))`,
    ).get(bind({ sweep: sweepId })) as any;
    const j = this.prepare(
      "SELECT COALESCE(SUM(cost_usd), 0) cost, COUNT(*) n FROM jev_calls WHERE (:track IS NULL OR track_id = :track) AND sweep_id = ?",
    ).get(sweepId) as any;
    const i = this.prepare(
      "SELECT COALESCE(SUM(im.cost_usd), 0) cost FROM images im JOIN cards c ON c.image_id = im.id WHERE (:track IS NULL OR im.track_id = :track) AND c.sweep_id = ? AND im.origin = 'generated'",
    ).get(sweepId) as any;
    return {
      modelUsd: g.cost,
      jevUsd: j.cost,
      imageUsd: i.cost,
      jevCalls: j.n,
      tokensIn: g.tin,
      tokensOut: g.tout,
    };
  }

  /** Everything this device has spent, all time: model generations, jev calls and generated images. */
  spend(): { modelUsd: number; jevUsd: number; imageUsd: number; totalUsd: number } {
    const sum = (sql: string) =>
      ((this.prepare(sql).get() as { c: number | null }).c ?? 0) as number;
    const modelUsd = sum(
      "SELECT SUM(cost_usd) c FROM generations WHERE (:track IS NULL OR track_id = :track)",
    );
    const jevUsd = sum(
      "SELECT SUM(cost_usd) c FROM jev_calls WHERE (:track IS NULL OR track_id = :track)",
    );
    const imageUsd = sum(
      "SELECT SUM(cost_usd) c FROM images WHERE (:track IS NULL OR track_id = :track) AND origin = 'generated'",
    );
    return { modelUsd, jevUsd, imageUsd, totalUsd: modelUsd + jevUsd + imageUsd };
  }

  usage(days = 14): UsageDay[] {
    const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    const out = new Map<string, UsageDay>();
    const day = (d: string) => {
      if (!out.has(d))
        out.set(d, {
          day: d,
          modelUsd: 0,
          jevUsd: 0,
          imageUsd: 0,
          tokensIn: 0,
          tokensOut: 0,
          jevCalls: 0,
          firecrawlCredits: 0,
          sweeps: 0,
        });
      return out.get(d)!;
    };
    for (const r of this.prepare(
      "SELECT date(started_at / 1000, 'unixepoch') d, SUM(cost_usd) c, SUM(input_tokens + cache_read_tokens + cache_write_tokens) i, SUM(output_tokens) o FROM generations WHERE (:track IS NULL OR track_id = :track) GROUP BY d HAVING d >= ?",
    ).all(since) as any[]) {
      Object.assign(day(r.d), { modelUsd: r.c, tokensIn: r.i, tokensOut: r.o });
    }
    for (const r of this.prepare(
      "SELECT substr(created_at, 1, 10) d, SUM(cost_usd) c, COUNT(*) n FROM jev_calls WHERE (:track IS NULL OR track_id = :track) GROUP BY d HAVING d >= ?",
    ).all(since) as any[])
      Object.assign(day(r.d), { jevUsd: r.c ?? 0, jevCalls: r.n });
    for (const r of this.prepare(
      "SELECT substr(created_at, 1, 10) d, SUM(credits_used) c FROM firecrawl_calls WHERE (:track IS NULL OR track_id = :track) GROUP BY d HAVING d >= ?",
    ).all(since) as any[])
      day(r.d).firecrawlCredits = r.c ?? 0;
    for (const r of this.prepare(
      "SELECT substr(created_at, 1, 10) d, SUM(cost_usd) c FROM images WHERE (:track IS NULL OR track_id = :track) AND origin = 'generated' GROUP BY d HAVING d >= ?",
    ).all(since) as any[])
      day(r.d).imageUsd = r.c ?? 0;
    for (const r of this.prepare(
      "SELECT substr(created_at, 1, 10) d, COUNT(*) n FROM sweeps WHERE (:track IS NULL OR track_id = :track) AND status != 'skipped' GROUP BY d HAVING d >= ?",
    ).all(since) as any[])
      day(r.d).sweeps = r.n;
    return [...out.values()].sort((a, b) => a.day.localeCompare(b.day));
  }
}
