import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { bind, tx, type Db } from "../db/db.ts";
import { SourceHttpError, type Http, type HttpResponse } from "../news/http.ts";

export interface CaptureContext {
  kind: "feed" | "listing" | "api" | "search" | "article";
  trackId?: string;
  sourceId?: number;
  sweepId?: number;
  conversationId?: number;
  /** Name/configuration of the adapter producing normalized cache entries. */
  extractor?: string;
  config?: Record<string, unknown>;
}
interface Session {
  context: CaptureContext;
  observations: number[];
  failure?: ArchiveError;
}
const sha = (body: Uint8Array | string) => createHash("sha256").update(body).digest("hex");
const REQUEST_HEADERS = [
  "accept",
  "accept-language",
  "content-type",
  "if-none-match",
  "if-modified-since",
];
const HEADERS = ["content-type", "content-language", "etag", "last-modified", "content-encoding"];

/** Never persist URL credentials or common credential query parameters, nor request headers/bodies. */
function safeUrl(value: string): string {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.hash = "";
  for (const name of url.searchParams.keys())
    if (
      /^(authorization|api[_-]?key|access[_-]?token|token|secret|password|signature|sig)$/i.test(
        name,
      )
    )
      url.searchParams.set(name, "[redacted]");
  return url.toString();
}

export class ArchiveError extends Error {
  constructor(cause: unknown) {
    super("Could not preserve source evidence", { cause });
  }
}

/** One shared blob store, with async-local acquisition contexts rather than mutable global ownership. */
export class Archive {
  private readonly sessions = new AsyncLocalStorage<Session>();
  private readonly wrappers = new WeakMap<Http, Http>();
  constructor(
    readonly db: Db,
    readonly directory: string,
  ) {}

  private transaction<T>(run: () => T): T {
    return this.db.isTransaction ? run() : tx(this.db, run);
  }
  blobPath(hash: string) {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("Invalid archive hash");
    return join(this.directory, "blobs", hash.slice(0, 2), `${hash}.gz`);
  }
  readBlob(hash: string): Buffer {
    const body = gunzipSync(readFileSync(this.blobPath(hash)));
    if (sha(body) !== hash) throw new Error("Archive blob integrity check failed");
    return body;
  }
  private blob(body: Uint8Array): string {
    const hash = sha(body),
      file = this.blobPath(hash);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const compressed = gzipSync(body);
    if (!existsSync(file)) {
      const temporary = `${file}.${randomUUID()}.tmp`;
      const fd = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(fd, compressed);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      try {
        try {
          linkSync(temporary, file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        const directory = openSync(dirname(file), "r");
        try {
          fsyncSync(directory);
        } finally {
          closeSync(directory);
        }
      } finally {
        unlinkSync(temporary);
      }
    }
    // A corrupt pre-existing blob must never acquire another successful reference.
    this.readBlob(hash);
    this.db
      .prepare("INSERT OR IGNORE INTO archive_blobs VALUES (?,?,?,?)")
      .run(hash, body.byteLength, statSync(file).size, new Date().toISOString());
    return hash;
  }

  /** Capture before adapters parse or clip. Any archive failure survives callers' fallback catches. */
  async capture<T>(
    context: CaptureContext,
    http: Http,
    operation: (http: Http) => Promise<T>,
  ): Promise<{ value: T; captureIds: number[] }> {
    const session: Session = { context, observations: [] };
    return this.sessions.run(session, async () => {
      let value: T;
      try {
        value = await operation(this.transport(http));
      } catch (error) {
        throw session.failure ?? error;
      }
      if (session.failure) throw session.failure;
      return { value, captureIds: [...session.observations] };
    });
  }

  transport(base: Http): Http {
    const prior = this.wrappers.get(base);
    if (prior) return prior;
    const record = async (
      method: string,
      url: string,
      request: unknown,
      headers: Record<string, string> | undefined,
      run: () => Promise<HttpResponse>,
    ) => {
      const active = this.sessions.getStore();
      if (active?.failure) throw active.failure;
      let response: HttpResponse;
      try {
        response = await run();
      } catch (error) {
        const session = this.sessions.getStore();
        if (session) {
          try {
            const failure =
              error instanceof SourceHttpError
                ? error.response
                : { status: 0, url, text: "", headers: new Headers() };
            session.observations.push(
              this.observe(session.context, method, url, request, headers, failure),
            );
          } catch (cause) {
            session.failure = new ArchiveError(cause);
            throw session.failure;
          }
        }
        throw error;
      }
      const session = this.sessions.getStore();
      if (session) {
        try {
          const captureId = this.observe(session.context, method, url, request, headers, response);
          session.observations.push(captureId);
          response = { ...response, captureId };
        } catch (cause) {
          session.failure = new ArchiveError(cause);
          throw session.failure;
        }
      }
      return response;
    };
    const wrapped: Http = {
      get: (url, options) =>
        record("GET", url, undefined, options?.headers, () => base.get(url, options)),
      postJson: (url, body, headers, options) =>
        record("POST", url, body, headers, () => base.postJson(url, body, headers, options)),
      ...(base.postForm
        ? {
            postForm: (
              url: string,
              form: string,
              options: Parameters<NonNullable<Http["postForm"]>>[2],
            ) =>
              record("POST", url, form, options?.headers, () => base.postForm!(url, form, options)),
          }
        : {}),
    };
    this.wrappers.set(base, wrapped);
    this.wrappers.set(wrapped, wrapped);
    return wrapped;
  }

  private observe(
    context: CaptureContext,
    method: string,
    requested: string,
    request: unknown,
    requestHeaders: Record<string, string> | undefined,
    response: HttpResponse,
  ): number {
    const url = safeUrl(requested),
      final = safeUrl(response.url || requested);
    const at = new Date().toISOString();
    const incoming = new Headers(requestHeaders);
    const safeRequestHeaders = Object.fromEntries(
      REQUEST_HEADERS.flatMap((name) => (incoming.has(name) ? [[name, incoming.get(name)]] : [])),
    );
    const requestKey = sha(
      JSON.stringify([
        context.kind,
        method,
        url,
        request === undefined ? "" : sha(JSON.stringify(request)),
        [incoming.get("accept"), incoming.get("accept-language"), incoming.get("content-type")],
      ]),
    );
    return this.transaction(() => {
      this.db
        .prepare(
          "INSERT OR IGNORE INTO archive_documents(request_key,kind,url,created_at) VALUES (?,?,?,?)",
        )
        .run(requestKey, context.kind, url, at);
      const document = (
        this.db.prepare("SELECT id FROM archive_documents WHERE request_key=?").get(requestKey) as {
          id: number;
        }
      ).id;
      let version: number | null = null;
      if (response.status === 0) {
        version = null;
      } else if (response.status === 304) {
        // Only inherit a complete representation of this exact request identity.
        const previous = this.db
          .prepare(
            "SELECT v.id,o.headers_json FROM archive_observations o JOIN archive_versions v ON v.id=o.version_id WHERE o.document_id=? AND o.status BETWEEN 200 AND 299 AND v.completeness='complete' ORDER BY o.id DESC LIMIT 1",
          )
          .get(document) as { id: number; headers_json: string } | undefined;
        if (previous) {
          const previousHeaders = JSON.parse(previous.headers_json) as Record<string, string>;
          const etag = incoming.get("if-none-match") ?? response.headers.get("etag");
          const modified = incoming.get("if-modified-since");
          const matches = etag
            ? etag
                .split(",")
                .map((x) => x.trim())
                .includes(previousHeaders.etag)
            : !!modified && modified === previousHeaders["last-modified"];
          if (matches) version = previous.id;
        }
      } else {
        const body = response.raw?.body ?? Buffer.from(response.text, "utf8");
        const hash = this.blob(body);
        const representation = /\/v2\/(search|scrape)(?:\?|$)/.test(new URL(url).pathname)
          ? "provider-response"
          : response.raw
            ? "decoded-http-body"
            : "reencoded-text";
        const complete = response.raw
          ? response.raw.complete
            ? "complete"
            : "partial"
          : "unknown";
        this.db
          .prepare(
            "INSERT OR IGNORE INTO archive_versions(document_id,blob_hash,representation,completeness,first_seen_at) VALUES (?,?,?,?,?)",
          )
          .run(document, hash, representation, complete, at);
        version = (
          this.db
            .prepare(
              "SELECT id FROM archive_versions WHERE document_id=? AND blob_hash=? AND representation=? AND completeness=?",
            )
            .get(document, hash, representation, complete) as { id: number }
        ).id;
      }
      const headers = Object.fromEntries(
        HEADERS.flatMap((name) =>
          response.headers.has(name) ? [[name, response.headers.get(name)]] : [],
        ),
      );
      const result = this.db
        .prepare(`INSERT INTO archive_observations(document_id,version_id,track_id,source_id,sweep_id,conversation_id,requested_url,final_url,status,request_headers_json,headers_json,observed_at)
        VALUES (:document,:version,:track,:source,:sweep,:conversation,:url,:final,:status,:requestHeaders,:headers,:at)`)
        .run(
          bind({
            document,
            version,
            track: context.trackId,
            source: context.sourceId,
            sweep: context.sweepId,
            conversation: context.conversationId,
            url,
            final,
            status: response.status,
            requestHeaders: safeRequestHeaders,
            headers,
            at,
          }),
        );
      return Number(result.lastInsertRowid);
    });
  }

  extraction(
    input: {
      url: string;
      title?: string;
      contentMd?: string;
      captureIds?: number[];
      [key: string]: unknown;
    },
    provenance?: "legacy-cache",
  ): number {
    try {
      const session = this.sessions.getStore();
      if (session?.failure) throw session.failure;
      const captures = input.captureIds ?? session?.observations ?? [];
      const { captureIds: _, ttlMinutes: __, ...normalized } = input;
      const origin = provenance ?? (captures.length ? "captured" : "unattributed");
      const extractor =
        session?.context.extractor ??
        (origin === "legacy-cache" ? "legacy-cache/v1" : "normalized-cache/v1");
      const config = JSON.stringify(session?.context.config ?? {});
      return this.transaction(() => {
        const hash = this.blob(Buffer.from(JSON.stringify(normalized)));
        this.db
          .prepare(
            "INSERT OR IGNORE INTO archive_extractions(url,blob_hash,extractor,config_json,provenance,created_at) VALUES (?,?,?,?,?,?)",
          )
          .run(input.url, hash, extractor, config, origin, new Date().toISOString());
        const id = (
          this.db
            .prepare(
              "SELECT id FROM archive_extractions WHERE url=? AND blob_hash=? AND extractor=? AND config_json=? AND provenance=?",
            )
            .get(input.url, hash, extractor, config, origin) as { id: number }
        ).id;
        for (const capture of new Set(captures))
          this.db
            .prepare("INSERT OR IGNORE INTO archive_extraction_inputs VALUES (?,?)")
            .run(id, capture);
        return id;
      });
    } catch (cause) {
      const error = new ArchiveError(cause);
      const session = this.sessions.getStore();
      if (session) session.failure = error;
      throw error;
    }
  }

  inputsForExtraction(id: number | undefined): number[] {
    if (id === undefined) return [];
    return (
      this.db
        .prepare("SELECT observation_id FROM archive_extraction_inputs WHERE extraction_id=?")
        .all(id) as { observation_id: number }[]
    ).map((row) => row.observation_id);
  }

  /** Existing text is explicitly derived legacy material, never a reconstructed original. */
  importLegacyCache(): void {
    for (const row of this.db
      .prepare("SELECT * FROM source_cache WHERE archive_extraction_id IS NULL")
      .all() as Record<string, unknown>[]) {
      const id = this.extraction(
        {
          url: String(row.url),
          title: row.title as string | undefined,
          contentMd: row.content_md as string | undefined,
          legacyFetchedAt: row.fetched_at,
          excerpt: row.excerpt,
        },
        "legacy-cache",
      );
      this.transaction(() => {
        this.db
          .prepare("UPDATE source_cache SET archive_extraction_id=? WHERE id=?")
          .run(id, row.id as number);
        this.db
          .prepare("INSERT OR IGNORE INTO archive_cache_history VALUES (?,?)")
          .run(row.id as number, id);
      });
    }
  }
}
