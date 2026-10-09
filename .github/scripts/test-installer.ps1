param(
  [string]$InstallerPath
)

$ErrorActionPreference = 'Stop'
if (!$IsWindows -or $env:GITHUB_ACTIONS -cne 'true' -or !$env:RUNNER_TEMP) {
  throw 'Installer verification runs only on an ephemeral GitHub Windows runner.'
}

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$manifest = Get-Content -LiteralPath (Join-Path $repositoryRoot 'package.json') -Raw | ConvertFrom-Json
$appName = $manifest.build.productName
$appId = $manifest.build.appId
$shortcutName = $manifest.build.nsis.shortcutName
if (!$InstallerPath) {
  $InstallerPath = Join-Path $repositoryRoot "dist/Qiye-Setup-$($manifest.version)-x64.exe"
}
$InstallerPath = (Resolve-Path -LiteralPath $InstallerPath).Path
$iconPath = Join-Path $repositoryRoot 'src/assets/qiye.ico'
$testRoot = Join-Path $env:RUNNER_TEMP ('qiye-installed-check-' + [Guid]::NewGuid().ToString('N'))
$installDirectory = Join-Path $testRoot 'application'
$dataDirectory = Join-Path $testRoot 'browser-data'
$outputDirectory = Join-Path $testRoot 'verification'
$installedExe = Join-Path $installDirectory ($appName + '.exe')
$desktopLink = Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) ($shortcutName + '.lnk')
$startMenuLink = Join-Path ([Environment]::GetFolderPath('Programs')) ($shortcutName + '.lnk')

if ((Test-Path -LiteralPath $desktopLink) -or (Test-Path -LiteralPath $startMenuLink)) {
  throw 'Refusing to replace an existing application shortcut, even on this runner.'
}
New-Item -ItemType Directory -Path $testRoot, $outputDirectory -Force | Out-Null
if ($env:GITHUB_OUTPUT) {
  "verification_path=$outputDirectory" | Out-File -FilePath $env:GITHUB_OUTPUT -Encoding utf8 -Append
}
$uninstaller = $null
$shell = $null
$desktopShell = $null
$successful = $false
$failureMessage = $null

function Invoke-NodeCheck {
  param([string[]]$CheckArguments)
  $nodeOutput = @(& node @CheckArguments 2>&1)
  $nodeExitCode = $LASTEXITCODE
  $nodeOutput | ForEach-Object { Write-Host $_ }
  if ($nodeExitCode -ne 0) {
    $details = ($nodeOutput | Select-Object -Last 35 | ForEach-Object { $_.ToString() }) -join "`n"
    throw "Node verification failed with exit $nodeExitCode`n$details"
  }
}

function Assert-Shortcut {
  param([string]$LinkPath)
  if (!(Test-Path -LiteralPath $LinkPath -PathType Leaf)) { throw "Missing installer shortcut: $LinkPath" }
  $shortcut = $shell.CreateShortcut($LinkPath)
  try {
    $targetPath = [string]$shortcut.TargetPath
    $iconLocation = [string]$shortcut.IconLocation
    $properties = @{ link = $LinkPath; target = $targetPath; icon = $iconLocation } | ConvertTo-Json -Compress
    Write-Host "::notice title=Installed shortcut properties::$properties"
    # Load the existing Shell Link explicitly and retain native HRESULTs.
    # WScript.CreateShortcut can return a default object without explaining why
    # loading the file failed; it must not be the sole installation verdict.
    $inspection = & (Join-Path $PSScriptRoot 'inspect-shortcut.ps1') -LinkPath $LinkPath
    $inspectionJson = $inspection | ConvertTo-Json -Depth 8 -Compress
    $inspectionJson | Set-Content -LiteralPath (Join-Path $outputDirectory ((Split-Path -Leaf $LinkPath) + '.json')) -Encoding utf8
    $annotation = $inspectionJson.Replace('%', '%25').Replace("`r", '%0D').Replace("`n", '%0A')
    Write-Host "::notice title=Native installed shortcut inspection::$annotation"
    $native = $inspection.native
    if ($inspection.headerSize -ne 76 -or $inspection.shellLinkCLSID -cne '00021401-0000-0000-c000-000000000046' -or
        $native.loadHRESULT -cne '0x00000000' -or $native.getPathHRESULT -cne '0x00000000' -or
        [string]::IsNullOrWhiteSpace([string]$native.target)) {
      throw "The existing shortcut must load and expose its target through Windows IShellLinkW: $LinkPath"
    }
    if ([IO.Path]::GetFullPath([string]$native.target) -ine [IO.Path]::GetFullPath($installedExe)) {
      throw "Shortcut target is not the verified installed executable: $LinkPath"
    }
    if ($native.getIconHRESULT -cne '0x00000000' -or $native.iconIndex -ne 0 -or
        [string]::IsNullOrWhiteSpace([string]$native.iconPath)) {
      throw "Shortcut must expose executable icon index zero through Windows IShellLinkW: $LinkPath"
    }
    $iconFile = [string]$native.iconPath
    if ([IO.Path]::GetFullPath($iconFile) -ine [IO.Path]::GetFullPath($installedExe)) {
      throw "Shortcut icon does not refer to the verified executable: $LinkPath"
    }
    if ($native.getAppIdHRESULT -cne '0x00000000' -or $native.appId -cne $appId) {
      throw "Shortcut AppUserModelID does not match $appId`: $LinkPath"
    }
    Write-Host "Verified shortcut target, executable icon index 0 and AppUserModelID: $LinkPath"
  } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) }
}

try {
  # /D= must be the final argument, unquoted, as required by NSIS. The assisted
  # installer does not launch the application during /S unless --force-run is set.
  $installer = Start-Process -FilePath $InstallerPath -ArgumentList "/S /currentuser /D=$installDirectory" -PassThru
  if (!$installer.WaitForExit(180000)) { throw 'Silent NSIS installation timed out.' }
  if ($installer.ExitCode -ne 0) { throw "Silent NSIS installer exited with $($installer.ExitCode)." }
  if (!(Test-Path -LiteralPath $installedExe -PathType Leaf)) { throw 'Installed executable is missing.' }
  $uninstallers = @(Get-ChildItem -LiteralPath $installDirectory -File -Filter 'Uninstall*.exe')
  if ($uninstallers.Count -ne 1) { throw 'Expected exactly one installed NSIS uninstaller.' }
  $uninstaller = $uninstallers[0].FullName

  Invoke-NodeCheck -CheckArguments @(
    (Join-Path $repositoryRoot '.github/scripts/verify-branding.cjs'), '--ico', $iconPath,
    '--exe', $installedExe, '--exe', $InstallerPath, '--exe', $uninstaller
  )
  foreach ($name in @('qiye.ico', 'qiye.png')) {
    $source = Join-Path $repositoryRoot "src/assets/$name"
    $installed = Join-Path $installDirectory "resources/brand-icons/$name"
    if (!(Test-Path -LiteralPath $installed -PathType Leaf)) { throw "Missing physical window icon: $name" }
    if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -cne (Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash) {
      throw "Installed physical window icon differs from the checked-in source: $name"
    }
  }
  $shell = New-Object -ComObject WScript.Shell
  $desktopShell = New-Object -ComObject Shell.Application
  Assert-Shortcut -LinkPath $desktopLink
  Assert-Shortcut -LinkPath $startMenuLink
  Invoke-NodeCheck -CheckArguments @(
    (Join-Path $repositoryRoot 'tests/windows-installed.cjs'), '--exe', $installedExe,
    '--data', $dataDirectory, '--output', $outputDirectory
  )
  $successful = $true
} catch {
  $failureMessage = $_.Exception.Message
} finally {
  if ($shell) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
  if ($desktopShell) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($desktopShell) }
  if ($uninstaller -and (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
    try {
      $uninstallProcess = Start-Process -FilePath $uninstaller -ArgumentList '/S /currentuser' -PassThru
      if (!$uninstallProcess.WaitForExit(120000) -or $uninstallProcess.ExitCode -ne 0) {
        throw 'Temporary application uninstall did not complete normally.'
      }
      # NSIS may copy its uninstaller to TEMP. Wait for its actual cleanup rather
      # than treating the original stub's exit as proof of removal.
      $uninstallDeadline = [DateTime]::UtcNow.AddSeconds(45)
      while (((Test-Path -LiteralPath $installedExe) -or (Test-Path -LiteralPath $desktopLink) -or (Test-Path -LiteralPath $startMenuLink)) -and
          [DateTime]::UtcNow -lt $uninstallDeadline) {
        Start-Sleep -Milliseconds 250
      }
      if ((Test-Path -LiteralPath $installedExe) -or (Test-Path -LiteralPath $desktopLink) -or (Test-Path -LiteralPath $startMenuLink)) {
        throw 'Temporary uninstall left the executable or generated shortcuts behind.'
      }
    } catch {
      if (!$failureMessage) { $failureMessage = $_.Exception.Message }
      $successful = $false
    }
  }
  if ($env:GITHUB_STEP_SUMMARY) {
    @(
      '### Installed Windows application and branding', '',
      "Passed: $successful", '',
      'Checks: first PE icon group and every ICO frame, desktop/start-menu icon source and AppUserModelID, physical window icon hashes, native installed launch, original wordmark aspect ratio, nine local platform logos, platform association and icon restoration, saved environment order, locked launch configuration, profile persistence and normal WM_CLOSE shutdown.', '',
      "Temporary verification artifacts: $outputDirectory"
    ) | Out-File -FilePath $env:GITHUB_STEP_SUMMARY -Encoding utf8 -Append
    if ($failureMessage) {
      @('', '```text', $failureMessage, '```') |
        Out-File -FilePath $env:GITHUB_STEP_SUMMARY -Encoding utf8 -Append
    }
  }
}
if (!$successful) {
  if (!$failureMessage) { $failureMessage = 'Installed application verification or cleanup failed.' }
  $annotation = $failureMessage.Replace('%', '%25').Replace("`r", '%0D').Replace("`n", '%0A')
  Write-Host "::error title=Installed Windows application and branding verification failed::$annotation"
  throw $failureMessage
}
Write-Host "Installed application and branding verification passed. Screenshots and JSON: $outputDirectory"
Write-Host '::notice title=Installed Windows application verification passed::Verified source-matching PE icon frames, desktop and start-menu shortcuts, AppUserModelID, packaged wordmark, nine local platform logos, platform association and icon restoration, saved environment order, locked launch configuration, native installed startup, normal WM_CLOSE shutdown and account data restoration after restart.'
