# syntax=docker/dockerfile:1
# Chartmate server + web UI. Multi-arch (linux/amd64, linux/arm64): the build stage runs on the build host's
# platform (its output is plain JavaScript plus better-sqlite3's bundled prebuilds), only the runtime stage is
# per-target. The base image is pinned by digest (same in both stages); Dependabot keeps it current.
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS build
WORKDIR /repo
RUN corepack enable
# Manifests + lockfile first so the dependency layer is cached until they change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs ./
COPY patches ./patches
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
# No dependency install script runs (as in CI): better-sqlite3 ships prebuilt binaries for every platform.
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm build
# THIRD_PARTY_NOTICES.txt for what the image ships (server runtime + web UI); fails on a license outside the
# AGPL-3.0-compatible allowlist.
RUN node scripts/third-party-notices.mjs --profile=server --out=/repo/THIRD_PARTY_NOTICES.txt
# Self-contained, prod-only copy of the server package (node_modules incl. the
# workspace dep @chartmate/shared with its dist, plus apps/server/dist).
RUN pnpm deploy --filter @chartmate/server --prod --ignore-scripts /out
# Keep only the target's better-sqlite3 binary; drop its C sources (they are only for building from source).
ARG TARGETARCH
RUN set -eu; \
    case "$TARGETARCH" in amd64) arch=x64 ;; arm64) arch=arm64 ;; *) echo "unsupported arch: $TARGETARCH" >&2; exit 1 ;; esac; \
    for pkg in /out/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3; do \
      rm -rf "$pkg/deps" "$pkg/src" "$pkg/build" "$pkg/binding.gyp"; \
      find "$pkg/prebuilds" -name '*.node' ! -name "linux-$arch.node" -delete; \
      test -f "$pkg/prebuilds/linux-$arch.node"; \
    done

FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS runtime
LABEL org.opencontainers.image.title="Chartmate" \
      org.opencontainers.image.description="Self-hosted charting app for stocks, crypto and custom baskets (server + web UI)" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
# The app needs only the node binary: drop npm, npx, corepack and yarn (less to patch, less attack surface).
# /data is the only persistent directory the app writes to; SQLite's temp files (large sorts, VACUUM) go to
# TMPDIR. With a read-only root filesystem, mount a tmpfs on /tmp (compose.yaml does).
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* \
 && test "$(id -u node):$(id -g node)" = 1000:1000 \
 && mkdir -p /data && chown 1000:1000 /data
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATABASE_URL=sqlite:/data/chartmate.db \
    CHARTMATE_WEB_DIST=/app/web \
    TMPDIR=/tmp
WORKDIR /app
# App files stay root-owned (read-only for the app user).
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /out/dist ./dist
COPY --from=build /repo/apps/web/dist ./web
COPY --from=build /repo/LICENSE /repo/THIRD_PARTY_NOTICES.txt ./
# The base image's `node` user, numerically (checked above), so runAsNonRoot can verify it.
USER 1000:1000
VOLUME /data
EXPOSE 8787
# No curl in the slim image: Node's fetch does the check. Honors PORT.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# The server closes connections and the database on SIGTERM (docker stop) and exits 0.
STOPSIGNAL SIGTERM
CMD ["node", "dist/main.js"]
