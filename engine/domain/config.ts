// engine/domain/config.ts — fail-loud config validation.
// config.yml is the loop's convergence clause: every bound must be a real number,
// checked once at load, never assumed at use. `YAML.parse(...) as Config` was the
// old shape — a typo'd key used to surface as a runtime crash mid-run or, worse,
// a silently disabled source.
//
// Hand-rolled validator (no zod): AGENTS.md keeps `yaml` as the only runtime dep.

import type { Config } from "./types.ts";

type Problem = string;

export function validateConfig(raw: unknown): { config: Config; problems: Problem[] } {
  const problems: Problem[] = [];
  if (typeof raw !== "object" || raw === null) {
    return { config: raw as Config, problems: ["config root must be a mapping"] };
  }
  const c = raw as Record<string, any>;

  const bool = (path: string, v: unknown) => {
    if (typeof v !== "boolean") { problems.push(`${path}: expected boolean, got ${typeof v}`); return false; }
    return true;
  };
  const posInt = (path: string, v: unknown, max = 10_000_000) => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > max) {
      problems.push(`${path}: expected a finite number in [0, ${max}], got ${JSON.stringify(v)}`);
      return false;
    }
    return true;
  };
  const intRange = (path: string, v: unknown, lo: number, hi: number) => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) {
      problems.push(`${path}: expected an integer in [${lo}, ${hi}], got ${JSON.stringify(v)}`);
      return false;
    }
    return true;
  };
  const strArr = (path: string, v: unknown) => {
    if (!Array.isArray(v) || v.some(x => typeof x !== "string")) {
      problems.push(`${path}: expected a list of strings, got ${JSON.stringify(v)}`);
      return false;
    }
    return true;
  };
  const nonEmptyStr = (path: string, v: unknown) => {
    if (typeof v !== "string" || v.trim() === "") {
      problems.push(`${path}: expected a non-empty string, got ${JSON.stringify(v)}`);
      return false;
    }
    return true;
  };
  const obj = (path: string, v: unknown): Record<string, any> => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      problems.push(`${path}: expected a mapping`);
      return {};
    }
    return v as Record<string, any>;
  };

  bool("enabled", c.enabled);
  posInt("cadence_hours", c.cadence_hours, 24 * 30);

  strArr("sources", c.sources);
  const KNOWN_SOURCES = ["inbox", "websearch"];
  for (const s of (Array.isArray(c.sources) ? c.sources : [])) {
    if (!KNOWN_SOURCES.includes(s)) problems.push(`sources: unknown source "${s}" — known: ${KNOWN_SOURCES.join(", ")} (a typo silently disables it; fix or remove)`);
  }

  const search = obj("search", c.search);
  nonEmptyStr("search.engine", search.engine);
  nonEmptyStr("search.site", search.site);
  nonEmptyStr("search.location", search.location);
  strArr("search.queries", search.queries);

  const filters = obj("filters", c.filters);
  strArr("filters.exclude_title_keywords", filters.exclude_title_keywords);
  strArr("filters.must_include_any", filters.must_include_any);
  posInt("filters.max_results_per_run", filters.max_results_per_run, 500);
  if (filters.jd_min_chars !== undefined) intRange("filters.jd_min_chars", filters.jd_min_chars, 1, 20000);

  const screening = obj("screening", c.screening);
  const tailorMin = intRange("screening.score_tailor_min", screening.score_tailor_min, 0, 10);
  const reviewMin = intRange("screening.score_review_min", screening.score_review_min, 0, 10);
  if (tailorMin && reviewMin && screening.score_review_min > screening.score_tailor_min) {
    problems.push(`screening: score_review_min (${screening.score_review_min}) must be <= score_tailor_min (${screening.score_tailor_min}) — otherwise the mid-band is empty`);
  }

  const caps = obj("caps", c.caps);
  posInt("caps.postings_screened_per_run", caps.postings_screened_per_run, 1000);
  posInt("caps.resumes_tailored_per_run", caps.resumes_tailored_per_run, 100);
  posInt("caps.model_budget_tokens_per_run", caps.model_budget_tokens_per_run, 100_000_000);
  intRange("caps.build_retries", caps.build_retries ?? 0, 0, 3);
  if (caps.wall_clock_minutes !== undefined) posInt("caps.wall_clock_minutes", caps.wall_clock_minutes, 240);

  const build = obj("build", c.build);
  intRange("build.max_pages", build.max_pages, 1, 10);
  if (build.location_line !== undefined && typeof build.location_line !== "string") {
    problems.push(`build.location_line: expected a string ("" to skip), got ${JSON.stringify(build.location_line)}`);
  }
  strArr("build.section_order", build.section_order);

  const llm = obj("llm", c.llm);
  nonEmptyStr("llm.screen_model", llm.screen_model);
  nonEmptyStr("llm.work_model", llm.work_model);
  if (typeof llm.temperature !== "number" || !Number.isFinite(llm.temperature) || llm.temperature < 0 || llm.temperature > 2) {
    problems.push(`llm.temperature: expected a number in [0, 2], got ${JSON.stringify(llm.temperature)}`);
  }

  const paths = obj("paths", c.paths);
  for (const p of ["profile", "state", "inbox", "targets", "build"] as const) {
    nonEmptyStr(`paths.${p}`, paths[p]);
    if (typeof paths[p] === "string" && (paths[p].startsWith("/") || /^[A-Za-z]:/.test(paths[p]) || paths[p].split(/[\\/]/).includes(".."))) {
      problems.push(`paths.${p}: must be a relative path inside the repo (no absolute paths, no "..")`);
    }
  }

  // Backfill defaults for optional keys added by this refactor, so callers of the
  // validated Config always see a complete object.
  if (filters.jd_min_chars === undefined) filters.jd_min_chars = 200;
  if (caps.wall_clock_minutes === undefined) caps.wall_clock_minutes = 30;
  if (caps.build_retries === undefined) caps.build_retries = 0;

  return { config: c as Config, problems };
}
