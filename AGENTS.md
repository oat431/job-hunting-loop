# AGENTS.md — job-hunting-loop engine instructions

> Read by any coding agent working on this repo. The loop's own runtime instructions live in `engine/prompts/*.md` — this file governs agents modifying the ENGINE.

## Role

You are maintaining a **loop-engineering reference implementation**: a scheduled loop that screens job postings against the user's positioning and tailors their resume per job. The product is the machinery — bounds, verified state, maker/checker separation, human gates, frozen anchors — not any single resume.

## Commands

```bash
bun install                 # deps (yaml)
bun run gate                # onboarding-gate check only
bun run loop                # one full run (fetch → … → publish → trace)
bun run jd <path-to-jd.md>  # single-JD harness run (Phase 1 testing)
bun run master-pdf          # build profile/resume.yml → master-resume.pdf (same toolchain as the loop)
bun run seed-test           # MUST pass before shipping: honesty checker catches a seeded fabrication
bun test                    # Tier 1+2 suite — pure functions + orchestrator decisions (no network/keys)
bash engine/build.sh        # same as master-pdf, via bash (delegates to master-build.ts)
```

Build chain requires: `npx yamlresume`, `xelatex` (MiKTeX/TeX Live) on PATH.

## Architecture constraints

- **Layered layout (dependency rule: imports point inward only):** `engine/domain/` (pure types + rules, zero I/O) ← `engine/ports.ts` (interfaces) ← `engine/app/` (orchestrator `loop.ts`, `stages.ts`, `report.ts`) ← `engine/adapters/` (fs/JSONL, LLM HTTP, LaTeX, sources) ← `engine/run.ts` (composition root — the ONLY file allowed to wire concrete adapters). Domain imports nothing below it; app imports domain + ports only; a new layer violation is rejected in review.
- **Nothing is injected through module globals.** LLM budget lives on the `ModelGateway` instance (one per run). Any new capability gets a port + adapter + fake in `tests/fakes.ts` — if a rule can't be tested with a fake, the seam is wrong.
- **The transition table is code:** every per-posting outcome funnels through `dispose()` in `app/loop.ts` — record, escalate, count, in one place. New outcomes extend `Disposition`, never copy-paste a branch.
- **`profile/` is read-only to the engine.** The loop writes ONLY to `targets/`, `loop/state/`, and `build/`. The `ProfileStore` port has no write methods. Any PR giving engine code a write path into `profile/` is rejected — that's the frozen anchor.
- **Model judgment lives in exactly three stages** — screen, tailor, check — each driven by a versioned prompt file in `engine/prompts/`, validated at the stage boundary (`domain/validate.ts`, fail closed). Everything else is deterministic TypeScript. Don't add a fourth model call without a checklist justification ([[loop-engineering]] §3: tool surface is cost surface).
- **Maker/checker separation:** the tailorer never validates its own output; `check.md` runs as an independent pass. Never merge them, even to save tokens. (Pinned by `tests/loop.test.ts` — honesty fail ⇒ zero build calls.)
- **State is JSONL, append-only** (`jobs.jsonl`, `runs.jsonl`, `human-review.jsonl`). Dedup keys off `hash(company|title|url)`; terminal statuses suppress reconsider, `skipped_budget` does not. `human-review.md` is a DERIVED view of the JSONL — edit the render, not the file. Never rewrite history; supersede with a new line.
- **Every exit is designed:** done / queued-for-human / nothing-new / budget-exhausted / disabled / error. Caps enforced in code: screened/run, tailored/run, token budget, wall-clock (`caps.wall_clock_minutes`), build retries. New code paths must land in one of these — no silent continues. Prompt text like "stay under budget" is not a bound.
- **Config is validated at load** (`domain/config.ts` — fail loud with line-level problems, `exit 2`), never `as Config`-cast and never discovered mid-run. Unknown source names throw at assembly.
- **The human gate is permanent.** No feature may auto-apply, auto-email, or auto-upload. `targets/` + `human-review.md` are the loop's terminal outputs, period.
- **Idempotency:** re-running on unchanged sources must produce zero new model calls (dedup) and zero duplicate targets. (Pinned by tests.)

## Red lines

- Never fabricate or "smooth" numbers, dates, employers, or skills anywhere in engine output. The honesty invariant: tailor = select/reorder/re-emphasize from `profile/` ONLY.
- Never weaken `prompts/check.md`. It fails closed on doubt, by design.
- Never commit `.env`, real profiles with personal data (use `profile/_template/` examples), or `loop/state/` from live runs.
- Retry policy: transient errors (429/5xx/network) retry ONCE with backoff inside `adapters/llm.ts`; deterministic errors (4xx, bad YAML, LaTeX failure) escalate to `human-review` — never retry-storm.
- `bun run seed-test` must pass in CI before any release (nightly workflow). A checker that misses a seeded fabrication = the loop doesn't ship. `bun test` must pass on every PR — AGENTS.md rules that lost their test are folklore, not constraints.

## Conventions

- TypeScript on Bun; no framework. Node built-ins for fs/crypto. `yaml` is the only runtime dep — keep it that way.
- Prompts are product: changes to `engine/prompts/*.md` get the same review scrutiny as code, and re-run the seed test.
- Every run leaves a trace: `runs.jsonl` entry + `loop/state/last-run.md` summary + `match-report.md` per tailored job. New features add to the trace, never bypass it.
- Config over code: thresholds, caps, cadence, section order, location line — all in `config.yml`.
