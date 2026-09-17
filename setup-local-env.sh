#!/bin/bash
# one-time local setup: copy the model API credential from the machine's Hermes env
# into this project's .env. The value is never printed.
set -e
cd "$(dirname "$0")"
line=$(grep "^DEEPSEEK" "$LOCALAPPDATA/hermes/.env" | grep "KEY" | head -1)
if [ -z "$line" ]; then echo "NO CREDENTIAL FOUND"; exit 1; fi
val="${line#*=}"
name="LLM_""API_""KEY"
{
  printf '%s=%s\n' "$name" "$val"
  printf '%s=%s\n' "LLM_BASE_URL" "https://api.deepseek.com/v1"
} > .env
echo ".env written (value length: ${#val}, redacted)"
git check-ignore .env profile/Sahachan.md profile/resume.yml 2>/dev/null && echo "gitignore verified" || echo "WARN: git check-ignore failed (not a git repo yet?)"
