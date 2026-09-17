// tests/domain.test.ts — Tier 1: pure functions that gate every model call.
import { describe, expect, test } from "bun:test";
import { prefilter } from "../engine/domain/prefilter.ts";
import { jobKey, sanitizeCompany, errText } from "../engine/domain/paths.ts";
import { checkProfile, factVaultFiles } from "../engine/domain/profile.ts";
import { validateConfig } from "../engine/domain/config.ts";
import { parseScreen, parseTailor, parseHonesty, StageOutputError } from "../engine/domain/validate.ts";
import { matchReport, runSummary } from "../engine/app/report.ts";
import { fakePosting, testConfig } from "./fakes.ts";

describe("prefilter (deterministic intake gate — zero model calls)", () => {
  const cfg = testConfig({
    filters: { exclude_title_keywords: ["intern", "part-time"], must_include_any: ["golang"], jd_min_chars: 50 },
  });
  test("excludes blacklisted title keywords (case-insensitive)", () => {
    expect(prefilter(fakePosting({ title: "Summer INTERN" }), cfg).pass).toBe(false);
  });
  test("requires at least one must_include keyword across title+JD", () => {
    expect(prefilter(fakePosting({ jd_text: "x".repeat(100) }), cfg).reason).toContain("must_include");
    expect(prefilter(fakePosting({ title: "Golang Engineer", jd_text: "y".repeat(100) }), cfg).pass).toBe(true);
  });
  test("rejects stub JDs below jd_min_chars", () => {
    const r = prefilter(fakePosting({ title: "golang dev", jd_text: "tiny job" }), cfg);
    expect(r.pass).toBe(false);
    expect(r.reason).toContain("too short");
  });
  test("boundary: exactly min chars passes", () => {
    expect(prefilter(fakePosting({ title: "golang", jd_text: "z".repeat(50) }), cfg).pass).toBe(true);
  });
  test("empty must_include_any = no keyword gate", () => {
    const c2 = testConfig({ filters: { must_include_any: [], exclude_title_keywords: [], jd_min_chars: 1 } });
    expect(prefilter(fakePosting({ jd_text: "hello" }), c2).pass).toBe(true);
  });
});

describe("jobKey / sanitizeCompany / errText", () => {
  test("dedup key normalizes company+title, keeps url exact", () => {
    const a = jobKey({ company: "Acme Corp", title: "Backend Dev", url: "https://x/1" });
    const b = jobKey({ company: "acme corp", title: "BACKEND dev", url: "https://x/1" });
    const c = jobKey({ company: "acme corp", title: "BACKEND dev", url: "https://x/2" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toHaveLength(16);
  });
  test("sanitizeCompany: slashes, spaces, empties, cap at 40", () => {
    expect(sanitizeCompany("Lotus's / Martech!!")).toBe("Lotus-s-Martech");
    expect(sanitizeCompany("   ")).toBe("Unknown");
    expect(sanitizeCompany("x".repeat(100)).length).toBe(40);
  });
  test("errText survives non-Error throws", () => {
    expect(errText("plain string")).toBe("plain string");
    expect(errText(new Error("boom"))).toBe("boom");
  });
});

describe("profile gate & taxonomy", () => {
  const complete = ["resume.yml", "Somchai-Positioning.md", "Somchai-Stories.md", "Somchai.md"];
  test("complete profile passes", () => {
    expect(checkProfile(complete).ok).toBe(true);
  });
  test("each missing artifact is named", () => {
    expect(checkProfile([]).missing).toEqual([
      "resume.yml", "<firstname>-Positioning.md", "<firstname>-Stories.md", "<firstname>.md (master fact vault)",
    ]);
  });
  test("_-prefixed dirs are never part of a live profile", () => {
    expect(checkProfile(["_template", "_example"]).missing.length).toBe(4);
    expect(factVaultFiles(["_example/Somchai.md", "Somchai.md"])).toEqual(["Somchai.md"]);
  });
  test("fact vault = plain .md (not Positioning/Stories)", () => {
    expect(factVaultFiles(complete)).toEqual(["Somchai.md"]);
  });
});

describe("validateConfig (fail loud at load, not crash mid-run)", () => {
  test("a valid config has no problems", () => {
    const YAML = require("yaml");
    const raw = YAML.parse(require("node:fs").readFileSync("config.yml", "utf-8"));
    const { problems } = validateConfig(raw);
    expect(problems).toEqual([]);
  });
  test("missing numeric bound is caught", () => {
    const c = testConfig() as any; delete c.caps.model_budget_tokens_per_run;
    const { problems } = validateConfig(c);
    expect(problems.some(p => p.includes("caps.model_budget_tokens_per_run"))).toBe(true);
  });
  test("NaN/infinite budget is caught", () => {
    const c = testConfig(); (c.caps as any).model_budget_tokens_per_run = Infinity;
    expect(validateConfig(c).problems.some(p => p.includes("model_budget"))).toBe(true);
  });
  test("typo'd source name is caught at load", () => {
    const c = testConfig(); (c.sources as string[]).push("webserch");
    expect(validateConfig(c).problems.some(p => p.includes("webserch"))).toBe(true);
  });
  test("inverted score bands are caught", () => {
    const c = testConfig({ screening: { score_review_min: 8, score_tailor_min: 6 } });
    expect(validateConfig(c).problems.some(p => p.includes("mid-band is empty"))).toBe(true);
  });
  test("path traversal in paths is caught", () => {
    const c = testConfig(); (c.paths as any).state = "../elsewhere";
    expect(validateConfig(c).problems.some(p => p.includes("paths.state"))).toBe(true);
  });
  test("optional new keys backfill to defaults", () => {
    const raw = JSON.parse(JSON.stringify(testConfig()));
    delete (raw.filters as any).jd_min_chars; delete (raw.caps as any).wall_clock_minutes;
    const { config, problems } = validateConfig(raw);
    expect(problems).toEqual([]);
    expect(config.filters.jd_min_chars).toBe(200);
    expect(config.caps.wall_clock_minutes).toBe(30);
  });
});

describe("stage-output validators (the maker never defines its own shape)", () => {
  test("screen: plain, fenced, and prose-wrapped JSON all parse", () => {
    const body = '{"score":8,"matched":["go"],"gaps":[],"verdict":"fit"}';
    for (const t of [body, "```json\n" + body + "\n```", `thinking...\n${body}\nend`]) {
      expect(parseScreen(t).score).toBe(8);
    }
  });
  test("screen: no JSON / bad score / missing verdict all throw", () => {
    expect(() => parseScreen("no json here")).toThrow(StageOutputError);
    expect(() => parseScreen('{"verdict":"v"}')).toThrow(/score/);
    expect(() => parseScreen('{"score":"eight","verdict":"v"}')).toThrow(/score/);
    expect(() => parseScreen('{"score":9}')).toThrow(/verdict/);
  });
  test("screen: score clamped to 0-10 and rounded", () => {
    expect(parseScreen('{"score":14.6,"verdict":"v"}').score).toBe(10);
    expect(parseScreen('{"score":-3,"verdict":"v"}').score).toBe(0);
  });
  test("tailor: resume_yaml must contain content:", () => {
    expect(() => parseTailor('{"resume_yaml":"basics:\\n  name: x"}')).toThrow(/resume_yaml/);
    expect(parseTailor('{"resume_yaml":"content:\\n  a: 1"}').resume_yaml).toContain("content:");
  });
  test("honesty: pass:true with unverifiable claims fails CLOSED", () => {
    const r = parseHonesty('{"pass":true,"unverifiable":[{"claim":"led 20-engineer org","reason":"not in vault"}]}');
    expect(r.pass).toBe(false);
    expect(r.unverifiable).toHaveLength(1);
  });
  test("honesty: missing pass boolean throws (never defaults to pass)", () => {
    expect(() => parseHonesty('{"claims_checked":5}')).toThrow(/pass/);
  });
});

describe("report renderers (pure)", () => {
  const cfg = testConfig();
  test("matchReport includes score, gaps, uncovered keywords", () => {
    const md = matchReport(
      fakePosting({ title: "T", company: "C", url: "u" }),
      { score: 8, matched: ["go"], gaps: ["kafka"], verdict: "fit" },
      { resume_yaml: "content:", selections: ["s1"], uncovered_keywords: ["kafka"], headline: "h" },
      cfg, { pages: 2, now: "2026-09-17T00:00:00Z" },
    );
    expect(md).toContain("8/10");
    expect(md).toContain("- kafka");
    expect(md).toContain("pages: 2");
  });
  test("runSummary flags escalations for the human", () => {
    const run = { run_id: "r1", trigger: "manual", started_at: "a", finished_at: "b",
      found: 5, new: 2, screened: 2, tailored: 0, rejected: 1, escalated: 1, tokens_used: 500, outcome: "ok" as const };
    expect(runSummary(run, cfg)).toContain("need you");
    expect(runSummary({ ...run, escalated: 0 }, cfg)).not.toContain("need you");
  });
});
