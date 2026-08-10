#!/usr/bin/env bash
# Builds unifi-sensor-helper for both linux/arm64 (native on Apple Silicon
# Macs) and linux/amd64 (cross-built via Docker Desktop's bundled QEMU —
# no separate setup needed, just slow: `next build` runs several minutes
# under emulation). See DEPLOY.md.
#
# Usage:
#   ./scripts/docker-build.sh                 # build both, load arm64 into
#                                              # local Docker, save amd64 as
#                                              # a tarball for transfer
#   ./scripts/docker-build.sh --push <registry/image:tag>
#                                              # build both and push a
#                                              # multi-arch manifest instead
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE_NAME="unifi-sensor-helper"
OUT_DIR="dist"

if [[ "${1:-}" == "--push" ]]; then
  TAG="${2:?usage: docker-build.sh --push <registry/image:tag>}"
  echo "==> Building and pushing multi-arch manifest: $TAG"
  docker buildx build --platform linux/amd64,linux/arm64 -t "$TAG" --push .
  echo "==> Done. Pull on the target machine with: docker pull $TAG"
  exit 0
fi

mkdir -p "$OUT_DIR"

echo "==> Building linux/arm64 (loading into local Docker for immediate use here)"
docker buildx build --platform linux/arm64 -t "$IMAGE_NAME:arm64" --load .

echo "==> Building linux/amd64 (cross-build via QEMU — this step is slow, be patient)"
docker buildx build --platform linux/amd64 -t "$IMAGE_NAME:amd64" --load .

echo "==> Saving linux/amd64 image to $OUT_DIR/$IMAGE_NAME-amd64.tar for transfer"
docker save "$IMAGE_NAME:amd64" -o "$OUT_DIR/$IMAGE_NAME-amd64.tar"

echo
echo "==> Done."
echo "  Local (this Mac, arm64): docker run ... $IMAGE_NAME:arm64"
echo "  Transfer $OUT_DIR/$IMAGE_NAME-amd64.tar to the x86 machine, then there:"
echo "    docker load -i $IMAGE_NAME-amd64.tar"
echo "    docker run ... $IMAGE_NAME:amd64"
