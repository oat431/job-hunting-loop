// engine/lib.ts — config, state, dedup, shared types (deterministic code — no model judgment here)
import { readFileSync, existsSync, mkdirSync, appendFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import YAML from "yaml";

export const ROOT = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");

export interface Config {
  enabled: boolean;
  cadence_hours: number;
  sources: string[];
  search: { engine: string; site: string; location: string; queries: string[] };
  filters: { exclude_title_keywords: string[]; must_include_any: string[]; max_results_per_run: number };
  screening: { score_tailor_min: number; score_review_min: number };
  caps: { postings_screened_per_run: number; resumes_tailored_per_run: number; model_budget_tokens_per_run: number; build_retries: number };
  build: { max_pages: number; location_line: string; section_order: string[] };
  llm: { screen_model: string; work_model: string; temperature: number };
  paths: { profile: string; state: string; inbox: string; targets: string; build: string };
}

export function loadConfig(): Config {
  const cfg = YAML.parse(readFileSync(join(ROOT, "config.yml"), "utf-8"));
  // .env loading (Bun does this automatically; keep explicit for node compat)
  return cfg as Config;
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

export interface JobRecord extends JobPosting {
  status: "rejected_prefilter" | "not_a_fit" | "queued_for_human" | "tailored" | "build_failed" | "skipped_budget";
  score?: number;
  screen_verdict?: string;
  gaps?: string[];
  target_dir?: string;
  run_id: string;
  updated_at: string;
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
  outcome: "ok" | "nothing_new" | "budget_exhausted" | "error" | "disabled";
  error?: string;
}

// ── state (JSONL, external to any context window — survives every run) ──

export function jobKey(p: { company: string; title: string; url: string }): string {
  return createHash("sha256").update(`${p.company.toLowerCase()}|${p.title.toLowerCase()}|${p.url}`).digest("hex").slice(0, 16);
}

export function readJobs(stateDir: string): Map<string, JobRecord> {
  const f = join(stateDir, "jobs.jsonl");
  const m = new Map<string, JobRecord>();
  if (!existsSync(f)) return m;
  for (const line of readFileSync(f, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line) as JobRecord; m.set(r.hash, r); } catch { /* skip corrupt line */ }
  }
  return m;
}

export function appendJob(stateDir: string, rec: JobRecord): void {
  mkdirSync(stateDir, { recursive: true });
  appendFileSync(join(stateDir, "jobs.jsonl"), JSON.stringify(rec) + "\n");
}

export function appendRun(stateDir: string, rec: RunRecord): void {
  mkdirSync(stateDir, { recursive: true });
  appendFileSync(join(stateDir, "runs.jsonl"), JSON.stringify(rec) + "\n");
}

// ── deterministic pre-filter (zero model calls) ──

export function prefilter(p: JobPosting, cfg: Config): { pass: boolean; reason?: string } {
  const title = p.title.toLowerCase();
  for (const kw of cfg.filters.exclude_title_keywords) {
    if (title.includes(kw.toLowerCase())) return { pass: false, reason: `title contains "${kw}"` };
  }
  if (cfg.filters.must_include_any.length > 0) {
    const hay = (p.title + " " + p.jd_text).toLowerCase();
    if (!cfg.filters.must_include_any.some(k => hay.includes(k.toLowerCase()))) {
      return { pass: false, reason: "none of must_include_any keywords present" };
    }
  }
  if (p.jd_text.trim().length < 200) return { pass: false, reason: "JD text too short (<200 chars) — likely a stub" };
  return { pass: true };
}

// ── onboarding gate (the loop refuses to start without a profile) ──

export function checkProfile(profileDir: string): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  const required = ["resume.yml"];
  // firstname-agnostic: at least one *-Positioning.md, one *-Stories.md, and one master fact vault .md
  let files: string[] = [];
  if (existsSync(profileDir)) files = readdirSync(profileDir).filter(f => !f.startsWith("_"));
  for (const r of required) if (!files.includes(r)) missing.push(r);
  if (!files.some(f => f.endsWith("-Positioning.md"))) missing.push("<firstname>-Positioning.md");
  if (!files.some(f => f.endsWith("-Stories.md"))) missing.push("<firstname>-Stories.md");
  const factVault = files.filter(f => f.endsWith(".md") && !f.endsWith("-Positioning.md") && !f.endsWith("-Stories.md"));
  if (factVault.length === 0) missing.push("<firstname>.md (master fact vault)");
  return { ok: missing.length === 0, missing };
}

export function sanitizeCompany(name: string): string {
  return name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "Unknown";
}
