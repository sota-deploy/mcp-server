# sota-mcp — HTTP Streamable MCP server for mcp.sota.io

FROM node:22-alpine AS builder

WORKDIR /app

# Dependency layer (cache-friendly)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev=false

# Build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Production deps only
RUN npm prune --omit=dev

# ───────────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    PORT=8080

WORKDIR /app

# Non-root user
RUN addgroup -g 1001 -S sota && \
    adduser -u 1001 -S sota -G sota

COPY --from=builder --chown=sota:sota /app/node_modules ./node_modules
COPY --from=builder --chown=sota:sota /app/dist ./dist
COPY --from=builder --chown=sota:sota /app/package.json ./

USER sota

# The deploy tool packs the uploaded files with the system tar. Alpine ships
# BusyBox tar, which lacks options GNU tar and bsdtar have (2026-11-18: no
# --null, every hosted deploy failed). Pack a small archive with this image's
# own tar at build time, so an image that cannot deploy is never built.
RUN node -e "import('./dist/lib/archive-builder.js').then(m => { const b = m.archiveFromFiles({'a.txt':'x','d/b.txt':'y'}); if (b[0] !== 0x1f || b.length < 40) throw new Error('bad archive'); })"

EXPOSE 8080

# Commit and build time of this image, reported by GET /health.
# Declared last on purpose: the build time differs on every deploy, and
# anything after these lines is rebuilt each time. Both default to "unknown":
# a build without the args works as before.
ARG GIT_SHA=unknown
ARG BUILD_TIME=unknown
ENV GIT_SHA=$GIT_SHA \
    BUILD_TIME=$BUILD_TIME

HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health > /dev/null 2>&1 || exit 1

CMD ["node", "dist/http.js"]
