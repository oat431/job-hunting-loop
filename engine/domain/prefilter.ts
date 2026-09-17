// engine/domain/prefilter.ts — deterministic intake gate (zero model calls).
// Pure function over posting + config; testable with no filesystem at all.
import type { Config, JobPosting } from "./types.ts";

export function prefilter(p: JobPosting, cfg: Config): { pass: boolean; reason?: string } {
  const title = p.title.toLowerCase();
  for (const kw of cfg.filters.exclude_title_keywords) {
    if (title.includes(kw.toLowerCase())) return { pass: false, reason: `title contains "${kw}"` };
  }
  if (cfg.filters.must_include_any.length > 0) {
    const hay = (p.title + " " + p.jd_text).toLowerCase();
    if (!cfg.filters.must_include_any.some(k => hay.includes(k.toLowerCase()))) {
      return { pass: false, reason: "none of must_include_any keywords present" };
    }
  }
  const minChars = cfg.filters.jd_min_chars ?? 200;
  if (p.jd_text.trim().length < minChars) {
    return { pass: false, reason: `JD text too short (<${minChars} chars) — likely a stub` };
  }
  return { pass: true };
}
