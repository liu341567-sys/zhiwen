$ErrorActionPreference = 'Continue'
$logDirectory = 'test-results/ui'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$logPath = Join-Path $logDirectory 'windows-ui.log'
& npm run test:ui 2>&1 | Tee-Object -FilePath $logPath
$testExitCode = $LASTEXITCODE
if ($testExitCode -eq 0) {
  $summaries = (Get-Content -LiteralPath $logPath | Where-Object {
    $_ -match '^\{"scaleSummary":|^\d+ real-window UI checks passed'
  }) -join "`n"
  if ($env:GITHUB_STEP_SUMMARY) {
    @('### Windows UI scaling', '', '```text', $summaries, '```') |
      Out-File -FilePath $env:GITHUB_STEP_SUMMARY -Encoding utf8 -Append
  }
  $annotation = $summaries.Replace('%', '%25').Replace("`r", '%0D').Replace("`n", '%0A')
  Write-Host "::notice title=Windows UI scaling measurements::$annotation"
}
if ($testExitCode -ne 0) {
  $details = (Get-Content -LiteralPath $logPath -Tail 40) -join "`n"
  $details = $details.Replace('%', '%25').Replace("`r", '%0D').Replace("`n", '%0A')
  Write-Host "::error title=Windows UI and display scaling checks failed::$details"
}
exit $testExitCode
