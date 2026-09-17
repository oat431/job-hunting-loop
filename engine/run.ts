// engine/run.ts — ONE RUN of the job-hunting loop.
// fetch → dedup → pre-filter → screen → tailor → honesty-check → build → verify → publish → trace
// The scheduler (cron / Task Scheduler / Hermes cronjob) invokes this at cadence_hours.
// Exits are designed: done · queued-for-human · nothing-new · budget-exhausted · disabled · error.
import { readFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  ROOT, loadConfig, readJobs, appendJob, appendRun, prefilter, checkProfile,
  sanitizeCompany, jobKey, type Config, type JobPosting, type JobRecord, type RunRecord,
} from "./lib.ts";
import { llmCall, parseJsonLoose, setBudget, budgetSpent, budgetLeft } from "./llm.ts";
import { getSources } from "./sources.ts";
import { buildResume, publishTarget } from "./build.ts";

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);

const cfg = loadConfig();
const stateDir = join(ROOT, cfg.paths.state);
const profileDir = join(ROOT, cfg.paths.profile);
mkdirSync(stateDir, { recursive: true });

// ── mode dispatch ────────────────────────────────────────────────────────
if (has("--check-profile")) { process.exit(gateReport()); }
if (has("--seed-test")) { await seedTest(); process.exit(0); }

const jdFile = args.findIndex(a => a === "--jd") >= 0 ? args[args.findIndex(a => a === "--jd") + 1] : null;
if (jdFile) { await singleJdRun(jdFile); process.exit(0); }

await fullRun(jdFile === null ? (has("--scheduled") ? "scheduled" : "manual") : "jd-file");

// ── onboarding gate ──────────────────────────────────────────────────────
function gateReport(): number {
  const g = checkProfile(profileDir);
  if (g.ok) {
    console.log("✅ profile complete — the loop may run.");
  } else {
    console.log("🚫 ONBOARDING GATE: the loop refuses to start. Missing in profile/:");
    for (const m of g.missing) console.log(`   - ${m}`);
    console.log("\nSee README §Onboarding — bring your own story before starting the loop.");
  }
  return g.ok ? 0 : 1;
}

// ── the full scheduled run ───────────────────────────────────────────────
async function fullRun(trigger: string): Promise<void> {
  const run: RunRecord = {
    run_id: `run-${Date.now().toString(36)}`,
    trigger, started_at: new Date().toISOString(),
    found: 0, new: 0, screened: 0, tailored: 0, rejected: 0, escalated: 0,
    tokens_used: 0, outcome: "ok",
  };
  const finish = (outcome: RunRecord["outcome"], error?: string) => {
    run.outcome = outcome; run.error = error;
    run.finished_at = new Date().toISOString();
    run.tokens_used = budgetSpent();
    appendRun(stateDir, run);
    writeRunSummary(run);
    console.log(`\n── run ${run.run_id}: ${outcome} | found ${run.found}, new ${run.new}, screened ${run.screened}, tailored ${run.tailored}, rejected ${run.rejected}, escalated ${run.escalated}, tokens ${run.tokens_used}`);
  };

  // KILL-SWITCH — checked first thing, every run
  if (!cfg.enabled) { console.log("⏹ loop disabled (config.yml enabled:false) — clean exit."); finish("disabled"); return; }

  // ONBOARDING GATE — deterministic, not a prompt
  const gate = checkProfile(profileDir);
  if (!gate.ok) { finish("error", `onboarding gate: missing ${gate.missing.join(", ")}`); return; }

  setBudget(cfg.caps.model_budget_tokens_per_run);

  // 1. FETCH from all configured sources
  let postings: JobPosting[] = [];
  for (const src of getSources(cfg)) {
    try {
      const got = await src.fetch(cfg);
      console.log(`📥 ${src.name}: ${got.length} posting(s)`);
      postings.push(...got);
    } catch (e) {
      console.log(`⚠️  source ${src.name} failed: ${(e as Error).message} — continuing with other sources`);
    }
  }
  run.found = postings.length;

  // 2. DEDUP against external state — seen postings cost ZERO model calls
  const seen = readJobs(stateDir);
  const fresh = postings.filter(p => !seen.has(p.hash));
  run.new = fresh.length;
  if (fresh.length === 0) { console.log("💤 nothing new — designed exit."); finish("nothing_new"); return; }

  const positioning = readProfileFile("-Positioning.md");
  const factVault = readProfileFile(".md", f => !f.endsWith("-Positioning.md") && !f.endsWith("-Stories.md"));
  const stories = readProfileFile("-Stories.md");
  const masterResume = readFileSync(join(profileDir, "resume.yml"), "utf-8");

  let tailoredCount = 0;
  for (const p of fresh) {
    if (budgetLeft() <= 0) {
      record(p, "skipped_budget", run.run_id);
      run.escalated++;
      console.log("💸 model budget exhausted — remaining postings deferred to next run (state stays consistent).");
      finish("budget_exhausted"); return;
    }
    if (run.screened >= cfg.caps.postings_screened_per_run) { console.log("⏸ screening cap reached — rest deferred."); break; }

    // 3. DETERMINISTIC PRE-FILTER (code — no tokens)
    const pf = prefilter(p, cfg);
    if (!pf.pass) {
      record(p, "rejected_prefilter", run.run_id, undefined, pf.reason);
      run.rejected++;
      console.log(`🚫 pre-filter: "${p.title}" — ${pf.reason}`);
      continue;
    }

    // 4. LLM SCREEN vs the user's Positioning (cheap model)
    let screen: { score: number; matched: string[]; gaps: string[]; verdict: string };
    try {
      screen = await screenPosting(p, positioning);
      run.screened++;
      console.log(`🔎 ${screen.score}/10 "${p.title}" @ ${p.company} — ${screen.verdict}`);
    } catch (e) {
      console.log(`⚠️  screen failed for "${p.title}": ${(e as Error).message} — queued for human`);
      record(p, "queued_for_human", run.run_id);
      enqueueHuman(p, run.run_id, `screen error: ${(e as Error).message}`);
      run.escalated++;
      continue;
    }

    if (screen.score < cfg.screening.score_review_min) {
      record(p, "not_a_fit", run.run_id, screen);
      run.rejected++;
      continue;
    }
    if (screen.score < cfg.screening.score_tailor_min) {
      record(p, "queued_for_human", run.run_id, screen);
      enqueueHuman(p, run.run_id, `mid-band score ${screen.score}: ${screen.verdict}`, screen);
      run.escalated++;
      continue;
    }
    if (tailoredCount >= cfg.caps.resumes_tailored_per_run) {
      record(p, "queued_for_human", run.run_id, screen);
      enqueueHuman(p, run.run_id, `score ${screen.score} but tailoring cap (${cfg.caps.resumes_tailored_per_run}) reached — tailor next run or by hand`, screen);
      run.escalated++;
      continue;
    }

    // 5. TAILOR + 6. HONESTY CHECK + 7. BUILD/VERIFY + 8. PUBLISH
    const companySlug = sanitizeCompany(p.company);
    const targetDir = join(ROOT, cfg.paths.targets, `${companySlug}_resume`);
    try {
      const tailored = await tailorResume(p, screen, masterResume, factVault);
      const check = await honestyCheck(tailored.resume_yaml, factVault, masterResume);
      if (!check.pass) {
        record(p, "queued_for_human", run.run_id, screen);
        enqueueHuman(p, run.run_id, `HONESTY CHECK FAILED — ${check.unverifiable.length} unverifiable claim(s)`, screen, check.unverifiable);
        run.escalated++;
        console.log(`🚨 honesty check failed for "${p.title}" — escalated, NOT built.`);
        continue;
      }

      let built = await buildResume({ companySlug, resumeYaml: tailored.resume_yaml, cfg });
      if (!built.ok && cfg.caps.build_retries > 0) {
        console.log(`🔧 build failed (${built.error?.slice(0, 120)}) — one retry, then escalate`);
        built = await buildResume({ companySlug, resumeYaml: tailored.resume_yaml, cfg });
      }
      if (!built.ok) {
        record(p, "build_failed", run.run_id, screen);
        enqueueHuman(p, run.run_id, `build failed after retry: ${built.error}`, screen);
        run.escalated++;
        continue;
      }

      // publish to targets/{company}_resume/ — terminal state: done-and-verified, human reviews
      publishTarget({
        targetDir, companySlug,
        buildDir: join(ROOT, cfg.paths.build, companySlug),
        yamlContent: tailored.resume_yaml,
        matchReport: matchReport(p, screen, tailored, built.pages),
      });
      record(p, "tailored", run.run_id, screen, undefined, targetDir);
      tailoredCount++; run.tailored++;
      console.log(`✅ tailored: ${targetDir} (${built.pages ?? "?"}p, score ${screen.score})`);
    } catch (e) {
      record(p, "build_failed", run.run_id, screen);
      enqueueHuman(p, run.run_id, `tailor/check/build error: ${(e as Error).message}`, screen);
      run.escalated++;
      console.log(`⚠️  pipeline error for "${p.title}": ${(e as Error).message} — escalated`);
    }
  }

  finish("ok");
}

// ── model stages (prompts are versioned files — judgment lives here, nowhere else) ──

function prompt(name: string): string { return readFileSync(join(ROOT, "engine/prompts", name), "utf-8"); }

async function screenPosting(p: JobPosting, positioning: string) {
  const r = await llmCall({
    model: cfg.llm.screen_model, system: prompt("screen.md"), temperature: 0.1, json: true,
    user: `<positioning>\n${positioning}\n</positioning>\n\n<posting>\ntitle: ${p.title}\ncompany: ${p.company}\nlocation: ${p.location ?? "n/a"}\nurl: ${p.url}\n\n${p.jd_text}\n</posting>`,
  });
  return parseJsonLoose<{ score: number; matched: string[]; gaps: string[]; verdict: string }>(r.text);
}

async function tailorResume(p: JobPosting, screen: unknown, masterResume: string, factVault: string) {
  const r = await llmCall({
    model: cfg.llm.work_model, system: prompt("tailor.md"), temperature: cfg.llm.temperature, json: true,
    user: `<master_resume>\n${masterResume}\n</master_resume>\n\n<fact_vault>\n${factVault}\n</fact_vault>\n\n<jd>\ntitle: ${p.title}\ncompany: ${p.company}\n\n${p.jd_text}\n</jd>\n\n<screen>\n${JSON.stringify(screen)}\n</screen>`,
  });
  const out = parseJsonLoose<{ resume_yaml: string; selections: string[]; uncovered_keywords: string[]; headline: string }>(r.text);
  if (!out.resume_yaml || !out.resume_yaml.includes("content:")) throw new Error("tailor output missing resume_yaml content");
  return out;
}

async function honestyCheck(tailoredYaml: string, factVault: string, masterResume: string) {
  const r = await llmCall({
    model: cfg.llm.work_model, system: prompt("check.md"), temperature: 0, json: true,
    user: `<tailored_resume>\n${tailoredYaml}\n</tailored_resume>\n\n<fact_vault>\n${factVault}\n</fact_vault>\n\n<master_resume>\n${masterResume}\n</master_resume>`,
  });
  return parseJsonLoose<{ pass: boolean; claims_checked: number; unverifiable: { claim: string; reason: string }[] }>(r.text);
}

// ── artifacts & state ────────────────────────────────────────────────────

function record(p: JobPosting, status: JobRecord["status"], runId: string, screen?: { score: number; verdict: string; gaps?: string[] }, reason?: string, targetDir?: string): void {
  appendJob(stateDir, {
    ...p, status, run_id: runId, updated_at: new Date().toISOString(),
    score: screen?.score, screen_verdict: screen?.verdict ?? reason, gaps: screen?.gaps, target_dir: targetDir,
  });
}

function enqueueHuman(p: JobPosting, runId: string, why: string, screen?: { score: number; verdict: string }, unverifiable?: { claim: string; reason: string }[]): void {
  const f = join(stateDir, "human-review.md");
  if (!existsSync(f)) writeFileSync(f, "# Human Review Queue\n\n> The loop escalates here and STOPS. Nothing applies, emails, or uploads without you.\n\n");
  let entry = `\n## ${p.title} — ${p.company}\n- **When:** ${new Date().toISOString()} (${runId})\n- **Why:** ${why}\n- **URL:** ${p.url}\n`;
  if (screen) entry += `- **Score:** ${screen.score}/10 — ${screen.verdict}\n`;
  if (unverifiable?.length) entry += `- **Unverifiable claims:**\n${unverifiable.map(u => `  - "${u.claim}" — ${u.reason}`).join("\n")}\n`;
  entry += `- **Action:** [ ] review · [ ] fix profile/prompt · [ ] drop\n`;
  appendFileSync(f, entry);
}

function matchReport(p: JobPosting, screen: { score: number; matched: string[]; gaps: string[]; verdict: string },
  tailored: { selections: string[]; uncovered_keywords: string[]; headline: string }, pages?: number): string {
  return `# Match Report — ${p.title} @ ${p.company}

- **Score:** ${screen.score}/10 (tailor threshold: ${cfg.screening.score_tailor_min})
- **Screen verdict:** ${screen.verdict}
- **URL:** ${p.url}
- **Generated:** ${new Date().toISOString()} · pages: ${pages ?? "?"}

## Matched positioning requirements
${screen.matched.map(m => `- ${m}`).join("\n") || "- (none listed)"}

## Gaps (JD wants, positioning/JD analysis flagged)
${screen.gaps.map(g => `- ${g}`).join("\n") || "- (none)"}

## Bullets selected for this tailoring (and why)
${tailored.selections.map(s => `- ${s}`).join("\n") || "- (none recorded)"}

## ⚠️ Uncovered JD keywords — NO honest backing in your vault
> Interview prep: know these before you walk in. Never let the loop claim them.
${tailored.uncovered_keywords.map(k => `- ${k}`).join("\n") || "- (fully covered)"}

---
*Honesty check passed before build. Facts trace to profile/ only — the loop may select and re-emphasize, never invent.*
`;
}

function writeRunSummary(run: RunRecord): void {
  const f = join(stateDir, "last-run.md");
  writeFileSync(f, `# Last Run — ${run.run_id}

- **Trigger:** ${run.trigger} · **Outcome:** ${run.outcome}
- **Window:** ${run.started_at} → ${run.finished_at ?? "?"}
- found ${run.found} · new ${run.new} · screened ${run.screened} · tailored ${run.tailored} · rejected ${run.rejected} · escalated ${run.escalated}
- **Tokens:** ${run.tokens_used} / ${cfg.caps.model_budget_tokens_per_run}
${run.error ? `- **Error:** ${run.error}\n` : ""}
${run.escalated > 0 ? `\n👉 **${run.escalated} item(s) need you:** loop/state/human-review.md\n` : ""}
`);
}

function readProfileFile(suffix: string, extra?: (f: string) => boolean): string {
  const files = readdirSync(profileDir).filter(f => !f.startsWith("_"));
  const f = files.find(x => x.endsWith(suffix) && (extra ? extra(x) : true));
  return f ? readFileSync(join(profileDir, f), "utf-8") : "";
}

// ── --jd mode: one JD file in → one tailored resume out (Phase 1 harness) ─
async function singleJdRun(jdPath: string): Promise<void> {
  const gate = checkProfile(profileDir);
  if (!gate.ok) { console.log(`🚫 onboarding gate: missing ${gate.missing.join(", ")}`); process.exitCode = 1; return; }
  const raw = readFileSync(jdPath, "utf-8");
  // drop the JD into the inbox (frontmatter = metadata) and run the normal pipeline once
  const inboxDir = join(ROOT, cfg.paths.inbox);
  mkdirSync(inboxDir, { recursive: true });
  const base = jdPath.replace(/^.*[\\/]/, "").replace(/\.md$/, "");
  writeFileSync(join(inboxDir, `${base}.md`), `---\ntitle: ${base}\ncompany: ManualJD\nurl: file://${jdPath}\n---\n${raw}`);
  await fullRun("jd-file");
}

// ── --seed-test: prove the honesty checker catches a fabrication ─────────
async function seedTest(): Promise<void> {
  const gate = checkProfile(profileDir);
  if (!gate.ok) { console.log(`🚫 seed test needs a complete profile: missing ${gate.missing.join(", ")}`); process.exitCode = 1; return; }
  const factVault = readProfileFile(".md", f => !f.endsWith("-Positioning.md") && !f.endsWith("-Stories.md"));
  const masterResume = readFileSync(join(profileDir, "resume.yml"), "utf-8");
  // inject a fake skill + a number drift into the master's YAML — checker MUST catch both
  const poisoned = masterResume
    .replace("keywords:", "keywords:\n        - Quantum Blockchain AI")
    .replace(/(\d+)%/, (_m, n) => `${parseInt(n, 10) + 7}%`);
  console.log("🧪 seed test: injected fake skill 'Quantum Blockchain AI' + number drift into a copy of resume.yml");
  setBudget(cfg.caps.model_budget_tokens_per_run);
  const check = await honestyCheck(poisoned, factVault, masterResume);
  if (!check.pass && check.unverifiable.length > 0) {
    console.log(`✅ PASS — checker caught ${check.unverifiable.length} fabrication(s):`);
    for (const u of check.unverifiable) console.log(`   - "${u.claim}" — ${u.reason}`);
    console.log(`   tokens: ${budgetSpent()}`);
  } else {
    console.log("🚨 FAIL — checker did NOT catch the seeded fabrication. DO NOT SHIP THE LOOP.");
    process.exitCode = 1;
  }
}
