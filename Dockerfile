# ─────────────────────────────────────────────────────────────────────────────
# CLONE FRAME HUB — bridge container.
#
# Runs the local daemon inside an isolated sandbox. Its shell, file, and network
# access are confined to THIS container — that isolation IS the security point of
# running in Docker. The UI opens in your HOST browser at http://127.0.0.1:8765
# (the port is published to the host's loopback only). See DOCKER.md.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim

# node-pty (the real terminal) is a native module; these let it build if no
# prebuilt binary matches this image's Node / architecture.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install bridge deps first so this layer caches across source edits.
COPY bridge/package*.json ./bridge/
RUN cd bridge && npm install --omit=dev --no-audit --no-fund

# The rest of the app tree (dist/index.html is what the bridge serves).
COPY . .

# Container mode:
#   HUB_BRIDGE_HOST=0.0.0.0     bind all interfaces INSIDE the container (compose
#                               publishes the port to the host loopback ONLY).
#   HUB_BRIDGE_CONTAINER=1      trust the container network namespace as the
#                               boundary (the socket-loopback check can't see the
#                               real client through the gateway); Host-header +
#                               pairing-token gates still apply.
#   CLONE_FRAME_HUB_ROOT=/data  keep app state on a mounted volume.
ENV HUB_BRIDGE_HOST=0.0.0.0 \
    HUB_BRIDGE_CONTAINER=1 \
    HUB_BRIDGE_PORT=8765 \
    CLONE_FRAME_HUB_ROOT=/data \
    NODE_ENV=production

EXPOSE 8765
WORKDIR /app/bridge

# Liveness on the public /health endpoint (no token needed).
HEALTHCHECK --interval=30s --timeout=4s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8765/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "hub-bridge.mjs"]
