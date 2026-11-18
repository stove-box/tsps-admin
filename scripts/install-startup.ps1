# Adds (or with -Remove, deletes) a shortcut in your Startup folder so the admin panel starts
# when you sign in to Windows. Servers marked "Start with panel" then start with it.
param([switch]$Remove)
$startup = [Environment]::GetFolderPath('Startup')
$link = Join-Path $startup 'tsps admin.lnk'
if ($Remove) {
  if (Test-Path $link) { Remove-Item $link; "Removed $link" } else { "No shortcut at $link" }
  return
}
$root = Split-Path -Parent $PSScriptRoot
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($link)
$shortcut.TargetPath = Join-Path $root 'start-panel.cmd'
$shortcut.WorkingDirectory = $root
$shortcut.WindowStyle = 7  # minimized
$shortcut.Save()
"Created $link"
