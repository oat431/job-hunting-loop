// engine/app/loop.ts — the orchestrator: ONE RUN of the job-hunting loop.
// fetch → dedup → pre-filter → screen → tailor → honesty-check → build → verify →
// publish → trace. Pure coordination: it decides WHAT happens when, applies the
// transition table uniformly, and delegates everything else to the ports.
//
// The old fullRun() copy-pasted "record → enqueueHuman → escalated++ → continue"
// six times with drift risk. Here it is once: every stage outcome maps to a
// Disposition, and dispose() is the single funnel that records state, escalates,
// and counts — "every exit is designed" (AGENTS.md) as code, not folklore.
import { errText, sanitizeCompany } from "../domain/paths.ts";
import { prefilter } from "../domain/prefilter.ts";
import type { Config, JobPosting, JobStatus, ReviewItem, RunRecord, ScreenResult } from "../domain/types.ts";
import { isTerminalStatus } from "../domain/types.ts";
import { honestyCheck, screenPosting, tailorResume, type StageDeps } from "./stages.ts";
import { honestyWhy, matchReport } from "./report.ts";
import type {
  JobStore, ModelGateway, ProfileStore, PromptReader, ReviewQueue,
  Source, TargetPublisher, Toolchain, TraceSink,
} from "../ports.ts";

export interface LoopDeps {
  cfg: Config;
  gateway: ModelGateway;
  store: JobStore;
  queue: ReviewQueue;
  trace: TraceSink;
  profile: ProfileStore;
  sources: Source[];
  toolchain: Toolchain;
  publisher: TargetPublisher;
  prompts: PromptReader;
  targetsRoot: string;          // absolute path to targets/
  buildRoot: string;            // absolute path to build/
  now?: () => Date;             // clock (tests)
  log?: (msg: string) => void;  // console line sink (tests)
}

/** A posting's fate — the transition table from AGENTS.md expressed as data. */
export type Disposition =
  | { kind: "reject"; status: Extract<JobStatus, "rejected_prefilter" | "not_a_fit">; note?: string; screen?: ScreenResult }
  | { kind: "escalate"; status: Extract<JobStatus, "queued_for_human" | "build_failed" | "skipped_budget">; why: string; screen?: ScreenResult; unverifiable?: { claim: string; reason: string }[] };

export async function runLoop(deps: LoopDeps, trigger: string): Promise<RunRecord> {
  const { cfg } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((m: string) => console.log(m));
  const stages: StageDeps = { gateway: deps.gateway, prompts: deps.prompts, cfg };

  const run: RunRecord = {
    run_id: `run-${now().getTime().toString(36)}`,
    trigger, started_at: now().toISOString(),
    found: 0, new: 0, screened: 0, tailored: 0, rejected: 0, escalated: 0,
    tokens_used: 0, outcome: "ok",
  };
  const deadline = now().getTime() + cfg.caps.wall_clock_minutes * 60_000;
  let queuedAny = false;

  const finish = (outcome: RunRecord["outcome"], error?: string): RunRecord => {
    run.outcome = outcome; run.error = error;
    run.finished_at = now().toISOString();
    run.tokens_used = deps.gateway.budgetSpent();
    deps.store.appendRun(run);
    deps.trace.writeRunSummary(run);
    if (queuedAny) deps.queue.render();
    log(`\n── run ${run.run_id}: ${outcome} | found ${run.found}, new ${run.new}, screened ${run.screened}, tailored ${run.tailored}, rejected ${run.rejected}, escalated ${run.escalated}, tokens ${run.tokens_used}`);
    return run;
  };

  /** THE funnel: record the job state, escalate if needed, keep counters honest. */
  const dispose = (p: JobPosting, d: Disposition): void => {
    deps.store.appendJob({
      ...p,
      status: d.status,
      run_id: run.run_id,
      updated_at: now().toISOString(),
      score: d.screen?.score,
      screen_verdict: d.screen?.verdict ?? (d.kind === "escalate" ? d.why : "note" in d ? d.note : undefined),
      gaps: d.screen?.gaps,
    });
    if (d.kind === "reject") {
      run.rejected++;
    } else {
      run.escalated++;
      queuedAny = true;
      deps.queue.append({
        at: now().toISOString(), run_id: run.run_id, title: p.title, company: p.company,
        url: p.url, why: d.why, score: d.screen?.score, verdict: d.screen?.verdict,
        unverifiable: d.unverifiable,
      });
    }
  };

  // KILL-SWITCH — checked first thing, every run
  if (!cfg.enabled) { log("⏹ loop disabled (config.yml enabled:false) — clean exit."); return finish("disabled"); }

  // ONBOARDING GATE — deterministic, not a prompt (main.ts runs --check-profile
  // for the detailed report; here we simply refuse to spend anything on a stub)
  const bundle = deps.profile.load();
  if (!bundle.positioning || !bundle.factVault || !bundle.masterResume) {
    return finish("error", "onboarding gate: incomplete profile/ — run: bun run gate");
  }

  // 1. FETCH from all configured sources
  let postings: JobPosting[] = [];
  for (const src of deps.sources) {
    try {
      const got = await src.fetch(cfg);
      log(`📥 ${src.name}: ${got.length} posting(s)`);
      postings.push(...got);
    } catch (e) {
      log(`⚠️  source ${src.name} failed: ${errText(e)} — continuing with other sources`);
    }
  }
  run.found = postings.length;

  // 2. DEDUP against external state — seen postings cost ZERO model calls.
  // Non-terminal records (skipped_budget) do NOT suppress a reconsider.
  const seen = deps.store.readJobs();
  const fresh = postings.filter(p => {
    const prev = seen.get(p.hash);
    return !prev || !isTerminalStatus(prev.status);
  });
  run.new = fresh.length;
  if (fresh.length === 0) { log("💤 nothing new — designed exit."); return finish("nothing_new"); }

  let tailoredCount = 0;
  for (const p of fresh) {
    if (deps.gateway.budgetLeft() <= 0) {
      dispose(p, { kind: "escalate", status: "skipped_budget", why: "model budget exhausted — deferred to next run" });
      log("💸 model budget exhausted — remaining postings deferred to next run (state stays consistent).");
      return finish("budget_exhausted");
    }
    if (now().getTime() > deadline) {
      log("⏱ wall-clock budget reached — remaining postings deferred to next run.");
      return finish("budget_exhausted", "wall-clock deadline reached");
    }
    if (run.screened >= cfg.caps.postings_screened_per_run) { log("⏸ screening cap reached — rest deferred."); break; }

    // 3. DETERMINISTIC PRE-FILTER (code — no tokens)
    const pf = prefilter(p, cfg);
    if (!pf.pass) {
      log(`🚫 pre-filter: "${p.title}" — ${pf.reason}`);
      dispose(p, { kind: "reject", status: "rejected_prefilter", note: pf.reason });
      continue;
    }

    // 4. LLM SCREEN vs the user's Positioning (cheap model)
    let screen: ScreenResult;
    try {
      screen = await screenPosting(stages, p, bundle.positioning);
      run.screened++;
      log(`🔎 ${screen.score}/10 "${p.title}" @ ${p.company} — ${screen.verdict}`);
    } catch (e) {
      log(`⚠️  screen failed for "${p.title}": ${errText(e)} — queued for human`);
      dispose(p, { kind: "escalate", status: "queued_for_human", why: `screen error: ${errText(e)}` });
      continue;
    }

    if (screen.score < cfg.screening.score_review_min) {
      dispose(p, { kind: "reject", status: "not_a_fit", screen });
      continue;
    }
    if (screen.score < cfg.screening.score_tailor_min) {
      dispose(p, { kind: "escalate", status: "queued_for_human", screen,
        why: `mid-band score ${screen.score}: ${screen.verdict}` });
      continue;
    }
    if (tailoredCount >= cfg.caps.resumes_tailored_per_run) {
      dispose(p, { kind: "escalate", status: "queued_for_human", screen,
        why: `score ${screen.score} but tailoring cap (${cfg.caps.resumes_tailored_per_run}) reached — tailor next run or by hand` });
      continue;
    }

    // 5→8. TAILOR → HONESTY CHECK → BUILD/VERIFY → PUBLISH
    const companySlug = sanitizeCompany(p.company);
    const targetDir = `${deps.targetsRoot.replace(/[\\/]+$/, "")}/${companySlug}_resume`;
    try {
      const tailored = await tailorResume(stages, p, screen, bundle);
      const check = await honestyCheck(stages, tailored.resume_yaml, bundle);
      if (!check.pass) {
        log(`🚨 honesty check failed for "${p.title}" — escalated, NOT built.`);
        dispose(p, { kind: "escalate", status: "queued_for_human", screen,
          why: honestyWhy(check),
          unverifiable: check.unverifiable });
        continue;
      }

      let built = await deps.toolchain.build({ companySlug, resumeYaml: tailored.resume_yaml, cfg });
      if (!built.ok && cfg.caps.build_retries > 0) {
        log(`🔧 build failed (${built.error?.slice(0, 120)}) — one retry, then escalate`);
        built = await deps.toolchain.build({ companySlug, resumeYaml: tailored.resume_yaml, cfg });
      }
      if (!built.ok) {
        dispose(p, { kind: "escalate", status: "build_failed", screen, why: `build failed after retry: ${built.error}` });
        continue;
      }

      deps.publisher.publish({
        targetDir, companySlug,
        buildDir: `${deps.buildRoot.replace(/[\\/]+$/, "")}/${companySlug}`,
        yamlContent: tailored.resume_yaml,
        matchReport: matchReport(p, screen, tailored, cfg, { pages: built.pages, now: now().toISOString() }),
      });
      deps.store.appendJob({
        ...p, status: "tailored", run_id: run.run_id, updated_at: now().toISOString(),
        score: screen.score, screen_verdict: screen.verdict, gaps: screen.gaps, target_dir: targetDir,
      });
      tailoredCount++; run.tailored++;
      log(`✅ tailored: ${targetDir} (${built.pages ?? "?"}p, score ${screen.score})`);
    } catch (e) {
      log(`⚠️  pipeline error for "${p.title}": ${errText(e)} — escalated`);
      dispose(p, { kind: "escalate", status: "build_failed", screen, why: `tailor/check/build error: ${errText(e)}` });
    }
  }

  return finish("ok");
}
