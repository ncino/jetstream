#!/bin/bash
#
# Start Jetstream (run this every time)
#
# Ensures the Podman machine is running, fixes DNS if needed,
# and starts Jetstream. Safe to run repeatedly.
#
# Usage:
#   ./scripts/podman-start.sh

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

info()  { echo -e "${GREEN}[INFO]${NC}  $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# ------------------------------------------------------------------
# Ensure Podman machine is running
# ------------------------------------------------------------------
MACHINE_STATE=$(podman machine inspect --format '{{.State}}' 2>/dev/null || echo "not_found")

if [ "$MACHINE_STATE" = "not_found" ]; then
    error "Podman machine not found. Run the setup script first: ./scripts/podman-setup.sh"
elif [ "$MACHINE_STATE" != "running" ]; then
    info "Starting Podman machine..."
    podman machine start
fi

# ------------------------------------------------------------------
# Fix DNS if needed (does not persist across restarts)
# ------------------------------------------------------------------
DNS_OK=$(podman machine ssh "nslookup github.com > /dev/null 2>&1 && echo yes || echo no")

if [ "$DNS_OK" = "no" ]; then
    info "Fixing DNS..."
    podman machine ssh "echo 'nameserver 8.8.8.8' | sudo tee -a /etc/resolv.conf" > /dev/null 2>&1
fi

# ------------------------------------------------------------------
# Check that the image exists
# ------------------------------------------------------------------
if ! podman image exists jetstream-app 2>/dev/null; then
    error "Jetstream image not found. Run the setup script first: ./scripts/podman-setup.sh"
fi

# ------------------------------------------------------------------
# Start Jetstream
# ------------------------------------------------------------------
echo ""
echo -e "${BOLD}========================================${NC}"
echo -e "${BOLD}  Starting Jetstream${NC}"
echo -e "${BOLD}========================================${NC}"
echo ""
echo -e "  ${GREEN}App URL:${NC}    http://localhost:3333/app"
echo -e "  ${GREEN}Email:${NC}      test@example.com"
echo -e "  ${GREEN}Password:${NC}   EXAMPLE_123!"
echo ""
echo -e "  Press ${YELLOW}Ctrl+C${NC} to stop."
echo ""

cd "$PROJECT_DIR"
podman compose up
