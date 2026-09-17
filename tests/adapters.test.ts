// tests/adapters.test.ts — Tier 1 for the adapter layer: tex patching (the most
// likely silent-breakage point), source parsing, JSONL state round-trips, and
// the LLM gateway driven through an injected fetch (no network, no keys).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patchTex } from "../engine/adapters/build.ts";
import { parseFrontmatter, guessCompany, getSources, parseDdgHtml } from "../engine/adapters/sources.ts";
import { createJobStore, createReviewQueue, entryMd } from "../engine/adapters/state.ts";
import { Budget, createLlmGateway } from "../engine/adapters/llm.ts";
import { poisonResume } from "../engine/run.ts";
import { testConfig } from "./fakes.ts";

// ── patchTex: template surgery must LOUDLY report drift ─────────────────

const REF_TEX = [
  "\\documentclass{article}",
  "\\usepackage{fontspec}",
  "\\IfFontExistsTF{Linux Libertine}{\\setmainfont{Linux Libertine}}{}",
  "\\IfFontExistsTF{Linux Libertine O}{\\setsansfont{Linux Libertine O}}{}",
  "\\usepackage[top=2cm, bottom=2cm, left=1.5cm, right=1.5cm]{geometry}",
  "\\setstretch{1.125}",
  "\\usepackage[UTF8]{ctex}",
  "\\setCJKmainfont{Noto Serif CJK SC}",
  "\\begin{document}",
  "\\section{Basics}",
  "basics text \\textbf{Keywords}: go, sql",
  "{\\small \\faGithub}",
  "\\section{Work}",
  "work text",
  "\\section{Education}",
  "edu text",
  "\\section{Skills}",
  "skill text",
  "\\end{document}",
].join("\n");

describe("patchTex (deterministic template surgery)", () => {
  const cfg = testConfig({ build: { max_pages: 2, location_line: "Bangkok, Thailand", section_order: ["Summary", "Work", "Education", "Skills"] } });

  test("patches a reference-shaped tex fully, no missing anchors", () => {
    const r = patchTex(REF_TEX, cfg);
    expect(r.missing).toEqual([]);
    expect(r.text).toContain("\\setmainfont{Times New Roman}");
    expect(r.text).toContain("[top=1.27cm");
    expect(r.text).toContain("\\setstretch{1.0}");
    expect(r.text).toContain("% \\usepackage[UTF8]{ctex}");   // CJK commented
    expect(r.text).toContain("% \\setCJKmainfont");
    expect(r.text).toContain("\\section{Summary}");            // Basics renamed
    expect(r.text).toContain("Bangkok, Thailand $|$");
  });

  test("reorders sections to config order and never drops content", () => {
    const r = patchTex(REF_TEX, testConfig({
      build: { max_pages: 2, location_line: "", section_order: ["Skills", "Education", "Work"] },
    }));
    const pos = (s: string) => r.text.indexOf(s);
    expect(pos("\\section{Skills}")).toBeLessThan(pos("\\section{Education}"));
    expect(pos("\\section{Education}")).toBeLessThan(pos("\\section{Work}"));
    expect(r.text).toContain("skill text");
    expect(r.text).toContain("work text");
  });

  test("template drift: missing anchors are REPORTED (silent no-op is the old bug)", () => {
    const r = patchTex("no anchors here at all", cfg);
    expect(r.missing).toContain("font:times");
    expect(r.missing).toContain("geom:margins");
  });

  test("location_line='' skips the contact patch without flagging missing", () => {
    const r = patchTex(REF_TEX, testConfig({ build: { location_line: "" } }));
    expect(r.missing).not.toContain("contact:location");
  });
});

// ── sources: parsing helpers are pure; unknown source names throw ────────

describe("source parsers", () => {
  test("frontmatter parse: quoted values, missing keys, no-frontmatter fallback", () => {
    const { meta, body } = parseFrontmatter('---\ntitle: "My Role"\ncompany: Acme\n---\nbody here');
    expect(meta.title).toBe("My Role");
    expect(body.trim()).toBe("body here");
    expect(parseFrontmatter("just body").body).toBe("just body");
  });
  test("guessCompany: Roles at/across separators, falls back to hostname", () => {
    expect(guessCompany("Backend Engineer — Lotus's", "https://x.test/j")).toBe("Lotus's");
    expect(guessCompany("Senior Developer at Google", "https://x.test/j")).toBe("Google");
    expect(guessCompany("Software Engineer", "https://www.jobsdb.com/j/1")).toBe("jobsdb.com");
  });
  test("parseDdgHtml extracts result rows and resolves uddg redirects", () => {
    const html = '<a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fjobsdb.com%2Fj%2F1&rut=x">Go Dev – Acme</a><div class="result__snippet">snippet &amp; more</a>';
    const rows = parseDdgHtml(html);
    expect(rows).toHaveLength(1);
    expect(rows[0].url).toBe("https://jobsdb.com/j/1");
    expect(rows[0].snippet).toBe("snippet & more");
  });
  test("getSources throws on an unknown source name (fail loud, not silent-disable)", () => {
    const cfg = testConfig(); (cfg as any).sources = ["inboxx"];
    expect(() => getSources(cfg)).toThrow(/unknown source "inboxx"/);
  });
});

// ── JSONL state adapters (tmpdir round-trip) ─────────────────────────────

describe("state adapters (append-only JSONL)", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "jhl-state-"));

  test("job records round-trip through disk; corrupt lines are skipped, not fatal", () => {
    const d = dir();
    const s = createJobStore(d);
    s.appendJob({ hash: "h1", title: "T", company: "C", url: "u", source: "inbox", jd_text: "j", found_at: "f",
      status: "not_a_fit", run_id: "r", updated_at: "u" });
    appendFileSync(join(d, "jobs.jsonl"), "{not json}\n"); // a torn write must not poison state reads
    expect(s.readJobs().get("h1")?.status).toBe("not_a_fit");
    expect(s.readJobs().size).toBe(1);
  });

  test("readJobs: last append wins (append-only supersede)", () => {
    const d = dir();
    const s = createJobStore(d);
    s.appendJob({ hash: "h", title: "T", company: "C", url: "u", source: "inbox", jd_text: "j", found_at: "f", status: "skipped_budget", run_id: "r1", updated_at: "a" });
    s.appendJob({ hash: "h", title: "T", company: "C", url: "u", source: "inbox", jd_text: "j", found_at: "f", status: "tailored", run_id: "r2", updated_at: "b" });
    expect(s.readJobs().get("h")?.status).toBe("tailored");
    const raw = readFileSync(join(d, "jobs.jsonl"), "utf-8").trim().split("\n");
    expect(raw).toHaveLength(2); // history preserved
  });

  test("review queue: JSONL is truth, MD is rendered from it", () => {
    const d = dir();
    const q = createReviewQueue(d);
    q.append({ at: "2026-09-17T00:00:00Z", run_id: "r1", title: "Role #1", company: "A&B", url: "u",
      why: "HONESTY CHECK FAILED — 1 unverifiable claim(s)", score: 8, verdict: "fit",
      unverifiable: [{ claim: "led 20 engineers", reason: "no source" }] });
    q.render();
    const md = readFileSync(join(d, "human-review.md"), "utf-8");
    expect(md).toContain("Role #1 — A&B");
    expect(md).toContain("8/10");
    expect(md).toContain("led 20 engineers");
    expect(JSON.parse(readFileSync(join(d, "human-review.jsonl"), "utf-8").trim()).why).toContain("HONESTY");
  });
});

// ── LLM gateway: injected fetch — budgets, retry classification, errors ──

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
const completion = (text: string, tokens = 42) =>
  ({ choices: [{ message: { content: text } }], usage: { total_tokens: tokens } });

describe("createLlmGateway", () => {
  const opts = () => { const b = new Budget(1000); return { b }; };

  test("happy path: counts real usage tokens against instance budget", async () => {
    const { b } = opts();
    const g = createLlmGateway({ budget: b, apiKey: "k", baseUrl: "https://x.test/v1",
      fetchImpl: async () => jsonResponse(completion("hi")) } as any);
    const r = await g.call({ model: "m", system: "s", user: "u" });
    expect(r.text).toBe("hi");
    expect(b.spent()).toBe(42);
    expect(b.left()).toBe(958);
  });

  test("429 → retried ONCE with backoff, succeeds", async () => {
    const { b } = opts();
    let n = 0;
    const sleeps: number[] = [];
    const g = createLlmGateway({ budget: b, apiKey: "k", baseUrl: "https://x.test/v1",
      sleep: async (ms) => { sleeps.push(ms); },
      fetchImpl: async () => (++n === 1 ? new Response("rate", { status: 429 }) : jsonResponse(completion("ok"))) } as any);
    const r = await g.call({ model: "m", system: "s", user: "u" });
    expect(r.text).toBe("ok");
    expect(n).toBe(2);
    expect(sleeps).toEqual([2000]); // one backoff — no retry storm
  });

  test("400 (deterministic) → NO retry, throws immediately", async () => {
    const { b } = opts();
    let n = 0;
    const g = createLlmGateway({ budget: b, apiKey: "k", baseUrl: "https://x.test/v1",
      fetchImpl: async () => { n++; return new Response("bad request", { status: 400 }); } } as any);
    await expect(g.call({ model: "m", system: "s", user: "u" })).rejects.toThrow(/400/);
    expect(n).toBe(1);
  });

  test("missing API key → clear onboarding error, zero calls", async () => {
    const { b } = opts();
    const saved = process.env.LLM_API_KEY; delete process.env.LLM_API_KEY;
    const g = createLlmGateway({ budget: b } as any);
    await expect(g.call({ model: "m", system: "s", user: "u" })).rejects.toThrow(/LLM_API_KEY not set/);
    if (saved !== undefined) process.env.LLM_API_KEY = saved;
  });

  test("failed calls do NOT charge the budget (only delivered completions count)", async () => {
    const { b } = opts();
    const g = createLlmGateway({ budget: b, apiKey: "k", baseUrl: "https://x.test/v1",
      fetchImpl: async () => new Response("boom", { status: 400 }) } as any);
    await expect(g.call({ model: "m", system: "s", user: "u" })).rejects.toThrow();
    expect(b.spent()).toBe(0);
  });
});

// ── seed-test poison injection: verified, never a silent no-op ───────────

describe("poisonResume (seed-test fixture integrity)", () => {
  test("injects both poisons when anchors exist", () => {
    const { poisoned, injected } = poisonResume("basics:\n  keywords:\n    - go\nimpact: cut latency 30%\n");
    expect(poisoned).toContain("Quantum Blockchain AI");
    expect(poisoned).toContain("37%");
    expect(injected).toEqual(["fake skill 'Quantum Blockchain AI'", "number drift (+7%)"]);
  });
  test("returns EMPTY injection list when no anchors → caller fails the test loudly", () => {
    const { injected } = poisonResume("basics:\n  name: x\n");
    expect(injected).toEqual([]);
  });
});
