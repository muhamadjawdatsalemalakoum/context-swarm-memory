#!/usr/bin/env bash
# Autopilot for ONE free-ladder tier: wait for retrieval -> render contexts ->
# head-to-head on the free reader -> capture the full report.
#
# Every stage is resumable and idempotent, so an interruption costs only the
# in-flight work. The wait loop polls the run's payloads.jsonl rather than
# tracking a PID, so it survives the retrieval process being killed and
# relaunched (which happens routinely on usage limits).
#
#   scripts/free-ladder-tier.sh <tier> <csmRunId> <targetRows> [readerModel]
set -uo pipefail
TIER="$1"; RUN="$2"; TARGET="$3"; MODEL="${4:-stealth/ox-alpha}"
REPO="/c/Users/Keonm/OneDrive/Documents/GitHub/context-swarm-memory"
SCRATCH="/c/Users/Keonm/AppData/Local/Temp/claude/C--Users-Keonm-OneDrive-Documents-GitHub-context-swarm-memory/8de07c06-7b02-45c0-aabe-b3d0b89709aa/scratchpad"
cd "$REPO" || exit 1
P="data/eval/runs/$RUN/payloads.jsonl"
LOG="$SCRATCH/ladder-$TIER.log"

echo "[$(date -u +%H:%M:%SZ)] tier=$TIER run=$RUN target=$TARGET waiting for retrieval" | tee -a "$LOG"
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

echo "[$(date -u +%H:%M:%SZ)] head-to-head on $MODEL" | tee -a "$LOG"
CSM_AGENT_BASE_URL=http://127.0.0.1:8788 npx tsx scripts/headtohead-arms.ts \
  --csm "data/eval/runs/$RUN/contexts.json" \
  --hindsight "data/eval/external/hindsight-$TIER.json" \
  --tier "$TIER-free" --model "$MODEL" --jobs 2 >> "$LOG" 2>&1

echo "[$(date -u +%H:%M:%SZ)] capturing report" | tee -a "$LOG"
node scripts/free-ladder-report.mjs --tier "$TIER" --csm "$RUN" --h2h "$TIER-free" \
  --out docs/experiments/free-ladder 2>&1 | tee -a "$LOG"
echo "[$(date -u +%H:%M:%SZ)] tier=$TIER DONE" | tee -a "$LOG"
