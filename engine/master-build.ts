// engine/master-build.ts — build the MASTER resume (profile/resume.yml → PDF)
// through the SAME toolchain the loop uses (patchTex, page-count verification).
// This exists so engine/build.sh carries no copy of the patch logic — the old
// inline bash copy drifted from the engine's own rules (no section reorder, no
// CJK disabling) and duplicated fragile template knowledge.
//
// Usage: bun run engine/master-build.ts          → build/_master/resume.pdf
//        also copies to master-resume.pdf at repo root (parity with build.sh).
import { existsSync, copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { errText } from "./domain/paths.ts";
import { createTexToolchain } from "./adapters/build.ts";
import { loadConfig } from "./adapters/profile.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export async function masterBuild(root = ROOT): Promise<number> {
  let cfg;
  try {
    cfg = loadConfig(root);
  } catch (e) {
    console.log(`🚫 ${errText(e)}`);
    return 2;
  }
  const profileYml = join(root, cfg.paths.profile, "resume.yml");
  if (!existsSync(profileYml)) {
    console.log(`ERROR: ${cfg.paths.profile}/resume.yml not found. Complete onboarding first (see README).`);
    return 1;
  }

  const toolchain = createTexToolchain({ root, cfg });
  const built = await toolchain.build({
    companySlug: "_master",
    resumeYaml: readFileSync(profileYml, "utf-8"),
    cfg,
  });
  if (!built.ok) {
    console.log(`ERROR: master build failed: ${built.error}`);
    console.log(`  (inspect ${cfg.paths.build}/_master/resume.log)`);
    return 1;
  }
  const out = join(root, "master-resume.pdf");
  copyFileSync(built.pdf_path!, out);
  console.log(`==> Done: master-resume.pdf (${built.pages ?? "?"} pages)`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = await masterBuild();
}
