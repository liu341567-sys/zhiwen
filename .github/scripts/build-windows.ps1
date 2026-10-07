param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('nsis', 'zip')]
  [string]$Target
)

# Keep the command's exit status, and expose packaging diagnostics in the job summary.
$ErrorActionPreference = 'Continue'
$scriptName = if ($Target -eq 'nsis') { 'dist:win' } else { 'dist:win:zip' }
$logPath = Join-Path $env:RUNNER_TEMP "qiye-build-$Target.log"
& npm run $scriptName -- --publish never 2>&1 | Tee-Object -FilePath $logPath
$buildExitCode = $LASTEXITCODE

if ($env:GITHUB_STEP_SUMMARY) {
  @(
    "### Windows $Target packaging (exit $buildExitCode)",
    '',
    '```text'
  ) | Out-File -FilePath $env:GITHUB_STEP_SUMMARY -Encoding utf8 -Append
  Get-Content -LiteralPath $logPath -Tail 100 |
    Out-File -FilePath $env:GITHUB_STEP_SUMMARY -Encoding utf8 -Append
  '```' | Out-File -FilePath $env:GITHUB_STEP_SUMMARY -Encoding utf8 -Append
}

if ($buildExitCode -ne 0) {
  $details = (Get-Content -LiteralPath $logPath -Tail 40) -join "`n"
  $details = $details.Replace('%', '%25').Replace("`r", '%0D').Replace("`n", '%0A')
  Write-Host "::error title=Windows $Target packaging failed::$details"
}

exit $buildExitCode
