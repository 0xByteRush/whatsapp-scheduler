# Sends one message through the WhatsApp Desktop app that's already signed in on this PC.
# Opens whatsapp://send (chat opens with the text pre-filled), focuses WhatsApp, presses Enter.
param(
  [Parameter(Mandatory)][string]$Phone,
  [Parameter(Mandatory)][string]$TextB64,
  [switch]$DraftOnly
)
$ErrorActionPreference = 'Stop'

Add-Type @"
using System; using System.Runtime.InteropServices;
public static class U {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr h);
}
"@

function Fail($msg) { [Console]::Error.WriteLine($msg); exit 1 }

function Key($vk) {
  [U]::keybd_event($vk, 0, 0, [UIntPtr]::Zero)
  [U]::keybd_event($vk, 0, 2, [UIntPtr]::Zero)
}

function ForegroundPid {
  $fpid = 0
  [void][U]::GetWindowThreadProcessId([U]::GetForegroundWindow(), [ref]$fpid)
  return $fpid
}

function Focus($hwnd) {
  if ([U]::IsIconic($hwnd)) { [void][U]::ShowWindow($hwnd, 9) } # SW_RESTORE
  # Windows only lets the foreground thread hand over focus, so borrow its input queue.
  $ignored = 0
  $fgThread = [U]::GetWindowThreadProcessId([U]::GetForegroundWindow(), [ref]$ignored)
  $me = [U]::GetCurrentThreadId()
  [void][U]::AttachThreadInput($me, $fgThread, $true)
  [void][U]::BringWindowToTop($hwnd)
  [void][U]::SetForegroundWindow($hwnd)
  [void][U]::AttachThreadInput($me, $fgThread, $false)
}

# Keystrokes can't reach apps while Windows is locked (the lock screen owns the input desktop).
$desk = [U]::OpenInputDesktop(0, $false, 0x0100)
if ($desk -eq [IntPtr]::Zero) { Fail 'The PC was locked, so WhatsApp could not be used. Keep Windows unlocked at send time.' }
[void][U]::CloseDesktop($desk)

$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($TextB64))
$uri = "whatsapp://send?phone=$Phone&text=" + [Uri]::EscapeDataString($text)

$wasRunning = [bool](Get-Process WhatsApp.Root -ErrorAction SilentlyContinue | Where-Object MainWindowHandle -ne 0)
$previous = [U]::GetForegroundWindow()

Start-Process $uri

$deadline = (Get-Date).AddSeconds(45)
do {
  Start-Sleep -Milliseconds 500
  $wa = Get-Process WhatsApp.Root -ErrorAction SilentlyContinue | Where-Object MainWindowHandle -ne 0 | Select-Object -First 1
} until ($wa -or (Get-Date) -gt $deadline)
if (-not $wa) { Fail 'WhatsApp Desktop did not open. Is it installed and signed in?' }

# Give the chat time to open and the draft to fill in (much longer on a cold start).
Start-Sleep -Seconds $(if ($wasRunning) { 4 } else { 15 })

if ($DraftOnly) { 'drafted'; exit 0 }

$hwnd = $wa.MainWindowHandle
for ($i = 0; $i -lt 3 -and (ForegroundPid) -ne $wa.Id; $i++) {
  Focus $hwnd
  Start-Sleep -Milliseconds 600
  if ((ForegroundPid) -ne $wa.Id) { Key 0x12; Start-Sleep -Milliseconds 200 } # Alt tap unlocks SetForegroundWindow
}
if ((ForegroundPid) -ne $wa.Id) { Fail 'Could not bring WhatsApp to the front to send.' }

Key 0x0D # Enter = send
Start-Sleep -Seconds 1

# Hand focus back to whatever you were using.
if ($previous -ne [IntPtr]::Zero -and $previous -ne $hwnd) { Focus $previous }
'sent'
