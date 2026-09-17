#!/bin/bash
# Build the MASTER resume (profile/resume.yml) to PDF — the Phase 0 manual-proof chain.
# Requires: npx (yamlresume), xelatex (MiKTeX/TeX Live) on PATH.
# All logic lives in engine/master-build.ts — the SAME toolchain + patcher the loop
# uses (section reorder, CJK disabling, drift detection, page-count verification).
# No duplicated template knowledge in this file anymore. Output: master-resume.pdf at repo root.
set -e
cd "$(dirname "$0")/.."
bun run engine/master-build.ts
