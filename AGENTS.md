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
bun run seed-test           # MUST pass before shipping: honesty checker catches a seeded fabrication
bash engine/build.sh        # (reference) standalone build chain check
```

Build chain requires: `npx yamlresume`, `xelatex` (MiKTeX/TeX Live) on PATH.

## Architecture constraints

- **`profile/` is read-only to the engine.** The loop writes ONLY to `targets/`, `loop/state/`, and `build/`. Any PR giving engine code a write path into `profile/` is rejected — that's the frozen anchor.
- **Model judgment lives in exactly three stages** — screen, tailor, check — each driven by a versioned prompt file in `engine/prompts/`. Everything else is deterministic TypeScript. Don't add a fourth model call without a checklist justification ([[loop-engineering]] §3: tool surface is cost surface).
- **Maker/checker separation:** the tailorer never validates its own output; `check.md` runs as an independent pass. Never merge them, even to save tokens.
- **State is JSONL, append-only** (`jobs.jsonl`, `runs.jsonl`). Dedup keys off `hash(company|title|url)`. Never rewrite history; supersede with a new line.
- **Every exit is designed:** done / queued-for-human / nothing-new / budget-exhausted / disabled / error. New code paths must land in one of these — no silent continues.
- **Caps are enforced in code, not prompts:** `config.yml` caps (screened/run, tailored/run, token budget, build retries) are checked in `run.ts`. Prompt text like "stay under budget" is not a bound.
- **The human gate is permanent.** No feature may auto-apply, auto-email, or auto-upload. `targets/` + `human-review.md` are the loop's terminal outputs, period.
- **Idempotency:** re-running on unchanged sources must produce zero new model calls (dedup) and zero duplicate targets.

## Red lines

- Never fabricate or "smooth" numbers, dates, employers, or skills anywhere in engine output. The honesty invariant: tailor = select/reorder/re-emphasize from `profile/` ONLY.
- Never weaken `prompts/check.md`. It fails closed on doubt, by design.
- Never commit `.env`, real profiles with personal data (use `profile/_template/` examples), or `loop/state/` from live runs.
- Retry policy: transient errors retry once with backoff; deterministic errors (bad YAML, LaTeX failure) escalate to `human-review.md` — never retry-storm.
- `bun run seed-test` must pass in CI before any release. A checker that misses a seeded fabrication = the loop doesn't ship.

## Conventions

- TypeScript on Bun; no framework. Node built-ins for fs/crypto. `yaml` is the only runtime dep — keep it that way.
- Prompts are product: changes to `engine/prompts/*.md` get the same review scrutiny as code, and re-run the seed test.
- Every run leaves a trace: `runs.jsonl` entry + `loop/state/last-run.md` summary + `match-report.md` per tailored job. New features add to the trace, never bypass it.
- Config over code: thresholds, caps, cadence, section order, location line — all in `config.yml`.
