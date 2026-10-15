# Ends the SimplySign Desktop certificate session on a CI runner (.github/workflows/desktop.yml, package-win): stops
# the process, waits for it to exit, and fails unless it is gone, so a session that outlived the build is an error
# rather than a silent risk. Safe to run when SimplySign was never started.
$ErrorActionPreference = 'Stop'
Get-Process SimplySignDesktop -ErrorAction SilentlyContinue | Stop-Process -Force
Wait-Process -Name SimplySignDesktop -Timeout 15 -ErrorAction SilentlyContinue
if (Get-Process SimplySignDesktop -ErrorAction SilentlyContinue) {
  Write-Output '::error title=Certum::SimplySign Desktop is still running after Stop-Process: the certificate session may still be live'
  exit 1
}
Write-Output 'SimplySign Desktop is not running (certificate session ended)'
