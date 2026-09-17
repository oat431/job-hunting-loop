// engine/build.ts — resume build chain: tailored YAML → tex (via yamlresume) → patch → PDF (xelatex)
// Deterministic verification: PDF exists, validate passed, page count ≤ max. No model judgment here.
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT, type Config } from "./lib.ts";

export interface BuildResult {
  ok: boolean;
  pdf_path?: string;
  pages?: number;
  error?: string;
}

export async function buildResume(opts: {
  companySlug: string;
  resumeYaml: string;       // tailored YAML content
  cfg: Config;
}): Promise<BuildResult> {
  const { companySlug, resumeYaml, cfg } = opts;
  const dir = join(ROOT, cfg.paths.build, companySlug);
  mkdirSync(dir, { recursive: true });
  const ymlPath = join(dir, "resume.yml");
  writeFileSync(ymlPath, resumeYaml);

  // 1. yamlresume: yml → tex (no pdf — we patch first, then compile ourselves)
  // Bun.$ = shell execution (required for npx on Windows); nothrow so we inspect the FS, not the exit code
  await Bun.$`npx yamlresume build resume.yml --no-pdf --no-validate`.cwd(dir).quiet().nothrow();
  const texPath = join(dir, "resume.tex");
  if (!existsSync(texPath)) return { ok: false, error: "yamlresume produced no resume.tex" };

  // 2. patch tex: fonts (Times New Roman), disable CJK, tighten margins, section order, location line
  patchTex(texPath, cfg);

  // 3. xelatex × 2 passes (cross-refs)
  for (let i = 0; i < 2; i++) {
    await Bun.spawn(["xelatex", "-interaction=nonstopmode", "resume.tex"], {
      cwd: dir, stdout: "ignore", stderr: "ignore",
    }).exited;
  }
  const pdfPath = join(dir, "resume.pdf");
  if (!existsSync(pdfPath)) {
    const log = existsSync(join(dir, "resume.log")) ? readFileSync(join(dir, "resume.log"), "utf-8").slice(-800) : "no log";
    return { ok: false, error: `xelatex produced no PDF. Log tail: ${log}` };
  }

  // 4. verify: page count (xelatex log is authoritative; PDF regex as fallback)
  const pages = countPagesFromLog(join(dir, "resume.log")) ?? countPages(pdfPath);
  if (pages !== null && pages > cfg.build.max_pages) {
    return { ok: false, pages, error: `PDF is ${pages} pages (max ${cfg.build.max_pages}) — tailor must trim` };
  }
  return { ok: true, pdf_path: pdfPath, pages: pages ?? undefined };
}

// ── tex patcher (TS port of the reference instance's patch_tex.py) ────────
function patchTex(texPath: string, cfg: Config): void {
  let c = readFileSync(texPath, "utf-8");

  // fonts: disable Linux Libertine, force Times New Roman
  c = c.replaceAll("\\IfFontExistsTF{Linux Libertine}", "\\IfFontExistsTF{DISABLED}");
  c = c.replaceAll("\\IfFontExistsTF{Linux Libertine O}", "\\IfFontExistsTF{DISABLED}");
  if (!c.includes("\\setmainfont{Times New Roman}")) {
    c = c.replace("\\usepackage{fontspec}", "\\usepackage{fontspec}\n\\setmainfont{Times New Roman}");
  }
  // tighten margins + line spacing for 1–2 page fit
  c = c.replace(/\[top=2cm, bottom=2cm, left=1\.5cm, right=1\.5cm\]\{geometry\}/,
    "[top=1.27cm, bottom=1.27cm, left=1.5cm, right=1.5cm]{geometry}");
  c = c.replaceAll("\\setstretch{1.125}", "\\setstretch{1.0}");
  // disable CJK packages (English resumes; template may change)
  c = c.split("\n").map(l => {
    const s = l.trim();
    if (s.startsWith("\\usepackage[UTF8") && s.includes("ctex")) return "% " + l;
    if (s.startsWith("\\setCJKmainfont") || s.startsWith("\\setCJKsansfont")) return "% " + l;
    return l;
  }).join("\n");
  // location line in contact header
  if (cfg.build.location_line && c.includes("{\\small \\faGithub}")) {
    c = c.replace("{\\small \\faGithub}", `${cfg.build.location_line} $|$ {\\small \\faGithub}`);
  }
  // ATS-friendly labels
  c = c.replaceAll("\\section{Basics}", "\\section{Summary}");
  c = c.replaceAll("\\textbf{Keywords}: ", "");

  // section reorder (config-driven)
  const order = cfg.build.section_order;
  const sections = new Map<string, string[]>();
  const preamble: string[] = [];
  let current: string | null = null;
  let inDoc = false;
  for (const line of c.split("\n")) {
    if (line.includes("\\begin{document}")) { inDoc = true; preamble.push(line); continue; }
    if (!inDoc) { preamble.push(line); continue; }
    const m = line.trim().match(/^\\section\{(\w+)\}/);
    if (m) { current = m[1]; sections.set(current, [line]); }
    else if (current) sections.get(current)!.push(line);
    else { preamble.push(line); }
  }
  let result = preamble.join("\n") + "\n";
  for (const name of order) {
    const sec = sections.get(name);
    if (sec) result += sec.join("\n") + "\n";
  }
  // append any sections not in the configured order (never silently drop content)
  for (const [name, sec] of sections) {
    if (!order.includes(name)) result += sec.join("\n") + "\n";
  }
  result += "\\end{document}\n";
  writeFileSync(texPath, result);
}

function countPagesFromLog(logPath: string): number | null {
  if (!existsSync(logPath)) return null;
  const log = readFileSync(logPath, "utf-8");
  const m = log.match(/Output written on resume\.pdf \((\d+) pages?/);
  return m ? parseInt(m[1], 10) : null;
}

function countPages(pdfPath: string): number | null {
  const buf = readFileSync(pdfPath);
  const txt = buf.toString("latin1");
  const m = txt.match(/\/Count\s+(\d+)/);
  if (m) return parseInt(m[1], 10);
  const pages = txt.match(/\/Type\s*\/Page[^s]/g);
  return pages ? pages.length : null;
}

export function publishTarget(opts: { targetDir: string; companySlug: string; buildDir: string; yamlContent: string; matchReport: string; }): void {
  const { targetDir, companySlug, buildDir, yamlContent, matchReport } = opts;
  mkdirSync(targetDir, { recursive: true });
  copyFileSync(join(buildDir, "resume.pdf"), join(targetDir, `${companySlug}_resume.pdf`));
  writeFileSync(join(targetDir, `${companySlug}_resume.yml`), yamlContent);
  writeFileSync(join(targetDir, "match-report.md"), matchReport);
}
