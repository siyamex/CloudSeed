# Installs CloudSeed with Docker Desktop in one step. In PowerShell:
#   irm https://raw.githubusercontent.com/siyamex/CloudSeed/main/install/install.ps1 | iex
# Choose another folder or port first:  $env:CLOUDSEED_DIR = 'D:\cloudseed'; $env:PORT = '9000'
$ErrorActionPreference = 'Stop'
$dir  = if ($env:CLOUDSEED_DIR) { $env:CLOUDSEED_DIR } else { Join-Path $HOME 'cloudseed' }
$port = if ($env:PORT) { $env:PORT } else { '8080' }
$src  = if ($env:CLOUDSEED_COMPOSE_URL) { $env:CLOUDSEED_COMPOSE_URL } else { 'https://raw.githubusercontent.com/siyamex/CloudSeed/main/install/docker-compose.yml' }

function Fail($m) { Write-Host "ERROR: $m" -ForegroundColor Red; exit 1 }
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Fail 'Docker is not installed. Install Docker Desktop first: https://www.docker.com/products/docker-desktop/' }
docker compose version *> $null
if ($LASTEXITCODE -ne 0) { Fail "The 'docker compose' command is missing. Update Docker Desktop." }
docker info *> $null
if ($LASTEXITCODE -ne 0) { Fail 'Docker is installed but not running. Start Docker Desktop and run this again.' }

New-Item -ItemType Directory -Force -Path $dir | Out-Null
Set-Location $dir
Write-Host "Installing into $dir"
if (Test-Path docker-compose.yml) { Write-Host 'Keeping your existing docker-compose.yml.' } else { Invoke-WebRequest -UseBasicParsing -Uri $src -OutFile docker-compose.yml }
if (-not (Test-Path .env)) { Set-Content -Path .env -Value "PORT=$port" -Encoding ascii }
$line = Select-String -Path .env -Pattern '^PORT=(.+)$' | Select-Object -Last 1
if ($line) { $port = $line.Matches[0].Groups[1].Value.Trim() }

Write-Host 'Downloading the images (the first time takes a few minutes)...'
docker compose pull -q
docker compose up -d
if ($LASTEXITCODE -ne 0) { Fail 'docker compose up failed. See the messages above.' }

Write-Host 'Waiting for it to start...'
$ok = $false
for ($i = 0; $i -lt 90; $i++) {
  try { Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:$port/api/v1/health" -TimeoutSec 3 | Out-Null; $ok = $true; break } catch { Start-Sleep -Seconds 2 }
}
if (-not $ok) { Fail "It is taking longer than expected. Look at the logs with:  cd $dir; docker compose logs" }

Write-Host ''
Write-Host 'CloudSeed is running.' -ForegroundColor Green
Write-Host "  Open:  http://localhost:$port"
Write-Host ''
Write-Host 'The first page asks you to create the administrator account. That is the only setup needed.'
Write-Host "Stop it:  cd $dir; docker compose down      Update it:  cd $dir; docker compose pull; docker compose up -d"
