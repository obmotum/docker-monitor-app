# --- Build stage: install dependencies and collect frontend vendor files ---
FROM node:24.22.1-slim AS builder

WORKDIR /app/backend

# Full install (incl. devDependencies) so the frontend libraries can be copied out
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --no-audit --no-fund

# Frontend libraries are served locally instead of from a CDN
WORKDIR /app
COPY frontend/ ./frontend/
RUN mkdir -p frontend/vendor \
 && cp backend/node_modules/chart.js/dist/chart.umd.min.js frontend/vendor/ \
 && cp backend/node_modules/chartjs-adapter-date-fns/dist/chartjs-adapter-date-fns.bundle.min.js frontend/vendor/ \
 && cp backend/node_modules/ansi_up/ansi_up.js frontend/vendor/

# Runtime dependencies only
WORKDIR /app/backend
RUN npm prune --omit=dev
COPY backend/*.js ./


# --- Final image ---
FROM node:24.22.1-slim

ENV NODE_ENV=production \
    PORT=3000 \
    FRONTEND_PATH=/app/frontend \
    METRICS_DB_PATH=/app/data/metrics.db

WORKDIR /app
COPY --from=builder --chown=node:node /app/backend ./backend
COPY --from=builder --chown=node:node /app/frontend ./frontend
# CPU/RAM history (SQLite) – mount a volume here
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME /app/data

# Docker access goes through docker-socket-proxy (DOCKER_HOST), so no root / socket group needed
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# node:sqlite is stable enough for this use but still flagged experimental in Node 24
CMD ["node", "--disable-warning=ExperimentalWarning", "backend/server.js"]
