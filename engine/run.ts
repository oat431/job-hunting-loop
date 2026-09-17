// engine/run.ts — composition root + CLI. The ONLY file that knows concrete
// adapters exist; everything the pipeline touches arrives through ports
// (engine/ports.ts). This is what makes engine/app/* testable with fakes.
//
// Modes: --check-profile | --seed-test | --jd <file> | (default) full run
// The scheduler (cron / Task Scheduler / Hermes cronjob) invokes this at cadence_hours.
// Exits are designed: done · queued-for-human · nothing-new · budget-exhausted · disabled · error.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { errText } from "./domain/paths.ts";
import { checkProfile } from "./domain/profile.ts";
import type { Config, RunRecord } from "./domain/types.ts";
import { Budget, createLlmGateway } from "./adapters/llm.ts";
import { createJobStore, createReviewQueue } from "./adapters/state.ts";
import { createProfileStore, createPromptReader, loadConfig } from "./adapters/profile.ts";
import { createTexToolchain, createTargetPublisher } from "./adapters/build.ts";
import { getSources, setSourcesRoot } from "./adapters/sources.ts";
import { honestyCheck, type StageDeps } from "./app/stages.ts";
import { runLoop, type LoopDeps } from "./app/loop.ts";
import { runSummary } from "./app/report.ts";
import type { TraceSink } from "./ports.ts";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  const has = (f: string) => args.includes(f);

  // load + validate config BEFORE any spending (fail loud, one place)
  let cfg: Config;
  try {
    cfg = loadConfig(ROOT);
  } catch (e) {
    console.log(`🚫 ${errText(e)}`);
    return 2;
  }

  const stateDir = join(ROOT, cfg.paths.state);
  const profileDir = join(ROOT, cfg.paths.profile);
  mkdirSync(stateDir, { recursive: true });

  // ── mode dispatch ──────────────────────────────────────────────────────
  if (has("--check-profile")) return gateReport(profileDir);
  if (has("--seed-test")) return seedTest(cfg, profileDir);
  const jdIdx = args.indexOf("--jd");
  if (jdIdx >= 0 && args[jdIdx + 1]) return singleJdRun(cfg, profileDir, stateDir, args[jdIdx + 1]);
  const run = await fullRun(cfg, profileDir, stateDir, has("--scheduled") ? "scheduled" : "manual");
  return run.outcome === "error" ? 1 : 0;
}

// ── wiring (composition root: ports ← adapters, once) ────────────────────

function makeDeps(cfg: Config, profileDir: string, stateDir: string): LoopDeps {
  const budget = new Budget(cfg.caps.model_budget_tokens_per_run);
  const trace: TraceSink = {
    writeRunSummary(run: RunRecord) { writeFileSync(join(stateDir, "last-run.md"), runSummary(run, cfg)); },
  };
  return {
    cfg,
    gateway: createLlmGateway({ budget }),
    store: createJobStore(stateDir),
    queue: createReviewQueue(stateDir),
    trace,
    profile: createProfileStore(profileDir),
    sources: getSources(cfg),
    toolchain: createTexToolchain({ root: ROOT, cfg }),
    publisher: createTargetPublisher(),
    prompts: createPromptReader(join(ROOT, "engine/prompts")),
    targetsRoot: join(ROOT, cfg.paths.targets),
    buildRoot: join(ROOT, cfg.paths.build),
  };
}

async function fullRun(cfg: Config, profileDir: string, stateDir: string, trigger: string): Promise<RunRecord> {
  setSourcesRoot(ROOT);
  try {
    return await runLoop(makeDeps(cfg, profileDir, stateDir), trigger);
  } catch (e) {
    // the orchestrator funnels every per-posting error itself; anything reaching
    // here is a run-level failure (bad config paths at I/O time, etc.) — trace it.
    console.log(`💥 run crashed: ${errText(e)}`);
    try {
      createJobStore(stateDir).appendRun({
        run_id: `run-${Date.now().toString(36)}`, trigger, started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(), found: 0, new: 0, screened: 0, tailored: 0,
        rejected: 0, escalated: 0, tokens_used: 0, outcome: "error", error: errText(e),
      });
    } catch { /* trace best-effort */ }
    return { run_id: "crashed", trigger, started_at: "", found: 0, new: 0, screened: 0, tailored: 0, rejected: 0, escalated: 0, tokens_used: 0, outcome: "error", error: errText(e) };
  }
}

// ── onboarding gate ──────────────────────────────────────────────────────

function gateReport(profileDir: string): number {
  const g = checkProfile(existsSync(profileDir) ? readdirSync(profileDir) : []);
  if (g.ok) {
    console.log("✅ profile complete — the loop may run.");
  } else {
    console.log("🚫 ONBOARDING GATE: the loop refuses to start. Missing in profile/:");
    for (const m of g.missing) console.log(`   - ${m}`);
    console.log("\nSee README §Onboarding — bring your own story before starting the loop.");
  }
  return g.ok ? 0 : 1;
}

// ── --jd mode: one JD file in → one tailored resume out (Phase 1 harness) ─

async function singleJdRun(cfg: Config, profileDir: string, stateDir: string, jdPath: string): Promise<number> {
  const g = checkProfile(readdirSync(profileDir));
  if (!g.ok) { console.log(`🚫 onboarding gate: missing ${g.missing.join(", ")}`); return 1; }
  const raw = readFileSync(jdPath, "utf-8");
  // drop the JD into the inbox (frontmatter = metadata) and run the normal pipeline once.
  // Strip the source file's own frontmatter so it isn't double-wrapped into jd_text.
  const inboxDir = join(ROOT, cfg.paths.inbox);
  mkdirSync(inboxDir, { recursive: true });
  const base = jdPath.replace(/^.*[\\/]/, "").replace(/\.md$/, "");
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const srcMeta: Record<string, string> = {};
  if (fm) for (const line of fm[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) srcMeta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  const body = fm ? raw.slice(fm[0].length) : raw;
  const title = srcMeta.title ?? base;
  const company = srcMeta.company ?? "ManualJD";
  writeFileSync(join(inboxDir, `${base}.md`), `---\ntitle: ${title}\ncompany: ${company}\nurl: file://${jdPath.replace(/\\/g, "/")}\n---\n${body}`);
  const run = await fullRun(cfg, profileDir, stateDir, "jd-file");
  return run.outcome === "error" ? 1 : 0;
}

// ── --seed-test: prove the honesty checker catches a fabrication ─────────

export function poisonResume(masterResume: string): { poisoned: string; injected: string[] } {
  // Inject into a copy of the master YAML — checker MUST catch both changes.
  // (Old bug: silent no-op replaces made a PASS misleading; now verified.)
  const injected: string[] = [];
  let poisoned = masterResume;
  if (poisoned.includes("keywords:")) {
    poisoned = poisoned.replace("keywords:", "keywords:\n        - Quantum Blockchain AI");
    injected.push("fake skill 'Quantum Blockchain AI'");
  }
  const before = poisoned;
  poisoned = poisoned.replace(/(\d+)%/, (_m, n) => `${parseInt(n, 10) + 7}%`);
  if (poisoned !== before) injected.push("number drift (+7%)");
  return { poisoned, injected };
}

async function seedTest(cfg: Config, profileDir: string): Promise<number> {
  const g = checkProfile(readdirSync(profileDir));
  if (!g.ok) { console.log(`🚫 seed test needs a complete profile: missing ${g.missing.join(", ")}`); return 1; }
  const profile = createProfileStore(profileDir).load();
  const { poisoned, injected } = poisonResume(profile.masterResume);
  if (injected.length === 0) {
    console.log("🚨 FAIL — seed test could inject NOTHING (no 'keywords:' key, no N% figure in resume.yml). A green run here would be meaningless — fix the fixture, not the result.");
    return 1;
  }
  console.log(`🧪 seed test: injected ${injected.join(" + ")} into a copy of resume.yml`);
  const budget = new Budget(cfg.caps.model_budget_tokens_per_run);
  const stages: StageDeps = {
    gateway: createLlmGateway({ budget }),
    prompts: createPromptReader(join(ROOT, "engine/prompts")),
    cfg,
  };
  const check = await honestyCheck(stages, poisoned, profile);
  if (!check.pass && check.unverifiable.length > 0) {
    console.log(`✅ PASS — checker caught ${check.unverifiable.length} fabrication(s):`);
    for (const u of check.unverifiable) console.log(`   - "${u.claim}" — ${u.reason}`);
    console.log(`   tokens: ${budget.spent()}`);
    return 0;
  }
  console.log("🚨 FAIL — checker did NOT catch the seeded fabrication. DO NOT SHIP THE LOOP.");
  return 1;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv);
}
