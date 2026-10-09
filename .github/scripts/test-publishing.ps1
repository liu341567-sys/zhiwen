$ErrorActionPreference = 'Continue'
$logDirectory = 'test-results/ui'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$logPath = Join-Path $logDirectory 'windows-publishing.log'
& npm run test:publishing 2>&1 | Tee-Object -FilePath $logPath
$testExitCode = $LASTEXITCODE
if ($testExitCode -eq 0) {
  $summaries = (Get-Content -LiteralPath $logPath | Where-Object {
    $_ -match '^\{"publishingLayout":|^\d+ publishing real-window checks passed'
  }) -join "`n"
  if ($env:GITHUB_STEP_SUMMARY) {
    @('### Windows publishing fixtures', '', '```text', $summaries, '```') |
      Out-File -FilePath $env:GITHUB_STEP_SUMMARY -Encoding utf8 -Append
  }
  $annotation = $summaries.Replace('%', '%25').Replace("`r", '%0D').Replace("`n", '%0A')
  Write-Host "::notice title=Windows publishing fixtures measurements::$annotation"
}
if ($testExitCode -ne 0) {
  $failure = @(Get-Content -LiteralPath $logPath | Where-Object { $_ -match '^\{"uiFailure":' })
  $details = if ($failure.Count) { $failure[-1] } else { (Get-Content -LiteralPath $logPath -Tail 12) -join "`n" }
  # Keep every diagnostic chunk below GitHub's annotation limit, including
  # Chinese text. The concise failure record includes the error and stack.
  for ($offset = 0; $offset -lt $details.Length; $offset += 800) {
    $part = $details.Substring($offset, [Math]::Min(800, $details.Length - $offset))
    $part = $part.Replace('%', '%25').Replace("`r", '%0D').Replace("`n", '%0A')
    $number = 1 + [Math]::Floor($offset / 800)
    Write-Host "::error title=Windows publishing failure details ${number}::$part"
  }
}
exit $testExitCode
