#Requires -Version 5.1
<#
.SYNOPSIS
    Start Jetstream (run this every time)

.DESCRIPTION
    Ensures the Podman machine is running, fixes DNS if needed,
    and starts Jetstream. Safe to run repeatedly.

.EXAMPLE
    .\scripts\podman-start-windows.ps1
#>

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir

function Write-Info  { param($msg) Write-Host "[INFO]  $msg" -ForegroundColor Green }
function Write-Warn  { param($msg) Write-Host "[WARN]  $msg" -ForegroundColor Yellow }
function Write-Err   { param($msg) Write-Host "[ERROR] $msg" -ForegroundColor Red; exit 1 }

# ------------------------------------------------------------------
# Ensure Podman machine is running
# ------------------------------------------------------------------
$machineState = "not_found"
try {
    $inspectOutput = & podman machine inspect 2>&1
    $machineInfo = $inspectOutput | ConvertFrom-Json
    if ($machineInfo -is [array]) {
        $machineInfo = $machineInfo[0]
    }
    $machineState = $machineInfo.State
} catch {
    $machineState = "not_found"
}

if ($machineState -eq "not_found") {
    Write-Err "Podman machine not found. Run the setup script first: .\scripts\podman-setup-windows.ps1"
} elseif ($machineState -ne "running") {
    Write-Info "Starting Podman machine..."
    & podman machine start
}

# ------------------------------------------------------------------
# Fix DNS if needed (does not persist across restarts)
# ------------------------------------------------------------------
$dnsResult = & podman machine ssh "nslookup github.com > /dev/null 2>&1 && echo yes || echo no" 2>&1

if (-not ("$dnsResult" -match "yes")) {
    Write-Info "Fixing DNS..."
    & podman machine ssh "echo 'nameserver 8.8.8.8' | sudo tee -a /etc/resolv.conf" > $null 2>&1
}

# ------------------------------------------------------------------
# Check that the image exists
# ------------------------------------------------------------------
$imageCheck = & podman image exists jetstream-app 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Err "Jetstream image not found. Run the setup script first: .\scripts\podman-setup-windows.ps1"
}

# ------------------------------------------------------------------
# Start Jetstream
# ------------------------------------------------------------------
Write-Host ""
Write-Host "========================================" -ForegroundColor White
Write-Host "  Starting Jetstream" -ForegroundColor White
Write-Host "========================================" -ForegroundColor White
Write-Host ""
Write-Host "  App URL:    http://localhost:3333/app" -ForegroundColor Green
Write-Host "  Email:      test@example.com" -ForegroundColor Green
Write-Host "  Password:   EXAMPLE_123!" -ForegroundColor Green
Write-Host ""
Write-Host "  You can safely close this terminal window." -ForegroundColor Green
Write-Host "  Jetstream will keep running in the background." -ForegroundColor Green
Write-Host ""
Write-Host "  To stop Jetstream later, open PowerShell and run:"
Write-Host "    cd `$HOME\Documents\jetstream; podman compose down"
Write-Host ""

Set-Location $ProjectDir
& podman compose up -d

Write-Host ""
Write-Host "  Jetstream is running! Open http://localhost:3333/app" -ForegroundColor Green
Write-Host ""
