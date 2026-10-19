// DNA_SEARCH_MODE=fixture: the real parsers and code paths over local fixture files, plus a rule-based jev
// stand-in, so faux end to end and UI tests are free and deterministic. DNA_FIXTURE_SET=news|empty.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Answer, Decide, Questions, State, SystemOneResult } from "@dna/jev";
import type { Http, HttpResponse } from "./http.ts";

export const FIXTURES_DIR = join(import.meta.dirname, "../../fixtures");
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

function route(url: string, set: string): string | "png" | undefined {
  const u = new URL(url);
  const empty = set === "empty";
  if (/\.(png|jpe?g|webp|gif)$/i.test(u.pathname)) return "png";
  if (
    [
      "www.schneier.com",
      "krebsonsecurity.com",
      "blog.talosintelligence.com",
      "security.googleblog.com",
      "www.microsoft.com",
    ].includes(u.host) ||
    (u.host === "github.blog" && u.pathname.startsWith("/security/"))
  )
    return empty ? "empty.rss.xml" : "security.rss.xml";
  if (u.host === "security.example.dev")
    return u.pathname.endsWith("feed.xml") ? "security.rss.xml" : "security-article.html";
  if (u.host === "hn.algolia.com")
    return empty ? "hn.json" : u.search.includes("front_page") ? "hn_front.json" : "hn_search.json";
  if (u.host === "www.bing.com" && u.pathname.startsWith("/news/search"))
    return empty ? "empty.rss.xml" : "bing_news.xml";
  if (u.host === "www.bing.com" && u.pathname === "/search")
    return empty ? "empty.rss.xml" : "bing_news.xml";
  if (u.host === "news.google.com") return empty ? "empty.rss.xml" : "google_news.xml";
  if (u.host === "html.duckduckgo.com") return empty ? undefined : "duckduckgo.html";
  if (u.host === "api.firecrawl.dev") {
    if (u.pathname.endsWith("/search")) return "firecrawl-search.json";
    if (u.pathname.endsWith("/scrape")) return empty ? undefined : "firecrawl-scrape.json";
    if (u.pathname.includes("credit-usage")) return "firecrawl-credits.json";
  }
  if (u.host.endsWith("simonwillison.net") && u.pathname.includes("atom"))
    return empty ? "empty.rss.xml" : "simon.atom.xml";
  if (u.host === "github.com" && u.pathname.endsWith(".atom"))
    return u.pathname.includes("earendil-works/pi")
      ? "github.atom.xml"
      : empty
        ? "github.atom.xml"
        : "empty.rss.xml";
  if (u.host.endsWith("openai.com") && u.pathname.endsWith(".xml"))
    return empty ? "empty.rss.xml" : "openai.rss.xml";
  if (u.host.endsWith("anthropic.com") && u.pathname === "/news") return "listing.html";
  if (u.host === "durable.example.dev")
    return u.pathname.endsWith("feed.xml") ? "simon.atom.xml" : "blog.html";
  if (/\.(xml|rss)$|\/feed\/?$|\.rss/.test(u.pathname + u.search)) return "empty.rss.xml";
  return empty ? undefined : "article.html";
}

export function fixtureHttp(set = process.env.DNA_FIXTURE_SET ?? "news", dir = FIXTURES_DIR): Http {
  const now = new Date();
  const fill = (text: string) =>
    text
      .replaceAll("__NOW_ISO__", now.toISOString())
      .replaceAll("__NOW_RFC822__", now.toUTCString())
      .replaceAll("__NOW_EPOCH__", String(Math.floor(now.getTime() / 1000)));
  const respond = (url: string): HttpResponse => {
    const file = route(url, set);
    if (file === "png")
      return {
        status: 200,
        url,
        headers: new Headers({ "content-type": "image/png" }),
        text: PNG.toString("latin1"),
      };
    if (!file) return { status: 404, url, headers: new Headers(), text: "" };
    let text: string;
    try {
      text = readFileSync(join(dir, set, file), "utf8");
    } catch {
      text = readFileSync(join(dir, "news", file), "utf8");
    }
    const type = file.endsWith(".json")
      ? "application/json"
      : file.endsWith(".html")
        ? "text/html"
        : "application/xml";
    return { status: 200, url, headers: new Headers({ "content-type": type }), text: fill(text) };
  };
  return {
    get: async (url, options = {}) => {
      const res = respond(url);
      if (res.status >= 400 && !(options.allowStatus ?? []).includes(res.status))
        throw Object.assign(new Error(`fixture GET ${url} HTTP ${res.status}`), {
          status: res.status,
        });
      return res;
    },
    postJson: async (url) => respond(url),
  };
}

const RELEVANT = [
  "pi-durable",
  "durable",
  "agent",
  "claude",
  "codex",
  "mcp",
  "jev",
  "exe.dev",
  "sandbox",
  "haiku",
];
const HYPE = ["insiders", "100x", "game changer", "revolutionary", "agi", "replace every engineer"];
const FACTS = [
  "release notes",
  "changelog",
  "version",
  "v1.1.0",
  "documentation",
  "benchmarks",
  "available in the api",
];
const SIGNAL = [
  "breaking change",
  "migrate",
  "migration",
  "available now",
  "how to",
  "upgrade",
  "must",
];

const count = (text: string, words: string[]) => words.filter((w) => text.includes(w)).length;

function scoreAnswer(criteria: string[], level: number): Answer {
  const top = criteria.length - 1;
  const at = Math.max(0, Math.min(top, level));
  const probabilities = Object.fromEntries(
    criteria.map((_, i) => [String(i), i === at ? 0.85 : 0.15 / top]),
  );
  return {
    type: "score",
    score: at,
    legend: Object.fromEntries(criteria.map((c, i) => [String(i), c])),
    probabilities,
    confidence: 0.85,
  };
}

/** Deterministic jev for fixture mode: rules over the state text. */
export function fixtureDecide(): Decide {
  const delay = Number(process.env.DNA_FIXTURE_JEV_DELAY_MS ?? 0);
  return async (state: State, questions: Questions): Promise<SystemOneResult> => {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    const all = JSON.stringify(state).toLowerCase();
    const s = state as Record<string, unknown>;
    // Judge the item itself, not the reader's keyword lists that ride along in the state.
    const text =
      typeof state === "object" && state && !Array.isArray(state)
        ? JSON.stringify({
            title: s.title,
            excerpt: s.excerpt,
            findings: s.findings,
            candidate: s.candidate,
          }).toLowerCase()
        : all;
    const security = JSON.stringify({ audience: s.audience, topics: s.topic_keywords })
      .toLowerCase()
      .includes("security");
    const relevant = count(
      text,
      security
        ? [
            "security",
            "vulnerability",
            "ransomware",
            "malware",
            "cryptography",
            "prompt injection",
            "exploitation",
            "mitigation",
          ]
        : RELEVANT,
    );
    const answers: Record<string, Answer> = {};
    for (const [id, q] of Object.entries(questions)) {
      if (q.type === "noul") {
        if (["same", "covered", "development", "addition", "sufficient"].includes(id)) {
          const c = (s.candidate as { title?: string })?.title?.toLowerCase() ?? "";
          const e = (s.existing as { title?: string })?.title?.toLowerCase() ?? "";
          answers[id] = {
            type: "noul",
            noul:
              id === "sufficient"
                ? 0.95
                : ["development", "addition"].includes(id)
                  ? 0.05
                  : c && e && (c === e || c.includes(e) || e.includes(c))
                    ? 0.95
                    : 0.05,
          };
        } else if (id.startsWith("supported")) answers[id] = { type: "noul", noul: 0.8 };
        else
          answers[id] = { type: "noul", noul: relevant > 0 && count(text, HYPE) < 2 ? 0.85 : 0.15 };
        continue;
      }
      if (q.type === "choice") {
        const keys = Object.keys(q.criteria);
        const choice =
          keys.find((k) => k !== "none" && text.includes(String(q.criteria[k]).toLowerCase())) ??
          (keys.includes("none") ? "none" : keys[0]);
        answers[id] = {
          type: "choice",
          choice,
          probabilities: Object.fromEntries(
            keys.map((k) => [k, k === choice ? 1 - 0.01 * (keys.length - 1) : 0.01]),
          ),
          confidence: 0.9,
        };
        continue;
      }
      const top = q.criteria.length - 1;
      const level =
        id === "relevance"
          ? relevant >= 2
            ? top
            : relevant === 1
              ? top - 1
              : 0
          : id === "novelty"
            ? Math.min(top, 2)
            : id === "hype"
              ? Math.min(top, count(text, HYPE))
              : id === "facts"
                ? Math.min(top, count(text, FACTS) + (count(text, HYPE) > 1 ? -1 : 0))
                : id === "signal"
                  ? Math.min(top, count(text, SIGNAL))
                  : 1;
      answers[id] = scoreAnswer(q.criteria, level);
    }
    const response = {
      model: "jev-fixture",
      answers,
      usage: {
        input_tokens: Math.ceil(all.length / 4),
        output_tokens: Object.keys(questions).length,
      },
    };
    const text0 = JSON.stringify(response);
    return {
      ...response,
      raw: {
        request: { model: "jev-fixture", state, questions },
        requestText: "",
        response,
        responseText: text0,
      },
      meta: {
        provider: "mock",
        requestedModel: "jev-fixture",
        resolvedModel: "jev-fixture",
        elapsedMs: 1,
        attempts: 1,
        cost: { amount: 0, source: "mock" },
      },
    } as SystemOneResult;
  };
}
