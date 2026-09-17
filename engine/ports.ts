// engine/ports.ts — the seams. The orchestrator and stages depend ONLY on these
// interfaces; every implementation (network, fs, LaTeX, shell) lives behind them.
// This is what makes the pipeline testable with fakes and the budget a property
// of an instance instead of module-level globals.
import type {
  BuildResult, Config, JobPosting, JobRecord, ProfileBundle, ReviewItem, RunRecord,
} from "../domain/types.ts";

/** Model access + per-run token accounting (one instance per run — no globals). */
export interface ModelGateway {
  call(opts: {
    model: string;
    system: string;
    user: string;
    temperature?: number;
    json?: boolean;
    maxTokens?: number;
  }): Promise<{ text: string; tokens_used: number; model: string }>;
  budgetSpent(): number;
  budgetLeft(): number;
}

/** Append-only JSONL job/run state (dedup read + history). */
export interface JobStore {
  readJobs(): Map<string, JobRecord>;
  appendJob(rec: JobRecord): void;
  appendRun(rec: RunRecord): void;
}

/** Human-review queue: JSONL is truth; the MD file is rendered from it. */
export interface ReviewQueue {
  append(item: ReviewItem): void;
  render(): void;
}

/** Where run traces / last-run.md go. */
export interface TraceSink {
  writeRunSummary(run: RunRecord): void;
}

/** Read-only view of profile/ (the frozen anchor — no write methods by design). */
export interface ProfileStore {
  load(): ProfileBundle;
}

/** Invokes the yamlresume/xelatex toolchain for one company slug. */
export interface Toolchain {
  build(opts: { companySlug: string; resumeYaml: string; cfg: Config }): Promise<BuildResult>;
}

/** Publishes build output + match report into targets/{company}_resume/. */
export interface TargetPublisher {
  publish(opts: { targetDir: string; companySlug: string; buildDir: string; yamlContent: string; matchReport: string }): void;
}

/** A pluggable intake source (inbox/, websearch, future boards). */
export interface Source {
  name: string;
  fetch(cfg: Config): Promise<JobPosting[]>;
}

/** Read a versioned prompt file (engine/prompts/*) — injected so tests can stub it. */
export interface PromptReader {
  read(name: string): string;
}
