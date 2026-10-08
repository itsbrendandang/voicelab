# syntax=docker/dockerfile:1
#
# voicelab: bench UI + voice server in one image.
#   docker compose up --build        -> http://localhost:8787
# API keys come from .env at runtime (never baked into the image).
#
# Behind a TLS-inspecting corporate proxy? Pass its CA to the npm steps:
#   docker build --secret id=extra_ca,src=/path/to/proxy-ca.pem .

ARG NODE_IMAGE=node:22-bookworm-slim

# ---- deps: install the whole workspace once (manifests first for layer caching)
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    npm ci --no-audit --no-fund

# ---- build: compile the web UI to static files
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY apps/web apps/web
RUN npm run build -w @voicelab/web

# ---- runtime: production deps only; the server runs TypeScript directly via tsx
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    VOICELAB_SOP_DIR=/app/sops \
    VOICELAB_DATA_DIR=/data
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY packages/core packages/core
COPY apps/server apps/server
COPY --from=build /app/apps/web/dist apps/web/dist
COPY sops sops
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--import", "tsx", "apps/server/src/index.ts"]
