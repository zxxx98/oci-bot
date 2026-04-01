Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$trackedRuntimeFiles = @(
  "data/config.json",
  "data/job-state.json"
)

Write-Host "Restoring tracked runtime files before commit..."

foreach ($relativePath in $trackedRuntimeFiles) {
  $absolutePath = Join-Path $repoRoot $relativePath
  $gitOutput = & git -c "safe.directory=$repoRoot" show "HEAD:$relativePath" 2>$null
  if ($LASTEXITCODE -ne 0) {
    continue
  }

  $parentDir = Split-Path -Parent $absolutePath
  if (-not (Test-Path -LiteralPath $parentDir)) {
    New-Item -ItemType Directory -Path $parentDir | Out-Null
  }

  [System.IO.File]::WriteAllText($absolutePath, ($gitOutput -join [Environment]::NewLine) + [Environment]::NewLine)
}

Write-Host ""
Write-Host "Remaining changes ready for review:"
& git -c "safe.directory=$repoRoot" status --short
if ($LASTEXITCODE -ne 0) {
  throw "Failed to read git status."
}
