<#
.SYNOPSIS
  Run the full BEAM ladder (100k -> 500k -> 1m -> 10m) resumably and
  self-healingly against the frozen CSM pipeline.

.DESCRIPTION
  Each tier runs through run-beam-tier.ps1 with --skip-ingested, so completed
  units (saved incrementally by the AMB runner per unit) are skipped on every
  re-attempt — only unfinished units cost time/tokens. If a tier exits without
  reaching its full query count (crash, power loss, network blip), it is retried
  up to -MaxAttemptsPerTier times, each attempt resuming from the last saved
  unit. Safe to re-launch at any time after an interruption: it picks up exactly
  where it stopped.

.EXAMPLE
  pwsh scripts/run-beam-ladder.ps1
#>
# -Tag names this ladder attempt (run dirs become amb-beam-<split>-<tag>).
# BLOCKER fix (2026-08-25 pre-flight audit): the tier names were hardcoded to
# the COMPLETED June run dirs, so a re-run would have judged every tier
# "already complete" and done nothing. -SkipTenM holds the 10M tier: upstream
# PR #38 documents the 10M loader as broken (the published 10M results
# measured a 0.27%-loaded corpus) -- run 10M only after that fix merges.
param(
  [int]$MaxAttemptsPerTier = 8,
  [Parameter(Mandatory = $true)][ValidatePattern("^[a-z0-9-]+$")][string]$Tag,
  [switch]$SkipTenM = $true
)
$ErrorActionPreference = 'Continue'

# Keep the machine awake for the duration of the ladder. Repeated idle
# sleep/hibernate was the cause of the overnight + afternoon stalls (the run
# process is frozen/killed when the system sleeps). ES_CONTINUOUS keeps the
# request active for this process's lifetime; it clears when the script exits.
# NOTE: this does NOT survive a true power loss or manual hibernate. For that,
# just re-run this script and it resumes from the last saved unit.
Add-Type -Name PowerGuard -Namespace Win32 -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
# ES_CONTINUOUS(0x80000000)|ES_SYSTEM_REQUIRED(0x1)|ES_DISPLAY_REQUIRED(0x2) = 2147483651.
# Written as a decimal uint32 because the 0x80000003 hex literal overflows
# PowerShell's signed Int32 and fails the UInt32 cast.
$keepAwake = [uint32]2147483651
$prev = [Win32.PowerGuard]::SetThreadExecutionState($keepAwake)
"[$([DateTime]::UtcNow.ToString('HH:mm:ssZ'))] keep-awake guard armed (prev state=$prev; system will not idle-sleep while this runs)"

# Single-instance guard: kill any stale omb / CSM warm-service workers left by a
# previous run (e.g. one that was frozen by sleep then resumed on wake). Without
# this, a relaunch can run concurrently with a resurrected old run, double-billing
# the API and racing the same result files. Targets ONLY the benchmark workers
# (uv/python running omb, node running the warm service) — never PowerShell, so
# this script can't kill itself.
$stale = 0
$me = $PID
# Kill any prior ladder instance first (a frozen-then-resumed zombie that the
# harness/UI can no longer stop) — this is what spawns competing omb workers.
# Excludes this process so the script never kills itself.
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*run-beam-ladder*' -and $_.ProcessId -ne $me } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; $stale++ } catch {} }
Get-CimInstance Win32_Process -Filter "Name='uv.exe' OR Name='python.exe'" | Where-Object { $_.CommandLine -like '*omb*' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; $stale++ } catch {} }
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*amb-csm-server*' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; $stale++ } catch {} }
if ($stale -gt 0) { Start-Sleep -Seconds 3 }
"[$([DateTime]::UtcNow.ToString('HH:mm:ssZ'))] single-instance guard: cleared $stale stale process(es)"

$repo = 'C:\Users\Keonm\OneDrive\Documents\GitHub\context-swarm-memory'
$tierScript = Join-Path $repo 'scripts\run-beam-tier.ps1'

$tiers = @(
  [pscustomobject]@{ Split = '100k'; Name = "amb-beam-100k-$Tag"; Target = 400 },
  [pscustomobject]@{ Split = '500k'; Name = "amb-beam-500k-$Tag"; Target = 700 },
  [pscustomobject]@{ Split = '1m';   Name = "amb-beam-1m-$Tag";   Target = 700 }
)
if (-not $SkipTenM) {
  $tiers += [pscustomobject]@{ Split = '10m'; Name = "amb-beam-10m-$Tag"; Target = 200 }
} else {
  "[$([DateTime]::UtcNow.ToString('HH:mm:ssZ'))] 10M tier HELD (upstream loader broken, PR #38) - pass -SkipTenM:`$false only after the fix merges"
}

function Get-SavedCount {
  param([string]$Name, [string]$Split)
  $p = Join-Path $repo "data\eval\runs\$Name\amb-outputs\beam\$Name\rag\$Split.json"
  if (-not (Test-Path $p)) { return 0 }
  $c = node -e "try{const j=JSON.parse(require('fs').readFileSync(process.argv[1]));process.stdout.write(String((j.results||[]).length))}catch(e){process.stdout.write('0')}" $p
  if ($c -match '^\d+$') { return [int]$c } else { return 0 }
}

foreach ($t in $tiers) {
  $done = Get-SavedCount -Name $t.Name -Split $t.Split
  if ($done -ge $t.Target) {
    "[$([DateTime]::UtcNow.ToString('HH:mm:ssZ'))] TIER $($t.Name): already complete ($done/$($t.Target)) - skipping"
    continue
  }
  for ($a = 1; $a -le $MaxAttemptsPerTier; $a++) {
    "[$([DateTime]::UtcNow.ToString('HH:mm:ssZ'))] ==== TIER $($t.Name) attempt $a/$MaxAttemptsPerTier (saved $done/$($t.Target)) ===="
    try { & $tierScript -Split $t.Split -Name $t.Name -SkipIngested } catch { "  tier attempt threw: $_" }
    $done = Get-SavedCount -Name $t.Name -Split $t.Split
    if ($done -ge $t.Target) {
      "[$([DateTime]::UtcNow.ToString('HH:mm:ssZ'))] TIER $($t.Name): COMPLETE ($done/$($t.Target))"
      break
    }
    "[$([DateTime]::UtcNow.ToString('HH:mm:ssZ'))] TIER $($t.Name): incomplete ($done/$($t.Target)); retry in 10s"
    Start-Sleep -Seconds 10
  }
}
"[$([DateTime]::UtcNow.ToString('HH:mm:ssZ'))] ==== LADDER DONE ===="
