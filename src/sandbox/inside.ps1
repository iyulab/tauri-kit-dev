# Runs inside Windows Sandbox (see sandbox.js): records whether the sandbox can reach the
# internet and whether a WebView2 runtime is present, installs the app silently for the current
# user from the installer in this folder, starts it, checks that it started a web view, and writes
# what it saw to out\result.json. It never throws before the result is written - a result file
# with a failure in it tells the host more than a sandbox that never answers.
#
# -Exe is the app's executable file name. -Identifier is its bundle identifier, used only to list
# its data folder when the start fails. -Extra names a script in this folder that is dot-sourced
# after the start: it adds the app's own checks with `Step '<name>' { ... }` and can use $target.
#
# -Target installs somewhere else and -Cleanup stops the app and uninstalls it afterwards, so the
# script can be tried on a host (where the sandbox is thrown away instead). -WithoutWebView2
# removes the WebView2 runtime first, so the installer meets a computer that does not have it -
# only inside the sandbox, whose account is WDAGUtilityAccount.

param(
  [Parameter(Mandatory)][string]$Exe,
  [string]$Identifier,
  [string]$Extra,
  [string]$Target = (Join-Path $env:LOCALAPPDATA 'tauri-app-sandbox'),
  [int]$StartSeconds = 20,
  [switch]$Cleanup,
  [switch]$WithoutWebView2)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = Join-Path $here 'out'
New-Item -ItemType Directory -Force $out | Out-Null
$result = [ordered]@{ started = (Get-Date).ToString('o'); steps = @() }

# Each step is logged as it starts and ends, so a sandbox that never writes its result still shows
# where it stopped.
function Progress($line) { Add-Content -Encoding utf8 (Join-Path $out 'progress.log') "$((Get-Date).ToString('HH:mm:ss')) $line" }

# Runs a program and waits for it, but not forever: a setup that hangs is a finding, not a stall.
function Run($file, $arguments, [int]$minutes = 5) {
  $p = Start-Process -FilePath $file -ArgumentList $arguments -PassThru
  if (-not $p.WaitForExit($minutes * 60000)) {
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    throw "$(Split-Path -Leaf $file) did not finish within $minutes minutes"
  }
  $p
}

function Step($name, [scriptblock]$body) {
  Progress "start $name"
  try {
    $value = & $body
    $result.steps += [ordered]@{ name = $name; ok = $true; value = $value }
    Progress "ok    $name"
  } catch {
    $result.steps += [ordered]@{ name = $name; ok = $false; error = $_.Exception.Message }
    Progress "fail  $name - $($_.Exception.Message)"
  }
}

# The WebView2 runtime registers its version under EdgeUpdate, per machine or per user.
$WebView2Clients = @(
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
  'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
  'HKCU:\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}')

function WebView2Version {
  foreach ($key in $WebView2Clients) {
    $pv = (Get-ItemProperty -Path $key -Name pv -ErrorAction SilentlyContinue).pv
    if ($pv -and $pv -ne '0.0.0.0') { return "$pv ($key) - $(WebView2Files $pv)" }
  }
  return $null
}

# A registration is not a runtime: the registry can name a version whose files are not on disk.
function WebView2Files($pv) {
  foreach ($root in @("${env:ProgramFiles(x86)}\Microsoft\EdgeWebView\Application", "$env:LOCALAPPDATA\Microsoft\EdgeWebView\Application")) {
    if (Test-Path (Join-Path $root "$pv\msedgewebview2.exe")) { return "files in $root" }
  }
  return 'no runtime files on disk'
}

Step 'network' {
  try {
    Invoke-WebRequest -Uri 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -Method Head -TimeoutSec 10 -UseBasicParsing | Out-Null
    'online'
  } catch { 'offline' }
}
if ($WithoutWebView2) {
  Step 'remove webview2' {
    if ($env:USERNAME -ne 'WDAGUtilityAccount') { throw 'refusing to remove WebView2 outside Windows Sandbox' }
    $uninstallKey = 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Microsoft EdgeWebView'
    $entry = Get-ItemProperty $uninstallKey -ErrorAction SilentlyContinue
    if (-not $entry) { return 'not installed' }
    # A registration without runtime files (Windows Sandbox ships one) has no uninstaller to run:
    # remove the registration itself, which is all an installer looks at.
    if (-not $entry.UninstallString -and (WebView2Version) -match 'no runtime files') {
      foreach ($key in @($uninstallKey) + $WebView2Clients) {
        Remove-Item -Path $key -Recurse -Force -ErrorAction SilentlyContinue
      }
      $left = WebView2Version
      if ($left) { throw "still registered after removing the registration: $left" }
      return 'removed a registration that had no runtime files'
    }
    # The runtime marks itself as not removable; its own setup removes it when forced.
    if ($entry.UninstallString -notmatch '^"([^"]+)"\s*(.*)$') { throw "unexpected uninstall command: $($entry.UninstallString)" }
    $p = Run $Matches[1] "$($Matches[2]) --force-uninstall"
    $left = WebView2Version
    if ($left) { throw "still registered after the uninstaller exited with $($p.ExitCode): $left" }
    "removed (the uninstaller exited with $($p.ExitCode))"
  }
}
Step 'webview2 before' { WebView2Version }

$installer = Get-ChildItem $here -Filter '*-setup.exe' | Select-Object -First 1
$target = $Target
Step 'installer' { $installer.Name }
Step 'install' {
  # NSIS: /S is silent, /D= must come last and unquoted.
  $p = Run $installer.FullName @('/S', "/D=$target") 10
  if ($p.ExitCode -ne 0) { throw "the installer exited with $($p.ExitCode)" }
  (Get-ChildItem $target -Name) -join ', '
}
if (-not ($result.steps | Where-Object { $_.name -eq 'install' }).ok) {
  # The installer aborts when the WebView2 setup it carries fails; that setup logs to these places.
  Step 'install diagnostics' {
    $logs = Join-Path $out 'logs'
    New-Item -ItemType Directory -Force $logs | Out-Null
    $since = (Get-Date).AddMinutes(-30)
    $found = foreach ($dir in @("$env:ProgramData\Microsoft\EdgeUpdate\Log", $env:TEMP, "$env:SystemRoot\Temp", "$env:LOCALAPPDATA\Microsoft\EdgeUpdate\Log")) {
      Get-ChildItem $dir -Filter '*.log' -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt $since } | ForEach-Object {
        Copy-Item $_.FullName (Join-Path $logs "$($_.Directory.Name)-$($_.Name)") -ErrorAction SilentlyContinue
        $_.FullName
      }
    }
    # The update service logs in UTF-16; its failure lines say why the runtime did not install.
    $update = "$env:ProgramData\Microsoft\EdgeUpdate\Log\MicrosoftEdgeUpdate.log"
    $why = @(Get-Content $update -Encoding Unicode -ErrorAction SilentlyContinue | Select-String 'InstallApp returned|Failed to install' | Select-Object -Last 2 | ForEach-Object { "$_".Substring("$_".IndexOf('][', 30) + 1) })
    [ordered]@{ logs = @($found); webview2Setup = $why }
  }
}
Step 'webview2 after' { WebView2Version }
Step 'start' {
  $script:app = Start-Process -FilePath (Join-Path $target $Exe) -PassThru
  Start-Sleep -Seconds $StartSeconds
  if ($script:app.HasExited) { throw "the app exited with $($script:app.ExitCode)" }
  # Only the web view the app started counts - other apps may run their own.
  $webview = Get-CimInstance Win32_Process -Filter "Name = 'msedgewebview2.exe' AND ParentProcessId = $($script:app.Id)"
  if (-not $webview) { throw 'the app is running but has started no WebView2 process' }
  "the app is running with its web view ($(@($webview)[0].ExecutablePath))"
}
# When the start check fails, record what was on screen and which processes ran, so the cause can
# be read from the kept folder instead of guessed.
if (-not ($result.steps | Where-Object { $_.name -eq 'start' }).ok) {
  Step 'start diagnostics' {
    $d = [ordered]@{}
    if ($script:app) {
      $script:app.Refresh()
      $d.app = [ordered]@{ pid = $script:app.Id; exited = $script:app.HasExited; window = $script:app.MainWindowTitle; responding = $script:app.Responding }
      $d.children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($script:app.Id)" | ForEach-Object { "$($_.ProcessId) $($_.Name)" })
    }
    $d.webviews = @(Get-CimInstance Win32_Process -Filter "Name = 'msedgewebview2.exe'" | ForEach-Object { "$($_.ProcessId) parent=$($_.ParentProcessId) $("$($_.CommandLine)".Substring(0, [Math]::Min(200, "$($_.CommandLine)".Length)))" })
    $d.windows = @(Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { "$($_.ProcessName): $($_.MainWindowTitle)" })
    if ($Identifier) { $d.userData = @(Get-ChildItem (Join-Path $env:LOCALAPPDATA $Identifier) -ErrorAction SilentlyContinue | ForEach-Object Name) }
    $d.events = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; Level = 1, 2; StartTime = (Get-Date).AddMinutes(-10) } -MaxEvents 5 -ErrorAction SilentlyContinue | ForEach-Object { "$($_.ProviderName): $("$($_.Message)".Split("`n")[0])" })
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bitmap = New-Object System.Drawing.Bitmap $screen.Width, $screen.Height
    [System.Drawing.Graphics]::FromImage($bitmap).CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
    $bitmap.Save((Join-Path $out 'start.png'))
    $d.screenshot = 'out\start.png'
    $d
  }
}
# The app's own checks - a bundled helper it starts only later, files it must carry - run here,
# with Step and $target in reach. A failure in loading the script is itself a step that failed.
if ($Extra) {
  Step "extra: $Extra" {
    $path = Join-Path $here $Extra
    if (-not (Test-Path $path)) { throw "no script $Extra beside this one" }
    'loaded'
  }
  if (Test-Path (Join-Path $here $Extra)) { . (Join-Path $here $Extra) }
}

if ($Cleanup) {
  Step 'uninstall' {
    if ($script:app -and -not $script:app.HasExited) { Stop-Process -Id $script:app.Id -Force }
    $p = Run (Join-Path $target 'uninstall.exe') '/S'
    if ($p.ExitCode -ne 0) { throw "the uninstaller exited with $($p.ExitCode)" }
    'removed'
  }
}

$result.finished = (Get-Date).ToString('o')
$result.ok = -not ($result.steps | Where-Object { -not $_.ok })
$result | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 (Join-Path $out 'result.json')
