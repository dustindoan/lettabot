#!/usr/bin/env bash
# LettaBot v2 — multi-channel AI assistant
# Config: lettabot.yaml
set -euo pipefail
cd "$(dirname "$0")"

export LETTA_API_KEY="${LETTA_API_KEY:-letta-local-dev}"
npm run build && node dist/cli.js server 2>&1 | tee /tmp/lettabot.log
