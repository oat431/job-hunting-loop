// engine/app/report.ts — presentation: match report + run summary as PURE string
// functions. The orchestrator calls these; nothing here touches the filesystem,
// so every rendering is snapshot-testable.
import type { Config, HonestyResult, JobPosting, RunRecord, ScreenResult, TailorResult } from "../domain/types.ts";

export function matchReport(
  p: JobPosting,
  screen: ScreenResult,
  tailored: TailorResult,
  cfg: Config,
  opts?: { pages?: number; now?: string },
): string {
  const pages = opts?.pages;
  const now = opts?.now ?? new Date().toISOString();
  return `# Match Report — ${p.title} @ ${p.company}

- **Score:** ${screen.score}/10 (tailor threshold: ${cfg.screening.score_tailor_min})
- **Screen verdict:** ${screen.verdict}
- **URL:** ${p.url}
- **Generated:** ${now} · pages: ${pages ?? "?"}

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

export function runSummary(run: RunRecord, cfg: Config): string {
  return `# Last Run — ${run.run_id}

- **Trigger:** ${run.trigger} · **Outcome:** ${run.outcome}
- **Window:** ${run.started_at} → ${run.finished_at ?? "?"}
- found ${run.found} · new ${run.new} · screened ${run.screened} · tailored ${run.tailored} · rejected ${run.rejected} · escalated ${run.escalated}
- **Tokens:** ${run.tokens_used} / ${cfg.caps.model_budget_tokens_per_run}
${run.error ? `- **Error:** ${run.error}\n` : ""}
${run.escalated > 0 ? `\n👉 **${run.escalated} item(s) need you:** loop/state/human-review.md\n` : ""}
`;
}

/** Human-readable one-liner for why an escalation happened (used by the queue). */
export function escalationWhy(reason: string, screen?: ScreenResult, check?: HonestyResult): string {
  if (check && !check.pass) return `HONESTY CHECK FAILED — ${check.unverifiable.length} unverifiable claim(s)`;
  if (screen && reason === "mid-band") return `mid-band score ${screen.score}: ${screen.verdict}`;
  return reason;
}
