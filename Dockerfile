# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# The BuildKit frontend (the line above) is pinned by digest. To move it: `docker buildx imagetools inspect
# docker/dockerfile:1`, then update the digest (Dependabot's docker updates propose it too).
# Chartmate server + web UI. Multi-arch (linux/amd64, linux/arm64): the build stage runs on the build host's
# platform (its output is plain JavaScript plus better-sqlite3's bundled prebuilds), only the runtime stage is
# per-target.
# Base image: the Node.js line of .nvmrc on the newest Debian (trixie) slim, by tag (no digest pin), so a build
# gets the current patch releases of Node.js and Debian. Build with --pull (CI and the release workflows always
# do). The workflows resolve the tag once per run (.github/scripts/resolve-base-image.sh), log its digest and pin
# every build of that run to it; BuildKit's provenance records it too. Both stages use the same image.
FROM --platform=$BUILDPLATFORM node:26-trixie-slim AS build
WORKDIR /repo
# Node.js 25 and later no longer bundle corepack: install-pnpm.sh installs the corepack release it pins (version
# and sha512), the pnpm that package.json pins (packageManager, sha512-checked) and pnpm's native binary
# (checked against pnpm-lock.yaml), as the workflows do. It reads package.json and pnpm-lock.yaml, so both come
# first; the build stops unless the pnpm that runs is the pinned one.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
COPY .github/scripts/install-pnpm.sh .github/scripts/
COPY package.json pnpm-lock.yaml ./
RUN bash .github/scripts/install-pnpm.sh \
 && want="$(node -p "require('./package.json').packageManager.split('@')[1].split('+')[0]")" \
 && got="$(pnpm --version)" \
 && { [ "$got" = "$want" ] || { echo "pnpm $got, but package.json pins $want" >&2; exit 1; }; } \
 && rm -rf .github
# Manifests + lockfile first so the dependency layer is cached until they change.
COPY pnpm-workspace.yaml .pnpmfile.cjs ./
COPY patches ./patches
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
# No dependency install script runs (as in CI): better-sqlite3 ships prebuilt binaries for every platform.
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
# owner/name of the repository the image is built from: the web UI's About dialog links to its source code (AGPL-3.0
# section 13). Pass it with --build-arg GITHUB_REPOSITORY=...; unset, the dialog points to the LICENSE in the image.
ARG GITHUB_REPOSITORY=""
# The ref it is built from (the workflows pass GitHub's GITHUB_REF_TYPE, GITHUB_REF_NAME and GITHUB_SHA): the
# dialog links the release tag for a build of exactly that tag, else the commit (apps/web/build/sourceRef.cjs).
ARG GITHUB_REF_TYPE="" GITHUB_REF_NAME="" GITHUB_SHA=""
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

FROM node:26-trixie-slim AS runtime
LABEL org.opencontainers.image.title="Chartmate" \
      org.opencontainers.image.description="Self-hosted charting app for stocks, crypto and custom baskets (server + web UI)" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
# Debian's security updates published since the base image was built, applied at build time (no package lists,
# apt caches or logs stay behind).
# The app needs only the node binary: drop npm, npx, corepack and yarn (less to patch, less attack surface).
# /data is the only persistent directory the app writes to; SQLite's temp files (large sorts, VACUUM) go to
# TMPDIR. With a read-only root filesystem, mount a tmpfs on /tmp (compose.yaml does).
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get -y --no-install-recommends upgrade \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/* /var/log/apt /var/log/dpkg.log \
 && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
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
