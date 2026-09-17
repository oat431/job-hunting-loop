#!/bin/bash
# Build the MASTER resume (profile/resume.yml) to PDF — the Phase 0 manual-proof chain.
# Requires: npx (yamlresume), xelatex (MiKTeX/TeX Live) on PATH.
# The loop itself builds via engine/build.ts (same steps, per-job YAML).
set -e
cd "$(dirname "$0")/.."

PROFILE_YML="profile/resume.yml"
BUILD_DIR="build/_master"

if [ ! -f "$PROFILE_YML" ]; then
  echo "ERROR: $PROFILE_YML not found. Complete onboarding first (see README)."
  exit 1
fi

mkdir -p "$BUILD_DIR"
cp "$PROFILE_YML" "$BUILD_DIR/resume.yml"
cd "$BUILD_DIR"

echo "==> Step 1: Generate resume.tex from YAML..."
npx yamlresume build resume.yml --no-pdf --no-validate 2>&1 || true

echo "==> Step 2: Patch resume.tex (fonts, margins, section order)..."
bun -e '
import { readFileSync, writeFileSync } from "node:fs";
import YAML from "yaml";
const cfg = YAML.parse(readFileSync("../../config.yml", "utf-8"));
let c = readFileSync("resume.tex", "utf-8");
c = c.replaceAll("\\\\IfFontExistsTF{Linux Libertine}", "\\\\IfFontExistsTF{DISABLED}");
c = c.replaceAll("\\\\IfFontExistsTF{Linux Libertine O}", "\\\\IfFontExistsTF{DISABLED}");
if (!c.includes("\\\\setmainfont{Times New Roman}")) c = c.replace("\\\\usepackage{fontspec}", "\\\\usepackage{fontspec}\n\\\\setmainfont{Times New Roman}");
c = c.replace(/\[top=2cm, bottom=2cm, left=1\.5cm, right=1\.5cm\]\{geometry\}/, "[top=1.27cm, bottom=1.27cm, left=1.5cm, right=1.5cm]{geometry}");
c = c.replaceAll("\\\\setstretch{1.125}", "\\\\setstretch{1.0}");
c = c.replaceAll("\\\\section{Basics}", "\\\\section{Summary}");
c = c.replaceAll("\\\\textbf{Keywords}: ", "");
if (cfg.build.location_line && c.includes("{\\\\small \\\\faGithub}")) c = c.replace("{\\\\small \\\\faGithub}", cfg.build.location_line + " $|$ {\\\\small \\\\faGithub}");
writeFileSync("resume.tex", c);
console.log("Patched: fonts, margins, labels, location.");
'

echo "==> Step 3: Compile PDF with xelatex (2 passes)..."
xelatex -interaction=nonstopmode resume.tex > /dev/null 2>&1 || true
xelatex -interaction=nonstopmode resume.tex > /dev/null 2>&1 || true

if [ -f resume.pdf ]; then
  cp resume.pdf ../../master-resume.pdf
  echo "==> Done: master-resume.pdf ($(grep -oP 'Output written.*\(\K\d+' resume.log | head -1) pages)"
else
  echo "ERROR: PDF not generated. Check $BUILD_DIR/resume.log"
  exit 1
fi
