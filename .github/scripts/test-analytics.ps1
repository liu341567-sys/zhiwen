$ErrorActionPreference = 'Continue'
$directory = 'test-results/ui'
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$logPath = Join-Path $directory 'windows-analytics.log'
& npm run test:analytics 2>&1 | Tee-Object -FilePath $logPath
$result = $LASTEXITCODE
$lines = Get-Content -LiteralPath $logPath
if ($result -eq 0) {
  $summary = ($lines | Where-Object { $_ -match '^\{"analyticsSummary":|^\d+ analytics real-window checks passed' }) -join "`n"
  $value = $summary.Replace('%','%25').Replace("`r",'%0D').Replace("`n",'%0A')
  Write-Host "::notice title=Windows analytics fixtures::$value"
} else {
  $failure = ($lines | Where-Object { $_ -match '^\{"uiFailure":' } | Select-Object -Last 1) -join "`n"
  if (-not $failure) { $failure = ($lines | Select-Object -Last 15) -join "`n" }
  for ($i=0; $i -lt $failure.Length; $i+=800) {
    $part = $failure.Substring($i,[Math]::Min(800,$failure.Length-$i)).Replace('%','%25').Replace("`r",'%0D').Replace("`n",'%0A')
    Write-Host "::error title=Windows analytics failure details::$part"
  }
}
exit $result
