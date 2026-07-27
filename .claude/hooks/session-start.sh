#!/bin/bash
# SessionStart hook for Claude Code on the web: install dependencies so `npm test` and
# `npm run build` work from the first turn. The suite is self-contained (fake embeddings,
# temp vaults) — dependencies are the only setup there is.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"
npm install
