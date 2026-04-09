#!/bin/bash
# ═══════════════════════════════════════════
# AgenticSRE — One-Click Docker Deployment
# Usage: ./deploy_docker.sh [--build] [--stop]
# ═══════════════════════════════════════════
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "${SCRIPT_DIR}"

IMAGE_NAME="agenticsre"
IMAGE_TAG="latest"
IMAGE_TAR="agenticsre-image.tar.gz"
CONTAINER_NAME="agenticsre"

# ── Parse arguments ──
ACTION="deploy"
FORCE_BUILD=false
for arg in "$@"; do
    case $arg in
        --stop)  ACTION="stop" ;;
        --build) FORCE_BUILD=true ;;
        --help|-h)
            echo "Usage: $0 [--build] [--stop]"
            echo "  --build  Force rebuild image (ignore cached tar)"
            echo "  --stop   Stop and remove container"
            exit 0
            ;;
    esac
done

# ── Colors ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ═══════════════════════════════════════════
# Step 1: Check Docker
# ═══════════════════════════════════════════
info "Checking Docker..."
command -v docker >/dev/null 2>&1 || error "Docker not found. Please install Docker first."

# Check docker compose (plugin or standalone)
if docker compose version >/dev/null 2>&1; then
    COMPOSE_CMD="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_CMD="docker-compose"
else
    error "docker compose not found. Please install docker compose."
fi
info "Docker OK. Compose: ${COMPOSE_CMD}"

# ═══════════════════════════════════════════
# Stop action
# ═══════════════════════════════════════════
if [ "$ACTION" = "stop" ]; then
    info "Stopping AgenticSRE container..."
    ${COMPOSE_CMD} down 2>/dev/null || true
    info "Container stopped."
    exit 0
fi

# ═══════════════════════════════════════════
# Step 2: Create directories
# ═══════════════════════════════════════════
info "Creating data directories..."
mkdir -p data/memory logs

# ═══════════════════════════════════════════
# Step 3: Load or build image
# ═══════════════════════════════════════════
if [ "$FORCE_BUILD" = true ]; then
    info "Force building image..."
    ${COMPOSE_CMD} build
elif [ -f "${IMAGE_TAR}" ]; then
    info "Found ${IMAGE_TAR}, loading image..."
    docker load -i "${IMAGE_TAR}"
    info "Image loaded."
elif docker image inspect ${IMAGE_NAME}:${IMAGE_TAG} >/dev/null 2>&1; then
    info "Image ${IMAGE_NAME}:${IMAGE_TAG} already exists."
else
    info "No image found, building..."
    ${COMPOSE_CMD} build
fi

# ═══════════════════════════════════════════
# Step 4: Stop old container → Start new
# ═══════════════════════════════════════════
info "Stopping old container (if any)..."
${COMPOSE_CMD} down 2>/dev/null || true

info "Starting AgenticSRE container..."
${COMPOSE_CMD} up -d

# ═══════════════════════════════════════════
# Step 5: Wait for health check
# ═══════════════════════════════════════════
info "Waiting for health check..."
MAX_WAIT=60
WAITED=0
while [ $WAITED -lt $MAX_WAIT ]; do
    if curl -sf http://localhost:8080/api/health >/dev/null 2>&1; then
        echo ""
        info "Health check passed!"
        break
    fi
    printf "."
    sleep 2
    WAITED=$((WAITED + 2))
done

if [ $WAITED -ge $MAX_WAIT ]; then
    warn "Health check timed out after ${MAX_WAIT}s. Check logs:"
    warn "  docker logs ${CONTAINER_NAME}"
fi

# ═══════════════════════════════════════════
# Step 6: Print access info
# ═══════════════════════════════════════════
echo ""
echo "═══════════════════════════════════════════"
info "AgenticSRE is running!"
echo ""
echo "  Dashboard:  http://localhost:8080"
echo "  Health:     http://localhost:8080/api/health"
echo "  Logs:       docker logs -f ${CONTAINER_NAME}"
echo "  Stop:       $0 --stop"
echo "═══════════════════════════════════════════"
