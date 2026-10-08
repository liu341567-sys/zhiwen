$ErrorActionPreference = 'Continue'
$logDirectory = 'test-results/ui'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$logPath = Join-Path $logDirectory 'windows-ui.log'
& npm run test:ui 2>&1 | Tee-Object -FilePath $logPath
$testExitCode = $LASTEXITCODE
if ($testExitCode -ne 0) {
  $details = (Get-Content -LiteralPath $logPath -Tail 40) -join "`n"
  $details = $details.Replace('%', '%25').Replace("`r", '%0D').Replace("`n", '%0A')
  Write-Host "::error title=Windows UI and display scaling checks failed::$details"
}
exit $testExitCode
