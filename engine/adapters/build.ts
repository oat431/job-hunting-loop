// engine/adapters/build.ts — Toolchain implementation: yaml→tex (yamlresume) →
// patch → tex→PDF (xelatex) → verify page count. Deterministic; no model judgment.
//
// The template-surgery rules are DATA (patchTex returns the applied/missing report),
// so a broken anchor against a changed yamlresume template becomes a loud error
// instead of a silent no-op. Previously every replaceAll of a missing string just
// did nothing and the run shipped a mis-styled PDF.
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import type { BuildResult, Config } from "../domain/types.ts";
import type { Toolchain, TargetPublisher } from "../ports.ts";

/** The commands the toolchain needs. Injectable so tests never run real LaTeX. */
export interface TexRunner {
  yamlToTex(opts: { dir: string }): Promise<void>;   // writes resume.tex (or doesn't)
  compilePdf(opts: { dir: string, passes: number }): Promise<void>; // writes resume.pdf
}

export const bunTexRunner: TexRunner = {
  async yamlToTex({ dir }) {
    // Bun.$ shell (works for npx on Windows); nothrow — we inspect the FS, not the exit code
    await Bun.$`npx yamlresume build resume.yml --no-pdf --no-validate`.cwd(dir).quiet().nothrow();
  },
  async compilePdf({ dir, passes }) {
    for (let i = 0; i < passes; i++) {
      await Bun.spawn(["xelatex", "-interaction=nonstopmode", "resume.tex"], {
        cwd: dir, stdout: "ignore", stderr: "ignore",
      }).exited;
    }
  },
};

export interface TexToolchainOpts {
  root: string;
  cfg: Config;
  runner?: TexRunner;
  /** xelatex cross-ref passes; default 2. */
  passes?: number;
}

export function createTexToolchain(opts: TexToolchainOpts): Toolchain {
  const { root, cfg } = opts;
  const runner = opts.runner ?? bunTexRunner;
  const passes = opts.passes ?? 2;

  return {
    async build({ companySlug, resumeYaml }): Promise<BuildResult> {
      const dir = join(root, cfg.paths.build, companySlug);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "resume.yml"), resumeYaml);

      // 1. yaml → tex
      await runner.yamlToTex({ dir });
      const texPath = join(dir, "resume.tex");
      if (!existsSync(texPath)) return { ok: false, error: "yamlresume produced no resume.tex" };

      // 2. patch tex — surface missing required anchors as a build error
      const patch = patchTex(readFileSync(texPath, "utf-8"), cfg);
      if (patch.missing.length > 0) {
        return { ok: false, error: `template drift: patch anchors not found: ${patch.missing.join(", ")}` };
      }
      writeFileSync(texPath, patch.text);

      // 3. xelatex × passes (cross-refs)
      await runner.compilePdf({ dir, passes });
      const pdfPath = join(dir, "resume.pdf");
      if (!existsSync(pdfPath)) {
        const log = existsSync(join(dir, "resume.log")) ? readFileSync(join(dir, "resume.log"), "utf-8").slice(-800) : "no log";
        return { ok: false, error: `xelatex produced no PDF. Log tail: ${log}` };
      }

      // 4. verify page count (xelatex log authoritative; PDF regex fallback)
      const pages = countPagesFromLog(join(dir, "resume.log")) ?? countPages(pdfPath);
      if (pages !== null && pages > cfg.build.max_pages) {
        return { ok: false, pages, error: `PDF is ${pages} pages (max ${cfg.build.max_pages}) — tailor must trim` };
      }
      return { ok: true, pdf_path: pdfPath, pages: pages ?? undefined };
    },
  };
}

// ── tex patcher: pure string transform, returns applied/missing for testability ──

export interface PatchReport { text: string; applied: string[]; missing: string[] }

export function patchTex(source: string, cfg: Config): PatchReport {
  let c = source;
  const applied: string[] = [];
  const missing: string[] = [];

  const need = (label: string, present: boolean) => (present ? applied : missing).push(label);
  const replaceAll = (label: string, find: string, repl: string) => {
    if (!c.includes(find)) { need(label, false); return; }
    c = c.split(find).join(repl); need(label, true);
  };
  const replaceOnce = (label: string, find: string | RegExp, repl: string) => {
    const present = typeof find === "string" ? c.includes(find) : find.test(c);
    if (!present) { need(label, false); return; }
    c = typeof find === "string" ? c.replace(find, repl) : c.replace(find, repl); need(label, true);
  };

  // fonts: disable Linux Libertine, force Times New Roman
  replaceAll("font:libertine", "\\IfFontExistsTF{Linux Libertine}", "\\IfFontExistsTF{DISABLED}");
  replaceAll("font:libertine-o", "\\IfFontExistsTF{Linux Libertine O}", "\\IfFontExistsTF{DISABLED}");
  if (!c.includes("\\setmainfont{Times New Roman}")) {
    replaceOnce("font:times", "\\usepackage{fontspec}", "\\usepackage{fontspec}\n\\setmainfont{Times New Roman}");
  }
  // tighten margins + line spacing for 1–2 page fit
  replaceOnce("geom:margins", /\[top=2cm, bottom=2cm, left=1\.5cm, right=1\.5cm\]\{geometry\}/,
    "[top=1.27cm, bottom=1.27cm, left=1.5cm, right=1.5cm]{geometry}");
  replaceAll("spacing", "\\setstretch{1.125}", "\\setstretch{1.0}");
  // disable CJK packages (English resumes; template may change) — not required
  c = c.split("\n").map(l => {
    const s = l.trim();
    if (s.startsWith("\\usepackage[UTF8") && s.includes("ctex")) return "% " + l;
    if (s.startsWith("\\setCJKmainfont") || s.startsWith("\\setCJKsansfont")) return "% " + l;
    return l;
  }).join("\n");
  // location line in contact header (optional)
  if (cfg.build.location_line) {
    replaceOnce("contact:location", "{\\small \\faGithub}", `${cfg.build.location_line} $|$ {\\small \\faGithub}`);
  }
  // ATS-friendly labels — Basics may legitimately be absent on a re-run; warn only
  replaceAll("label:summary", "\\section{Basics}", "\\section{Summary}");
  replaceAll("label:keywords", "\\textbf{Keywords}: ", "");

  return { text: reorderSections(c, cfg.build.section_order, applied, missing), applied, missing };
}

/** Reorder top-level \\section blocks to the configured order. Never drops content. */
function reorderSections(source: string, order: string[], applied: string[], missing: string[]): string {
  const sections = new Map<string, string[]>();
  const preamble: string[] = [];
  let current: string | null = null;
  let inDoc = false;
  let sawBeginDoc = false;
  for (const line of source.split("\n")) {
    if (line.includes("\\begin{document}")) { inDoc = true; sawBeginDoc = true; preamble.push(line); continue; }
    if (!inDoc) { preamble.push(line); continue; }
    const m = line.trim().match(/^\\section\{(\w+)\}/);
    if (m) { current = m[1]; sections.set(current, [line]); }
    else if (current) sections.get(current)!.push(line);
    else preamble.push(line);
  }
  if (!sawBeginDoc) { missing.push("struct:begin{document}"); return source; }
  for (const n of order) { if (sections.has(n)) applied.push(`section:${n}`); } // absent section is normal (e.g. no Education), not an error

  let result = preamble.join("\n") + "\n";
  for (const name of order) { const sec = sections.get(name); if (sec) result += sec.join("\n") + "\n"; }
  for (const [name, sec] of sections) if (!order.includes(name)) result += sec.join("\n") + "\n"; // keep strays
  result += "\\end{document}\n";
  return result;
}
export function countPagesFromLog(logPath: string): number | null {
  if (!existsSync(logPath)) return null;
  const log = readFileSync(logPath, "utf-8");
  const m = log.match(/Output written on resume\.pdf \((\d+) pages?/);
  return m ? parseInt(m[1], 10) : null;
}

export function countPages(pdfPath: string): number | null {
  const txt = readFileSync(pdfPath).toString("latin1");
  const m = txt.match(/\/Count\s+(\d+)/);
  if (m) return parseInt(m[1], 10);
  const pages = txt.match(/\/Type\s*\/Page[^s]/g);
  return pages ? pages.length : null;
}

// ── target publisher ──

export function createTargetPublisher(): TargetPublisher {
  return {
    publish({ targetDir, companySlug, buildDir, yamlContent, matchReport }) {
      mkdirSync(targetDir, { recursive: true });
      copyFileSync(join(buildDir, "resume.pdf"), join(targetDir, `${companySlug}_resume.pdf`));
      writeFileSync(join(targetDir, `${companySlug}_resume.yml`), yamlContent);
      writeFileSync(join(targetDir, "match-report.md"), matchReport);
    },
  };
}
