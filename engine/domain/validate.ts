// engine/domain/validate.ts — structural validation of model-stage outputs.
// The maker (LLM) never gets to define its own shape: every stage result is
// checked at the boundary and the run fails closed (escalates) on garbage.
import type { ScreenResult, TailorResult, HonestyResult } from "./types.ts";

export class StageOutputError extends Error {}

function asObj(text: string, what: string): Record<string, unknown> {
  const cleaned = text.replace(/```(?:json)?/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new StageOutputError(`${what}: no JSON object in model output: ${cleaned.slice(0, 200)}`);
  let parsed: unknown;
  try { parsed = JSON.parse(cleaned.slice(start, end + 1)); }
  catch (e) { throw new StageOutputError(`${what}: invalid JSON: ${(e as Error).message}`); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new StageOutputError(`${what}: expected an object`);
  return parsed as Record<string, unknown>;
}

const strArr = (v: unknown): string[] => Array.isArray(v) ? v.filter(x => typeof x === "string") : [];

/** Screen: { score: 0-10, matched[], gaps[], verdict }. Throws on unusable output. */
export function parseScreen(text: string): ScreenResult {
  const o = asObj(text, "screen");
  const score = typeof o.score === "number" && Number.isFinite(o.score) ? Math.max(0, Math.min(10, Math.round(o.score))) : NaN;
  if (Number.isNaN(score)) throw new StageOutputError(`screen: missing/invalid numeric score (got ${JSON.stringify(o.score)})`);
  const verdict = typeof o.verdict === "string" ? o.verdict : "";
  if (!verdict) throw new StageOutputError("screen: missing verdict string");
  return { score, matched: strArr(o.matched), gaps: strArr(o.gaps), verdict };
}

/** Tailor: { resume_yaml (must contain "content:"), selections[], uncovered_keywords[], headline }. */
export function parseTailor(text: string): TailorResult {
  const o = asObj(text, "tailor");
  const resume_yaml = typeof o.resume_yaml === "string" ? o.resume_yaml : "";
  if (!resume_yaml.includes("content:")) throw new StageOutputError("tailor output missing resume_yaml content");
  return {
    resume_yaml,
    selections: strArr(o.selections),
    uncovered_keywords: strArr(o.uncovered_keywords),
    headline: typeof o.headline === "string" ? o.headline : "",
  };
}

/** Honesty check: { pass, claims_checked, unverifiable[{claim,reason}] }. Fails closed. */
export function parseHonesty(text: string): HonestyResult {
  const o = asObj(text, "check");
  if (typeof o.pass !== "boolean") throw new StageOutputError(`check: missing boolean pass (got ${JSON.stringify(o.pass)})`);
  const unverifiable = Array.isArray(o.unverifiable)
    ? o.unverifiable
        .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
        .map(x => ({ claim: String(x.claim ?? ""), reason: String(x.reason ?? "") }))
    : [];
  // fail closed: a "pass" that still lists unverifiable claims is a contradiction — trust the claims
  const pass = o.pass && unverifiable.length === 0;
  return { pass, claims_checked: typeof o.claims_checked === "number" ? o.claims_checked : 0, unverifiable };
}
