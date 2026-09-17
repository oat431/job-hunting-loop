// tests/fakes.ts — in-memory implementations of every port. These are the whole
// point of the ports layer: the pipeline runs end-to-end with zero network,
// zero filesystem, zero LaTeX.
import type {
  BuildResult, Config, HonestyResult, JobPosting, JobRecord, ProfileBundle,
  ReviewItem, RunRecord, ScreenResult, TailorResult,
} from "../engine/domain/types.ts";
import type {
  JobStore, ModelGateway, ProfileStore, PromptReader, ReviewQueue,
  Source, TargetPublisher, Toolchain, TraceSink,
} from "../engine/ports.ts";

// ── ModelGateway: stage-aware scripted responses; records every request ──
// Responses are keyed by STAGE (system prompt marker), not global call order —
// so multi-posting runs get the right canned answer per stage. Arrays are
// consumed per stage; the last entry repeats.

export interface FakeGatewayOpts {
  screen?: string[] | string;
  tailor?: string[] | string;
  check?: string[] | string;
  /** any system not matching a stage marker (or overrides): returned verbatim */
  responses?: string[];           // legacy: consumed in call order, last repeats
  tokensPerCall?: number;         // default 100
  failAfter?: number;             // throw on call #N+1 onward (0-indexed)
}

export class FakeGateway implements ModelGateway {
  calls: { model: string; system: string; user: string }[] = [];
  private spent = 0;
  private byStage: Record<string, { queue: string[]; last: string }> = {};
  private legacy: string[];
  constructor(private opts: FakeGatewayOpts, private cap = 100_000) {
    this.legacy = opts.responses ?? [];
    for (const k of ["screen", "tailor", "check"] as const) {
      const v = opts[k];
      if (v !== undefined) {
        const q = Array.isArray(v) ? [...v] : [v];
        this.byStage[k] = { queue: q.slice(0, -1), last: q[q.length - 1] };
      }
    }
  }
  private stageOf(system: string): string | null {
    for (const k of Object.keys(this.byStage)) if (system.includes(k)) return k;
    return null;
  }
  async call(o: { model: string; system: string; user: string }) {
    if (this.opts.failAfter !== undefined && this.calls.length >= this.opts.failAfter) {
      throw new Error("fake gateway: scripted failure");
    }
    let text: string;
    const stage = this.stageOf(o.system);
    if (stage) {
      const s = this.byStage[stage];
      text = s.queue.length ? s.queue.shift()! : s.last;
    } else {
      text = this.legacy[Math.min(this.calls.length, Math.max(0, this.legacy.length - 1))] ?? "garbage-not-json";
    }
    this.calls.push(o);
    const tokens = this.opts.tokensPerCall ?? 100;
    this.spent += tokens;
    return { text, tokens_used: tokens, model: o.model };
  }
  budgetSpent() { return this.spent; }
  budgetLeft() { return Math.max(0, this.cap - this.spent); }
}

export const screenJson = (score: number, verdict = "strong fit") =>
  JSON.stringify({ score, matched: ["go", "api design"], gaps: ["kafka"], verdict });
export const tailorJson = (yaml = "basics:\n  name: Test\ncontent:\n  summary:\n    - 'built things'\n") =>
  JSON.stringify({ resume_yaml: yaml, selections: ["Led API redesign — quantified"], uncovered_keywords: ["kafka"], headline: "Backend engineer" });
export const checkJsonPass = () => JSON.stringify({ pass: true, claims_checked: 12, unverifiable: [] });
export const checkJsonFail = (n = 2) => JSON.stringify({
  pass: false, claims_checked: 10,
  unverifiable: Array.from({ length: n }, (_, i) => ({ claim: `fake claim ${i}`, reason: "no source in vault" })),
});

// ── JobStore / ReviewQueue / Trace: recording in-memory ──────────────────

export class MemStore implements JobStore {
  jobs: JobRecord[] = [];
  runs: RunRecord[] = [];
  seen = new Map<string, JobRecord>();
  seed(records: JobRecord[]) { for (const r of records) { this.jobs.push(r); this.seen.set(r.hash, r); } }
  readJobs() { return new Map(this.seen); }
  appendJob(rec: JobRecord) { this.jobs.push(rec); this.seen.set(rec.hash, rec); }
  appendRun(rec: RunRecord) { this.runs.push(rec); }
  byStatus(s: JobRecord["status"]) { return this.jobs.filter(j => j.status === s); }
}

export class MemQueue implements ReviewQueue {
  items: ReviewItem[] = [];
  renderCount = 0;
  append(item: ReviewItem) { this.items.push(item); }
  render() { this.renderCount++; }
}

export class MemTrace implements TraceSink {
  summaries: RunRecord[] = [];
  writeRunSummary(run: RunRecord) { this.summaries.push(run); }
}

// ── ProfileStore / PromptReader ──────────────────────────────────────────

export function memProfile(over: Partial<ProfileBundle> = {}): ProfileStore & { load(): ProfileBundle } {
  const bundle: ProfileBundle = {
    positioning: "# Positioning — senior backend",
    factVault: "# Vault\n- shipped systems",
    masterResume: "basics:\n  name: Sahachan\ncontent:\n  summary:\n    - '3 yrs'",
    ...over,
  };
  return { load: () => bundle };
}

export const memPrompts: PromptReader = {
  read: (name) => `[fake ${name}]`,
};

// ── Source / Toolchain / Publisher ───────────────────────────────────────

export function memSource(postings: JobPosting[], name = "mem"): Source {
  return { name, fetch: async () => postings };
}

export function fakePosting(over: Partial<JobPosting> = {}): JobPosting {
  return {
    hash: over.hash ?? `h-${Math.random().toString(36).slice(2, 8)}`,
    title: "Senior Backend Engineer", company: "Acme Corp", url: "https://x.test/j/1",
    source: "mem", jd_text: "x".repeat(300), found_at: "2026-09-17T00:00:00Z",
    ...over,
  };
}

export class FakeToolchain implements Toolchain {
  calls: string[] = [];
  constructor(public results: BuildResult[] = [{ ok: true, pdf_path: "/x/resume.pdf", pages: 2 }]) {}
  async build(o: { companySlug: string }) {
    this.calls.push(o.companySlug);
    return this.results[Math.min(this.calls.length - 1, this.results.length - 1)];
  }
}

export class MemPublisher implements TargetPublisher {
  published: { targetDir: string; companySlug: string; matchReport: string }[] = [];
  publish(o: { targetDir: string; companySlug: string; buildDir: string; yamlContent: string; matchReport: string }) { this.published.push(o); }
}

// ── Config factory (always a fully-valid object for tests) ───────────────

import type { Config as Cfg } from "../engine/domain/types.ts";

export function testConfig(over: DeepPartial<Cfg> = {}): Cfg {
  const base: Cfg = {
    enabled: true,
    cadence_hours: 2,
    sources: ["inbox"],
    search: { engine: "auto", site: "jobsdb.com", location: "Thailand", queries: ["backend"] },
    filters: { exclude_title_keywords: ["intern"], must_include_any: [], max_results_per_run: 20, jd_min_chars: 200 },
    screening: { score_tailor_min: 7, score_review_min: 5 },
    caps: { postings_screened_per_run: 20, resumes_tailored_per_run: 3, model_budget_tokens_per_run: 100000, build_retries: 1, wall_clock_minutes: 30 },
    build: { max_pages: 2, location_line: "Bangkok", section_order: ["Summary", "Work"] },
    llm: { screen_model: "cheap", work_model: "work", temperature: 0.2 },
    paths: { profile: "profile", state: "state", inbox: "inbox", targets: "targets", build: "build" },
  };
  return { ...base, ...deepMerge(base, over) } as Cfg;
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function deepMerge(base: any, over: any): any {
  const out = { ...base };
  for (const k of Object.keys(over ?? {})) {
    out[k] = typeof over[k] === "object" && over[k] !== null && !Array.isArray(over[k])
      ? deepMerge(base[k] ?? {}, over[k])
      : over[k];
  }
  return out;
}
