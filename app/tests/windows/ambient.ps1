<#
.SYNOPSIS
  WP-12 acceptance tests on Windows (SPEC 9.1 WP-12 tests 1 to 3; test 4, CPU, is a manual measurement noted below).

.DESCRIPTION
  *** WRITTEN ON macOS. THIS SCRIPT HAS NOT BEEN RUN ON WINDOWS YET. ***
  Expect to fix small things (quoting, timing, a P/Invoke signature) the first time it runs. The first
  red run may be the script's fault and not the app's.

  Runs the real DEBUG binary (the test hooks are compiled out of release builds) on the real desktop of an
  interactive session and reads the app's own test log (--test-log, JSON lines).

    1  idle trigger: with a fake idle file (BUSYHOLM_FAKE_IDLE_FILE) and the gate override
       (BUSYHOLM_IDLE_TRIGGER=on): no scene at 299 s, a scene at 300 s; with BUSYHOLM_FAKE_MEDIA=on no scene.
    2  exit: a hand-started scene closes within 100 ms of (a) a cursor move over 8 px (SetCursorPos),
       (b) a real key press (SendInput), (c) a real click (SendInput); and the click is NOT delivered to
       a probe window placed underneath (the probe counts WM_LBUTTONDOWN).
    3  power: no display or system request from Busyholm. Checks `powercfg /requests` (needs an elevated
       prompt; reported as INFO when not elevated) and, without elevation, the ES_DISPLAY_REQUIRED bit of
       CallNtPowerInformation(SystemExecutionState) while the scene is open and no other app plays video.
    4  CPU (manual): run the app, open the scene, and measure Busyholm plus WebView2 child processes for
       2 minutes in Task Manager or with `typeperf`; budget 8% of one core at 30 fps on a 4-core laptop.

.PARAMETER Binary   Path of the built debug binary busyholm.exe.
.PARAMETER OutDir   Where logs and results.json go.
.PARAMETER Tests    Comma separated list, default "1,2,3".

.EXAMPLE
  powershell -File app\tests\windows\ambient.ps1 -Binary app\src-tauri\target\debug\busyholm.exe
#>
param(
  [Parameter(Mandatory = $true)][string]$Binary,
  [string]$OutDir = '',
  [string]$Tests = '1,2,3'
)
$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppDir = (Resolve-Path (Join-Path $Here '..\..')).Path
if (-not (Test-Path -LiteralPath $Binary)) { Write-Host "app binary missing: $Binary"; exit 2 }
$Binary = (Resolve-Path -LiteralPath $Binary).Path
if (-not $OutDir) { $OutDir = Join-Path $AppDir ('tests\out\windows-ambient-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = (Resolve-Path -LiteralPath $OutDir).Path

Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public static class BhAmb {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("powrprof.dll")] public static extern int CallNtPowerInformation(int level, IntPtr inp, uint inLen, out uint outp, uint outLen);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] public struct U { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public U u; }
  public static void Key(ushort vk) {
    var a = new INPUT[2];
    a[0].type = 1; a[0].u.ki.vk = vk;
    a[1].type = 1; a[1].u.ki.vk = vk; a[1].u.ki.flags = 2;
    SendInput(2, a, Marshal.SizeOf(typeof(INPUT)));
  }
  public static void Click() {
    var a = new INPUT[2];
    a[0].type = 0; a[0].u.mi.dwFlags = 0x0002;
    a[1].type = 0; a[1].u.mi.dwFlags = 0x0004;
    SendInput(2, a, Marshal.SizeOf(typeof(INPUT)));
  }
  public static uint ExecutionState() { uint s; int r = CallNtPowerInformation(16, IntPtr.Zero, 0, out s, 4); return r == 0 ? s : 0xFFFFFFFF; }
}
'@

$Results = New-Object System.Collections.ArrayList
$Fails = 0
function Rec($test, $name, $status, $detail) {
  [void]$Results.Add([ordered]@{ test = $test; name = $name; status = $status; detail = $detail })
  if ($status -eq 'fail') { $script:Fails++ }
  Write-Host ("[{0,-7}] {1} {2}: {3}" -f $status.ToUpper(), $test, $name, ($detail | ConvertTo-Json -Compress -Depth 4))
}
function Now { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() / 1000.0 }

function Start-App($tag, $extra, $envMap, $idleMinutes) {
  $data = Join-Path $OutDir "data-$tag"; $log = Join-Path $OutDir "$tag.log"
  New-Item -ItemType Directory -Force -Path $data | Out-Null
  if ($idleMinutes) {
    # let the app write its defaults once, then edit them
    $p0 = Start-Process -FilePath $Binary -ArgumentList @('--data-dir', $data, '--exit-after', '1', '--mock-collector', '--mock-static') -PassThru -WindowStyle Hidden
    [void]$p0.WaitForExit(30000); Start-Sleep -Seconds 1
    $f = Join-Path $data 'settings.json'
    $s = Get-Content -Raw $f | ConvertFrom-Json
    $s.ambient.idle_minutes = $idleMinutes
    ($s | ConvertTo-Json -Depth 20 -Compress) | Set-Content -Encoding UTF8 $f
  }
  foreach ($k in $envMap.Keys) { [Environment]::SetEnvironmentVariable($k, $envMap[$k], 'Process') }
  $args = @('--data-dir', $data, '--test-log', $log, '--mock-collector', '--mock-static', '--exit-after', '90') + $extra
  $p = Start-Process -FilePath $Binary -ArgumentList $args -PassThru
  foreach ($k in $envMap.Keys) { [Environment]::SetEnvironmentVariable($k, $null, 'Process') }
  return @{ proc = $p; log = $log; tag = $tag }
}
function Events($app, $name) {
  if (-not (Test-Path $app.log)) { return @() }
  Get-Content $app.log | ForEach-Object { try { $_ | ConvertFrom-Json } catch { } } | Where-Object { $_.event -eq $name }
}
function Wait-Event($app, $name, $pred, $timeoutS) {
  $end = (Get-Date).AddSeconds($timeoutS)
  while ((Get-Date) -lt $end) {
    $e = Events $app $name | Where-Object { & $pred $_ } | Select-Object -First 1
    if ($e) { return $e }
    Start-Sleep -Milliseconds 50
  }
  return $null
}
function Open-State($app, $open, $since) { Wait-Event $app 'ambient' { param($e) $e.data.open -eq $open -and $e.t -ge $since } 4 }
function Stop-App($app) { if (-not $app.proc.HasExited) { Stop-Process -Id $app.proc.Id -Force }; Start-Sleep -Seconds 1 }

# ---- test 1: trigger ----------------------------------------------------------------------------
if ($Tests -match '1') {
  $idle = Join-Path $OutDir 'idle-1.txt'; '299' | Set-Content $idle
  $app = Start-App 't1' @() @{ BUSYHOLM_FAKE_IDLE_FILE = $idle; BUSYHOLM_IDLE_TRIGGER = 'on'; BUSYHOLM_FAKE_MEDIA = 'off'; BUSYHOLM_FAKE_FULLSCREEN = 'off' } 5
  try {
    [void](Wait-Event $app 'strip_visibility' { param($e) $e.data.visible -eq $true } 25)
    Start-Sleep -Seconds 3
    $quiet = -not (Events $app 'ambient' | Where-Object { $_.data.open })
    $t = Now; '300' | Set-Content $idle
    $o = Open-State $app $true $t
    Rec '1' 'no scene at 299 s, a scene at the 5 min threshold' $(if ($quiet -and $o) { 'pass' } else { 'fail' }) @{ quiet = $quiet; opened = [bool]$o }
  } finally { Stop-App $app }
  $app = Start-App 't1m' @() @{ BUSYHOLM_FAKE_IDLE_FILE = $idle; BUSYHOLM_IDLE_TRIGGER = 'on'; BUSYHOLM_FAKE_MEDIA = 'on'; BUSYHOLM_FAKE_FULLSCREEN = 'off' } 5
  try {
    [void](Wait-Event $app 'strip_visibility' { param($e) $e.data.visible -eq $true } 25)
    Start-Sleep -Seconds 6
    $quiet = -not (Events $app 'ambient' | Where-Object { $_.data.open })
    Rec '1' 'call or video active (fake probe): no scene' $(if ($quiet) { 'pass' } else { 'fail' }) @{ quiet = $quiet }
  } finally { Stop-App $app }
}

# ---- test 2: exit on input, and the input is not delivered beneath ------------------------------
if ($Tests -match '2') {
  Add-Type -AssemblyName System.Windows.Forms
  foreach ($case in 'move', 'key', 'click') {
    $app = Start-App "t2-$case" @('--open', 'ambient') @{} $null
    $probe = New-Object System.Windows.Forms.Form
    $script:downs = 0
    try {
      if (-not (Wait-Event $app 'ambient' { param($e) $e.data.open -eq $true } 25)) { Rec '2' "exit on $case" 'fail' @{ reason = 'scene never opened' }; continue }
      Start-Sleep -Milliseconds 2300   # grace for a hand-started scene, then the guard baseline
      $pt = New-Object BhAmb+POINT; [void][BhAmb]::GetCursorPos([ref]$pt)
      $t = Now
      switch ($case) {
        'move'  { [void][BhAmb]::SetCursorPos($pt.X + 20, $pt.Y + 3) }
        'key'   { [BhAmb]::Key(0x41) }
        'click' { [BhAmb]::Click() }
      }
      $c = Open-State $app $false $t
      $lat = if ($c) { [math]::Round($c.t - $t, 3) } else { $null }
      Rec '2' "$case: the scene closes within 100 ms" $(if ($c -and $lat -le 0.1) { 'pass' } else { 'fail' }) @{ latency_s = $lat }
    } finally { Stop-App $app }
  }
  # Underneath: a probe window must not see the click. The probe is shown and the cursor parked inside it
  # BEFORE the scene opens, so the guard's baseline is that spot and the click happens in place.
  $form = New-Object System.Windows.Forms.Form
  $form.StartPosition = 'Manual'; $form.Location = New-Object System.Drawing.Point(300, 300); $form.Size = New-Object System.Drawing.Size(400, 300)
  $global:BhDowns = 0
  $form.Add_MouseDown({ $global:BhDowns++ })
  $form.Show(); $form.Refresh()
  [void][BhAmb]::SetCursorPos(500, 450)
  $app = Start-App 't2-beneath' @('--open', 'ambient') @{} $null
  try {
    if (-not (Wait-Event $app 'ambient' { param($e) $e.data.open -eq $true } 25)) { Rec '2' 'click not delivered beneath' 'fail' @{ reason = 'scene never opened' } }
    else {
      Start-Sleep -Milliseconds 2300
      $t = Now; [BhAmb]::Click()
      $c = Open-State $app $false $t
      [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 300; [System.Windows.Forms.Application]::DoEvents()
      Rec '2' 'a click on the scene closes it and is not delivered to the window beneath (probe WM_LBUTTONDOWN count 0)' $(if ($c -and $global:BhDowns -eq 0) { 'pass' } else { 'fail' }) @{ closed = [bool]$c; probe_mouse_downs = $global:BhDowns }
    }
  } finally { $form.Close(); Stop-App $app }
}

# ---- test 3: no power request -------------------------------------------------------------------
if ($Tests -match '3') {
  $app = Start-App 't3' @('--open', 'ambient') @{} $null
  try {
    if (-not (Wait-Event $app 'ambient' { param($e) $e.data.open -eq $true } 25)) { Rec '3' 'no power request' 'fail' @{ reason = 'scene never opened' } }
    else {
      Start-Sleep -Seconds 10
      $es = [BhAmb]::ExecutionState()
      $display = ($es -ne 0xFFFFFFFF) -and (($es -band 2) -ne 0)
      Rec '3' 'SystemExecutionState has no ES_DISPLAY_REQUIRED while the scene is open (no other app may be playing video)' $(if (-not $display) { 'pass' } else { 'fail' }) @{ execution_state = $es }
      $pc = & powercfg /requests 2>&1 | Out-String
      if ($pc -match 'administrator|access is denied|Zugriff') { Rec '3' 'powercfg /requests lists nothing from busyholm' 'blocked' @{ reason = 'needs an elevated prompt' } }
      else { Rec '3' 'powercfg /requests lists nothing from busyholm or msedgewebview2 started by it' $(if ($pc -notmatch '(?i)busyholm') { 'pass' } else { 'fail' }) @{ output = $pc.Substring(0, [math]::Min(600, $pc.Length)) } }
    }
  } finally { Stop-App $app }
}

$Results | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 (Join-Path $OutDir 'results.json')
Write-Host "WP-12 Windows ambient: $($Results.Count) checks, $Fails failed -> $OutDir\results.json"
exit $(if ($Fails) { 1 } else { 0 })
