Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

$p = Get-Process | Where-Object { $_.MainWindowTitle -eq 'DeepSeek Codex' } | Select-Object -First 1
if (-not $p) { Write-Output 'NOT_FOUND'; exit 1 }

$root = [System.Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle)
$editCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Edit
)
$edit = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $editCond)
if (-not $edit) { Write-Output 'NO_EDIT'; exit 2 }

$edit.SetFocus()
Start-Sleep -Milliseconds 400
try {
  $vp = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  $vp.SetValue('Reply with OK only')
} catch {
  [System.Windows.Forms.SendKeys]::SendWait('Reply with OK only')
}
Start-Sleep -Milliseconds 400
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Write-Output 'SENT'