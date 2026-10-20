import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { ArchiveError } from "../src/archive/archive.ts";
import { openStore, scopeStore } from "../src/db/store.ts";
import { liveHttp, type Http, type HttpResponse } from "../src/news/http.ts";
import { fetchSource } from "../src/news/sources/index.ts";
import { fixtureHttp } from "../src/news/fixtures.ts";
import { SearchService } from "../src/news/search/index.ts";
import { pageText } from "../src/news/page.ts";
import { CONFIG_DIR, tempStore } from "./helpers.ts";

const response = (url: string, text: string, status = 200): HttpResponse => ({
  url,
  text,
  status,
  headers: new Headers({
    "content-type": "text/html",
    etag: '"v1"',
    "set-cookie": "private-cookie",
  }),
  raw: { body: Buffer.from(text), complete: true },
});
const fake = (get: Http["get"]): Http => ({
  get,
  postJson: async () => {
    throw new Error("unexpected POST");
  },
});
const hash = (body: Uint8Array) => createHash("sha256").update(body).digest("hex");
const scalar = (store: ReturnType<typeof tempStore>["store"], table: string) =>
  Number(store.db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n);

test("captures feed XML before stripping/clipping, records extraction inputs and safe response metadata", async () => {
  const { store, cleanup } = tempStore();
  try {
    const source = store.sources.list().find((x) => x.kind === "rss")!;
    const xml = `<rss><channel><item><title>Preserve this &amp; that</title><link>https://archive.test/article</link><description><![CDATA[<p>${"original text ".repeat(1000)}</p>]]></description></item></channel></rss>`;
    const result = await fetchSource(source, {
      http: fake(async (url) => response(url, xml)),
      store,
      since: new Date(0),
    });
    assert.equal(result.ok, true);
    const doc = result.docs[0];
    assert.ok(doc.contentMd!.length <= 8000);
    assert.ok(doc.archiveExtractionId);
    const version = store.db.prepare("SELECT * FROM archive_versions").get()!;
    assert.deepEqual(store.archive.readBlob(String(version.blob_hash)), Buffer.from(xml));
    const obs = store.db.prepare("SELECT * FROM archive_observations").get()!;
    assert.equal(obs.track_id, "ai");
    assert.equal(obs.source_id, source.id);
    assert.equal(JSON.parse(String(obs.headers_json))["set-cookie"], undefined);
    assert.equal(scalar(store, "archive_extraction_inputs"), 1);
  } finally {
    cleanup();
  }
});

test("shorter corrections, unchanged checks, 304s and reverts preserve the version timeline", async () => {
  const { store, cleanup } = tempStore();
  try {
    const url = "https://archive.test/versioned";
    const context = { kind: "article" as const, trackId: "ai" };
    for (const [text, status] of [
      ["long original", 200],
      ["correction", 200],
      ["correction", 200],
      ["", 304],
      ["long original", 200],
    ] as const)
      await store.archive.capture(
        context,
        fake(async () => response(url, text, status)),
        (http) => http.get(url),
      );
    const observations = store.db
      .prepare("SELECT version_id FROM archive_observations ORDER BY id")
      .all();
    assert.equal(scalar(store, "archive_versions"), 2);
    assert.equal(scalar(store, "archive_blobs"), 2);
    assert.equal(observations[0].version_id, observations[4].version_id);
    assert.equal(observations[1].version_id, observations[2].version_id);
    assert.equal(observations[2].version_id, observations[3].version_id);
    await store.archive.capture(
      context,
      fake(async () => response("https://archive.test/no-prior", "", 304)),
      (http) => http.get("https://archive.test/no-prior"),
    );
    assert.equal(
      store.db
        .prepare("SELECT version_id FROM archive_observations ORDER BY id DESC LIMIT 1")
        .get()!.version_id,
      null,
    );
  } finally {
    cleanup();
  }
});

test("a feed body correction is archived even when title/date admission hashing skips it", async () => {
  const { store, cleanup } = tempStore();
  try {
    const source = store.sources.list().find((s) => s.kind === "rss")!;
    let body = "Original reporting with a long explanation";
    const http = fake(async (url) =>
      response(
        url,
        `<rss><channel><item><title>Same title</title><link>https://archive.test/correction</link><description>${body}</description></item></channel></rss>`,
      ),
    );
    await fetchSource(source, { store, http, since: new Date(0) });
    body = "Corrected.";
    const result = await fetchSource(source, { store, http, since: new Date(0) });
    assert.equal(result.status, "unchanged");
    assert.equal(scalar(store, "archive_versions"), 2);
    const versions = store.db
      .prepare(
        "SELECT e.blob_hash FROM archive_cache_history h JOIN archive_extractions e ON e.id=h.extraction_id",
      )
      .all();
    assert.equal(versions.length, 2);
    assert.ok(
      versions.some(
        (v) =>
          JSON.parse(store.archive.readBlob(String(v.blob_hash)).toString()).contentMd ===
          "Corrected.",
      ),
    );
  } finally {
    cleanup();
  }
});

test("concurrent desks share body storage without mixing observation or extraction ownership", async () => {
  const { store, cleanup } = tempStore();
  try {
    const security = scopeStore(store, "cyber-security", `${CONFIG_DIR}/cyber-security`);
    const body = "identical original bytes";
    await Promise.all(
      [store, security].map(async (desk) => {
        const url = `https://archive.test/${desk.trackId}`;
        await desk.archive.capture(
          { kind: "article", trackId: desk.trackId },
          fake(async () => {
            await new Promise((r) => setTimeout(r, desk.trackId === "ai" ? 10 : 1));
            return response(url, body);
          }),
          async (http) => {
            await http.get(url);
            desk.sources.cache({
              url,
              title: desk.trackId,
              contentMd: body,
              fetchVia: "http",
              ttlMinutes: 1440,
            });
          },
        );
      }),
    );
    const rows = store.db
      .prepare(
        `SELECT e.url,o.track_id FROM archive_extractions e JOIN archive_extraction_inputs i ON i.extraction_id=e.id JOIN archive_observations o ON o.id=i.observation_id`,
      )
      .all();
    assert.equal(rows.length, 2);
    for (const row of rows) assert.ok(String(row.url).endsWith(String(row.track_id)));
    const rawHash = hash(Buffer.from(body));
    assert.equal(
      store.db.prepare("SELECT count(*) n FROM archive_versions WHERE blob_hash=?").get(rawHash)!.n,
      2,
    );
    assert.equal(
      store.db.prepare("SELECT count(*) n FROM archive_blobs WHERE hash=?").get(rawHash)!.n,
      1,
    );
  } finally {
    cleanup();
  }
});

test("a parse failure retains the original and archive failures cannot be swallowed as successful fallbacks", async () => {
  const { store, cleanup } = tempStore();
  try {
    const source = store.sources.list().find((x) => x.kind === "rss")!;
    const out = await fetchSource(source, {
      store,
      http: fake(async (url) => response(url, "<html>not a feed</html>")),
      since: new Date(0),
    });
    assert.equal(out.ok, false);
    assert.equal(scalar(store, "archive_versions"), 1);
    const version = store.db.prepare("SELECT blob_hash FROM archive_versions").get()!;
    writeFileSync(store.archive.blobPath(String(version.blob_hash)), "corrupted");
    await assert.rejects(
      store.archive.capture(
        { kind: "feed", trackId: "ai" },
        fake(async (url) => response(url, "<html>not a feed</html>")),
        async (http) => {
          try {
            await http.get(source.url);
          } catch {}
          return "fallback tried to hide failure";
        },
      ),
      ArchiveError,
    );
    assert.equal(scalar(store, "archive_observations"), 1);
  } finally {
    cleanup();
  }
});

test("failed blob writes do not leave successful observations or cache entries", async () => {
  const { store, cleanup } = tempStore();
  try {
    writeFileSync(store.archive.directory, "directory blocked");
    await assert.rejects(
      store.archive.capture(
        { kind: "article", trackId: "ai" },
        fake(async (url) => response(url, "new evidence")),
        async (http) => {
          try {
            await http.get("https://archive.test/no-space");
          } catch {}
          return "ignored";
        },
      ),
      ArchiveError,
    );
    assert.equal(scalar(store, "archive_observations"), 0);
    assert.equal(scalar(store, "archive_versions"), 0);
    assert.equal(scalar(store, "archive_documents"), 0);
  } finally {
    cleanup();
  }
});

test("legacy cache migration is explicit, preserves text, creates no invented original and is restart safe", () => {
  const f = tempStore();
  let store = f.store;
  try {
    const doc = store.sources.cache({
      url: "https://archive.test/legacy",
      contentMd: "legacy extraction",
      fetchVia: "feed",
      ttlMinutes: 1,
    });
    store.db.exec(
      "UPDATE source_cache SET archive_extraction_id=NULL; DELETE FROM archive_cache_history; DELETE FROM archive_extraction_inputs; DELETE FROM archive_extractions; DELETE FROM archive_blobs;",
    );
    store.close();
    store = openStore(f.dir, CONFIG_DIR);
    assert.equal(store.sources.cachedById(doc.id)?.contentMd, "legacy extraction");
    assert.equal(
      store.db.prepare("SELECT provenance FROM archive_extractions").get()!.provenance,
      "legacy-cache",
    );
    assert.equal(scalar(store, "archive_versions"), 0);
    store.close();
    store = openStore(f.dir, CONFIG_DIR);
    assert.equal(scalar(store, "archive_extractions"), 1);
    assert.equal(
      store.db.prepare("SELECT enforcement FROM archive_policy").get()!.enforcement,
      "disabled",
    );
    assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    try {
      store.close();
    } catch {}
    f.cleanup();
  }
});

test("live HTTP preserves exact byte prefixes and partial/error status without archiving request credentials", async () => {
  const { store, cleanup } = tempStore();
  const bytes = Buffer.from([0x61, 0xff, 0xc3, 0xa9, 0x62, 0x63, 0x64]);
  const server = createServer((req, res) => {
    res.writeHead(req.url?.startsWith("/denied") ? 403 : 200, {
      "content-type": "application/octet-stream",
      "set-cookie": "should-not-save",
    });
    if (req.url?.startsWith("/interrupted")) {
      res.write(bytes.subarray(0, 3));
      setTimeout(() => res.destroy(), 30);
      return;
    }
    res.end(bytes);
  });
  let port = 8700;
  for (; port <= 8899; port++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    }
  }
  try {
    assert.ok(port <= 8899);
    const url = `http://127.0.0.1:${port}/bytes?api_key=hidden-key`;
    await store.archive.capture({ kind: "article", trackId: "ai" }, liveHttp(), (http) =>
      http.get(url, { maxBytes: 4 }),
    );
    const version = store.db.prepare("SELECT * FROM archive_versions").get()!;
    assert.equal(version.completeness, "partial");
    assert.deepEqual(store.archive.readBlob(String(version.blob_hash)), bytes.subarray(0, 4));
    const obs = store.db.prepare("SELECT * FROM archive_observations").get()!;
    assert.ok(!JSON.stringify(obs).includes("hidden-key"));
    assert.ok(!JSON.stringify(obs).includes("should-not-save"));
    await assert.rejects(
      store.archive.capture({ kind: "article", trackId: "ai" }, liveHttp(), (http) =>
        http.get(`http://127.0.0.1:${port}/denied`, { noRetryOn: [403] }),
      ),
    );
    assert.equal(
      store.db.prepare("SELECT status FROM archive_observations ORDER BY id DESC LIMIT 1").get()!
        .status,
      403,
    );
    await assert.rejects(
      store.archive.capture({ kind: "article", trackId: "ai" }, liveHttp(), (http) =>
        http.get(`http://127.0.0.1:${port}/interrupted`, { noRetryOn: [502] }),
      ),
    );
    const interrupted = store.db
      .prepare(
        "SELECT v.completeness,v.blob_hash FROM archive_observations o JOIN archive_versions v ON v.id=o.version_id ORDER BY o.id DESC LIMIT 1",
      )
      .get()!;
    assert.equal(interrupted.completeness, "partial");
    assert.deepEqual(store.archive.readBlob(String(interrupted.blob_hash)), bytes.subarray(0, 3));
    await assert.rejects(
      store.archive.capture(
        { kind: "article", trackId: "ai" },
        fake(async () => {
          throw new Error("network");
        }),
        (http) => http.get(url),
      ),
    );
    assert.equal(
      store.db
        .prepare("SELECT version_id,status FROM archive_observations ORDER BY id DESC LIMIT 1")
        .get()!.status,
      0,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    cleanup();
  }
});

test("every configured acquisition adapter captures its source responses", async () => {
  const { store, cleanup } = tempStore();
  try {
    for (const source of store.sources.list()) {
      const result = await fetchSource(source, {
        store,
        http: fixtureHttp("news"),
        since: new Date(0),
        queries: ["durable agents"],
      });
      assert.equal(result.ok, true, source.name);
      assert.ok(
        store.db
          .prepare("SELECT count(*) n FROM archive_observations WHERE source_id=?")
          .get(source.id)!.n,
        source.name,
      );
    }
    assert.ok(scalar(store, "archive_cache_history") > 0);
  } finally {
    cleanup();
  }
});

test("ordinary, full and deep article reads preserve originals beyond their agent/cache text limits", async () => {
  const { store, cleanup } = tempStore();
  try {
    const html = `<html><head><title>Original article</title></head><body><article><p>${"archived original sentence. ".repeat(11000)}</p></article></body></html>`;
    const http = fake(async (url) => response(url, html));
    const search = new SearchService({ store, http }, { mode: "web", sweepCap: 5, dailyCap: 40 });
    const url = "https://archive.test/long";
    const short = await search.scrape(url);
    assert.equal(short.doc.contentMd!.length, 12000);
    const full = await search.hyperFetch(url);
    assert.equal(full.markdown.length, 200000);
    await search.deepScrape("https://archive.test/deep");
    const original = store.db
      .prepare("SELECT blob_hash FROM archive_versions ORDER BY id LIMIT 1")
      .get()!;
    assert.equal(store.archive.readBlob(String(original.blob_hash)).toString(), html);
    const extractions = store.db
      .prepare("SELECT blob_hash FROM archive_extractions")
      .all()
      .map((r) => JSON.parse(store.archive.readBlob(String(r.blob_hash)).toString()));
    assert.ok(extractions.some((x) => x.contentMd?.length === 200000));
    const item = store.news.upsertItem({
      url: "https://archive.test/page",
      title: "Read page",
    }).item;
    assert.equal((await pageText({ store, http }, item, 2400))!.length, 2400);
    assert.equal(
      store.db.prepare("SELECT count(*) n FROM archive_documents WHERE kind='article'").get()!.n,
      3,
    );
  } finally {
    cleanup();
  }
});

test("search response collections stay attached when hit normalization happens after search returns", async () => {
  const { store, cleanup } = tempStore();
  try {
    const search = new SearchService(
      { store, http: fixtureHttp("news") },
      { mode: "fixture", sweepCap: 5, dailyCap: 40 },
    );
    const result = await search.search("durable agents");
    assert.ok(result.hits.length);
    assert.ok(result.hits[0].captureIds?.length);
    const hit = result.hits[0];
    const doc = store.sources.cache({
      url: hit.url,
      title: hit.title,
      excerpt: hit.excerpt,
      captureIds: hit.captureIds,
      fetchVia: "feed",
      ttlMinutes: 1440,
    });
    assert.ok(
      store.db
        .prepare("SELECT count(*) n FROM archive_extraction_inputs WHERE extraction_id=?")
        .get(doc.archiveExtractionId!)!.n,
    );
    assert.equal(
      store.db.prepare("SELECT representation FROM archive_versions LIMIT 1").get()!.representation,
      "provider-response",
    );
    // Authorization sent to Firecrawl never appears in the observation metadata.
    assert.ok(
      !JSON.stringify(store.db.prepare("SELECT * FROM archive_observations").all()).includes(
        "Bearer fixture",
      ),
    );
  } finally {
    cleanup();
  }
});

test("cached search hits retain their own source observations when live engines fail", async () => {
  const { store, cleanup } = tempStore();
  try {
    const url = "https://archive.test/cache-only";
    const original = await store.archive.capture(
      { kind: "article", trackId: "ai" },
      fake(async () => response(url, "original cached article")),
      async (http) => {
        await http.get(url);
        store.sources.cache({
          url,
          title: "durable cache article",
          excerpt: "durable cache",
          contentMd: "original cached article",
          fetchVia: "http",
          ttlMinutes: 1440,
        });
      },
    );
    const search = new SearchService(
      {
        store,
        http: fake(async () => {
          throw new Error("engine offline");
        }),
      },
      { mode: "web", sweepCap: 0, dailyCap: 0 },
    );
    const result = await search.search("durable cache");
    const hit = result.hits.find((x) => x.url === url)!;
    assert.ok(hit);
    assert.deepEqual(hit.captureIds, original.captureIds);
    assert.ok(scalar(store, "archive_observations") > original.captureIds.length);
  } finally {
    cleanup();
  }
});

test(
  "a process killed after writing a blob but before SQLite commit restarts without a dangling reference",
  { timeout: 15000 },
  async () => {
    const f = tempStore();
    f.store.close();
    let child: ReturnType<typeof spawn> | undefined;
    let store: ReturnType<typeof openStore> | undefined;
    try {
      const moduleUrl = new URL("../src/db/store.ts", import.meta.url).href;
      const code = `import {openStore} from ${JSON.stringify(moduleUrl)};
      const store=openStore(${JSON.stringify(f.dir)},${JSON.stringify(CONFIG_DIR)});
      store.db.exec('BEGIN IMMEDIATE');
      const url='https://archive.test/crash';
      const http={get:async()=>({url,status:200,headers:new Headers(),text:'crash evidence',raw:{body:Buffer.from('crash evidence'),complete:true}}),postJson:async()=>{throw Error('unused')}};
      await store.archive.capture({kind:'article',trackId:'ai'},http,h=>h.get(url));
      process.stdout.write('blob-written\\n'); setInterval(()=>{},1000);`;
      child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      await new Promise<void>((resolve, reject) => {
        let output = "",
          errors = "";
        child!.stderr!.on("data", (d) => {
          errors += d;
        });
        child!.stdout!.on("data", (d) => {
          output += d;
          if (output.includes("blob-written")) resolve();
        });
        child!.once("exit", () => reject(new Error(errors || "child exited before write")));
      });
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      store = openStore(f.dir, CONFIG_DIR);
      assert.equal(scalar(store, "archive_versions"), 0);
      assert.equal(scalar(store, "archive_observations"), 0);
      const url = "https://archive.test/crash";
      await store.archive.capture(
        { kind: "article", trackId: "ai" },
        fake(async () => response(url, "crash evidence")),
        (http) => http.get(url),
      );
      assert.equal(scalar(store, "archive_versions"), 1);
      assert.equal(
        store.archive.readBlob(hash(Buffer.from("crash evidence"))).toString(),
        "crash evidence",
      );
      assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      child?.kill("SIGKILL");
      try {
        store?.close();
      } catch {}
      f.cleanup();
    }
  },
);
