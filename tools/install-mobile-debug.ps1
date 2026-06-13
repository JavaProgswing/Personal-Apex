param(
  [switch]$Build,
  [string]$Serial,
  [string]$Apk
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Resolve-Path (Join-Path $ScriptDir "..")
$MobileDir = Join-Path $RepoRoot "mobile_android"

function Add-Candidate {
  param([System.Collections.Generic.List[string]]$List, [string]$PathValue)
  if ([string]::IsNullOrWhiteSpace($PathValue)) { return }
  $expanded = [Environment]::ExpandEnvironmentVariables($PathValue)
  if (-not $List.Contains($expanded)) { $List.Add($expanded) }
}

function Find-Adb {
  $candidates = [System.Collections.Generic.List[string]]::new()
  Add-Candidate $candidates $env:ADB

  $fromPath = Get-Command adb.exe -ErrorAction SilentlyContinue
  if ($fromPath) { Add-Candidate $candidates $fromPath.Source }

  foreach ($root in @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT, "$env:LOCALAPPDATA\Android\Sdk")) {
    if ([string]::IsNullOrWhiteSpace($root)) { continue }
    Add-Candidate $candidates (Join-Path $root "platform-tools\adb.exe")
  }

  Add-Candidate $candidates "C:\Program Files (x86)\Minimal ADB and Fastboot\adb.exe"
  Add-Candidate $candidates "C:\Program Files\Android\platform-tools\adb.exe"
  Add-Candidate $candidates "C:\platform-tools\adb.exe"

  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) { return (Resolve-Path -LiteralPath $candidate).Path }
  }

  throw @"
adb.exe was not found.

Install Android platform-tools or set one of these:
- ADB=C:\path\to\adb.exe
- ANDROID_HOME=C:\Users\<you>\AppData\Local\Android\Sdk
- ANDROID_SDK_ROOT=C:\Users\<you>\AppData\Local\Android\Sdk
"@
}

if ([string]::IsNullOrWhiteSpace($Apk)) {
  $Apk = Join-Path $MobileDir "app\build\outputs\apk\debug\app-debug.apk"
}

if ($Build) {
  Push-Location $MobileDir
  try {
    & ".\gradlew.bat" ":app:assembleDebug"
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  } finally {
    Pop-Location
  }
}

if (-not (Test-Path -LiteralPath $Apk)) {
  throw "APK not found at $Apk. Run this script with -Build first."
}

$adb = Find-Adb
Write-Host "Using adb: $adb"

$deviceLines = & $adb devices | Select-Object -Skip 1 | Where-Object { $_.Trim().Length -gt 0 }
$readyDevices = @($deviceLines | Where-Object { $_ -match "\sdevice$" })
$blockedDevices = @($deviceLines | Where-Object { $_ -notmatch "\sdevice$" })

if ($readyDevices.Count -eq 0) {
  if ($blockedDevices.Count -gt 0) {
    Write-Host "ADB sees devices, but none are authorized/ready:"
    $blockedDevices | ForEach-Object { Write-Host "  $_" }
    throw "Unlock the phone, accept the USB debugging prompt, then retry."
  }
  throw "No Android device/emulator is connected. Connect a phone or start an emulator, then retry."
}

$installArgs = @("install", "-r")
if (-not [string]::IsNullOrWhiteSpace($Serial)) {
  $installArgs = @("-s", $Serial) + $installArgs
} elseif ($readyDevices.Count -gt 1) {
  Write-Host "Multiple devices are connected:"
  $readyDevices | ForEach-Object { Write-Host "  $_" }
  throw "Pass -Serial <device-id> to choose one."
}
$installArgs += $Apk

& $adb @installArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
