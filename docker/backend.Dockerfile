# syntax=docker/dockerfile:1
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
# The BitTorrent library has a native WebRTC part. If it cannot be installed for this platform, install without it: the app then
# starts normally and only torrents report "unavailable" (the engine loads the library lazily and handles the failure).
RUN npm ci --workspace backend --include-workspace-root \n || (echo 'WARNING: a native module failed to install; torrents will be unavailable in this image' && npm ci --workspace backend --include-workspace-root --ignore-scripts)
COPY backend backend
RUN npm -w backend run build && npm prune --omit=dev --workspace backend

FROM node:24-alpine
ENV NODE_ENV=production MIGRATIONS_DIR=/app/migrations LOCAL_STORAGE_ROOT=/data/storage LOCAL_TMP_DIR=/data/tmp DOWNLOAD_WORKDIR=/downloads MEDIA_WORKDIR=/downloads/media
# FFmpeg (and ffprobe) index media and make thumbnails; only the worker runs them.
RUN apk upgrade --no-cache && apk add --no-cache ffmpeg 7zip
# The app only ever runs `node dist/...`. The package managers that ship in the base image (npm bundles its own copies of undici,
# tar, etc.) are never used at runtime, so remove them: fewer vulnerable packages and less for an attacker to use.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/backend/package.json backend/package.json
COPY --from=build /app/backend/dist backend/dist
COPY migrations migrations
RUN mkdir -p /data/storage /data/tmp /downloads /backups /secrets && chown -R node:node /data /downloads /backups /secrets
USER node
WORKDIR /app/backend
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
