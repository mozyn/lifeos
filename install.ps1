# LifeOS installer for Windows (PowerShell, with Docker Desktop and its WSL 2 backend).
# Run it from this folder:   powershell -ExecutionPolicy Bypass -File .\install.ps1
# It does what install.sh does on Linux and macOS: checks Docker, fills in .env, asks for your notes
# folder (or makes a new, empty one: LifeOS puts the starter notes in it when it first starts),
# builds, starts, prints the address. The search secret and the notification keys LifeOS makes itself.
# Prefer WSL? Open this folder in a WSL terminal and run ./install.sh instead (keep your notes on
# the Linux side then, for speed).
# Answers can be given ahead: $env:LIFEOS_INSTALL_VAULT, $env:LIFEOS_INSTALL_STARTER = "1",
# $env:LIFEOS_INSTALL_PORT, $env:LIFEOS_INSTALL_YES = "1" (ask nothing).
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot
$Here = (Get-Location).Path

function Die($msg) { Write-Host "install.ps1: $msg" -ForegroundColor Red; exit 1 }
function Interactive { return ($env:LIFEOS_INSTALL_YES -ne '1') -and [Environment]::UserInteractive }
function Ask($question, $default) {
  if (-not (Interactive)) { return $default }
  $q = if ($default) { "$question [$default]" } else { $question }
  $a = Read-Host $q
  if ([string]::IsNullOrWhiteSpace($a)) { return $default } else { return $a.Trim() }
}
$EnvFile = Join-Path $Here '.env'
$Utf8 = New-Object System.Text.UTF8Encoding $false
function Get-EnvValue($key) {
  if (-not (Test-Path $EnvFile)) { return '' }
  $line = [System.IO.File]::ReadAllLines($EnvFile, $Utf8) | Where-Object { $_ -match "^$key=" } | Select-Object -Last 1
  if ($line) { return $line.Substring($key.Length + 1) } else { return '' }
}
# one value set where its line is (the comments stay beside it), or at the end; UTF-8 without a BOM
function Set-EnvValue($key, $value) {
  $done = $false
  $lines = @(foreach ($l in [System.IO.File]::ReadAllLines($EnvFile, $Utf8)) {
    if ($l -match "^$key=") { if (-not $done) { "$key=$value"; $done = $true } } else { $l }
  })
  if (-not $done) { $lines += "$key=$value" }
  [System.IO.File]::WriteAllLines($EnvFile, [string[]]$lines, $Utf8)
}

Write-Host "LifeOS: installing in $Here"

# 1. Docker
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Die 'Docker is not installed. Install Docker Desktop first: https://docs.docker.com/desktop/setup/install/windows-install/' }
docker compose version *> $null
if ($LASTEXITCODE -ne 0) { Die 'Docker Compose v2 is missing. Update Docker Desktop.' }
docker info *> $null
if ($LASTEXITCODE -ne 0) { Die 'Docker Desktop is not running. Start it and try again.' }

# 2. .env (made when missing: the folder ships one file, compose.yaml)
if (-not (Test-Path $EnvFile)) { Set-Content -Path $EnvFile -Value 'LIFEOS_NAME=','LIFEOS_VAULT_HOST=','LIFEOS_UID=','LIFEOS_GID=','LIFEOS_PORT=','TZ=' }
$Name = Get-EnvValue 'LIFEOS_NAME'
if (-not $Name) { $Name = 'lifeos' }

# 3. the notes folder (forward slashes: Docker Desktop reads C:/Users/... in .env)
$vault = Get-EnvValue 'LIFEOS_VAULT_HOST'
$fresh = $false
if (-not $vault) {
  $vault = $env:LIFEOS_INSTALL_VAULT
  $starter = $env:LIFEOS_INSTALL_STARTER
  if (-not $vault -and (Interactive)) {
    Write-Host ''
    Write-Host 'LifeOS works on a folder of plain .md notes: an Obsidian vault, or any folder.'
    Write-Host '  1) Use a folder I already have'
    Write-Host '  2) Make a new folder with a few starter notes'
    if ((Ask 'Choose 1 or 2' '2') -eq '1') { $vault = Ask 'The path of your notes folder' ''; $starter = '0' }
    else { $vault = Ask 'Where should the new folder go' (Join-Path $Here 'my-notes'); $starter = '1' }
  }
  if (-not $vault) { Die 'No notes folder: set $env:LIFEOS_INSTALL_VAULT, or run me in a terminal.' }
  $vault = [System.IO.Path]::GetFullPath($vault)
  if ($starter -eq '1') {
    if ((Test-Path $vault) -and (Get-ChildItem -Force $vault | Select-Object -First 1)) { Die "$vault is not empty. The starter notes go into a new or empty folder." }
    New-Item -ItemType Directory -Force -Path $vault | Out-Null
    $fresh = $true
  }
  if (-not (Test-Path -PathType Container $vault)) { Die "$vault is not a folder." }
  Set-EnvValue 'LIFEOS_VAULT_HOST' ($vault -replace '\\', '/')
  $vault = $vault -replace '\\', '/'
}
Write-Host "Notes folder: $vault"

# 4. port
$port = if ($env:LIFEOS_INSTALL_PORT) { $env:LIFEOS_INSTALL_PORT } else { Get-EnvValue 'LIFEOS_PORT' }
if (-not $port) { $port = '8480' }
$busy = Get-NetTCPConnection -State Listen -LocalPort ([int]$port) -ErrorAction SilentlyContinue
$ours = docker compose -p $Name ps -q web 2>$null
if ($busy -and -not $ours) {
  if (Interactive) { $port = Ask "Port $port is in use. Which port should LifeOS use" ([string]([int]$port + 1)) }
  else { Die "Port $port is in use. Set `$env:LIFEOS_INSTALL_PORT to a free one." }
}
Set-EnvValue 'LIFEOS_PORT' $port
# the time zone until the first run picks a city (PowerShell 7 knows the IANA name; else UTC)
$tz = 'UTC'
try { $iana = $null; if ([System.TimeZoneInfo]::TryConvertWindowsIdToIanaId([System.TimeZoneInfo]::Local.Id, [ref]$iana)) { $tz = $iana } } catch { $tz = 'UTC' }
if ((Get-EnvValue 'TZ') -in @('', 'UTC')) { Set-EnvValue 'TZ' $tz }

# 5. build (the search secret, the notifications' key pair and an empty folder's starter notes are
# made by LifeOS itself on its first start)
$env:LIFEOS_BUILD = ((Get-Content VERSION | Where-Object { $_ -match '^commit=' }) -replace '^commit=', '')
Write-Host ''
Write-Host 'Building LifeOS (the first time takes a few minutes)...'
docker compose -p $Name build
if ($LASTEXITCODE -ne 0) { Die 'the build failed (see above).' }

# 6. start
Write-Host 'Starting LifeOS...'
docker compose -p $Name up -d --wait --wait-timeout 300
if ($LASTEXITCODE -ne 0) { Die 'LifeOS did not start (see above; docker compose -p lifeos logs shows more).' }
if ($fresh) { Write-Host "Starter notes: $((Get-ChildItem -Recurse -Filter *.md $vault).Count) notes in $vault" }
Write-Host ''
Write-Host "LifeOS is running: http://localhost:$port/lifeos/" -ForegroundColor Green
Write-Host 'Open it in your browser, choose a passphrase, then tell it where you are.'
Write-Host 'Then connect Hermes: Settings -> Hermes -> Create token, and paste the prompt in your Hermes chat.'
