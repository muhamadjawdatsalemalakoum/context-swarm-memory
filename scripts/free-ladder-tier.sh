#!/usr/bin/env bash
# Autopilot for ONE free-instrument ladder tier: wait for retrieval -> render
# contexts -> head-to-head on the chosen reader -> capture the full report.
#
# "Free" here means free of the official AMB runner, not free of API cost: the
# Hindsight arm is replayed from Vectorize's own published BEAM artifacts, so
# only the CSM arm has to be produced locally. Both arms are then read and
# judged by ONE model, which is what makes the comparison apples-to-apples.
#
# Every stage is resumable and idempotent, so an interruption costs only the
# in-flight work. The wait loop polls the run's payloads.jsonl rather than
# tracking a PID, so it survives the retrieval process being killed and
# relaunched.
#
#   scripts/free-ladder-tier.sh <tier> <csmRunId> <targetRows> [readerModel] [baseUrl]
#
# Defaults target the Claude sidecar (integrations/claude-agent/server.mjs on
# :8787). Any OpenAI-compatible endpoint that speaks the sidecar's
# /health + /complete contract works via the baseUrl argument.
set -uo pipefail
TIER="$1"; RUN="$2"; TARGET="$3"
MODEL="${4:-claude-sonnet-5}"
BASE_URL="${5:-http://127.0.0.1:8787}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1
P="data/eval/runs/$RUN/payloads.jsonl"
LOG="${CSM_LADDER_LOG:-$REPO/data/eval/ladder-$TIER.log}"

echo "[$(date -u +%H:%M:%SZ)] tier=$TIER run=$RUN target=$TARGET reader=$MODEL waiting for retrieval" | tee -a "$LOG"
while :; do
  n=$(wc -l < "$P" 2>/dev/null || echo 0)
  if [ "$n" -ge "$TARGET" ]; then break; fi
  sleep 60
done
echo "[$(date -u +%H:%M:%SZ)] retrieval complete ($n rows) -> rendering contexts" | tee -a "$LOG"

npx tsx scripts/emit-run-contexts.ts --run "$RUN" --split "$TIER" >> "$LOG" 2>&1
if [ $? -ne 0 ]; then
  echo "[$(date -u +%H:%M:%SZ)] emit-contexts FAILED for $TIER" | tee -a "$LOG"
  exit 1
fi

echo "[$(date -u +%H:%M:%SZ)] head-to-head on $MODEL via $BASE_URL" | tee -a "$LOG"
CSM_AGENT_BASE_URL="$BASE_URL" npx tsx scripts/headtohead-arms.ts \
  --csm "data/eval/runs/$RUN/contexts.json" \
  --hindsight "data/eval/external/hindsight-$TIER.json" \
  --tier "$TIER-free" --model "$MODEL" --jobs 2 >> "$LOG" 2>&1
if [ $? -ne 0 ]; then
  # Without this the report step summarised whatever stale <tier>-free.json
  # already existed for the label (audit 2026-09-05).
  echo "[$(date -u +%H:%M:%SZ)] head-to-head FAILED for $TIER -- not writing a report over stale results" | tee -a "$LOG"
  exit 1
fi

echo "[$(date -u +%H:%M:%SZ)] capturing report" | tee -a "$LOG"
node scripts/free-ladder-report.mjs --tier "$TIER" --csm "$RUN" --h2h "$TIER-free" \
  --out docs/experiments/free-ladder 2>&1 | tee -a "$LOG"
echo "[$(date -u +%H:%M:%SZ)] tier=$TIER DONE" | tee -a "$LOG"
