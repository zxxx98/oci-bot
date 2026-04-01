Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$hooksPath = Join-Path $repoRoot ".githooks"

Write-Host "Configuring local git hooks path..."
& git -c "safe.directory=$repoRoot" config core.hooksPath $hooksPath

if ($LASTEXITCODE -ne 0) {
  throw "Failed to configure core.hooksPath."
}

Write-Host "Git hooks are now configured to use $hooksPath"
