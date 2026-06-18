<#
.SYNOPSIS
  Run one BEAM tier through the unmodified public AMB runner against the CSM
  provider, on the frozen CSM pipeline (src/ identical to commit 599dfc0).

.DESCRIPTION
  Reproducible, auditable wrapper for the official BEAM ladder runs. The env
  block matches data/eval/runs/amb-beam-100k-official-v1/RUN_MANIFEST.md exactly
  so every tier is produced by the same configuration. The Gemini API key is
  read from the CSM repo's gitignored .env at runtime and is never written to
  any artifact or printed.

  No changes to AMB scoring, prompts, judge, or gold data. Answer model is
  gemini-3.1-pro-preview and judge is gemini-2.5-flash-lite — the same path as
  the accepted Hindsight artifact.

.EXAMPLE
  pwsh scripts/run-beam-tier.ps1 -Split 10m -Name amb-beam-10m-smoke-v1 -QueryLimit 1
  pwsh scripts/run-beam-tier.ps1 -Split 500k -Name amb-beam-500k-official-v1
#>
param(
  [Parameter(Mandatory = $true)][ValidateSet('100k','500k','1m','10m')][string]$Split,
  [Parameter(Mandatory = $true)][string]$Name,
  [int]$QueryLimit = 0,
  [switch]$SkipIngested
)
$ErrorActionPreference = 'Stop'

$CsmRepo = 'C:\Users\Keonm\OneDrive\Documents\GitHub\context-swarm-memory'
$Amb     = 'E:\benchmarks\amb-t3-data'

$RunDir = Join-Path $CsmRepo "data\eval\runs\$Name"
New-Item -ItemType Directory -Force -Path $RunDir | Out-Null
$OutDir = Join-Path $RunDir 'amb-outputs'

# --- read GEMINI_API_KEY from the CSM .env without printing it ---
$envFile = Join-Path $CsmRepo '.env'
if (-not (Test-Path $envFile)) { throw "No .env at $envFile" }
$keyLine = Get-Content $envFile | Where-Object { $_ -match '^\s*GEMINI_API_KEY=' } | Select-Object -First 1
if (-not $keyLine) { throw 'GEMINI_API_KEY not found in .env' }
$env:GEMINI_API_KEY = ($keyLine -replace '^\s*GEMINI_API_KEY=\s*', '').Trim().Trim('"')
# AMB's google-genai client prefers GOOGLE_API_KEY when both are set. Force it
# to the same funded key from .env so omb (answer + judge) and the CSM warm
# service never pick up a stale/other-account GOOGLE_API_KEY from the machine
# environment. Both vars now point at the single intended billing key.
$env:GOOGLE_API_KEY = $env:GEMINI_API_KEY

# --- frozen CSM pipeline config (matches amb-beam-100k-official-v1) ---
$env:CSM_REPO_DIR            = $CsmRepo
$env:CSM_PROVIDER            = 'gemini'
$env:CSM_MODEL               = 'gemini-3.5-flash'
$env:CSM_GEMINI_MODEL        = 'gemini-3.5-flash'
$env:CSM_AMB_MODEL           = 'gemini-3.5-flash'
$env:CSM_GEMINI_THINKING     = 'low'
$env:CSM_GEMINI_TIMEOUT_MS   = '600000'
$env:CSM_GEMINI_MAX_RETRIES  = '2'
$env:CSM_AMB_MODEL_CONTEXT   = '8192'
$env:CSM_AMB_MAX_OUTPUT_TOKENS = '512'
$env:CSM_AMB_RETURN_K          = '24'
$env:CSM_AMB_SUMMARY_RETURN_K  = '24'
$env:CSM_AMB_REASONING_RETURN_K = '32'
$env:CSM_AMB_NEIGHBOR_WINDOW   = '1'
$env:CSM_PROBE_MODEL           = 'gemini-2.5-flash-lite'
$env:CSM_PARALLEL_PROBES       = '1'
$env:CSM_AMB_TELEMETRY_JSONL   = Join-Path $RunDir 'csm-token-telemetry.jsonl'
$env:CSM_AMB_SERVER_LOG        = Join-Path $RunDir 'csm-server-stderr.log'

# --- AMB answer/judge models (same path as the accepted Hindsight artifact) ---
# AMB contract: *_LLM is the bare provider key (gemini), *_MODEL is the bare
# model id. AMB records the identity as "gemini:<model>" (GeminiLLM.model_id),
# which is what the 100K artifact shows.
$env:OMB_ANSWER_LLM   = 'gemini'
$env:OMB_ANSWER_MODEL = 'gemini-3.1-pro-preview'
$env:OMB_JUDGE_LLM    = 'gemini'
$env:OMB_JUDGE_MODEL  = 'gemini-2.5-flash-lite'

# --- runtime safety ---
$env:PYTHONUTF8   = '1'                          # AMB rich console vs cp1252
$env:NODE_OPTIONS = '--max-old-space-size=8192'  # headroom for large units

$ombArgs = @(
  'run', '--no-sync', 'omb', 'run',
  '--dataset', 'beam', '--split', $Split,
  '--memory', 'csm', '--mode', 'rag',
  '--output-dir', $OutDir, '--name', $Name
)
if ($QueryLimit -gt 0) { $ombArgs += @('--query-limit', "$QueryLimit") }
if ($SkipIngested)     { $ombArgs += '--skip-ingested' }

"[$([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'))] START split=$Split name=$Name limit=$QueryLimit"
Push-Location $Amb
try {
  & uv @ombArgs
  $code = $LASTEXITCODE
} finally {
  Pop-Location
}
"[$([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'))] END   split=$Split name=$Name exit=$code"
exit $code
