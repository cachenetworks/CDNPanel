# syntax=docker/dockerfile:1.7
# API + worker image (same image, different command).
FROM node:25-bookworm-slim AS base
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS build
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/storage/package.json packages/storage/
COPY packages/database/package.json packages/database/
COPY packages/sdk-js/package.json packages/sdk-js/
COPY packages/cli/package.json packages/cli/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
RUN npx prisma generate --schema packages/database/prisma/schema.prisma \
 && npm run build -w @cdn/shared -w @cdn/storage -w @cdn/database -w @cdn/api \
 && npm prune --omit=dev \
 && npm install --no-save --omit=dev --no-audit --no-fund prisma@5.22.0

FROM base AS runtime
ENV NODE_ENV=production
# FFmpeg / ffprobe for the media pipeline (thumbnails, HLS / DASH, waveforms).
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
COPY --from=build /app /app
RUN mkdir -p /data/storage /data/tmp && chown -R node:node /data
USER node
WORKDIR /app/apps/api
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# The preload starts OpenTelemetry tracing when OTEL_EXPORTER_OTLP_ENDPOINT is set (no-op otherwise).
CMD ["node", "--import", "./dist/otel.js", "dist/server.js"]
