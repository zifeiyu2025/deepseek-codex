param([switch]$Kill)
$procs = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'electron.exe' -and $_.CommandLine -like '*codex-deepseek*'
}
foreach ($p in $procs) {
  Write-Output ("PID=" + $p.ProcessId + " PPID=" + $p.ParentProcessId)
  if ($Kill) {
    try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch { }
  }
}
