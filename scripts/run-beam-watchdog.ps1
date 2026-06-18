<#
.SYNOPSIS
  Watchdog for the BEAM ladder. Fired every 10 minutes by Windows Task
  Scheduler (task name CSM-BEAM-Watchdog). Idempotent and single-instance-safe:

    - if a ladder is already running  -> do nothing (let it run)
    - if all four tiers are complete  -> delete this watchdog task and exit
    - otherwise (dead + incomplete)   -> relaunch the ladder, detached

  This runs independently of Claude Code, so it recovers the run within ~10 min
  of any death (power blip, sleep, crash) and after a reboot/login — without
  anyone having to notice. It never starts a second ladder.
#>
$ErrorActionPreference = 'Continue'
$repo   = 'C:\Users\Keonm\OneDrive\Documents\GitHub\context-swarm-memory'
$ladder = Join-Path $repo 'scripts\run-beam-ladder.ps1'
$logp   = Join-Path $repo 'data\eval\runs\watchdog.log'
function Log($m) { ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) | Out-File -FilePath $logp -Append -Encoding utf8 }

# 1. Already running? Leave it alone. (CommandLine match; exclude self by name —
#    the watchdog's own command line contains run-beam-watchdog, not -ladder.)
$alive = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*run-beam-ladder*' })
if ($alive.Count -gt 0) { Log "ladder alive (PID $($alive[0].ProcessId)); no action"; exit 0 }

# 2. All tiers complete? Then we are done — remove the watchdog task.
$tiers = @(
  @('100k','amb-beam-100k-official-v2',400),
  @('500k','amb-beam-500k-official-v1',700),
  @('1m','amb-beam-1m-official-v1',700),
  @('10m','amb-beam-10m-official-v1',200)
)
$allDone = $true
foreach ($t in $tiers) {
  $p = Join-Path $repo "data\eval\runs\$($t[1])\amb-outputs\beam\$($t[1])\rag\$($t[0]).json"
  $n = 0
  if (Test-Path $p) {
    $c = node -e "try{console.log((JSON.parse(require('fs').readFileSync(process.argv[1])).results||[]).length)}catch(e){console.log(0)}" $p
    if ($c -match '^\d+$') { $n = [int]$c }
  }
  if ($n -lt $t[2]) { $allDone = $false }
}
if ($allDone) { Log "all tiers complete; deleting watchdog task"; schtasks /delete /tn 'CSM-BEAM-Watchdog' /f | Out-Null; exit 0 }

# 3. Dead + incomplete -> relaunch detached. The ladder's own single-instance
#    guard clears any stale workers; --skip-ingested resumes from saved units.
Log "ladder dead + incomplete; relaunching"
Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-File', $ladder) -WindowStyle Hidden
