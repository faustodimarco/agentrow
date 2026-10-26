# agentrow installer for Windows. agentrow needs a Unix PTY, so it runs inside WSL;
# this script installs the Linux build there and adds an `agentrow` command to Windows.
#   irm https://raw.githubusercontent.com/faustodimarco/agentrow/main/install.ps1 | iex
# Private repo: irm -Headers @{Authorization="Bearer $(gh auth token)"} <url> | iex
# Downloads use $env:GITHUB_TOKEN, or `gh auth token` when the GitHub CLI is installed.

function Install-Agentrow {
  $ErrorActionPreference = "Stop"
  $Repo = if ($env:AGENTROW_REPO) { $env:AGENTROW_REPO } else { "faustodimarco/agentrow" }

  if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    Write-Host "WSL is not available. In an administrator PowerShell run:  wsl --install" -ForegroundColor Yellow
    Write-Host "Reboot, finish the Ubuntu setup, then run this installer again."
    return
  }
  wsl.exe -e true 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "WSL has no Linux distribution yet. Run:  wsl --install -d Ubuntu" -ForegroundColor Yellow
    Write-Host "Finish the Ubuntu setup (create your user), then run this installer again."
    return
  }

  $Token = $env:GITHUB_TOKEN
  if (-not $Token -and (Get-Command gh -ErrorAction SilentlyContinue)) { $Token = (gh auth token 2>$null) }

  # Hand the token and repo to WSL via WSLENV and run the Linux installer there.
  $env:AGENTROW_GITHUB_TOKEN = "$Token"
  $env:AGENTROW_REPO = $Repo
  $env:WSLENV = "AGENTROW_GITHUB_TOKEN/u:AGENTROW_REPO/u:$env:WSLENV"
  $linux = 'set -e
command -v curl >/dev/null || { echo "agentrow install: curl is missing in WSL (sudo apt install curl)" >&2; exit 1; }
url="https://raw.githubusercontent.com/$AGENTROW_REPO/main/install.sh"
if [ -n "$AGENTROW_GITHUB_TOKEN" ]; then
  curl -fsSL -H "Authorization: Bearer $AGENTROW_GITHUB_TOKEN" "$url" | GITHUB_TOKEN="$AGENTROW_GITHUB_TOKEN" sh
else
  curl -fsSL "$url" | sh
fi'
  wsl.exe -e bash -c $linux
  if ($LASTEXITCODE -ne 0) { Write-Host "agentrow install inside WSL failed." -ForegroundColor Red; return }

  # Windows shim: `agentrow ...` in cmd/PowerShell runs the WSL binary through a login shell.
  $BinDir = Join-Path $env:LOCALAPPDATA "agentrow\bin"
  New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
  Set-Content -Encoding ASCII -Path (Join-Path $BinDir "agentrow.cmd") -Value @'
@echo off
wsl.exe -e bash -lc "exec \"$HOME/.local/bin/agentrow\" \"$@\"" agentrow %*
'@
  $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if (-not ($UserPath -split ";" | Where-Object { $_ -eq $BinDir })) {
    [Environment]::SetEnvironmentVariable("Path", "$UserPath;$BinDir", "User")
    $env:Path = "$env:Path;$BinDir"
  }

  # WSL stops its VM when no Windows process holds it open, which would stop the
  # daemon and its agents. A logon task starts the daemon and keeps WSL alive;
  # conhost --headless keeps wsl.exe from opening a console window.
  $Action = New-ScheduledTaskAction -Execute "conhost.exe" `
    -Argument '--headless wsl.exe -e bash -lc "$HOME/.local/bin/agentrow start >/dev/null 2>&1; exec sleep infinity"'
  $Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden
  Register-ScheduledTask -TaskName "agentrow" -Action $Action -Trigger $Trigger -Settings $Settings -Force | Out-Null
  Start-ScheduledTask -TaskName "agentrow"

  Write-Host ""
  Write-Host "agentrow installed in WSL; the daemon starts at Windows logon (task 'agentrow')." -ForegroundColor Green
  Write-Host "Open a new terminal, then:"
  Write-Host "  agentrow telegram setup <bot-token>"
  Write-Host "  agentrow ws new myproj ~/code/myproj"
  Write-Host "  agentrow new myproj/claude"
  Write-Host "Agents run inside WSL: install Claude Code / Codex there (e.g. in a wsl shell)."
}

Install-Agentrow
