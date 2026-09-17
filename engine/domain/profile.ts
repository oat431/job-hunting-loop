// engine/domain/profile.ts — onboarding gate & profile-file taxonomy, pure over
// a list of filenames. The adapter supplies the readdir; the rule lives here.
// (This predicate was previously duplicated in three places — one home now.)

export const POSITIONING_SUFFIX = "-Positioning.md";
export const STORIES_SUFFIX = "-Stories.md";

/** Files starting with "_" (_template, _example) are never part of a live profile. */
export function profileFiles(files: string[]): string[] {
  return files.filter(f => !f.startsWith("_"));
}

/** The master fact vault = a plain .md that is neither Positioning nor Stories. */
export function factVaultFiles(files: string[]): string[] {
  return profileFiles(files).filter(
    f => f.endsWith(".md") && !f.endsWith(POSITIONING_SUFFIX) && !f.endsWith(STORIES_SUFFIX),
  );
}

export function firstMatching(files: string[], suffix: string, exclude?: string[]): string | undefined {
  return profileFiles(files).find(f => f.endsWith(suffix) && !(exclude ?? []).includes(f));
}

export interface GateReport { ok: boolean; missing: string[] }

export function checkProfile(files: string[]): GateReport {
  const missing: string[] = [];
  const visible = profileFiles(files);
  if (!visible.includes("resume.yml")) missing.push("resume.yml");
  if (!visible.some(f => f.endsWith(POSITIONING_SUFFIX))) missing.push("<firstname>-Positioning.md");
  if (!visible.some(f => f.endsWith(STORIES_SUFFIX))) missing.push("<firstname>-Stories.md");
  if (factVaultFiles(files).length === 0) missing.push("<firstname>.md (master fact vault)");
  return { ok: missing.length === 0, missing };
}
