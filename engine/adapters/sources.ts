// engine/adapters/sources.ts — pluggable job-posting sources (inbox, websearch).
// A source returns raw postings; dedup happens in the orchestrator, never here.
// Unknown source names THROW at assembly time (a typo used to silently disable a
// source, making a starved run look like "nothing new").
import { readdirSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { jobKey } from "../domain/paths.ts";
import type { Config, JobPosting } from "../domain/types.ts";
import type { Source } from "../ports.ts";

// ── inbox source: user pastes JD files into loop/inbox/*.md ──────────────
// Frontmatter (optional): title:, company:, url:, location:
// Body = the job description text. This is the manual/intake path — always works, no network.
export const inboxSource: Source = {
  name: "inbox",
  async fetch(cfg: Config): Promise<JobPosting[]> {
    const dir = join(inboxRoot(), cfg.paths.inbox);
    if (!existsSync(dir)) { mkdirSync(dir, { recursive: true }); return []; }
    const out: JobPosting[] = [];
    for (const f of readdirSync(dir).filter(x => x.endsWith(".md"))) {
      const raw = readFileSync(join(dir, f), "utf-8");
      const { meta, body } = parseFrontmatter(raw);
      const title = meta.title ?? f.replace(/\.md$/, "");
      const company = meta.company ?? "Inbox";
      const url = meta.url ?? `inbox://${f}`;
      out.push({
        hash: jobKey({ company, title, url }),
        title, company, url,
        location: meta.location,
        source: "inbox",
        jd_text: body.trim(),
        found_at: new Date().toISOString(),
      });
    }
    return out;
  },
};

// Root for inbox reads — set once by main via setSourcesRoot (keeps this module
// free of the old engine-relative ROOT hack while staying import-light).
let ROOT_OVERRIDE = ".";
export function setSourcesRoot(root: string): void { ROOT_OVERRIDE = root; }
function inboxRoot(): string { return ROOT_OVERRIDE; }

export function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: m[2] };
}

// ── websearch source: JobsDB via DuckDuckGo HTML or SearXNG ──────────────
// Search-result snippets become stub postings. The LLM screen runs on
// snippet+title; a full-JD fetch can be added per-adapter later.
export const websearchSource: Source = {
  name: "websearch",
  async fetch(cfg: Config): Promise<JobPosting[]> {
    const out: JobPosting[] = [];
    for (const q of cfg.search.queries) {
      const query = `site:${cfg.search.site} ${q} ${cfg.search.location}`;
      const results = cfg.search.engine === "searxng" || process.env.SEARXNG_URL
        ? await searxng(query)
        : await duckduckgo(query);
      for (const r of results.slice(0, cfg.filters.max_results_per_run)) {
        out.push({
          hash: jobKey({ company: r.company, title: r.title, url: r.url }),
          title: r.title, company: r.company, url: r.url,
          source: "websearch",
          jd_text: r.snippet,
          found_at: new Date().toISOString(),
        });
      }
    }
    return out;
  },
};

interface SearchResult { title: string; url: string; snippet: string; company: string; }

async function searxng(query: string): Promise<SearchResult[]> {
  const base = (process.env.SEARXNG_URL ?? "").replace(/\/$/, "");
  if (!base) return [];
  const res = await fetch(`${base}/search?q=${encodeURIComponent(query)}&format=json`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) return [];
  const data = await res.json() as { results?: { title: string; url: string; content?: string }[] };
  return (data.results ?? []).map(r => ({
    title: r.title, url: r.url, snippet: r.content ?? "", company: guessCompany(r.title, r.url),
  }));
}

async function duckduckgo(query: string): Promise<SearchResult[]> {
  // DDG HTML endpoint — no API key. Fragile by nature; the adapter seam isolates the damage.
  const res = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "Mozilla/5.0 (job-hunting-loop)" },
    body: `q=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null);
  if (!res || !res.ok) return [];
  const html = await res.text();
  return parseDdgHtml(html);
}

/** DDG HTML result parse (pure — testable against a saved fixture). */
export function parseDdgHtml(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < 20) {
    const url = decodeURIComponent(m[1].replace(/.*uddg=/, "").replace(/&rut=.*/, ""));
    const title = stripTags(m[2]);
    const snippet = stripTags(m[3]);
    if (!url.startsWith("http")) continue;
    out.push({ title, url, snippet, company: guessCompany(title, url) });
  }
  return out;
}

function stripTags(s: string): string { return s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim(); }

export function guessCompany(title: string, url: string): string {
  // JobsDB titles are usually "Role - Company" / "Role – Company" or "Role at Company"; fall back to domain
  const t = title.split(/\s*[–—|]\s*|\s+at\s+/i).pop()?.trim();
  if (t && t.length > 1 && t.length < 60 && !/\b(engineer|developer|analyst|manager)\b/i.test(t)) return t;
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "Unknown"; }
}

const REGISTRY: Record<string, Source> = { inbox: inboxSource, websearch: websearchSource };

/** Resolve configured source names; THROWS on unknown names (fail loud). */
export function getSources(cfg: Config): Source[] {
  return cfg.sources.map(s => {
    const src = REGISTRY[s];
    if (!src) throw new Error(`unknown source "${s}" in config.yml — known: ${Object.keys(REGISTRY).join(", ")}`);
    return src;
  });
}
