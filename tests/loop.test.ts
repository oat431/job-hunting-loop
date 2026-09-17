// tests/loop.test.ts — Tier 2: the orchestrator's DECISIONS, driven entirely by
// fakes (zero network, zero fs, zero LaTeX). Each test pins one AGENTS.md rule:
// maker/checker separation, fail-closed honesty, caps, designed exits, idempotency.
import { describe, expect, test } from "bun:test";
import { runLoop, type LoopDeps } from "../engine/app/loop.ts";
import {
  FakeGateway, FakeToolchain, MemPublisher, MemQueue, MemStore, MemTrace,
  checkJsonFail, checkJsonPass, fakePosting, memProfile, memPrompts, memSource,
  screenJson, tailorJson, testConfig,
} from "./fakes.ts";
import type { JobRecord, JobPosting } from "../engine/domain/types.ts";

import type { FakeGatewayOpts } from "./fakes.ts";

interface HarnessOpts {
  cfg?: LoopDeps["cfg"];
  gatewayOpts?: FakeGatewayOpts;
  postings?: JobPosting[];
  profile?: LoopDeps["profile"];
  sources?: LoopDeps["sources"];
  toolchain?: FakeToolchain;
  now?: () => Date;
}

function harness(over: HarnessOpts = {}) {
  const cfg = over.cfg ?? testConfig();
  // stage-keyed defaults; a test's gatewayOpts overrides only the stage it cares about
  const gateway = new FakeGateway({
    screen: screenJson(9), tailor: tailorJson(), check: checkJsonPass(),
    ...over.gatewayOpts,
  }, cfg.caps.model_budget_tokens_per_run);
  const store = new MemStore();
  const queue = new MemQueue();
  const trace = new MemTrace();
  const toolchain = over.toolchain ?? new FakeToolchain([{ ok: true, pdf_path: "p", pages: 2 }]);
  const publisher = new MemPublisher();
  const logs: string[] = [];
  const deps: LoopDeps = {
    cfg, gateway, store, queue, trace,
    profile: over.profile ?? memProfile(),
    sources: over.sources ?? [memSource(over.postings ?? [fakePosting()])],
    toolchain, publisher,
    prompts: memPrompts,
    targetsRoot: "/t", buildRoot: "/b",
    log: (m) => logs.push(m),
    ...(over.now ? { now: over.now } : {}),
  };
  return { deps, gateway, store, queue, trace, toolchain, publisher, logs };
}

describe("designed exits", () => {
  test("kill-switch: disabled loop touches NOTHING and exits 'disabled'", async () => {
    const h = harness({ cfg: testConfig({ enabled: false }) });
    const run = await runLoop(h.deps, "scheduled");
    expect(run.outcome).toBe("disabled");
    expect(h.gateway.calls).toHaveLength(0);
    expect(h.store.jobs).toHaveLength(0);
    expect(h.trace.summaries).toHaveLength(1); // still traced
  });

  test("onboarding gate: incomplete profile → 'error' before any model spend", async () => {
    const h = harness({ profile: memProfile({ factVault: "" }) });
    const run = await runLoop(h.deps, "manual");
    expect(run.outcome).toBe("error");
    expect(h.gateway.calls).toHaveLength(0);
  });

  test("nothing_new: all postings already terminal → zero model calls", async () => {
    const p = fakePosting({ hash: "seen-1" });
    const h = harness({ postings: [p] });
    h.store.seed([{ ...p, status: "tailored", run_id: "r0", updated_at: "x" } as JobRecord]);
    const run = await runLoop(h.deps, "scheduled");
    expect(run.outcome).toBe("nothing_new");
    expect(h.gateway.calls).toHaveLength(0);
  });

  test("every run lands in runs + last-run trace (trace invariant)", async () => {
    const h = harness();
    const run = await runLoop(h.deps, "manual");
    expect(h.store.runs).toHaveLength(1);
    expect(h.store.runs[0].run_id).toBe(run.run_id);
    expect(h.trace.summaries).toHaveLength(1);
  });

  test("wall-clock deadline → budget_exhausted exit, not a hang", async () => {
    let t = 0;
    const cfg = testConfig(); cfg.caps.wall_clock_minutes = 1;
    // every clock read jumps +90s: by the first per-posting check, we're past the deadline
    const h = harness({ cfg, now: () => new Date(Date.UTC(2026, 8, 17) + (++t) * 90_000) });
    const run = await runLoop(h.deps, "manual");
    expect(run.outcome).toBe("budget_exhausted");
    expect(run.error).toContain("wall-clock");
    expect(h.gateway.calls).toHaveLength(0); // died before spending anything
  });
});

describe("score bands (the transition table)", () => {
  test("score >= tailor_min → full pipeline, status tailored", async () => {
    const h = harness();
    const run = await runLoop(h.deps, "manual");
    expect(run.tailored).toBe(1);
    expect(h.publisher.published).toHaveLength(1);
    expect(h.store.byStatus("tailored")[0].target_dir).toContain("_resume");
  });

  test("score < review_min → not_a_fit, NO tailor call (cheap model is the last call)", async () => {
    const h = harness({ gatewayOpts: { screen: screenJson(3) } });
    const run = await runLoop(h.deps, "manual");
    expect(run.rejected).toBe(1);
    expect(h.store.byStatus("not_a_fit")).toHaveLength(1);
    expect(h.gateway.calls).toHaveLength(1);   // only the screen
    expect(h.toolchain.calls).toHaveLength(0);
  });

  test("mid-band score → queued_for_human with screen detail, NO build", async () => {
    const h = harness({ gatewayOpts: { screen: screenJson(6) } });
    const run = await runLoop(h.deps, "manual");
    expect(run.escalated).toBe(1);
    expect(h.queue.items[0].why).toContain("mid-band score 6");
    expect(h.queue.items[0].score).toBe(6);
    expect(h.toolchain.calls).toHaveLength(0);
  });

  test("screen error (garbage model output) → queued_for_human, never silent", async () => {
    const h = harness({ gatewayOpts: { screen: "this is not json at all" } });
    const run = await runLoop(h.deps, "manual");
    expect(run.escalated).toBe(1);
    expect(h.store.byStatus("queued_for_human")).toHaveLength(1);
    expect(h.queue.items[0].why).toContain("screen error");
  });
});

describe("honesty invariant (the loop's red line)", () => {
  test("honesty FAIL → build is NEVER attempted, claims reach the human queue", async () => {
    const h = harness({ gatewayOpts: { check: checkJsonFail(3) } });
    const run = await runLoop(h.deps, "manual");
    expect(h.toolchain.calls).toHaveLength(0);      // ← the rule, as a test
    expect(h.publisher.published).toHaveLength(0);
    expect(run.escalated).toBe(1);
    expect(h.queue.items[0].unverifiable).toHaveLength(3);
    expect(h.queue.items[0].why).toContain("HONESTY CHECK FAILED");
  });

  test("contradictory pass (pass:true + claims) fails closed → no build", async () => {
    const h = harness({ gatewayOpts: { check:
      '{"pass":true,"claims_checked":5,"unverifiable":[{"claim":"x","reason":"not in vault"}]}' } });
    const run = await runLoop(h.deps, "manual");
    expect(h.toolchain.calls).toHaveLength(0);
    expect(run.escalated).toBe(1);
  });

  test("tailor returns garbage (no content:) → escalate, no build", async () => {
    const h = harness({ gatewayOpts: { tailor: '{"resume_yaml":"basics:\\n  name: x"}' } });
    const run = await runLoop(h.deps, "manual");
    expect(h.store.byStatus("build_failed")).toHaveLength(1);
    expect(h.toolchain.calls).toHaveLength(0);
  });
});

describe("caps & budgets", () => {
  test("token budget exhausted mid-run → skipped_budget, exit designed", async () => {
    const cfg = testConfig(); cfg.caps.model_budget_tokens_per_run = 100; // exactly one call (100 tokens)
    const h = harness({ cfg, postings: [fakePosting({ hash: "a" }), fakePosting({ hash: "b" })],
      gatewayOpts: { screen: screenJson(3) } });
    const run = await runLoop(h.deps, "manual");
    expect(run.outcome).toBe("budget_exhausted");
    expect(h.store.byStatus("skipped_budget")).toHaveLength(1);
    expect(h.store.byStatus("not_a_fit")).toHaveLength(1);
  });

  test("skipped_budget postings are RECONSIDERED next run (not swallowed by dedup)", async () => {
    const p = fakePosting({ hash: "deferred" });
    const h = harness({ postings: [p] });
    h.store.seed([{ ...p, status: "skipped_budget", run_id: "r0", updated_at: "x" } as JobRecord]);
    await runLoop(h.deps, "manual");
    expect(h.gateway.calls.length).toBeGreaterThan(0); // it got another chance
  });

  test("tailoring cap: excess high-score postings queue, cap respected", async () => {
    const cfg = testConfig(); cfg.caps.resumes_tailored_per_run = 1;
    const h = harness({ cfg, postings: [fakePosting({ hash: "a" }), fakePosting({ hash: "b" })] });
    const run = await runLoop(h.deps, "manual");
    expect(run.tailored).toBe(1);
    expect(run.escalated).toBe(1);
    expect(h.queue.items[0].why).toContain("tailoring cap");
    expect(h.toolchain.calls).toHaveLength(1); // only the allowed one was built
  });

  test("screening cap defers the rest WITHOUT marking them", async () => {
    const cfg = testConfig(); cfg.caps.postings_screened_per_run = 1;
    const h = harness({ cfg, postings: [fakePosting({ hash: "a" }), fakePosting({ hash: "b" })],
      gatewayOpts: { screen: screenJson(3) } });
    const run = await runLoop(h.deps, "manual");
    expect(run.screened).toBe(1);
    // posting "b" has NO record at all — it stays fresh for next run
    expect(h.store.jobs.filter(j => j.hash === "b")).toHaveLength(0);
  });
});

describe("maker/checker separation & idempotency", () => {
  test("screen, tailor, check = exactly 3 gateway calls, each with its own prompt", async () => {
    const h = harness();
    await runLoop(h.deps, "manual");
    expect(h.gateway.calls).toHaveLength(3);
    expect(h.gateway.calls[0].system).toBe("[fake screen.md]");
    expect(h.gateway.calls[1].system).toBe("[fake tailor.md]");
    expect(h.gateway.calls[2].system).toBe("[fake check.md]");
    // the CHECKER sees the tailored YAML (independent adjudication, not the same call)
    expect(h.gateway.calls[2].user).toContain("built things");
  });

  test("idempotent rerun: same state → zero model calls, zero publishes", async () => {
    const p = fakePosting({ hash: "stable" });
    const first = harness({ postings: [p] });
    await runLoop(first.deps, "manual");
    expect(first.gateway.calls).toHaveLength(3);
    // replay next run against the state the first run produced
    const second = harness({ postings: [p] });
    second.store.seed(first.store.jobs);
    const run = await runLoop(second.deps, "manual");
    expect(run.outcome).toBe("nothing_new");
    expect(second.gateway.calls).toHaveLength(0);
    expect(second.publisher.published).toHaveLength(0);
  });

  test("build fails → exactly one retry (cfg.build_retries=1), then escalate", async () => {
    const h = harness({ toolchain: new FakeToolchain([{ ok: false, error: "xelatex died" }]) });
    const run = await runLoop(h.deps, "manual");
    expect(h.toolchain.calls).toHaveLength(2);
    expect(run.escalated).toBe(1);
    expect(h.queue.items[0].why).toContain("build failed after retry");
  });
});

describe("source failure isolation", () => {
  test("one source throwing doesn't kill the run; the other still delivers", async () => {
    const ok = memSource([fakePosting()], "good");
    const bad: typeof ok = { name: "bad", fetch: async () => { throw "string throw, not Error"; } };
    const h = harness({ sources: [bad, ok] });
    const run = await runLoop(h.deps, "manual");
    expect(run.found).toBe(1);
    expect(h.logs.join("\n")).toContain("source bad failed");
    expect(run.tailored).toBe(1);
  });
});
