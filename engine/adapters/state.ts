// engine/adapters/state.ts — JSONL JobStore + ReviewQueue (append-only history).
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JobRecord, ReviewItem, RunRecord } from "../domain/types.ts";
import type { JobStore, ReviewQueue } from "../ports.ts";

function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const out: T[] = [];
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as T); } catch { /* skip corrupt line */ }
  }
  return out;
}

export function createJobStore(stateDir: string): JobStore {
  const jobsFile = join(stateDir, "jobs.jsonl");
  const runsFile = join(stateDir, "runs.jsonl");
  const ensure = () => mkdirSync(stateDir, { recursive: true });
  return {
    readJobs(): Map<string, JobRecord> {
      const m = new Map<string, JobRecord>();
      for (const r of readJsonl<JobRecord>(jobsFile)) m.set(r.hash, r); // last write wins (append-only supersede)
      return m;
    },
    appendJob(rec) { ensure(); appendFileSync(jobsFile, JSON.stringify(rec) + "\n"); },
    appendRun(rec) { ensure(); appendFileSync(runsFile, JSON.stringify(rec) + "\n"); },
  };
}

// ── human-review queue: JSONL is the machine truth; MD is derived on demand ──

export function createReviewQueue(stateDir: string): ReviewQueue {
  const jsonl = join(stateDir, "human-review.jsonl");
  const md = join(stateDir, "human-review.md");
  return {
    append(item) {
      mkdirSync(stateDir, { recursive: true });
      appendFileSync(jsonl, JSON.stringify(item) + "\n");
    },
    render() {
      const items = readJsonl<ReviewItem>(jsonl);
      const body = items.map(entryMd).join("\n");
      writeFileSync(md,
        "# Human Review Queue\n\n" +
        "> The loop escalates here and STOPS. Nothing applies, emails, or uploads without you.\n" +
        "> Derived view — the machine-readable truth is `human-review.jsonl`.\n\n" +
        (body || "_nothing pending_\n"));
    },
  };
}

/** One escalation entry rendered to markdown (pure — snapshot-testable). */
export function entryMd(i: ReviewItem): string {
  let e = `\n## ${i.title} — ${i.company}\n`;
  e += `- **When:** ${i.at} (${i.run_id})\n`;
  e += `- **Why:** ${i.why}\n`;
  e += `- **URL:** ${i.url}\n`;
  if (i.score !== undefined) e += `- **Score:** ${i.score}/10 — ${i.verdict ?? ""}\n`;
  if (i.unverifiable?.length) e += `- **Unverifiable claims:**\n${i.unverifiable.map(u => `  - "${u.claim}" — ${u.reason}`).join("\n")}\n`;
  e += `- **Action:** [ ] review · [ ] fix profile/prompt · [ ] drop\n`;
  return e;
}
