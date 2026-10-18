<#
.SYNOPSIS
  WP-02 acceptance tests on Windows (SPEC 9.1 WP-02 tests 1 to 5, plus a few extras).

.DESCRIPTION
  *** WRITTEN ON macOS. THIS SCRIPT HAS NOT BEEN RUN ON WINDOWS YET. ***
  It was only read through, never executed, so expect to fix small things (quoting, timing,
  a P/Invoke signature) the first time it runs on a real Windows desktop. Every failure it prints
  is evidence to look at, but the first red run may be the script's fault and not the app's.

  Runs the real debug binary on the real desktop of an interactive session (a GitHub windows-latest
  runner, or a Windows PC) and checks it from the outside with Win32 calls (Add-Type + P/Invoke) plus
  the app's own test log (BUSYHOLM_TEST_LOG, JSON lines: window, layer, placement, strip_visibility,
  hit_rects, clickthrough, fade, page_event, tray_rect, autostart). Real mouse clicks are used
  (SetCursorPos + SendInput), unlike macOS where they need a permission.

  PowerShell 5.1 and 7 compatible. Writes <OutDir>\results.json, prints one PASS/FAIL/INFO line per
  check and exits 1 if anything failed.

  Tests
    1  focus: a WinForms test window is foreground; the strip appearing, and a real click on a
       resident, never change the foreground window (checked at +2 s and +5 s); resident_click logged.
    2  click routing: a click on an empty strip point reaches the window beneath; a click on a
       resident reaches the strip (page_event) and not the window beneath; hover-fade on and off.
    3  geometry: the strip bottom equals the bottom of its monitor's work area (within 1 px) and it
       spans the work area's width.
    x  extras: behind_windows layer is not topmost; tray icon placed; autostart off by default.
    4  fullscreen: a borderless window covering the monitor hides the strip within 3 s (reason
       fullscreen, IsWindowVisible false); closing it brings the strip back.
    5  reserve space (AppBar): a maximised window ends exactly at the strip's top, the work area
       bottom equals the strip's top, and the work area is restored when the app goes away. The kill
       case and the graceful --exit-after case are both checked and reported separately.

.PARAMETER Binary
  Path of the built debug binary busyholm.exe.
.PARAMETER OutDir
  Where logs and results.json go (default: app\tests\out\windows-<time>).
.PARAMETER Tests
  Comma separated list, default "1,2,3,x,4,5".

.EXAMPLE
  powershell -File app\tests\windows\acceptance.ps1 -Binary app\src-tauri\target\debug\busyholm.exe
#>
param(
  [Parameter(Mandatory = $true)][string]$Binary,
  [string]$OutDir = '',
  [string]$Tests = '1,2,3,x,4,5'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Off

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppDir = (Resolve-Path (Join-Path $Here '..\..')).Path
$Repo = (Resolve-Path (Join-Path $AppDir '..')).Path
$Fixtures = Join-Path $Repo 'fixtures\contracts'
if (-not (Test-Path -LiteralPath $Binary)) { Write-Host "app binary missing: $Binary"; exit 2 }
$Binary = (Resolve-Path -LiteralPath $Binary).Path
if (-not $OutDir) { $OutDir = Join-Path $AppDir ('tests\out\windows-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = (Resolve-Path -LiteralPath $OutDir).Path
$PsExe = (Get-Process -Id $PID).Path

# ------------------------------------------------------------------------------------------------
# Native helpers (C# 5 only, so Windows PowerShell 5.1 can compile it). Shared with the test-window
# helper process through a file.
# ------------------------------------------------------------------------------------------------
$NativeSource = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class BhNative {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  public delegate bool MonProc(IntPtr hMon, IntPtr hdc, IntPtr rc, IntPtr data);

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public MOUSEINPUT mi; }

  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint action, uint param, out RECT r, uint winIni);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr mon, ref MONITORINFO mi);
  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonProc proc, IntPtr data);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] static extern int GetWindowLong(IntPtr h, int idx);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);

  static IntPtr H(long v) { return new IntPtr(v); }

  // Per-monitor DPI aware v2 (so every number below is physical pixels, like the app's). Call first.
  public static string EnableDpi() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return "per-monitor-v2"; } catch (Exception) { }
    try { if (SetProcessDPIAware()) return "system"; } catch (Exception) { }
    return "unaware";
  }

  public static long[] Fg() {
    IntPtr h = GetForegroundWindow();
    uint pid = 0;
    if (h != IntPtr.Zero) GetWindowThreadProcessId(h, out pid);
    return new long[] { h.ToInt64(), pid };
  }
  public static long PidOf(long h) { uint pid; GetWindowThreadProcessId(H(h), out pid); return pid; }
  public static string Title(long h) { StringBuilder sb = new StringBuilder(256); GetWindowText(H(h), sb, 256); return sb.ToString(); }
  public static bool Visible(long h) { return IsWindowVisible(H(h)); }
  public static int[] Rect(long h) {
    RECT r; if (!GetWindowRect(H(h), out r)) return null;
    return new int[] { r.Left, r.Top, r.Right, r.Bottom };
  }
  // Visible frame (DWMWA_EXTENDED_FRAME_BOUNDS = 9): excludes the invisible resize border of a normal window.
  public static int[] Frame(long h) {
    RECT r; if (DwmGetWindowAttribute(H(h), 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) return null;
    return new int[] { r.Left, r.Top, r.Right, r.Bottom };
  }
  public static int ExStyle(long h) { return GetWindowLong(H(h), -20); }
  public static int[] Cursor() { POINT p; GetCursorPos(out p); return new int[] { p.X, p.Y }; }
  public static bool MoveCursor(int x, int y) { return SetCursorPos(x, y); }
  public static long RootAt(int x, int y) {
    POINT p; p.X = x; p.Y = y;
    IntPtr w = WindowFromPoint(p);
    if (w == IntPtr.Zero) return 0;
    IntPtr root = GetAncestor(w, 2);
    return (root == IntPtr.Zero ? w : root).ToInt64();
  }
  // SPI_GETWORKAREA: the PRIMARY monitor's work area. {left, top, right, bottom}
  public static int[] SpiWork() {
    RECT r; if (!SystemParametersInfo(0x0030, 0, out r, 0)) return null;
    return new int[] { r.Left, r.Top, r.Right, r.Bottom };
  }
  // The monitor a window is on: {hmonitor, work l,t,r,b, monitor l,t,r,b}
  public static long[] MonitorOf(long h) {
    IntPtr m = MonitorFromWindow(H(h), 2);
    return Info(m);
  }
  static long[] Info(IntPtr m) {
    MONITORINFO mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
    if (m == IntPtr.Zero || !GetMonitorInfo(m, ref mi)) return null;
    return new long[] { m.ToInt64(), mi.rcWork.Left, mi.rcWork.Top, mi.rcWork.Right, mi.rcWork.Bottom,
                        mi.rcMonitor.Left, mi.rcMonitor.Top, mi.rcMonitor.Right, mi.rcMonitor.Bottom };
  }
  public static long[][] Monitors() {
    List<long[]> res = new List<long[]>();
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate(IntPtr m, IntPtr dc, IntPtr rc, IntPtr d) { long[] i = Info(m); if (i != null) res.Add(i); return true; }, IntPtr.Zero);
    return res.ToArray();
  }
  public static long[] WorkOfMonitor(long hmon) { return Info(H(hmon)); }
  // Top-level windows of a process with an exact title.
  public static long[] FindWindows(uint pid, string title) {
    List<long> res = new List<long>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid) {
        StringBuilder sb = new StringBuilder(256); GetWindowText(h, sb, 256);
        if (title == null || sb.ToString() == title) res.Add(h.ToInt64());
      }
      return true;
    }, IntPtr.Zero);
    return res.ToArray();
  }
  public static bool Move(long h, int x, int y, int w, int ht) { return MoveWindow(H(h), x, y, w, ht, true); }
  // Foreground rules block SetForegroundWindow from a background process; the usual workaround is to
  // press and release Alt and to share input with the current foreground thread.
  public static void ForceForeground(long hv) {
    IntPtr h = H(hv);
    IntPtr fg = GetForegroundWindow();
    uint pid; uint fgThread = fg == IntPtr.Zero ? 0 : GetWindowThreadProcessId(fg, out pid);
    uint me = GetCurrentThreadId();
    bool attached = false;
    if (fgThread != 0 && fgThread != me) attached = AttachThreadInput(me, fgThread, true);
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
    ShowWindow(h, 5);
    BringWindowToTop(h);
    SetForegroundWindow(h);
    if (attached) AttachThreadInput(me, fgThread, false);
  }
  public static void MouseButton(bool down) {
    INPUT[] a = new INPUT[1];
    a[0].type = 0;
    a[0].mi.dwFlags = down ? 0x0002u : 0x0004u;
    SendInput(1, a, Marshal.SizeOf(typeof(INPUT)));
  }
}
'@

$NativeFile = Join-Path $OutDir 'native.cs'
[IO.File]::WriteAllText($NativeFile, $NativeSource)
Add-Type -TypeDefinition $NativeSource
$DpiMode = [BhNative]::EnableDpi()

# ------------------------------------------------------------------------------------------------
# The test-window helper: a separate PowerShell process running a WinForms window, because a window
# in this script's own thread would never get its messages pumped while the script sleeps.
# Modes: plain (borderless, exact rect), fullscreen (borderless, exact monitor rect), maximized
# (normal sizable window that maximises itself). Appends one JSON line per MouseDown to -Log.
# ------------------------------------------------------------------------------------------------
$HelperSource = @'
param([int]$X, [int]$Y, [int]$W, [int]$H, [int]$Seconds, [string]$Log, [string]$Mode, [string]$Title, [string]$Stop, [string]$NativeCs)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition ([IO.File]::ReadAllText($NativeCs))
[void][BhNative]::EnableDpi()
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$script:Log = $Log
$script:Stop = $Stop
$script:Mode = $Mode
$script:Deadline = (Get-Date).AddSeconds($Seconds)
$script:Rect = @($X, $Y, $W, $H)
$script:Form = New-Object System.Windows.Forms.Form
$f = $script:Form
$f.Text = $Title
$f.StartPosition = 'Manual'
$f.BackColor = [System.Drawing.Color]::Gainsboro
$f.ShowInTaskbar = $true
if ($Mode -eq 'maximized') { $f.FormBorderStyle = 'Sizable' } else { $f.FormBorderStyle = 'None' }
$f.Location = New-Object System.Drawing.Point($X, $Y)
$f.Size = New-Object System.Drawing.Size($W, $H)
$f.add_MouseDown({
  param($s, $e)
  $p = [BhNative]::Cursor()
  $t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() / 1000.0
  $line = '{"event":"mouse_down","t":' + $t.ToString([Globalization.CultureInfo]::InvariantCulture) + ',"x":' + $p[0] + ',"y":' + $p[1] + '}'
  [IO.File]::AppendAllText($script:Log, $line + [Environment]::NewLine)
})
$f.add_Shown({
  if ($script:Mode -eq 'maximized') { $script:Form.WindowState = 'Maximized' }
  else { [void][BhNative]::Move($script:Form.Handle.ToInt64(), $script:Rect[0], $script:Rect[1], $script:Rect[2], $script:Rect[3]) }
  [BhNative]::ForceForeground($script:Form.Handle.ToInt64())
})
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 200
$script:Timer = $timer
$timer.add_Tick({
  if ((Test-Path -LiteralPath $script:Stop) -or ((Get-Date) -gt $script:Deadline)) { $script:Timer.Stop(); $script:Form.Close() }
})
$timer.Start()
[System.Windows.Forms.Application]::Run($f)
'@
$HelperFile = Join-Path $OutDir 'testwin.ps1'
[IO.File]::WriteAllText($HelperFile, $HelperSource)

# ------------------------------------------------------------------------------------------------
# Small utilities
# ------------------------------------------------------------------------------------------------
$Results = New-Object System.Collections.ArrayList

function Now-T { return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() / 1000.0 }
function Q([string]$s) { return '"' + $s + '"' }
function Sleep-Sec([double]$s) { if ($s -gt 0) { Start-Sleep -Milliseconds ([int]($s * 1000)) } }
function Sleep-Until([double]$t) { Sleep-Sec ($t - (Now-T)) }

function Record([string]$test, [string]$name, [string]$status, $detail) {
  $row = [pscustomobject]@{ test = $test; name = $name; status = $status; detail = $detail }
  [void]$Results.Add($row)
  $json = ''
  try { $json = ($detail | ConvertTo-Json -Depth 6 -Compress) } catch { $json = "$detail" }
  if ($json.Length -gt 600) { $json = $json.Substring(0, 600) + '...' }
  Write-Host ("{0,-5} {1} {2} :: {3}" -f $status.ToUpper(), $test, $name, $json)
}

function Read-Log([string]$path) {
  $out = New-Object System.Collections.ArrayList
  if (-not (Test-Path -LiteralPath $path)) { return @() }
  $fs = $null
  try {
    $fs = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    $sr = New-Object IO.StreamReader($fs)
    while ($true) {
      $line = $sr.ReadLine()
      if ($line -eq $null) { break }
      if ($line.Trim().Length -eq 0) { continue }
      try { [void]$out.Add(($line | ConvertFrom-Json)) } catch { }   # a partial last line
    }
  } catch { } finally { if ($fs) { $fs.Dispose() } }
  return $out.ToArray()
}

function Events($app, [string]$name) {
  return @(Read-Log $app.Log | Where-Object { $_.event -eq $name })
}

# Waits for the first event (since time $since) for which the predicate scriptblock returns true.
function Wait-Ev($app, [scriptblock]$pred, [double]$timeout, [double]$since = 0) {
  $end = (Now-T) + $timeout
  while ($true) {
    foreach ($e in @(Read-Log $app.Log)) {
      if ($e.t -ge $since -and (& $pred $e)) { return $e }
    }
    if ((Now-T) -ge $end) { break }
    if ($app.Proc.HasExited) { Start-Sleep -Milliseconds 100; $end = [Math]::Min($end, (Now-T) + 0.3) }
    Start-Sleep -Milliseconds 100
  }
  return $null
}

function Start-App([string]$tag, [string[]]$extra = @(), [int]$exitAfter = 90) {
  $log = Join-Path $OutDir "$tag.log"
  $data = Join-Path $OutDir "data-$tag"
  Remove-Item -LiteralPath $log -ErrorAction SilentlyContinue
  $env:BUSYHOLM_TEST_LOG = $log
  $argList = @('--data-dir', (Q $data), '--mock-collector', (Q $Fixtures), '--mock-static',
               '--strip-page', 'placeholder/strip.html', '--test-freeze', '--test-fixed-rect',
               '--exit-after', "$exitAfter") + $extra
  $p = Start-Process -FilePath $Binary -ArgumentList ($argList -join ' ') -PassThru `
        -RedirectStandardOutput (Join-Path $OutDir "$tag.stdout") -RedirectStandardError (Join-Path $OutDir "$tag.stderr")
  return @{ Proc = $p; Pid = [uint32]$p.Id; Log = $log; Tag = $tag }
}

function Stop-App($app) {
  if ($app -and $app.Proc -and -not $app.Proc.HasExited) {
    try { Stop-Process -Id $app.Proc.Id -Force -ErrorAction SilentlyContinue } catch { }
    try { [void]$app.Proc.WaitForExit(5000) } catch { }
  }
}

function Find-Strip($app, [double]$timeout = 10) {
  $end = (Now-T) + $timeout
  while ($true) {
    $hs = @([BhNative]::FindWindows($app.Pid, 'Busyholm strip'))
    if ($hs.Count -gt 0) { return [long]$hs[0] }
    if ((Now-T) -ge $end) { return 0 }
    Start-Sleep -Milliseconds 150
  }
}

function Wait-Shown($app, [double]$timeout = 30) {
  return Wait-Ev $app { param($e) $e.event -eq 'strip_visibility' -and $e.data.visible -eq $true } $timeout
}

function Wait-Rects($app, [double]$timeout = 20) {
  return Wait-Ev $app { param($e) $e.event -eq 'hit_rects' -and $e.data.count -gt 0 } $timeout
}

function New-TestWindow([string]$tag, [int]$x, [int]$y, [int]$w, [int]$h, [string]$mode, [int]$seconds) {
  $log = Join-Path $OutDir "$tag.jsonl"
  $stop = Join-Path $OutDir "$tag.stop"
  Remove-Item -LiteralPath $log, $stop -ErrorAction SilentlyContinue
  $title = "BH-TEST-$tag"
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', (Q $HelperFile),
               '-X', $x, '-Y', $y, '-W', $w, '-H', $h, '-Seconds', $seconds, '-Log', (Q $log), '-Mode', $mode,
               '-Title', (Q $title), '-Stop', (Q $stop), '-NativeCs', (Q $NativeFile))
  $p = Start-Process -FilePath $PsExe -ArgumentList ($argList -join ' ') -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $OutDir "$tag.stdout") -RedirectStandardError (Join-Path $OutDir "$tag.stderr")
  $tw = @{ Proc = $p; Pid = [uint32]$p.Id; Log = $log; Stop = $stop; Title = $title; Hwnd = [long]0 }
  $end = (Now-T) + 30
  while ((Now-T) -lt $end) {
    foreach ($h2 in @([BhNative]::FindWindows($tw.Pid, $title))) {
      if ([BhNative]::Visible([long]$h2)) { $tw.Hwnd = [long]$h2 }
    }
    if ($tw.Hwnd -ne 0) { break }
    if ($p.HasExited) { break }
    Start-Sleep -Milliseconds 200
  }
  return $tw
}

function Stop-TestWindow($tw) {
  if (-not $tw) { return }
  try { Set-Content -LiteralPath $tw.Stop -Value 'stop' } catch { }
  try { if (-not $tw.Proc.WaitForExit(4000)) { Stop-Process -Id $tw.Proc.Id -Force -ErrorAction SilentlyContinue } } catch { }
}

function Mouse-Downs($tw) { return @(Read-Log $tw.Log | Where-Object { $_.event -eq 'mouse_down' }).Count }

function Set-Foreground([long]$hwnd, [double]$timeout = 8) {
  $end = (Now-T) + $timeout
  while ((Now-T) -lt $end) {
    $fg = [BhNative]::Fg()
    if ($fg[0] -eq $hwnd) { return $true }
    [BhNative]::ForceForeground($hwnd)
    Start-Sleep -Milliseconds 300
  }
  return ([BhNative]::Fg()[0] -eq $hwnd)
}

function Fg-Info {
  $fg = [BhNative]::Fg()
  return @{ hwnd = $fg[0]; pid = $fg[1]; title = [BhNative]::Title($fg[0]) }
}

function Move-Cursor([double]$x, [double]$y) { [void][BhNative]::MoveCursor([int][Math]::Round($x), [int][Math]::Round($y)) }

function Click-Here {
  [BhNative]::MouseButton($true)
  Start-Sleep -Milliseconds 60
  [BhNative]::MouseButton($false)
}

# The stable test sprite and an empty point, both in physical screen pixels.
# hit_rects are CSS px relative to the strip page; physical = window origin + css * scale.
function Get-Targets($app, [long]$strip) {
  $rc = [BhNative]::Rect($strip)
  $hr = @(Events $app 'hit_rects') | Select-Object -Last 1
  $pl = @(Events $app 'placement') | Select-Object -Last 1
  $rects = @($hr.data.rects)
  if ($rects.Count -gt 0 -and -not ($rects[0] -is [System.Array])) { $rects = @(, $rects) }   # one flat rect
  $widthPx = $rc[2] - $rc[0]
  $vp = @($hr.data.viewport)
  $scale = [double]$pl.data.scale
  if ($vp.Count -ge 1 -and [double]$vp[0] -gt 0) { $scale = $widthPx / [double]$vp[0] }
  $cssW = $widthPx / $scale
  $best = $null
  foreach ($r in $rects) {
    if ($best -eq $null -or [Math]::Abs($r[0] + $r[2] / 2 - $cssW / 2) -lt [Math]::Abs($best[0] + $best[2] / 2 - $cssW / 2)) { $best = $r }
  }
  $sprite = @(($rc[0] + ($best[0] + $best[2] / 2) * $scale), ($rc[1] + ($best[1] + $best[3] / 2) * $scale))
  $empty = $null
  foreach ($fx in @(0.05, 0.15, 0.3, 0.7, 0.9)) {
    $px = $cssW * $fx; $py = 10.0
    $hit = $false
    foreach ($r in $rects) { if ($r[0] -le $px -and $px -lt $r[0] + $r[2] -and $r[1] -le $py -and $py -lt $r[1] + $r[3]) { $hit = $true } }
    if (-not $hit) { $empty = @(($rc[0] + $px * $scale), ($rc[1] + $py * $scale)); break }
  }
  return @{ Rect = $rc; Scale = $scale; Sprite = $sprite; Empty = $empty; Rects = $rects; PlacementScale = $pl.data.scale }
}

# ------------------------------------------------------------------------------------------------
# Test 1: focus is never taken
# ------------------------------------------------------------------------------------------------
function Test-1 {
  $tw = $null; $app = $null
  $orig = [BhNative]::Cursor()
  try {
    $tw = New-TestWindow 't1-testwin' 200 200 480 320 'plain' 120
    if ($tw.Hwnd -eq 0 -or -not (Set-Foreground $tw.Hwnd)) {
      Record '1' 'stage: WinForms test window is foreground' 'fail' @{ reason = 'could not make the test window the foreground window'; fg = (Fg-Info) }
      return
    }
    $app = Start-App 't1-focus'
    $shown = Wait-Shown $app
    if (-not $shown) { Record '1' 'foreground unchanged after the strip appears' 'fail' @{ reason = 'strip never reported visible'; alive = (-not $app.Proc.HasExited) }; return }
    $t0 = $shown.t
    $samples = @{}
    foreach ($at in @(2.0, 5.0)) {
      Sleep-Until ($t0 + $at)
      $samples["${at}s"] = (Fg-Info)
    }
    $same = $true
    foreach ($k in $samples.Keys) { if ($samples[$k].hwnd -ne $tw.Hwnd) { $same = $false } }
    Record '1' 'foreground window unchanged 2 s and 5 s after the strip appears' $(if ($same) { 'pass' } else { 'fail' }) @{ test_window = $tw.Hwnd; samples = $samples }

    $win = @(Events $app 'window' | Where-Object { $_.data.label -eq 'strip' }) | Select-Object -Last 1
    $d = $win.data
    $struct = ($d.noactivate -eq $true -and $d.toolwindow -eq $true -and $d.topmost -eq $true)
    Record '1' 'strip has WS_EX_NOACTIVATE and WS_EX_TOOLWINDOW (structural)' $(if ($struct) { 'pass' } else { 'fail' }) @{ window_event = $d }

    $strip = Find-Strip $app
    if ($strip -eq 0 -or -not (Wait-Rects $app)) { Record '1' 'foreground unchanged after a real click on a resident' 'fail' @{ reason = 'no strip window or no hit rects' }; return }
    Sleep-Sec 1.0
    $g = Get-Targets $app $strip
    Move-Cursor $g.Sprite[0] ($g.Sprite[1] - 30)
    Sleep-Sec 0.5
    Move-Cursor $g.Sprite[0] $g.Sprite[1]
    Sleep-Sec 1.0
    $tc = Now-T
    Click-Here
    $got = @{}
    foreach ($at in @(2.0, 5.0)) {
      Sleep-Until ($tc + $at)
      $got["${at}s"] = (Fg-Info)
    }
    $clicked = (Wait-Ev $app { param($e) $e.event -eq 'page_event' -and $e.data.name -eq 'resident_click' } 2 ($tc - 0.2)) -ne $null
    $same2 = $true
    foreach ($k in $got.Keys) { if ($got[$k].hwnd -ne $tw.Hwnd) { $same2 = $false } }
    Record '1' 'foreground unchanged 2 s and 5 s after a real click on a resident, and the strip got the click' $(if ($same2 -and $clicked) { 'pass' } else { 'fail' }) @{ samples = $got; strip_received_click = $clicked; click_at = $g.Sprite }
  } finally {
    [void][BhNative]::MoveCursor($orig[0], $orig[1])
    Stop-App $app
    Stop-TestWindow $tw
  }
}

# ------------------------------------------------------------------------------------------------
# Test 2: click routing
# ------------------------------------------------------------------------------------------------
function Test-2 {
  $app = Start-App 't2-click'
  $tw = $null
  $orig = [BhNative]::Cursor()
  try {
    if (-not (Wait-Shown $app) -or -not (Wait-Rects $app)) {
      Record '2' 'click routing' 'fail' @{ reason = 'strip or hit rects never reported'; alive = (-not $app.Proc.HasExited) }; return
    }
    $strip = Find-Strip $app
    if ($strip -eq 0) { Record '2' 'click routing' 'fail' @{ reason = 'no strip window' }; return }
    Sleep-Sec 1.0
    $g = Get-Targets $app $strip
    if ($g.Empty -eq $null) { Record '2' 'click routing' 'fail' @{ reason = 'no empty strip point found'; rects = $g.Rects }; return }
    $rc = $g.Rect
    # A plain window exactly under the strip, recording MouseDown.
    $tw = New-TestWindow 't2-testwin' $rc[0] $rc[1] ($rc[2] - $rc[0]) ($rc[3] - $rc[1]) 'plain' 100
    if ($tw.Hwnd -eq 0) { Record '2' 'click routing' 'fail' @{ reason = 'test window never appeared' }; return }
    Sleep-Sec 1.5

    # 2a: empty strip point -> the window beneath (also dwell > 400 ms for hover-fade)
    $before = Mouse-Downs $tw
    $stripClicksBefore = @(Events $app 'page_event' | Where-Object { $_.data.name -eq 'resident_click' }).Count
    $tm = Now-T
    Move-Cursor $g.Empty[0] $g.Empty[1]
    Sleep-Sec 1.4
    $fadeOn = (Wait-Ev $app { param($e) $e.event -eq 'fade' -and $e.data.on -eq $true } 1 ($tm - 0.1)) -ne $null
    $rootAtEmpty = [BhNative]::RootAt([int]$g.Empty[0], [int]$g.Empty[1])
    Click-Here
    Sleep-Sec 0.9
    $gotBeneath = (Mouse-Downs $tw) -gt $before
    $stripClicksAfter = @(Events $app 'page_event' | Where-Object { $_.data.name -eq 'resident_click' }).Count
    $emptyOk = $gotBeneath -and ($stripClicksAfter -eq $stripClicksBefore)
    Record '2' 'click on an empty strip point reaches the window beneath, not the strip' $(if ($emptyOk) { 'pass' } else { 'fail' }) @{
      point = $g.Empty; window_beneath_got_it = $gotBeneath; strip_got_it = ($stripClicksAfter -ne $stripClicksBefore)
      window_at_point = $rootAtEmpty; strip_hwnd = $strip; test_window = $tw.Hwnd }

    # 2b: leave the strip -> fade off
    $tl = Now-T
    Move-Cursor $g.Empty[0] ($rc[1] - 150)
    Sleep-Sec 1.0
    $fadeOff = (Wait-Ev $app { param($e) $e.event -eq 'fade' -and $e.data.on -eq $false } 1 ($tl - 0.1)) -ne $null
    Record '2' 'hover-fade turns on after 400 ms over empty strip and off on leave' $(if ($fadeOn -and $fadeOff) { 'pass' } else { 'fail' }) @{ fade_on = $fadeOn; fade_off = $fadeOff }

    # 2c: resident -> the strip, not the window beneath
    $before = Mouse-Downs $tw
    $clicksBefore = @(Events $app 'page_event' | Where-Object { $_.data.name -eq 'resident_click' }).Count
    Move-Cursor $g.Sprite[0] ($g.Sprite[1] - 30)
    Sleep-Sec 0.5
    $ts = Now-T
    Move-Cursor $g.Sprite[0] $g.Sprite[1]
    Sleep-Sec 1.0
    $ct = @(Events $app 'clickthrough' | Where-Object { $_.t -ge ($ts - 0.1) }) | Select-Object -Last 1
    $clickable = ($ct -ne $null -and $ct.data.ignore -eq $false)
    $tc = Now-T
    Click-Here
    $stripGot = (Wait-Ev $app { param($e) $e.event -eq 'page_event' -and $e.data.name -eq 'resident_click' } 3 ($tc - 0.2)) -ne $null
    Sleep-Sec 0.5
    $beneathGot = (Mouse-Downs $tw) -gt $before
    Record '2' 'click on a resident reaches the strip (resident_click) and not the window beneath' $(if ($stripGot -and -not $beneathGot) { 'pass' } else { 'fail' }) @{
      point = $g.Sprite; strip_got_it = $stripGot; window_beneath_got_it = $beneathGot; clickthrough_ignore_false_before_click = $clickable
      window_at_point = [BhNative]::RootAt([int]$g.Sprite[0], [int]$g.Sprite[1]); strip_hwnd = $strip }
  } finally {
    [void][BhNative]::MoveCursor($orig[0], $orig[1])
    Stop-TestWindow $tw
    Stop-App $app
  }
}

# ------------------------------------------------------------------------------------------------
# Test 3: geometry against the work area
# ------------------------------------------------------------------------------------------------
function Test-3 {
  $app = Start-App 't3-geometry'
  try {
    if (-not (Wait-Shown $app)) { Record '3' 'strip bottom equals the work-area bottom' 'fail' @{ reason = 'strip never shown'; alive = (-not $app.Proc.HasExited) }; return }
    Sleep-Sec 1.0
    $strip = Find-Strip $app
    if ($strip -eq 0) { Record '3' 'strip bottom equals the work-area bottom' 'fail' @{ reason = 'no strip window' }; return }
    $r = [BhNative]::Rect($strip)
    $mon = [BhNative]::MonitorOf($strip)          # hmon, work l t r b, monitor l t r b
    $wl = $mon[1]; $wt = $mon[2]; $wr = $mon[3]; $wb = $mon[4]
    $bottomOk = [Math]::Abs($r[3] - $wb) -le 1
    $widthOk = [Math]::Abs($r[0] - $wl) -le 1 -and [Math]::Abs($r[2] - $wr) -le 1
    $pl = @(Events $app 'placement') | Select-Object -Last 1
    $want = @($pl.data.rect_px)
    $matchesApp = ($want.Count -eq 4) -and ([Math]::Abs($r[0] - $want[0]) -le 1) -and ([Math]::Abs($r[1] - $want[1]) -le 1) -and ([Math]::Abs(($r[2] - $r[0]) - $want[2]) -le 1) -and ([Math]::Abs(($r[3] - $r[1]) - $want[3]) -le 1)
    Record '3' 'strip bottom equals the work-area bottom of its monitor (within 1 px)' $(if ($bottomOk) { 'pass' } else { 'fail' }) @{
      strip_rect = $r; work_area = @($wl, $wt, $wr, $wb); monitor = @($mon[5], $mon[6], $mon[7], $mon[8]); spi_primary_work = [BhNative]::SpiWork(); dpi_mode = $DpiMode; scale = $pl.data.scale }
    Record '3' 'strip spans the work area width' $(if ($widthOk) { 'pass' } else { 'fail' }) @{ strip_rect = $r; work_area = @($wl, $wt, $wr, $wb) }
    Record '3' 'strip window rectangle equals the placement the app logged' $(if ($matchesApp) { 'pass' } else { 'fail' }) @{ strip_rect = $r; logged_rect_px = $want }
    Record '3' 'other matrix cells (taskbar left or top, auto-hide, 150% scale)' 'info' @{ reason = 'would change this machine''s taskbar and display settings; covered by the pure geometry matrix (cargo test --test geometry)' }
  } finally { Stop-App $app }
}

# ------------------------------------------------------------------------------------------------
# Test x: behind-windows layer, tray, autostart
# ------------------------------------------------------------------------------------------------
function Test-X {
  $app = Start-App 'x-behind' @('--layer', 'behind_windows')
  try {
    $lay = Wait-Ev $app { param($e) $e.event -eq 'layer' } 25
    Wait-Shown $app | Out-Null
    Sleep-Sec 1.0
    $strip = Find-Strip $app
    $ex = if ($strip -ne 0) { [BhNative]::ExStyle($strip) } else { 0 }
    $topmost = (($ex -band 0x8) -ne 0)
    $ok = $lay -ne $null -and $lay.data.effective -eq 'behind_windows' -and $strip -ne 0 -and -not $topmost
    Record 'x' 'behind-windows layer: the strip is not topmost' $(if ($ok) { 'pass' } else { 'fail' }) @{ layer_event = $(if ($lay) { $lay.data } else { $null }); ex_style = ('0x{0:x8}' -f $ex); topmost = $topmost }
    $tray = Wait-Ev $app { param($e) $e.event -eq 'tray_rect' -and $e.data.rect -ne $null } 6
    $auto = Wait-Ev $app { param($e) $e.event -eq 'autostart' } 6
    $ok2 = ($tray -ne $null) -and ($auto -ne $null) -and ($auto.data.enabled -eq $false)
    Record 'x' 'tray icon placed by the OS; autostart off by default' $(if ($ok2) { 'pass' } else { 'fail' }) @{ tray = $(if ($tray) { $tray.data } else { $null }); autostart = $(if ($auto) { $auto.data } else { $null }) }
  } finally { Stop-App $app }
}

# ------------------------------------------------------------------------------------------------
# Test 4: hidden while another app is fullscreen
# ------------------------------------------------------------------------------------------------
function Test-4 {
  $app = Start-App 't4-fullscreen' @() 150
  $tw = $null
  try {
    if (-not (Wait-Shown $app)) { Record '4' 'the strip hides while another app is fullscreen' 'fail' @{ reason = 'strip never shown'; alive = (-not $app.Proc.HasExited) }; return }
    Sleep-Sec 1.0
    $strip = Find-Strip $app
    if ($strip -eq 0) { Record '4' 'the strip hides while another app is fullscreen' 'fail' @{ reason = 'no strip window' }; return }
    $visBefore = [BhNative]::Visible($strip)
    $mon = [BhNative]::MonitorOf($strip)
    $tStart = Now-T
    $tw = New-TestWindow 't4-fullscreen-win' ([int]$mon[5]) ([int]$mon[6]) ([int]($mon[7] - $mon[5])) ([int]($mon[8] - $mon[6])) 'fullscreen' 90
    $fgOk = ($tw.Hwnd -ne 0) -and (Set-Foreground $tw.Hwnd)
    $tFg = Now-T
    if (-not $fgOk) { Record '4' 'the strip hides while another app is fullscreen' 'fail' @{ reason = 'could not make the fullscreen test window foreground'; fg = (Fg-Info) }; return }
    $hidden = Wait-Ev $app { param($e) $e.event -eq 'strip_visibility' -and $e.data.visible -eq $false -and $e.data.reason -eq 'fullscreen' } 3 ($tStart - 0.5)
    Sleep-Sec 0.4
    $visDuring = [BhNative]::Visible($strip)
    $rect = [BhNative]::Rect($tw.Hwnd)
    $okHide = ($visBefore -eq $true) -and ($hidden -ne $null) -and ($visDuring -eq $false)
    Record '4' 'a borderless window covering the monitor hides the strip within 3 s (reason fullscreen)' $(if ($okHide) { 'pass' } else { 'fail' }) @{
      visible_before = $visBefore; hidden_event = ($hidden -ne $null); hide_latency_s = $(if ($hidden) { [Math]::Round($hidden.t - $tFg, 2) } else { $null })
      visible_during = $visDuring; fullscreen_window_rect = $rect; monitor = @($mon[5], $mon[6], $mon[7], $mon[8]); fg = (Fg-Info) }
    if ($hidden -eq $null) { return }
    Stop-TestWindow $tw
    $tw = $null
    $back = Wait-Ev $app { param($e) $e.event -eq 'strip_visibility' -and $e.data.visible -eq $true } 8 $hidden.t
    Sleep-Sec 0.8
    $visAfter = [BhNative]::Visible($strip)
    Record '4' 'closing the fullscreen window brings the strip back' $(if ($back -ne $null -and $visAfter) { 'pass' } else { 'fail' }) @{ shown_again_event = ($back -ne $null); visible_after = $visAfter }

    # FIX-C M15: fullscreen evidence is per monitor. Needs two monitors; written on macOS, not yet run on Windows.
    $mons = @([BhNative]::Monitors())
    $other = $mons | Where-Object { [long]$_[0] -ne [long]$mon[0] } | Select-Object -First 1
    if ($other -eq $null) {
      Record '4' 'fullscreen evidence is per monitor (a fullscreen window on the other monitor does not hide the strip; one on the strip monitor stays detected when focus moves away)' 'blocked' @{ reason = 'needs two monitors'; monitors = $mons.Count }
    } else {
      # a) borderless fullscreen window on the OTHER monitor, in front: the strip's monitor shows no fullscreen app.
      $twB = New-TestWindow 't4-fullscreen-other' ([int]$other[5]) ([int]$other[6]) ([int]($other[7] - $other[5])) ([int]($other[8] - $other[6])) 'fullscreen' 40
      try {
        [void](Set-Foreground $twB.Hwnd)
        Sleep-Sec 3.0
        $visOther = [BhNative]::Visible($strip)
        Record '4' 'a fullscreen window on the other monitor does not hide the strip' $(if ($visOther) { 'pass' } else { 'fail' }) @{ strip_visible = $visOther; other_monitor = @($other[5], $other[6], $other[7], $other[8]) }
      } finally { Stop-TestWindow $twB }
      # b) fullscreen on the strip's monitor, then focus moves to a small window on the other monitor: still detected.
      $twA = New-TestWindow 't4-fullscreen-here' ([int]$mon[5]) ([int]$mon[6]) ([int]($mon[7] - $mon[5])) ([int]($mon[8] - $mon[6])) 'fullscreen' 40
      $twS = $null
      try {
        [void](Set-Foreground $twA.Hwnd)
        $h1 = Wait-Ev $app { param($e) $e.event -eq 'strip_visibility' -and $e.data.visible -eq $false -and $e.data.reason -eq 'fullscreen' } 4 (Now-T)
        $twS = New-TestWindow 't4-small-other' ([int]$other[5] + 100) ([int]$other[6] + 100) 600 400 'plain' 40
        [void](Set-Foreground $twS.Hwnd)
        Sleep-Sec 3.0
        $visStill = [BhNative]::Visible($strip)
        Record '4' 'a fullscreen window stays detected after the foreground moves to the other monitor' $(if (($h1 -ne $null) -and (-not $visStill)) { 'pass' } else { 'fail' }) @{ hidden_event = ($h1 -ne $null); strip_visible_after_focus_moved = $visStill }
      } finally { Stop-TestWindow $twS; Stop-TestWindow $twA }
    }
  } finally {
    Stop-TestWindow $tw
    Stop-App $app
  }
}

# ------------------------------------------------------------------------------------------------
# Test 5: reserve space (AppBar)
# ------------------------------------------------------------------------------------------------
function Work-Bottoms {
  $h = @{}
  foreach ($m in @([BhNative]::Monitors())) { $h[[long]$m[0]] = [long]$m[4] }
  return $h
}

function Wait-WorkRestored([long]$hmon, [long]$wantBottom, [double]$timeout) {
  $end = (Now-T) + $timeout
  while ($true) {
    $m = [BhNative]::WorkOfMonitor($hmon)
    if ($m -ne $null -and [Math]::Abs($m[4] - $wantBottom) -le 1) { return $true }
    if ((Now-T) -ge $end) { return $false }
    Start-Sleep -Milliseconds 250
  }
}

function Test-5 {
  # Run A: reserve, maximise a window, then kill the app.
  $base = Work-Bottoms
  $app = Start-App 't5-reserve' @('--layer', 'reserve_space') 120
  $tw = $null
  $hmon = 0
  try {
    $lay = Wait-Ev $app { param($e) $e.event -eq 'layer' } 25
    if (-not $lay -or $lay.data.effective -ne 'reserve_space' -or $lay.data.reserved -eq $null) {
      Record '5' 'reserve space takes effect (AppBar registered)' 'fail' @{ layer_event = $(if ($lay) { $lay.data } else { $null }); alive = (-not $app.Proc.HasExited) }
      return
    }
    Wait-Shown $app | Out-Null
    Sleep-Sec 1.5
    $strip = Find-Strip $app
    if ($strip -eq 0) { Record '5' 'reserve space' 'fail' @{ reason = 'no strip window' }; return }
    $r = [BhNative]::Rect($strip)
    $mon = [BhNative]::MonitorOf($strip)
    $hmon = [long]$mon[0]
    $workBottom = $mon[4]
    $stripTop = $r[1]
    Record '5' 'with reserve space the work-area bottom equals the strip top' $(if ([Math]::Abs($workBottom - $stripTop) -le 1) { 'pass' } else { 'fail' }) @{
      work_area_bottom = $workBottom; strip_rect = $r; baseline_work_bottom = $base[$hmon]; granted = $lay.data.reserved }
    $tw = New-TestWindow 't5-maximized' ([int]($mon[1] + 60)) ([int]($mon[2] + 60)) 700 420 'maximized' 90
    if ($tw.Hwnd -eq 0) { Record '5' 'a maximised window ends at the strip top' 'fail' @{ reason = 'test window never appeared' } }
    else {
      Sleep-Sec 2.0
      $fr = [BhNative]::Frame($tw.Hwnd)
      $wr = [BhNative]::Rect($tw.Hwnd)
      $mon2 = [BhNative]::MonitorOf($strip)
      $bottom = if ($fr -ne $null) { $fr[3] } else { $wr[3] }
      Record '5' 'a maximised window ends exactly at the strip top (within 1 px)' $(if ([Math]::Abs($bottom - $stripTop) -le 1) { 'pass' } else { 'fail' }) @{
        window_visible_frame = $fr; window_rect = $wr; strip_top = $stripTop; work_area_bottom_now = $mon2[4] }
      Stop-TestWindow $tw
      $tw = $null
    }
    # Kill: no cleanup runs.
    Stop-App $app
    $restoredKill = Wait-WorkRestored $hmon $base[$hmon] 10
    Record '5' 'work area restored after the app is killed (no cleanup runs)' $(if ($restoredKill) { 'pass' } else { 'info' }) @{
      restored = $restoredKill; work_bottom_now = ([BhNative]::WorkOfMonitor($hmon))[4]; baseline = $base[$hmon]
      note = 'when this is not restored, a killed app leaves its AppBar reservation until Explorer restarts; the graceful exit below is the product path' }
  } finally {
    Stop-TestWindow $tw
    Stop-App $app
  }

  # Run B: graceful exit through --exit-after, which runs the app's own cleanup (reserve_space(None)).
  $base2 = Work-Bottoms
  $app = Start-App 't5-exit' @('--layer', 'reserve_space') 14
  try {
    $lay = Wait-Ev $app { param($e) $e.event -eq 'layer' } 25
    Wait-Shown $app | Out-Null
    Sleep-Sec 1.5
    $strip = Find-Strip $app
    if (-not $lay -or $strip -eq 0) { Record '5' 'work area restored after a graceful exit' 'fail' @{ reason = 'reserve run B did not start'; layer = $(if ($lay) { $lay.data } else { $null }) }; return }
    $mon = [BhNative]::MonitorOf($strip)
    $hmon2 = [long]$mon[0]
    $reservedNow = ($base2[$hmon2] - $mon[4]) -ge 20
    $exited = $app.Proc.WaitForExit(40000)
    $restored = Wait-WorkRestored $hmon2 $base2[$hmon2] 8
    Record '5' 'work area restored after the app exits normally (--exit-after)' $(if ($reservedNow -and $exited -and $restored) { 'pass' } else { 'fail' }) @{
      reserved_while_running = $reservedNow; exited = $exited; restored = $restored; baseline = $base2[$hmon2]; work_bottom_now = ([BhNative]::WorkOfMonitor($hmon2))[4] }
  } finally { Stop-App $app }
}

# ------------------------------------------------------------------------------------------------
Write-Host "WP-02 Windows acceptance (written on macOS, first run on Windows may need script fixes)"
Write-Host "PowerShell $($PSVersionTable.PSVersion), DPI awareness: $DpiMode, binary: $Binary"
Write-Host "Output: $OutDir"
$want = $Tests.Split(',') | ForEach-Object { $_.Trim() }
$order = @{ '1' = ${function:Test-1}; '2' = ${function:Test-2}; '3' = ${function:Test-3}; 'x' = ${function:Test-X}; '4' = ${function:Test-4}; '5' = ${function:Test-5} }
foreach ($k in @('1', '2', '3', 'x', '4', '5')) {
  if ($want -contains $k) {
    try { & $order[$k] }
    catch { Record $k 'harness error' 'fail' @{ error = $_.Exception.Message; at = $_.InvocationInfo.PositionMessage } }   # a crash in the harness is a failure, never a pass
  }
}

ConvertTo-Json -InputObject @($Results) -Depth 8 | Set-Content -LiteralPath (Join-Path $OutDir 'results.json') -Encoding UTF8
$nPass = @($Results | Where-Object { $_.status -eq 'pass' }).Count
$nFail = @($Results | Where-Object { $_.status -eq 'fail' }).Count
$nInfo = @($Results | Where-Object { $_.status -eq 'info' }).Count
Write-Host ("`nWP-02 Windows acceptance: {0} pass, {1} fail, {2} info  ->  {3}" -f $nPass, $nFail, $nInfo, (Join-Path $OutDir 'results.json'))
if ($nFail -gt 0) { exit 1 }
exit 0
