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
$alive = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" | Where-Object { $_.CommandLine -like '*run-beam-ladder*' })
if ($alive.Count -gt 0) { Log "ladder alive (PID $($alive[0].ProcessId)); no action"; exit 0 }

# 2. Which ladder? The ladder records its -Tag on start. Without it we cannot
#    name the run dirs and must not relaunch (a relaunch without -Tag blocks
#    forever on the mandatory-parameter prompt in a hidden window).
$tagFile = Join-Path $repo 'data\eval\runs\ladder-current-tag.txt'
if (-not (Test-Path $tagFile)) { Log "no ladder-current-tag.txt; nothing to watch (start the ladder once with -Tag first)"; exit 0 }
$tag = (Get-Content -Path $tagFile -Raw).Trim()
if ($tag -notmatch '^[a-z0-9-]+$') { Log "tag file contents invalid ($tag); refusing to relaunch"; exit 0 }

# All tiers complete? Then we are done — remove the watchdog task. Run dirs are
# amb-beam-<split>-<tag>, mirroring run-beam-ladder.ps1. 10M is HELD there by
# default (-SkipTenM), so it is not in this list.
$tiers = @(
  @('100k',"amb-beam-100k-$tag",400),
  @('500k',"amb-beam-500k-$tag",700),
  @('1m',"amb-beam-1m-$tag",700)
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
Log "ladder dead + incomplete; relaunching with -Tag $tag"
Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-File', $ladder, '-Tag', $tag) -WindowStyle Hidden
