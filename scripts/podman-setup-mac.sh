#!/bin/bash
#
# Jetstream Local Setup Script for Podman Desktop (macOS / Linux)
#
# This script automates the entire setup process:
#   1. Validates prerequisites (Podman, cert file)
#   2. Configures the Podman machine (memory, Zscaler cert, DNS)
#   3. Prompts for Salesforce OAuth credentials
#   4. Builds the Jetstream container image
#   5. Starts Jetstream
#
# Prerequisites:
#   - Podman Desktop installed (https://podman-desktop.io)
#   - ZscalerRoot-FullBundle.pem in the project root directory
#
# Usage:
#   ./scripts/podman-setup-mac.sh

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CERT_FILE="$PROJECT_DIR/ZscalerRoot-FullBundle.pem"
ENV_FILE="$PROJECT_DIR/.env"
PODMAN_MEMORY=6144

info()  { echo -e "${GREEN}[INFO]${NC}  $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

echo ""
echo -e "${BOLD}========================================${NC}"
echo -e "${BOLD}  Jetstream Local Setup (Podman)${NC}"
echo -e "${BOLD}========================================${NC}"
echo ""

# ------------------------------------------------------------------
# Step 1: Validate prerequisites
# ------------------------------------------------------------------
info "Step 1/7: Checking prerequisites..."

if ! command -v podman &> /dev/null; then
    error "Podman is not installed.

  1. Download Podman Desktop from https://podman-desktop.io
  2. Install and launch it
  3. Initialize the Podman machine when prompted
  4. Re-run this script"
fi
info "  Podman found: $(podman --version)"

if [ ! -f "$CERT_FILE" ]; then
    error "Zscaler certificate not found.

  Please obtain ZscalerRoot-FullBundle.pem from your IT team and place it in:
    $PROJECT_DIR/

  Then re-run this script."
fi
info "  Zscaler certificate found"

# ------------------------------------------------------------------
# Step 2: Configure Podman machine
# ------------------------------------------------------------------
info "Step 2/7: Configuring Podman machine..."

MACHINE_STATE=$(podman machine inspect --format '{{.State}}' 2>/dev/null || echo "not_found")

if [ "$MACHINE_STATE" = "not_found" ]; then
    info "  Initializing Podman machine with ${PODMAN_MEMORY}MB memory..."
    podman machine init --memory $PODMAN_MEMORY
    podman machine start
elif [ "$MACHINE_STATE" = "running" ]; then
    CURRENT_MEMORY=$(podman machine inspect --format '{{.Resources.Memory}}' 2>/dev/null || echo "0")
    if [ "$CURRENT_MEMORY" -lt "$PODMAN_MEMORY" ]; then
        info "  Increasing Podman machine memory to ${PODMAN_MEMORY}MB..."
        podman machine stop
        podman machine set --memory $PODMAN_MEMORY
        podman machine start
    else
        info "  Podman machine memory OK (${CURRENT_MEMORY}MB)"
    fi
else
    info "  Starting Podman machine..."
    podman machine set --memory $PODMAN_MEMORY 2>/dev/null || true
    podman machine start
fi

# ------------------------------------------------------------------
# Step 3: Install Zscaler certificate into Podman VM
# ------------------------------------------------------------------
info "Step 3/7: Installing Zscaler certificate..."

podman machine ssh sudo tee /etc/pki/ca-trust/source/anchors/ZscalerRoot-FullBundle.pem < "$CERT_FILE" > /dev/null 2>&1
podman machine ssh sudo update-ca-trust 2>&1

info "  Certificate installed"

# ------------------------------------------------------------------
# Step 4: Fix DNS if needed
# ------------------------------------------------------------------
info "Step 4/7: Checking network connectivity..."

DNS_OK=$(podman machine ssh "nslookup github.com > /dev/null 2>&1 && echo yes || echo no")

if [ "$DNS_OK" = "no" ]; then
    warn "  DNS not working, adding fallback resolver..."
    podman machine ssh "echo 'nameserver 8.8.8.8' | sudo tee -a /etc/resolv.conf" > /dev/null 2>&1

    DNS_OK2=$(podman machine ssh "nslookup github.com > /dev/null 2>&1 && echo yes || echo no")
    if [ "$DNS_OK2" = "no" ]; then
        error "DNS resolution still failing. Check your network connection and try again."
    fi
    info "  DNS fixed"
else
    info "  Network connectivity OK"
fi

# ------------------------------------------------------------------
# Step 5: Set up Salesforce credentials
# ------------------------------------------------------------------
info "Step 5/7: Setting up Salesforce credentials..."

if [ -f "$ENV_FILE" ]; then
    info "  Credentials file (.env) already exists, keeping existing values"
else
    echo ""
    echo -e "  ${BOLD}To connect Salesforce orgs, you need OAuth credentials (one ECA per Salesforce org that hosts a Connected App).${NC}"
    echo -e "  Find them in the shared 1Password vault: ${BOLD}Jetstream Local Credentials${NC}"
    echo ""
    echo -e "  Press Enter at the ID prompt to stop adding ECAs."
    echo ""

    : > "$ENV_FILE"
    echo "# Salesforce External Client Apps (ECAs)" >> "$ENV_FILE"

    eca_index=1
    while true; do
        echo ""
        echo -e "  ${BOLD}ECA #${eca_index}${NC}"
        read -p "    ID (short slug, e.g. prod, ncinodev) [enter to stop]: " ECA_ID
        if [ -z "$ECA_ID" ]; then
            break
        fi
        if ! [[ "$ECA_ID" =~ ^[a-z0-9-]+$ ]]; then
            warn "    Invalid id; must match ^[a-z0-9-]+\$. Try again."
            continue
        fi
        read -p "    Label (e.g. Production): " ECA_LABEL
        read -p "    Consumer Key: " ECA_KEY
        read -p "    Consumer Secret: " ECA_SECRET
        echo "    Default for which org type? (optional)"
        echo "      1) Production (login.salesforce.com)"
        echo "      2) Sandbox (test.salesforce.com)"
        echo "      3) Pre-release (prerellogin.pre.salesforce.com)"
        echo "      4) None"
        read -p "    Choice [4]: " ECA_DEFAULT_CHOICE
        case "${ECA_DEFAULT_CHOICE:-4}" in
            1) ECA_DEFAULT="prod" ;;
            2) ECA_DEFAULT="sandbox" ;;
            3) ECA_DEFAULT="pre-release" ;;
            *) ECA_DEFAULT="" ;;
        esac

        cat >> "$ENV_FILE" << EOF
SFDC_ECA_${eca_index}_ID='${ECA_ID}'
SFDC_ECA_${eca_index}_LABEL='${ECA_LABEL}'
SFDC_ECA_${eca_index}_KEY='${ECA_KEY}'
SFDC_ECA_${eca_index}_SECRET='${ECA_SECRET}'
SFDC_ECA_${eca_index}_DEFAULT_FOR='${ECA_DEFAULT}'

EOF

        info "    Saved ECA #${eca_index} (${ECA_ID})"
        eca_index=$((eca_index + 1))

        read -p "  Add another ECA? (y/N) " ADD_ANOTHER
        case "$ADD_ANOTHER" in
            y|Y) continue ;;
            *) break ;;
        esac
    done

    if [ "$eca_index" -eq 1 ]; then
        warn "  No ECAs configured — adding placeholders so the app can boot."
        cat >> "$ENV_FILE" << 'EOF'
SFDC_ECA_1_ID='placeholder'
SFDC_ECA_1_LABEL='Placeholder'
SFDC_ECA_1_KEY='placeholder-get-key-from-your-team'
SFDC_ECA_1_SECRET='placeholder-get-secret-from-your-team'
SFDC_ECA_1_DEFAULT_FOR=''
EOF
    fi
fi

# ------------------------------------------------------------------
# Step 6: Build the Jetstream image
# ------------------------------------------------------------------
info "Step 6/7: Building Jetstream..."
info "  This takes 15-20 minutes on the first build. Please be patient."
echo ""

cd "$PROJECT_DIR"

# Clean up old images to free disk space
podman system prune -a -f > /dev/null 2>&1

podman build --no-cache -t jetstream-app .

echo ""
info "Build complete!"

# ------------------------------------------------------------------
# Step 7: Start Jetstream
# ------------------------------------------------------------------
echo ""
echo -e "${BOLD}========================================${NC}"
echo -e "${BOLD}  Jetstream is starting!${NC}"
echo -e "${BOLD}========================================${NC}"
echo ""
echo -e "  ${GREEN}Open in your browser:${NC}  http://localhost:3333/app"
echo ""
echo -e "  ${GREEN}Login:${NC}"
echo -e "    Email:     test@example.com"
echo -e "    Password:  EXAMPLE_123!"
echo ""
echo -e "  You can safely close this terminal window."
echo -e "  Jetstream will keep running in the background."
echo ""
echo -e "  To stop Jetstream later, open Terminal and run:"
echo -e "    cd ~/Documents/jetstream && podman compose down"
echo ""

cd "$PROJECT_DIR"
podman compose up -d

echo ""
echo -e "  ${GREEN}Jetstream is running!${NC} Open http://localhost:3333/app"
echo ""
