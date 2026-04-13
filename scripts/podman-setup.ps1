#Requires -Version 5.1
<#
.SYNOPSIS
    Jetstream Local Setup Script for Podman Desktop (Windows)

.DESCRIPTION
    Automates the entire setup process:
      1. Validates prerequisites (Podman, cert file)
      2. Configures the Podman machine (memory, Zscaler cert, DNS)
      3. Prompts for Salesforce OAuth credentials
      4. Builds the Jetstream container image
      5. Starts Jetstream

.NOTES
    Prerequisites:
      - Podman Desktop installed (https://podman-desktop.io)
      - ZscalerRoot-FullBundle.pem in the project root directory

.EXAMPLE
    .\scripts\podman-setup.ps1
#>

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
$CertFile = Join-Path $ProjectDir "ZscalerRoot-FullBundle.pem"
$EnvFile = Join-Path $ProjectDir ".env"
$PodmanMemory = 6144

function Write-Info  { param($msg) Write-Host "[INFO]  $msg" -ForegroundColor Green }
function Write-Warn  { param($msg) Write-Host "[WARN]  $msg" -ForegroundColor Yellow }
function Write-Err   { param($msg) Write-Host "[ERROR] $msg" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "========================================" -ForegroundColor White
Write-Host "  Jetstream Local Setup (Podman)" -ForegroundColor White
Write-Host "========================================" -ForegroundColor White
Write-Host ""

# ------------------------------------------------------------------
# Step 1: Validate prerequisites
# ------------------------------------------------------------------
Write-Info "Step 1/7: Checking prerequisites..."

$podmanPath = Get-Command podman -ErrorAction SilentlyContinue
if (-not $podmanPath) {
    Write-Err @"
Podman is not installed.

  1. Download Podman Desktop from https://podman-desktop.io
  2. Install and launch it
  3. Initialize the Podman machine when prompted
  4. Re-run this script
"@
}
$podmanVersion = podman --version 2>&1
Write-Info "  Podman found: $podmanVersion"

if (-not (Test-Path $CertFile)) {
    Write-Err @"
Zscaler certificate not found.

  Please obtain ZscalerRoot-FullBundle.pem from your IT team and place it in:
    $ProjectDir

  Then re-run this script.
"@
}
Write-Info "  Zscaler certificate found"

# ------------------------------------------------------------------
# Step 2: Configure Podman machine
# ------------------------------------------------------------------
Write-Info "Step 2/7: Configuring Podman machine..."

$machineInfo = $null
try {
    $machineInfo = podman machine inspect 2>&1 | ConvertFrom-Json
    $machineState = $machineInfo.State
} catch {
    $machineState = "not_found"
}

if ($machineState -eq "not_found") {
    Write-Info "  Initializing Podman machine with ${PodmanMemory}MB memory..."
    podman machine init --memory $PodmanMemory
    podman machine start
} elseif ($machineState -eq "running") {
    $currentMemory = $machineInfo.Resources.Memory
    if ($currentMemory -lt $PodmanMemory) {
        Write-Info "  Increasing Podman machine memory to ${PodmanMemory}MB..."
        podman machine stop
        podman machine set --memory $PodmanMemory
        podman machine start
    } else {
        Write-Info "  Podman machine memory OK (${currentMemory}MB)"
    }
} else {
    Write-Info "  Starting Podman machine..."
    podman machine set --memory $PodmanMemory 2>$null
    podman machine start
}

# ------------------------------------------------------------------
# Step 3: Install Zscaler certificate into Podman VM
# ------------------------------------------------------------------
Write-Info "Step 3/7: Installing Zscaler certificate..."

Get-Content $CertFile | podman machine ssh sudo tee /etc/pki/ca-trust/source/anchors/ZscalerRoot-FullBundle.pem > $null 2>&1
podman machine ssh sudo update-ca-trust 2>&1 > $null

Write-Info "  Certificate installed"

# ------------------------------------------------------------------
# Step 4: Fix DNS if needed
# ------------------------------------------------------------------
Write-Info "Step 4/7: Checking network connectivity..."

$dnsResult = podman machine ssh "nslookup github.com > /dev/null 2>&1 && echo yes || echo no" 2>&1
$dnsOk = ($dnsResult -match "yes")

if (-not $dnsOk) {
    Write-Warn "  DNS not working, adding fallback resolver..."
    podman machine ssh "echo 'nameserver 8.8.8.8' | sudo tee -a /etc/resolv.conf" > $null 2>&1

    $dnsResult2 = podman machine ssh "nslookup github.com > /dev/null 2>&1 && echo yes || echo no" 2>&1
    if (-not ($dnsResult2 -match "yes")) {
        Write-Err "DNS resolution still failing. Check your network connection and try again."
    }
    Write-Info "  DNS fixed"
} else {
    Write-Info "  Network connectivity OK"
}

# ------------------------------------------------------------------
# Step 5: Set up Salesforce credentials
# ------------------------------------------------------------------
Write-Info "Step 5/7: Setting up Salesforce credentials..."

if (Test-Path $EnvFile) {
    Write-Info "  Credentials file (.env) already exists, keeping existing values"
} else {
    Write-Host ""
    Write-Host "  To connect Salesforce orgs, you need OAuth credentials." -ForegroundColor White
    Write-Host "  Get these from your team lead or the Jetstream setup wiki."
    Write-Host ""
    Write-Host "  If you don't have them yet, press Enter to skip."
    Write-Host "  You can add them later by editing the .env file."
    Write-Host ""

    $sfdcKey = Read-Host "  Salesforce Consumer Key"
    $sfdcSecret = Read-Host "  Salesforce Consumer Secret"

    if ([string]::IsNullOrWhiteSpace($sfdcKey) -or [string]::IsNullOrWhiteSpace($sfdcSecret)) {
        Write-Warn "  Skipping - you can add credentials later by editing .env"
        $sfdcKey = "placeholder-get-key-from-your-team"
        $sfdcSecret = "placeholder-get-secret-from-your-team"
    } else {
        Write-Info "  Credentials saved"
    }

    @"
# Salesforce OAuth credentials (obtain from your team lead)
SFDC_CONSUMER_KEY='$sfdcKey'
SFDC_CONSUMER_SECRET='$sfdcSecret'
"@ | Set-Content -Path $EnvFile -Encoding UTF8

}

# ------------------------------------------------------------------
# Step 6: Build the Jetstream image
# ------------------------------------------------------------------
Write-Info "Step 6/7: Building Jetstream..."
Write-Info "  This takes 15-20 minutes on the first build. Please be patient."
Write-Host ""

Push-Location $ProjectDir

# Clean up old images to free disk space
podman system prune -a -f > $null 2>&1

podman build --no-cache -t jetstream-app .

Write-Host ""
Write-Info "Build complete!"

# ------------------------------------------------------------------
# Step 7: Start Jetstream
# ------------------------------------------------------------------
Write-Host ""
Write-Host "========================================" -ForegroundColor White
Write-Host "  Jetstream is starting!" -ForegroundColor White
Write-Host "========================================" -ForegroundColor White
Write-Host ""
Write-Host "  Open in your browser:  http://localhost:3333/app" -ForegroundColor Green
Write-Host ""
Write-Host "  Login:" -ForegroundColor Green
Write-Host "    Email:     test@example.com"
Write-Host "    Password:  EXAMPLE_123!"
Write-Host ""
Write-Host "  Press Ctrl+C to stop Jetstream." -ForegroundColor Yellow
Write-Host ""

podman compose up

Pop-Location
