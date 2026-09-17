// engine/domain/paths.ts — pure path/hash helpers shared by adapters. No I/O.
import { createHash } from "node:crypto";

/** Dedup key: hash(company|title|url), case-normalized on company+title. */
export function jobKey(p: { company: string; title: string; url: string }): string {
  return createHash("sha256")
    .update(`${p.company.toLowerCase()}|${p.title.toLowerCase()}|${p.url}`)
    .digest("hex")
    .slice(0, 16);
}

/** Filesystem-safe company slug (used for build/ and targets/ directory names). */
export function sanitizeCompany(name: string): string {
  return name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "Unknown";
}

/** Safe error text: throws aren't always Errors; never crash the trace on one. */
export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
