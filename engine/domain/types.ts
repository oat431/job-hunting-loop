// engine/domain/types.ts — the domain vocabulary. Pure types, zero imports, zero I/O.
// Everything below the app layer receives these as plain data; nothing here knows
// about files, networks, or models. (Clean Architecture: the innermost ring.)

export interface Config {
  enabled: boolean;
  cadence_hours: number;
  sources: string[];
  search: { engine: string; site: string; location: string; queries: string[] };
  filters: {
    exclude_title_keywords: string[];
    must_include_any: string[];
    max_results_per_run: number;
    jd_min_chars: number;
  };
  screening: { score_tailor_min: number; score_review_min: number };
  caps: {
    postings_screened_per_run: number;
    resumes_tailored_per_run: number;
    model_budget_tokens_per_run: number;
    build_retries: number;
    wall_clock_minutes: number;
  };
  build: { max_pages: number; location_line: string; section_order: string[] };
  llm: { screen_model: string; work_model: string; temperature: number };
  paths: { profile: string; state: string; inbox: string; targets: string; build: string };
}

export interface JobPosting {
  hash: string;
  title: string;
  company: string;
  url: string;
  location?: string;
  source: string;          // "inbox" | "websearch"
  jd_text: string;         // full job description text
  found_at: string;
}

export type JobStatus =
  | "rejected_prefilter"
  | "not_a_fit"
  | "queued_for_human"
  | "tailored"
  | "build_failed"
  | "skipped_budget";

export interface JobRecord extends JobPosting {
  status: JobStatus;
  score?: number;
  screen_verdict?: string;
  gaps?: string[];
  target_dir?: string;
  run_id: string;
  updated_at: string;
}

export type RunOutcome = "ok" | "nothing_new" | "budget_exhausted" | "error" | "disabled";

/**
 * Terminal = "we have finished with this posting; never spend on it again."
 * skipped_budget is NOT terminal — a deferred posting must be reconsidered next
 * run (the old code recorded it and dedup then silently swallowed it forever).
 */
export function isTerminalStatus(s: JobStatus): boolean {
  return s !== "skipped_budget";
}

export interface RunRecord {
  run_id: string;
  trigger: string;         // "manual" | "scheduled" | "seed-test" | "jd-file"
  started_at: string;
  finished_at?: string;
  found: number;
  new: number;
  screened: number;
  tailored: number;
  rejected: number;
  escalated: number;
  tokens_used: number;
  outcome: RunOutcome;
  error?: string;
}

// ── model-stage I/O shapes (validated at the stage boundary, not trusted) ──

export interface ScreenResult {
  score: number;
  matched: string[];
  gaps: string[];
  verdict: string;
}

export interface TailorResult {
  resume_yaml: string;
  selections: string[];
  uncovered_keywords: string[];
  headline: string;
}

export interface HonestyResult {
  pass: boolean;
  claims_checked: number;
  unverifiable: { claim: string; reason: string }[];
}

// ── profile bundle (what the loop reads; profile/ stays read-only) ──

export interface ProfileBundle {
  positioning: string;
  factVault: string;
  masterResume: string;
}

// ── build result (toolchain output, deterministic) ──

export interface BuildResult {
  ok: boolean;
  pdf_path?: string;
  pages?: number;
  error?: string;
}

// ── human-review queue item (JSONL is the source of truth; MD is derived) ──

export interface ReviewItem {
  at: string;
  run_id: string;
  title: string;
  company: string;
  url: string;
  why: string;
  score?: number;
  verdict?: string;
  unverifiable?: { claim: string; reason: string }[];
}
