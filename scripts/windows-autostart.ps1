# Registers a Windows scheduled task that starts the scheduler when you sign in and
# restarts it if it crashes. Run once:  powershell -ExecutionPolicy Bypass -File scripts\windows-autostart.ps1
# Remove with:                         powershell -ExecutionPolicy Bypass -File scripts\windows-autostart.ps1 -Remove
param([switch]$Remove)

$taskName = 'WhatsApp Scheduler'
if ($Remove) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  "Removed '$taskName'."
  exit 0
}

$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
New-Item -ItemType Directory -Force (Join-Path $root 'data') | Out-Null
$log = Join-Path $root 'data\scheduler.log'

# cmd wrapper so output lands in a log file.
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -WorkingDirectory $root `
  -Argument "/c `"`"$node`" --env-file-if-exists=.env src\index.js >> `"$log`" 2>&1`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
  -Principal $principal -Description 'Sends scheduled WhatsApp messages' -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
"Registered and started '$taskName'. Logs: $log"
